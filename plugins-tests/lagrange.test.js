// Unit tests for Lagrange's pure helpers and its provider code (with a fake fetch; no network).
//
// Run from the repository root:   node --test plugins-tests/
// Needs Node 18 or later. Kept outside vault/, so it is not packaged into Scriptorium.zip.
//
// Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = path.join(ROOT, 'vault', '.obsidian', 'plugins', 'lagrange');

// main.js requires Obsidian's modules; under Node they are stubs (every export is an empty class), which is enough
// for loading the file and testing everything that doesn't draw or edit.
function stubModule() {
  return new Proxy({}, {
    get(target, key) {
      if (!(key in target)) target[key] = class { static define() { return {}; } };
      return target[key];
    },
  });
}
const stubs = { obsidian: stubModule(), '@codemirror/state': stubModule(), '@codemirror/view': stubModule() };
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};
const Lagrange = require(path.join(PLUGIN, 'main.js'));
Module._load = realLoad;
const L = Lagrange.internals;

const LOREM = fs.readFileSync(path.join(ROOT, 'vault', 'Lorem Ipsum.md'), 'utf8');

/* ---------- helpers ---------- */

function sse(events) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function streamResponse(chunks, init, signal) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      if (signal) signal.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      else c.close();
    },
  });
  return new Response(body, Object.assign({ status: 200, headers: { 'content-type': 'text/event-stream' } }, init));
}

function jsonResponse(status, body, headers) {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({ 'content-type': 'application/json' }, headers) });
}

const ANTHROPIC_STREAM = sse([
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', model: 'claude-sonnet-5-5' } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['ping', { type: 'ping' }],
  ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Ink ' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'on “paper”.' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }],
  ['message_stop', { type: 'message_stop' }],
]);

function baseSettings(over) {
  return Object.assign({}, L.DEFAULT_SETTINGS, { anthropicApiKey: 'sk-ant-test' }, over);
}

/* ---------- SSE parsing ---------- */

test('SSE: events come out the same however the stream is cut', () => {
  const text = ANTHROPIC_STREAM + ': keep-alive comment\n\n';
  const whole = [];
  let p = L.createSSEParser(e => whole.push(e));
  p.push(text);
  p.end();
  assert.equal(whole.length, 11);
  assert.equal(whole[0].event, 'message_start');
  for (let cut = 1; cut < text.length; cut += 7) {
    const got = [];
    p = L.createSSEParser(e => got.push(e));
    p.push(text.slice(0, cut));
    p.push(text.slice(cut));
    p.end();
    assert.deepEqual(got, whole, `cut at ${cut}`);
  }
});

test('SSE: CRLF and CR line ends, split between the CR and the LF', () => {
  const text = 'event: a\r\ndata: 1\r\n\r\nevent: b\rdata: 2\r\rdata: x\r\ndata: y\r\n\r\n';
  const want = [{ event: 'a', data: '1' }, { event: 'b', data: '2' }, { event: 'message', data: 'x\ny' }];
  for (let cut = 1; cut < text.length; cut++) {
    const got = [];
    const p = L.createSSEParser(e => got.push(e));
    p.push(text.slice(0, cut));
    p.push(text.slice(cut));
    p.end();
    assert.deepEqual(got, want, `cut at ${cut}`);
  }
});

test('SSE: a last event without a blank line is flushed by end(); comments and unknown fields are ignored', () => {
  const got = [];
  const p = L.createSSEParser(e => got.push(e));
  p.push(':hello\nid: 7\nretry: 100\ndata:no space\ndata: [DONE]');
  p.end();
  assert.deepEqual(got, [{ event: 'message', data: 'no space\n[DONE]' }]);
});

/* ---------- Anthropic stream events ---------- */

test('Anthropic events: text is collected, thinking skipped, stop reason and model kept', () => {
  const st = { text: '', stopReason: null, stopDetails: null, model: null, fallbackTo: null };
  const deltas = [];
  const p = L.createSSEParser(ev => { const d = L.applyAnthropicEvent(st, ev); if (d) deltas.push(d); });
  p.push(ANTHROPIC_STREAM);
  p.end();
  assert.equal(st.text, 'Ink on “paper”.');
  assert.deepEqual(deltas, ['Ink ', 'on “paper”.']);
  assert.equal(st.stopReason, 'end_turn');
  assert.equal(st.model, 'claude-sonnet-5-5');
});

test('Anthropic events: a fallback block is noted and the reply carries on; refusal details are kept', () => {
  const st = { text: '', stopReason: null, stopDetails: null, model: null, fallbackTo: null };
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Part one, ' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-sonnet-5' } } },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'part two.' } },
    { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } },
  ];
  for (const e of events) L.applyAnthropicEvent(st, { event: e.type, data: JSON.stringify(e) });
  assert.equal(st.text, 'Part one, part two.');
  assert.equal(st.fallbackTo, 'claude-sonnet-5');
  assert.equal(st.stopReason, 'refusal');
  assert.equal(st.stopDetails.category, 'cyber');
});

test('Anthropic events: an error event throws a sentence for the writer', () => {
  const st = { text: '' };
  assert.throws(
    () => L.applyAnthropicEvent(st, { event: 'error', data: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }) }),
    e => e.name === 'LagrangeError' && /overloaded/i.test(e.message) && /529/.test(e.message));
});

/* ---------- Parsing edits ---------- */

test('parseEdits: a bare array', () => {
  const r = L.parseEdits('[{"find": "teh cat", "replace": "the cat", "reason": "spelling"}]');
  assert.equal(r.error, null);
  assert.deepEqual(r.edits, [{ find: 'teh cat', replace: 'the cat', reason: 'spelling' }]);
});

test('parseEdits: a fenced block with prose around it', () => {
  const r = L.parseEdits('Sure! Here are the fixes [2 of them]:\n\n```json\n[\n {"find": "a  b", "replace": "a b", "reason": "space"},\n' +
    ' {"find": "x", "replace": "y"}\n]\n```\nLet me know if you want more.');
  assert.equal(r.error, null);
  assert.equal(r.edits.length, 2);
  assert.equal(r.edits[1].reason, '');
});

test('parseEdits: prose with brackets and no fence; strings holding brackets, braces and escaped quotes', () => {
  const r = L.parseEdits('I checked [the note] {carefully}. Result: [{"find": "say \\"hi]\\" {x}", "replace": "say “hi]” {x}", "reason": "quotes"}] Done.');
  assert.equal(r.error, null);
  assert.deepEqual(r.edits, [{ find: 'say "hi]" {x}', replace: 'say “hi]” {x}', reason: 'quotes' }]);
});

test('parseEdits: an {"edits": [...]} object, other key names, and invalid items dropped', () => {
  const r = L.parseEdits('{"edits": [{"original": "colour", "replacement": "color", "why": "US"}, {"find": "", "replace": "x"}, {"find": "a"}, 7]}');
  assert.equal(r.error, null);
  assert.deepEqual(r.edits, [{ find: 'colour', replace: 'color', reason: 'US' }]);
  assert.equal(r.dropped, 3);
});

test('parseEdits: an empty list is "nothing to correct", not an error; junk is an error', () => {
  assert.deepEqual(L.parseEdits('```json\n[]\n```'), { edits: [], dropped: 0, error: null });
  assert.match(L.parseEdits('I could not find anything wrong.').error, /not a JSON list/);
  assert.match(L.parseEdits('[{"find": "unterminated').error, /not a JSON list/);
  assert.match(L.parseEdits('').error, /empty/);
});

/* ---------- Locating edits ---------- */

test('findAll counts overlapping occurrences', () => {
  assert.deepEqual(L.findAll('aaa', 'aa'), [[0, 2], [1, 3]]);
  assert.deepEqual(L.findAll('abc', ''), []);
});

test('locateEdits: found, not found, ambiguous, overlapping, no-op; kept edits sorted', () => {
  const doc = 'The cat sat. The dog sat. A bird flew over the house.';
  const { located, skipped } = L.locateEdits(doc, [
    { find: 'bird flew', replace: 'bird soared', reason: 'b' },
    { find: 'The cat', replace: 'The kitten', reason: 'a' },
    { find: 'sat', replace: 'stood', reason: 'ambiguous' },
    { find: 'zebra', replace: 'horse', reason: 'missing' },
    { find: 'cat sat', replace: 'cat stood', reason: 'overlaps' },
    { find: 'house', replace: 'house', reason: 'no-op' },
  ]);
  assert.deepEqual(located.map(e => [e.from, e.to, e.matched]), [[0, 7, 'The cat'], [28, 37, 'bird flew']]);
  assert.deepEqual(skipped.map(e => [e.reason, e.why]), [
    ['ambiguous', 'appears 2 times'], ['missing', 'not found in the note'], ['overlaps', 'overlaps another edit'], ['no-op', 'no change'],
  ]);
});

test('locateEdits: the loose search forgives quotes, dashes, ellipses and spacing', () => {
  const doc = 'She said “wait…” — and then,\nquietly, left.';
  const { located, skipped } = L.locateEdits(doc, [
    { find: 'said "wait..." - and', replace: 'said “wait” — and', reason: 'r' },
    { find: 'then, quietly,', replace: 'then quietly,', reason: 'r' },
  ]);
  assert.equal(skipped.length, 0);
  assert.equal(located[0].matched, 'said “wait…” — and');
  assert.equal(located[1].matched, 'then,\nquietly,');
});

test('looseFindAll treats regex characters literally', () => {
  assert.deepEqual(L.looseFindAll('cost (est.) $5+ [x]', '(est.) $5+ [x]'), [[5, 19]]);
});

/* ---------- Clipping notes, cleaning revisions ---------- */

test('clipText: short text unchanged; long text cut around the focus at line ends, with markers', () => {
  assert.deepEqual(L.clipText('short', 100), { text: 'short', clipped: false, start: 0, end: 5, total: 5 });
  const lines = Array.from({ length: 200 }, (_, i) => `line ${String(i).padStart(3, '0')}`).join('\n');
  const c = L.clipText(lines, 300, lines.indexOf('line 100'));
  assert.equal(c.clipped, true);
  assert.ok(c.end - c.start <= 300);
  assert.ok(c.text.includes('line 100'));
  assert.match(c.text, /^\[… the first \d+ characters are not shown …\]\nline \d{3}/);
  assert.match(c.text, /line \d{3}\n\[… the last \d+ characters are not shown …\]$/);
  const head = L.clipText(lines, 300);
  assert.equal(head.start, 0);
  assert.ok(head.text.startsWith('line 000'));
});

test('cleanRevision: unwraps fences, tags and quotes; keeps the passage’s own outer white space', () => {
  assert.equal(L.cleanRevision('```markdown\nA better line.\n```', 'A line.\n'), 'A better line.\n');
  assert.equal(L.cleanRevision('<passage>\nShorter.\n</passage>', '  Long text. '), '  Shorter. ');
  assert.equal(L.cleanRevision('“Quoted reply.”', 'Plain.'), 'Quoted reply.');
  assert.equal(L.cleanRevision('"Keep" these "quotes"', 'x'), '"Keep" these "quotes"');
  assert.equal(L.cleanRevision('“Quoted.”', '“Already quoted.”'), '“Quoted.”');
  assert.equal(L.cleanRevision('   ', 'x'), null);
});

/* ---------- Errors ---------- */

test('parseErrorBody and describeError give a clear sentence for each kind of failure', () => {
  const body = JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  assert.deepEqual(L.parseErrorBody(body), { type: 'authentication_error', message: 'invalid x-api-key' });
  assert.deepEqual(L.parseErrorBody('{"error":"model \'llama9\' not found"}'), { type: null, message: "model 'llama9' not found" });
  assert.deepEqual(L.parseErrorBody('<html>Bad gateway</html>'), { type: null, message: null });
  const d = o => L.describeError(Object.assign({ provider: 'anthropic', model: 'claude-x' }, o));
  assert.match(d({ status: 401 }), /did not accept the API key \(401\).*Settings → Lagrange/);
  assert.match(d({ status: 404 }), /“claude-x” was not found.*\(404\)/);
  assert.match(d({ status: 429, retryAfter: 12 }), /Rate limited \(429\): try again in 12 seconds/);
  assert.match(d({ status: 529 }), /overloaded.*\(529\)/);
  assert.match(d({ status: 500 }), /internal error \(500\)/);
  assert.match(d({ status: 400, message: 'messages: roles must alternate.' }), /\(400\): messages: roles must alternate\.$/);
  assert.match(L.describeError({ provider: 'openai', status: 404, message: 'model not found' }), /Check the base URL and the model name/);
});

/* ---------- The Anthropic provider, end to end with a fake fetch ---------- */

test('Anthropic: request shape, headers and streamed text', async () => {
  let seen;
  const pieces = [];
  const res = await L.streamAnthropic(baseSettings(), { system: 'SYS', messages: [{ role: 'user', content: 'Hi' }], cache: true }, {
    fetch: async (url, init) => { seen = { url, init }; return streamResponse([ANTHROPIC_STREAM.slice(0, 333), ANTHROPIC_STREAM.slice(333)]); },
    onText: d => pieces.push(d),
  }, {});
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  const h = seen.init.headers;
  assert.equal(h['x-api-key'], 'sk-ant-test');
  assert.equal(h['anthropic-version'], '2026-10-21');
  assert.equal(h['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(h['anthropic-beta'], 'server-side-fallback-2026-07-01');
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(Object.keys(body).sort(), ['cache_control', 'fallbacks', 'max_tokens', 'messages', 'model', 'stream', 'system']);
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.max_tokens, 64000);
  assert.equal(body.stream, true);
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(body.cache_control, { type: 'ephemeral' });
  assert.equal(res.text, 'Ink on “paper”.');
  assert.equal(pieces.join(''), res.text);
  assert.equal(res.stopReason, 'end_turn');
});

test('Anthropic: Haiku and custom models get no fallbacks; custom models a smaller max_tokens', async () => {
  for (const [over, maxTokens] of [[{ anthropicModel: 'claude-haiku-5-5' }, 64000], [{ anthropicModel: 'custom', anthropicCustomModel: 'claude-x-1' }, 8192]]) {
    let seen;
    await L.streamAnthropic(baseSettings(over), { system: 's', messages: [] }, {
      fetch: async (url, init) => { seen = init; return streamResponse([ANTHROPIC_STREAM]); },
    }, {});
    const body = JSON.parse(seen.body);
    assert.equal(body.fallbacks, undefined);
    assert.equal(seen.headers['anthropic-beta'], undefined);
    assert.equal(body.max_tokens, maxTokens);
  }
});

test('Anthropic: an account without the fallback beta is retried without it, once per session', async () => {
  const session = {};
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(init);
    if (init.headers['anthropic-beta']) {
      return jsonResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.' } });
    }
    return streamResponse([ANTHROPIC_STREAM]);
  };
  const res = await L.streamAnthropic(baseSettings(), { system: 's', messages: [] }, { fetch }, session);
  assert.equal(res.text, 'Ink on “paper”.');
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1].body).fallbacks, undefined);
  assert.equal(session.noFallback, true);
  await L.streamAnthropic(baseSettings(), { system: 's', messages: [] }, { fetch }, session);
  assert.equal(calls.length, 3, 'the next request goes straight without the beta');
});

test('Anthropic: overloaded (529) is retried, then succeeds', async () => {
  let n = 0;
  const retries = [];
  const res = await L.streamAnthropic(baseSettings(), { system: 's', messages: [] }, {
    fetch: async () => (++n === 1 ? jsonResponse(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }) : streamResponse([ANTHROPIC_STREAM])),
    retryDelays: [1, 1],
    onRetry: (status, ms) => retries.push([status, ms]),
  }, {});
  assert.equal(res.text, 'Ink on “paper”.');
  assert.deepEqual(retries, [[529, 1]]);
});

test('Anthropic: errors become sentences (no key, bad key, rate limit, network, mid-stream error)', async () => {
  const req = { system: 's', messages: [] };
  await assert.rejects(L.streamAnthropic(baseSettings({ anthropicApiKey: '' }), req, {}, {}), e => e.kind === 'setup' && /API key/.test(e.message));
  await assert.rejects(
    L.streamAnthropic(baseSettings(), req, { fetch: async () => jsonResponse(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) }, {}),
    e => e.status === 401 && /\(401\)/.test(e.message));
  await assert.rejects(
    L.streamAnthropic(baseSettings(), req, { fetch: async () => jsonResponse(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { 'retry-after': '60' }) }, {}),
    e => e.status === 429 && /try again in 60 seconds/.test(e.message));
  await assert.rejects(
    L.streamAnthropic(baseSettings(), req, { fetch: async () => { throw new TypeError('Failed to fetch'); } }, {}),
    e => e.kind === 'network' && /api\.anthropic\.com/.test(e.message));
  const broken = sse([
    ['message_start', { type: 'message_start', message: { model: 'claude-sonnet-5-5' } }],
    ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
  ]);
  await assert.rejects(L.streamAnthropic(baseSettings(), req, { fetch: async () => streamResponse([broken]) }, {}), /overloaded/i);
});

test('Anthropic: stopping mid-reply rejects with an AbortError', async () => {
  const controller = new AbortController();
  const first = ANTHROPIC_STREAM.slice(0, ANTHROPIC_STREAM.indexOf('on “paper”'));
  const p = L.streamAnthropic(baseSettings(), { system: 's', messages: [] }, {
    signal: controller.signal,
    fetch: async (url, init) => streamResponse([first], undefined, init.signal),
    onText: () => controller.abort(),
  }, {});
  await assert.rejects(p, e => e.name === 'AbortError');
});

/* ---------- The OpenAI-compatible provider ---------- */

test('OpenAI-compatible: streamed chunks, [DONE], key header and system message', async () => {
  let seen;
  const chunks = [
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Quill "}}]}\n\ndata: {"choices":[{"delta":{"content":"and ink."},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const s = baseSettings({ provider: 'openai', openaiBaseUrl: 'http://localhost:11434/v1/', openaiModel: 'llama3.1', openaiApiKey: 'k' });
  const res = await L.streamOpenAI(s, { system: 'SYS', messages: [{ role: 'user', content: 'Hi' }] }, {
    fetch: async (url, init) => { seen = { url, init }; return streamResponse(chunks); },
  });
  assert.equal(seen.url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(seen.init.headers.authorization, 'Bearer k');
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'Hi' }]);
  assert.equal(body.stream, true);
  assert.equal(res.text, 'Quill and ink.');
  assert.equal(res.stopReason, 'stop');
});

test('OpenAI-compatible: a non-streamed JSON answer, an error body, missing settings, an unreachable server', async () => {
  const s = baseSettings({ provider: 'openai', openaiModel: 'm' });
  const res = await L.streamOpenAI(s, { system: 's', messages: [] }, {
    fetch: async () => jsonResponse(200, { choices: [{ message: { content: 'Whole answer.' }, finish_reason: 'length' }] }),
  });
  assert.equal(res.text, 'Whole answer.');
  assert.equal(res.stopReason, 'max_tokens');
  await assert.rejects(L.streamOpenAI(s, { system: 's', messages: [] }, { fetch: async () => jsonResponse(404, { error: "model 'm' not found" }) }),
    /404.*model 'm' not found/);
  await assert.rejects(L.streamOpenAI(baseSettings({ provider: 'openai' }), { system: 's', messages: [] }, {}), e => e.kind === 'setup');
  await assert.rejects(L.streamOpenAI(s, { system: 's', messages: [] }, { fetch: async () => { throw new TypeError('fetch failed'); } }),
    e => e.kind === 'network' && /localhost:11434/.test(e.message) && /CORS/.test(e.message));
});

/* ---------- Demo mode ---------- */

test('Demo: the stream gives back exactly the canned text', async () => {
  const text = 'One two  three,\nfour.  ';
  let last = '';
  const res = await L.streamDemo({ purpose: 'revise', demo: () => text }, { onText: (d, full) => { last = full; } });
  assert.equal(res.text, text);
  assert.equal(last, text);
});

test('Demo: proofreading the Lorem Ipsum sample gives edits that all locate exactly once', () => {
  const edits = L.demoProofreadEdits(LOREM);
  assert.ok(edits.length >= 2, `got ${edits.length}`);
  const reply = 'Here are the corrections I would make:\n\n```json\n' + JSON.stringify(edits, null, 2) + '\n```\n';
  const parsed = L.parseEdits(reply);
  assert.equal(parsed.error, null);
  const { located, skipped } = L.locateEdits(LOREM, parsed.edits);
  assert.equal(skipped.length, 0);
  assert.equal(located.length, edits.length);
  let out = LOREM;
  for (const e of located.slice().reverse()) out = out.slice(0, e.from) + e.replace + out.slice(e.to);
  assert.notEqual(out, LOREM);
  assert.ok(out.includes('erat ante venenatis'));
});

test('Demo: typographic slips in any note, never inside code', () => {
  const doc = 'He said "yes" - twice...  It\'s the the end.\n\n`"code"` stays.';
  const edits = L.demoProofreadEdits(doc);
  const { located, skipped } = L.locateEdits(doc, edits);
  assert.equal(skipped.length, 0);
  let out = doc;
  for (const e of located.slice().reverse()) out = out.slice(0, e.from) + e.replace + out.slice(e.to);
  assert.equal(out, 'He said “yes”—twice… It’s the end.\n\n`"code"` stays.');
});

test('Demo: revisions follow the instruction', () => {
  assert.equal(L.demoRevise('One. Two. Three. Four.', 'make it shorter'), 'One. Two.');
  assert.equal(L.demoRevise('the art of the page', 'title case'), 'The Art of the Page');
  assert.equal(L.demoRevise('quiet', 'in capitals'), 'QUIET');
  assert.notEqual(L.demoRevise('First. Second.', 'anything'), 'First. Second.');
  assert.match(L.demoChatReply('What is this?', { title: 'Lorem Ipsum', text: LOREM }), /\*\*Lorem Ipsum\*\*: \d+ words/);
});

/* ---------- Settings and the shipped files ---------- */

test('Settings: junk is replaced by defaults; the shipped data.json is the defaults, with no key', () => {
  const s = L.sanitizeSettings({ provider: 'gpt', penSpeed: 99, loaderTheme: 'steam', anthropicModel: 'claude-2', showPen: 'yes' });
  assert.equal(s.provider, 'anthropic');
  assert.equal(s.penSpeed, 1);
  assert.equal(s.loaderTheme, 'clockwork');
  assert.equal(s.anthropicModel, 'claude-sonnet-5-5');
  assert.equal(s.showPen, true);
  const shipped = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'data.json'), 'utf8'));
  assert.deepEqual(shipped, L.DEFAULT_SETTINGS);
  for (const [k, v] of Object.entries(shipped)) if (/key/i.test(k)) assert.equal(v, '', `${k} must ship empty`);
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, 'lagrange');
  assert.equal(manifest.isDesktopOnly, false);
  const enabled = JSON.parse(fs.readFileSync(path.join(ROOT, 'vault', '.obsidian', 'community-plugins.json'), 'utf8'));
  assert.ok(enabled.includes('lagrange'));
});

test('The replaceable sections are delimited once each, and their functions are exported', () => {
  const js = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8');
  const css = fs.readFileSync(path.join(PLUGIN, 'styles.css'), 'utf8');
  for (const name of ['LOADER', 'PEN']) {
    for (const text of [js, css]) {
      assert.equal(text.split(`==== LAGRANGE ${name} (replaceable) ====`).length, 2, name);
      assert.equal(text.split(`==== END LAGRANGE ${name} ====`).length, 2, name);
    }
  }
  assert.equal(typeof Lagrange.mountLoader, 'function');
  assert.equal(Lagrange.mountLoader.length, 2);
  assert.equal(typeof Lagrange.createPen, 'function');
  assert.equal(Lagrange.createPen.length, 2);
  assert.equal(typeof Lagrange.rangeRects, 'function');
  assert.equal(Lagrange.rangeRects.length, 3);
  assert.doesNotMatch(js, /require\((['"])(fs|path|child_process|electron|http|https|os)\1\)/, 'no Node or Electron modules');
  assert.doesNotMatch(js, /\b(temperature|top_p|top_k)\b/, 'no sampling parameters (rejected on API version 2026-10-21)');
});
