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
  return Object.assign({}, L.DEFAULT_SETTINGS, { provider: 'anthropic', anthropicApiKey: 'sk-ant-test' }, over);
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

test('Demo: Markdown syntax is never changed (link titles, wikilinks, HTML, math, URLs, tables)', () => {
  const doc = [
    'A figure ![A second figure|300](fig.png "The fleuron figure") and a [link](https://x.org/a--b "Its title").',
    'An embed ![[plate "one".png]], a tag <span title="x">here</span>, math $a--b$ and https://x.org/c--d too.',
    '| col  | "q" |',
    '| --- | --- |',
    '',
    'Outside, "quoted" prose -- fixed.',
  ].join('\n');
  const edits = L.demoProofreadEdits(doc);
  const { located, skipped } = L.locateEdits(doc, edits);
  assert.equal(skipped.length, 0);
  let out = doc;
  for (const e of located.slice().reverse()) out = out.slice(0, e.from) + e.replace + out.slice(e.to);
  const lines = out.split('\n');
  assert.deepEqual(lines.slice(0, 5), doc.split('\n').slice(0, 5));
  assert.equal(lines[5], 'Outside, “quoted” prose -- fixed.');
});

test('Demo: revisions follow the instruction', () => {
  assert.equal(L.demoRevise('One. Two. Three. Four.', 'make it shorter'), 'One. Two.');
  assert.equal(L.demoRevise('the art of the page', 'title case'), 'The Art of the Page');
  assert.equal(L.demoRevise('quiet', 'in capitals'), 'QUIET');
  assert.notEqual(L.demoRevise('First. Second.', 'anything'), 'First. Second.');
  assert.match(L.demoChatReply('What is this?', { title: 'Lorem Ipsum', text: LOREM }), /\*\*Lorem Ipsum\*\*: \d+ words/);
});

test('Demo: a chat message that asks for a change gets edits the pen can make; a question gets none', () => {
  const note = { title: 'Lorem Ipsum', text: LOREM };
  assert.deepEqual(L.parseAgentReply(L.demoChatReply('What is this?', note, true)).ops, []);
  assert.deepEqual(L.parseAgentReply(L.demoChatReply('fix the typography', note, false)).ops, [], 'not when the chat only talks');
  const fix = L.parseAgentReply(L.demoChatReply('Please fix the typography', note, true));
  assert.equal(fix.error, null);
  assert.ok(fix.ops.length >= 3);
  assert.doesNotMatch(fix.text, /lagrange-edits|"find"/);
  const { located, skipped } = L.locateOps(LOREM, fix.ops);
  assert.equal(located.length, fix.ops.length);
  assert.equal(skipped.length, 0);
  const eq = L.parseAgentReply(L.demoChatReply('add an equation', note, true));
  assert.equal(eq.ops.length, 1);
  assert.equal(eq.ops[0].op, 'append');
  assert.ok(L.hasMath(eq.ops[0].text));
  assert.match(eq.ops[0].text, /\$\$\\frac\{d\}\{dt\}/);
});

/* ---------- Settings and the shipped files ---------- */

test('Defaults: a Claude subscription is the provider, the chat edits with the pen, and the trail is on', () => {
  const d = L.DEFAULT_SETTINGS;
  assert.equal(d.provider, 'claude-code');
  assert.equal(d.claudeCodeModel, 'sonnet');
  assert.equal(d.agenticEdits, true);
  assert.equal(d.penTrail, true);
  assert.equal(d.effort, '');
  assert.equal(L.sanitizeSettings(null).provider, 'claude-code');
  assert.equal(L.sanitizeSettings({}).provider, 'claude-code');
  // A vault that chose a provider keeps it.
  for (const p of ['anthropic', 'codex', 'openai-api', 'openai', 'demo']) assert.equal(L.sanitizeSettings({ provider: p }).provider, p);
  assert.equal(L.footLabel(d), 'Claude (subscription, sonnet)');
  // On a phone the subscription can't run: the plugin says so (and the file loads no Node module at the top level).
  const js = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8');
  assert.match(js, /On a phone or tablet, choose an API key provider \(or the Demo\)/);
});

test('The trebuchet is gone: no plate, no caption, no setting; a saved "trebuchet" becomes "random"', () => {
  assert.deepEqual(L.LOADER_THEMES, ['cycle', 'clockwork', 'alchemy', 'orbit']);
  assert.deepEqual(Object.keys(L.LOADER_CAPTIONS).sort(), ['alchemy', 'clockwork', 'orbit']);
  assert.equal(L.sanitizeSettings({ loaderTheme: 'trebuchet' }).loaderTheme, 'cycle');
  const kept = L.sanitizeSettings({ loaderTheme: 'trebuchet', provider: 'demo', penSpeed: 2 });
  assert.equal(kept.provider, 'demo', 'the rest of the saved settings are kept');
  assert.equal(kept.penSpeed, 2);
  const js = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8');
  const css = fs.readFileSync(path.join(PLUGIN, 'styles.css'), 'utf8');
  // The word survives only in the comment on the fallback.
  assert.deepEqual(js.split('\n').filter(l => /trebuchet/i.test(l)).map(l => l.trim()),
    ["// A plate that no longer exists (a saved 'trebuchet', from 0.1), and the 'random' of before 0.5.2, fall back to 'cycle'."]);
  assert.doesNotMatch(css, /trebuchet/i);
  assert.doesNotMatch(js, /taking aim|\bsling\b/i);
  for (const f of ['README.md', 'THIRD_PARTY.md']) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /trebuchet/i, f);
});

test('The pen’s handwriting is bundled in the styles (no network font), with its licence next to it', () => {
  const css = fs.readFileSync(path.join(PLUGIN, 'styles.css'), 'utf8');
  const faces = css.match(/@font-face\s*\{[^}]*\}/g) || [];
  assert.equal(faces.length, 1);
  assert.match(faces[0], /font-family: "Lagrange Hand"/);
  assert.match(faces[0], /src: url\(data:font\/woff2;base64,[A-Za-z0-9+/=]{20000,}\) format\("woff2"\)/);
  assert.doesNotMatch(css, /url\(\s*["']?https?:/i, 'nothing is fetched');
  assert.match(css, /--lagrange-hand: "Lagrange Hand",/);
  assert.match(css, /\.lagrange-loader-caption \{[^}]*font-family: var\(--lagrange-hand\)/);
  assert.match(css, /\.lagrange-pen-hand \{[^}]*font-family: var\(--lagrange-hand\)/);
  const ofl = fs.readFileSync(path.join(PLUGIN, 'LagrangeHand-OFL.txt'), 'utf8');
  assert.match(ofl, /Kimberly Geswein/);
  assert.match(ofl, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(fs.readFileSync(path.join(ROOT, 'THIRD_PARTY.md'), 'utf8'), /La Belle Aurore/);
});

test('Light theme: the panel takes the site’s paper, ink and accent, whatever the vault’s theme', () => {
  const css = fs.readFileSync(path.join(PLUGIN, 'styles.css'), 'utf8');
  const light = css.match(/\nbody \{[^}]*\}/)[0];
  for (const [name, value] of [['paper', '#f7f2e7'], ['ink', '#2a2420'], ['muted', '#595959'], ['faint', '#9e9e9e'], ['rule', '#e6e6e6'],
    ['rubric', '#8b2323'], ['rubric-deep', '#7d2219'], ['wash', '#fcf5e4']]) {
    assert.match(light, new RegExp(`--lagrange-${name}: ${value};`), name);
  }
  const dark = css.match(/\nbody\.theme-dark \{[^}]*\}/)[0];
  assert.match(dark, /--lagrange-paper: var\(--background-primary\);/);
  assert.match(dark, /--lagrange-ink: var\(--text-normal\);/);
  assert.match(css, /\.lagrange-view \{[^}]*background: var\(--lagrange-paper\);[^}]*color: var\(--lagrange-ink\);/);
});

test('Settings: junk is replaced by defaults; the shipped data.json is the defaults, with no key', () => {
  const s = L.sanitizeSettings({ provider: 'gpt', penSpeed: 99, loaderTheme: 'steam', anthropicModel: 'claude-2', showPen: 'yes' });
  assert.equal(s.provider, 'claude-code');
  assert.equal(s.penSpeed, 1);
  assert.equal(s.loaderTheme, 'cycle');
  for (const t of ['clockwork', 'alchemy', 'orbit', 'cycle']) assert.equal(L.sanitizeSettings({ loaderTheme: t }).loaderTheme, t);
  assert.equal(L.sanitizeSettings({ effort: 'extreme' }).effort, '');
  for (const e of ['', 'low', 'medium', 'high']) assert.equal(L.sanitizeSettings({ effort: e }).effort, e);
  assert.equal(L.sanitizeSettings({ agenticEdits: false, penTrail: false }).agenticEdits, false);
  assert.equal(L.sanitizeSettings({ agenticEdits: 'no' }).agenticEdits, true);
  assert.equal(s.anthropicModel, 'claude-sonnet-5-5');
  assert.equal(s.showPen, true);
  const shipped = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'data.json'), 'utf8'));
  assert.deepEqual(shipped, L.DEFAULT_SETTINGS);
  for (const [k, v] of Object.entries(shipped)) if (/key/i.test(k)) assert.equal(v, '', `${k} must ship empty`);
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, 'lagrange');
  assert.equal(manifest.isDesktopOnly, false);
  assert.match(manifest.version, /^0\.[2-9]\.\d+$/);
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
  assert.doesNotMatch(js, /require\((['"])(fs|path|child_process|electron|http|https|os)\1\)/, 'no Node or Electron modules loaded at the top level');
  // Node modules come only through nodeModule(), which refuses on mobile, and only the four the CLI providers need.
  const loaded = [...js.matchAll(/nodeModule\((['"])([^'"]+)\1\)/g)].map(m => m[2]);
  assert.ok(loaded.length > 0);
  for (const m of loaded) assert.ok(['child_process', 'fs', 'os', 'path'].includes(m), `unexpected Node module ${m}`);
  assert.doesNotMatch(js, /\b(temperature|top_p|top_k)\b/, 'no sampling parameters (rejected on API version 2026-10-21)');
});


// ---------------------------------------------------------------- subscriptions through Claude Code and Codex
test('Claude Code stream-json: text deltas stream; the result line closes; an error result is caught', () => {
  const st = { text: '', streamed: false, stopReason: null, model: null, error: null, done: false };
  const lines = [
    '{"type":"system","subtype":"init","model":"claude-sonnet-5-5"}',
    '{"type":"stream_event","event":{"type":"message_start"}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ink "}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"and paper"}}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"ink and paper"}]}}',
    '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"}}}',
    'not json',
    '{"type":"result","subtype":"success","is_error":false,"result":"ink and paper"}',
  ];
  const got = lines.map(l => L.applyClaudeCodeLine(st, l)).join('');
  assert.equal(got, 'ink and paper');
  assert.equal(st.text, 'ink and paper');
  assert.equal(st.model, 'claude-sonnet-5-5');
  assert.equal(st.stopReason, 'end_turn');
  assert.ok(st.done);
  const bad = { text: '', streamed: false };
  L.applyClaudeCodeLine(bad, '{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}');
  assert.match(L.cliErrorMessage('claude', bad.error), /isn’t signed in/);
  const whole = { text: '', streamed: false };   // without partial messages, the assistant message carries the text
  assert.equal(L.applyClaudeCodeLine(whole, '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}'), 'hello');
});

test('Codex JSONL: agent messages are the reply; errors and failed turns are caught; the older event shape works', () => {
  const st = { text: '', error: null, done: false };
  for (const l of ['{"type":"thread.started","thread_id":"x"}', '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"thinking"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"ink and paper."}}',
    '{"type":"turn.completed","usage":{}}']) L.applyCodexLine(st, l);
  assert.equal(st.text, 'ink and paper.');
  assert.ok(st.done);
  const e1 = { text: '' }; L.applyCodexLine(e1, '{"type":"turn.failed","error":{"message":"You are not logged in"}}');
  assert.match(L.cliErrorMessage('codex', e1.error), /codex login/);
  const e2 = { text: '' }; L.applyCodexLine(e2, '{"type":"error","message":"usage limit reached for your plan"}');
  assert.match(L.cliErrorMessage('codex', e2.error), /usage limit/);
  const old = { text: '' }; L.applyCodexLine(old, '{"id":"0","msg":{"type":"agent_message","message":"older shape"}}');
  assert.equal(old.text, 'older shape');
});

test('transcriptPrompt: one message passes through; a conversation becomes a short transcript', () => {
  assert.equal(L.transcriptPrompt([{ role: 'user', content: 'Hello' }]), 'Hello');
  const t = L.transcriptPrompt([{ role: 'user', content: 'A' }, { role: 'assistant', content: 'B' }, { role: 'user', content: 'C' }]);
  assert.match(t, /Writer: A\n\nLagrange: B/);
  assert.match(t, /The writer now says:\n\nC$/);
});

// Fake command-line tools: small Node scripts that print the event streams the real tools print, so the subprocess
// path (spawn, stdin, line splitting, errors, stop) is tested without an account. POSIX only (they use a shebang).
const posix = process.platform !== 'win32';
function fakeCli(dir, name, body) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return f;
}
test('Claude subscription: Lagrange runs Claude Code with tools, settings and sessions off, and streams its reply', { skip: !posix }, async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lagrange-cli-'));
  const exe = fakeCli(dir, 'claude', `
let input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
  const a = process.argv.slice(2), sys = require('fs').readFileSync(a[a.indexOf('--system-prompt-file') + 1], 'utf8');
  const ok = a.includes('-p') && a[a.indexOf('--tools') + 1] === '' && a.includes('--no-session-persistence')
    && a[a.indexOf('--setting-sources') + 1] === '' && a.includes('--strict-mcp-config') && a[a.indexOf('--model') + 1] === 'haiku';
  const say = t => console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } }));
  say(ok ? 'flags ok; ' : 'flags WRONG ' + JSON.stringify(a) + '; '); say('system: ' + sys + '; '); say('prompt: ' + input);
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'x' }));
});`);
  const pieces = [];
  const res = await L.streamClaudeCode({ claudeCodePath: exe, claudeCodeModel: 'haiku' },
    { system: 'Be brief.', messages: [{ role: 'user', content: 'Hello' }] }, { onText: d => pieces.push(d) });
  assert.equal(res.text, 'flags ok; system: Be brief.; prompt: Hello');
  assert.equal(pieces.length, 3);
  const notSigned = fakeCli(dir, 'claude2', `process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ type: 'result', is_error: true, result: 'Invalid API key · Please run /login' })));`);
  await assert.rejects(L.streamClaudeCode({ claudeCodePath: notSigned }, { system: '', messages: [{ role: 'user', content: 'x' }] }, {}), /isn’t signed in/);
  await assert.rejects(L.streamClaudeCode({ claudeCodePath: path.join(dir, 'missing') }, { system: '', messages: [] }, {}), /wasn’t found/);
  const slow = fakeCli(dir, 'claude3', `setInterval(() => {}, 1000);`);
  const ac = new AbortController(); setTimeout(() => ac.abort(), 150);
  await assert.rejects(L.streamClaudeCode({ claudeCodePath: slow }, { system: '', messages: [{ role: 'user', content: 'x' }] }, { signal: ac.signal }), e => e.name === 'AbortError');
  fs.rmSync(dir, { recursive: true, force: true });
});
test('ChatGPT subscription: Lagrange runs Codex read-only and ephemeral, and reads its agent message', { skip: !posix }, async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lagrange-cli-'));
  const exe = fakeCli(dir, 'codex', `
let input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
  const a = process.argv.slice(2);
  const ok = a[0] === 'exec' && a.includes('--json') && a.includes('--ephemeral') && a[a.indexOf('-s') + 1] === 'read-only' && a[a.length - 1] === '-';
  console.log(JSON.stringify({ type: 'thread.started' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: (ok ? 'flags ok' : 'flags WRONG') + (input.includes('<instructions>') && input.includes('Hello') ? '; prompt ok' : '; prompt WRONG') } }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
});`);
  const res = await L.streamCodex({ codexPath: exe, codexModel: '' }, { system: 'Be brief.', messages: [{ role: 'user', content: 'Hello' }] }, {});
  assert.equal(res.text, 'flags ok; prompt ok');
  fs.rmSync(dir, { recursive: true, force: true });
});
test('complete() routes the new providers; an OpenAI key and model are required', async () => {
  await assert.rejects(L.complete(Object.assign({}, L.DEFAULT_SETTINGS, { provider: 'openai-api' }), { system: '', messages: [] }, {}), /OpenAI API key/);
  await assert.rejects(L.complete(Object.assign({}, L.DEFAULT_SETTINGS, { provider: 'openai-api', openaiPlatformKey: 'sk-x' }), { system: '', messages: [] }, {}), /model ID/);
  for (const p of ['claude-code', 'codex', 'openai-api']) assert.equal(L.sanitizeSettings({ provider: p }).provider, p);
});

// Live, only when asked (LAGRANGE_LIVE_CLI=1): the real tools, signed in to real accounts. Uses a little of the plan.
test('live: the real Claude Code and Codex answer through Lagrange', { skip: process.env.LAGRANGE_LIVE_CLI !== '1' }, async () => {
  const req = { system: 'You are terse.', messages: [{ role: 'user', content: 'Reply with exactly: ink and paper' }] };
  const c = await L.streamClaudeCode({ claudeCodePath: '', claudeCodeModel: 'haiku' }, req, {});
  assert.match(c.text.toLowerCase(), /ink and paper/);
  const x = await L.streamCodex({ codexPath: '', codexModel: '' }, req, {});
  assert.match(x.text.toLowerCase(), /ink and paper/);
});


// ---------------------------------------------------------------- edits in a chat reply (the agentic chat)
const FENCE = '```';
test('Chat reply: a plain answer has no edits and is shown whole', () => {
  for (const text of ['It is a note about tides.', 'Use a list:\n\n- one\n- two\n\n```js\nconst a = [1];\n```\nDone.', 'Brackets [1] and {braces} in prose.', '']) {
    const r = L.parseAgentReply(text);
    assert.deepEqual(r.ops, []);
    assert.equal(r.error, null);
    assert.equal(r.open, false);
    assert.equal(r.text, text.trim());
  }
});

test('Chat reply: the edits block is taken out of the prose and parsed (fence, tildes, tags; three kinds of edit)', () => {
  const block = '[{"find": "teh", "replace": "the", "reason": "spelling"},\n {"insert_after": "End.", "text": " More."},\n {"append": "Last line."}]';
  const expected = [
    { op: 'replace', find: 'teh', replace: 'the', reason: 'spelling' },
    { op: 'insert', after: 'End.', text: ' More.', reason: '' },
    { op: 'append', text: 'Last line.', reason: '' },
  ];
  for (const reply of [
    `I fixed the spelling and added two lines.\n\n${FENCE}lagrange-edits\n${block}\n${FENCE}`,
    `I fixed the spelling and added two lines.\n\n${FENCE} lagrange-edits\n${block}\n${FENCE}\n`,
    `I fixed the spelling and added two lines.\n~~~lagrange-edits\n${block}\n~~~`,
    `I fixed the spelling and added two lines.\n\n<lagrange-edits>\n${block}\n</lagrange-edits>`,
    `I fixed the spelling and added two lines.\n\n${FENCE}${FENCE[0]}lagrange-edits\n{"edits": ${block}}\n${FENCE}${FENCE[0]}`,
  ]) {
    const r = L.parseAgentReply(reply);
    assert.equal(r.text, 'I fixed the spelling and added two lines.');
    assert.deepEqual(r.ops, expected);
    assert.equal(r.error, null);
    assert.equal(r.dropped, 0);
    assert.equal(r.open, false);
  }
  // Only the block: no prose at all. Prose after the block is kept. LaTeX survives JSON escaping.
  assert.equal(L.parseAgentReply(`${FENCE}lagrange-edits\n[]\n${FENCE}`).text, '');
  const after = L.parseAgentReply(`Before.\n\n${FENCE}lagrange-edits\n[{"append": "$\\\\frac{a}{b}$"}]\n${FENCE}\n\nAfter.`);
  assert.equal(after.text, 'Before.\n\nAfter.');
  assert.equal(after.ops[0].text, '$\\frac{a}{b}$');
  // other key names, a deletion, insert_before, and items that are not edits
  const odd = L.parseAgentReply(`${FENCE}lagrange-edits\n[{"original": "a b", "replacement": ""}, {"insert_before": "X", "text": "Y", "reason": " why "}, {"find": 3}, "junk", {"append": ""}]\n${FENCE}`);
  assert.deepEqual(odd.ops, [{ op: 'replace', find: 'a b', replace: '', reason: '' }, { op: 'insert', before: 'X', text: 'Y', reason: 'why' }]);
  assert.equal(odd.dropped, 3);
  // An ordinary code block that merely mentions the word is not an edits block.
  assert.deepEqual(L.parseAgentReply(`${FENCE}json\n["lagrange-edits"]\n${FENCE}`).ops, []);
});

test('Chat reply: while it streams, and when it is cut off or malformed, the block never shows and nothing is edited', () => {
  const full = `Fixing it.\n\n${FENCE}lagrange-edits\n[{"find": "teh", "replace": "the"}]\n${FENCE}`;
  for (let i = 0; i <= full.length; i++) {
    const part = L.splitAgentReply(full.slice(0, i));
    assert.doesNotMatch(part.text, /"find"|\[\{/, `at ${i}`);
    assert.ok('Fixing it.'.startsWith(part.text.replace(/\n?`{0,3}[a-z-]*$/i, '')) || part.text.startsWith('Fixing it.'), `at ${i}: ${JSON.stringify(part.text)}`);
  }
  const cut = L.parseAgentReply(full.slice(0, full.length - 12));
  assert.equal(cut.open, true);
  assert.deepEqual(cut.ops, []);
  assert.match(cut.error, /cut off/);
  assert.equal(cut.text, 'Fixing it.');
  const bad = L.parseAgentReply(`Fixing it.\n\n${FENCE}lagrange-edits\nfind teh, replace the\n${FENCE}`);
  assert.deepEqual(bad.ops, []);
  assert.match(bad.error, /not a JSON list/);
  assert.equal(bad.text, 'Fixing it.');
  const broken = L.parseAgentReply(`${FENCE}lagrange-edits\n[{"find": "a", "replace": "b"\n${FENCE}`);
  assert.deepEqual(broken.ops, []);
  assert.ok(broken.error);
});

test('locateOps: replacements by the proofreader’s rules; insertions next to their anchor; appends after a blank line', () => {
  const doc = 'One fish.\nTwo fish.\n\nRed fish, blue fish.';
  const { located, skipped } = L.locateOps(doc, [
    { op: 'append', text: 'The end.', reason: 'closing' },
    { op: 'replace', find: 'Two fish', replace: 'Three fish', reason: 'count' },
    { op: 'insert', after: 'One fish.', text: ' (Small.)', reason: '' },
    { op: 'insert', before: 'Red fish', text: 'Old fish. ', reason: '' },
    { op: 'insert', after: 'fish', text: '!', reason: '' },
    { op: 'insert', after: 'whale', text: '!', reason: '' },
    { op: 'replace', find: 'cat', replace: 'dog', reason: '' },
    { op: 'insert', after: 'Two fi', text: 'n', reason: '' },
  ]);
  assert.deepEqual(located.map(e => [e.from, e.to, e.replace, Boolean(e.insert)]), [
    [9, 9, ' (Small.)', true],
    [10, 18, 'Three fish', false],
    [21, 21, 'Old fish. ', true],
    [doc.length, doc.length, '\n\nThe end.', true],
  ]);
  assert.deepEqual(skipped.map(e => e.why), ['not found in the note', 'the place appears 4 times', 'the place was not found in the note', 'overlaps another edit']);
  // Applying them from the end gives the text the model meant.
  let out = doc;
  for (const e of located.slice().reverse()) out = out.slice(0, e.from) + e.replace + out.slice(e.to);
  assert.equal(out, 'One fish. (Small.)\nThree fish.\n\nOld fish. Red fish, blue fish.\n\nThe end.');
  assert.equal(L.locateOps('', [{ op: 'append', text: 'First.', reason: '' }]).located[0].replace, 'First.');
  assert.equal(L.locateOps('A.\n', [{ op: 'append', text: 'B.', reason: '' }]).located[0].replace, '\nB.');
  assert.equal(L.locateOps('A.\n\n', [{ op: 'append', text: 'B.', reason: '' }]).located[0].replace, 'B.');
  // the loose search finds an anchor copied with straight quotes
  assert.equal(L.locateOps('She said “no”. Then left.', [{ op: 'insert', after: 'said "no".', text: ' Twice.', reason: '' }]).located[0].from, 14);
});

test('The chat’s system prompt: the edits contract when the pen is on, the old advice when it is off', () => {
  const note = { title: 'Tides', text: 'The sea.' };
  const clip = L.clipText(note.text, 1000, 0);
  const on = L.chatSystemPrompt(note, clip, true), off = L.chatSystemPrompt(note, clip, false);
  assert.match(on, /```lagrange-edits\n\[\{"find": /);
  assert.match(on, /"insert_after"/);
  assert.match(on, /"append"/);
  assert.match(on, /answer in prose with no block/);
  assert.doesNotMatch(on, /You cannot change the note yourself/);
  assert.match(off, /You cannot change the note yourself/);
  assert.doesNotMatch(off, /lagrange-edits/);
  for (const p of [on, off]) assert.match(p, /<note>\nThe sea\.\n<\/note>/);
  assert.match(L.chatSystemPrompt(null, null, true), /No note is open/);
  // The example in the prompt is itself a valid block.
  const example = on.slice(on.indexOf('```lagrange-edits'), on.indexOf('```\n\n', on.indexOf('```lagrange-edits') + 5) + 3);
  assert.equal(L.parseAgentReply(example).ops.length, 3);
});


// ---------------------------------------------------------------- model and effort
test('Effort: which providers and models take one', () => {
  const s = over => Object.assign({}, L.DEFAULT_SETTINGS, { effort: 'high' }, over);
  assert.equal(L.effortFor(s({})), 'high', 'Claude Code');
  assert.equal(L.effortFor(s({ provider: 'codex' })), 'high');
  for (const m of L.ANTHROPIC_MODELS) assert.equal(L.effortFor(s({ provider: 'anthropic', anthropicModel: m.id })), 'high', m.id);
  const custom = id => L.effortFor(s({ provider: 'anthropic', anthropicModel: 'custom', anthropicCustomModel: id }));
  for (const id of ['claude-opus-4-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-fable-5-2', 'claude-opus-5']) assert.equal(custom(id), 'high', id);
  for (const id of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-7-sonnet-latest', '']) assert.equal(custom(id), '', id);
  const openai = m => L.effortFor(s({ provider: 'openai-api', openaiPlatformModel: m }));
  for (const m of ['gpt-5', 'gpt-5.2-mini', 'o3', 'o4-mini']) assert.equal(openai(m), 'high', m);
  for (const m of ['gpt-4o', 'gpt-4.1', 'gpt-5-chat-latest', '']) assert.equal(openai(m), '', m);
  assert.equal(L.effortFor(s({ provider: 'openai', openaiModel: 'gpt-5' })), '', 'a local server is sent none');
  assert.equal(L.effortFor(s({ provider: 'demo' })), '');
  assert.equal(L.effortFor(s({ effort: '' })), '');
  assert.equal(L.effortFor(s({ effort: 'max' })), '', 'only low, medium and high');
  assert.equal(L.footLabel(s({})), 'Claude (subscription, sonnet) · high effort');
  assert.equal(L.footLabel(s({ provider: 'demo' })), 'Demo (offline)');
  assert.equal(L.footLabel(s({ provider: 'anthropic', effort: 'low' })), 'Claude Sonnet 5.5 · low effort');
  assert.equal(L.footLabel(s({ provider: 'openai', openaiModel: 'llama3.1' })), 'llama3.1');
});

test('Effort, Anthropic: sent as output_config.effort; left out by default and for models that take none; a 400 naming it is retried without', async () => {
  const run = async (over, fetch, session) => {
    const calls = [];
    const res = await L.streamAnthropic(baseSettings(over), { system: 's', messages: [] }, {
      fetch: async (url, init) => { calls.push(JSON.parse(init.body)); return fetch ? fetch(JSON.parse(init.body)) : streamResponse([ANTHROPIC_STREAM]); },
    }, session || {});
    return { calls, res };
  };
  assert.equal((await run({})).calls[0].output_config, undefined);
  for (const e of ['low', 'medium', 'high']) {
    const body = (await run({ effort: e })).calls[0];
    assert.deepEqual(body.output_config, { effort: e });
    assert.equal(body.thinking, undefined, 'thinking is left adaptive');
    assert.equal(body.effort, undefined, 'never top-level');
  }
  assert.deepEqual((await run({ effort: 'high', anthropicModel: 'claude-opus-5-5' })).calls[0].output_config, { effort: 'high' });
  assert.equal((await run({ effort: 'high', anthropicModel: 'custom', anthropicCustomModel: 'claude-haiku-4-5' })).calls[0].output_config, undefined);
  // a model we believe takes effort but doesn't: one retry without it, remembered for the session
  const session = {};
  const refuse = body => (body.output_config
    ? jsonResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: 'output_config.effort: this model does not support the effort parameter' } })
    : streamResponse([ANTHROPIC_STREAM]));
  const over = { effort: 'medium', anthropicModel: 'custom', anthropicCustomModel: 'claude-opus-9-preview' };
  const first = await run(over, refuse, session);
  assert.equal(first.res.text, 'Ink on “paper”.');
  assert.deepEqual(first.calls.map(b => Boolean(b.output_config)), [true, false]);
  assert.deepEqual(session.noEffort, { 'anthropic:claude-opus-9-preview': true });
  assert.deepEqual((await run(over, refuse, session)).calls.map(b => Boolean(b.output_config)), [false]);
  assert.deepEqual((await run({ effort: 'medium' }, null, session)).calls[0].output_config, { effort: 'medium' }, 'other models still get it');
  // another 400 is still an error
  await assert.rejects(run({ effort: 'low' }, () => jsonResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages: at least one message is required' } })), /could not accept the request/);
});

test('Effort, OpenAI: reasoning_effort only for OpenAI’s reasoning models; never for a local server; a 400 naming it is retried without', async () => {
  const chunks = ['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'];
  const run = async (over, fetch, session) => {
    const calls = [];
    const s = Object.assign({}, L.DEFAULT_SETTINGS, { provider: 'openai-api', openaiPlatformKey: 'sk-x', effort: 'low' }, over);
    const res = await L.complete(s, { system: 's', messages: [] }, {
      fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return fetch ? fetch(JSON.parse(init.body)) : streamResponse(chunks); },
    }, session || {});
    return { calls, res };
  };
  const a = await run({ openaiPlatformModel: 'gpt-5' });
  assert.equal(a.calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(a.calls[0].body.reasoning_effort, 'low');
  assert.equal((await run({ openaiPlatformModel: 'gpt-4o' })).calls[0].body.reasoning_effort, undefined);
  assert.equal((await run({ openaiPlatformModel: 'gpt-5', effort: '' })).calls[0].body.reasoning_effort, undefined);
  assert.equal((await run({ provider: 'openai', openaiModel: 'gpt-5' })).calls[0].body.reasoning_effort, undefined);
  const session = {};
  const refuse = body => (body.reasoning_effort ? jsonResponse(400, { error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model." } }) : streamResponse(chunks));
  const r = await run({ openaiPlatformModel: 'o9-mini' }, refuse, session);
  assert.equal(r.res.text, 'ok');
  assert.deepEqual(r.calls.map(c => c.body.reasoning_effort), ['low', undefined]);
  assert.deepEqual(session.noEffort, { 'openai:o9-mini': true });
});

test('Effort, Claude subscription: --effort is passed; a Claude Code without the flag is run again without it', { skip: !posix }, async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lagrange-cli-'));
  const echo = fakeCli(dir, 'claude', `
process.stdin.resume(); process.stdin.on('end', () => {
  const a = process.argv.slice(2), i = a.indexOf('--effort');
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'effort=' + (i < 0 ? 'none' : a[i + 1]) + ' model=' + a[a.indexOf('--model') + 1] }));
});`);
  const req = { system: '', messages: [{ role: 'user', content: 'x' }] };
  const s = over => Object.assign({}, L.DEFAULT_SETTINGS, { claudeCodePath: echo }, over);
  assert.equal((await L.complete(s({}), req, {}, {})).text, 'effort=none model=sonnet');
  assert.equal((await L.complete(s({ effort: 'high', claudeCodeModel: 'opus' }), req, {}, {})).text, 'effort=high model=opus');
  assert.equal((await L.complete(s({ effort: 'low' }), req, {})).text, 'effort=low model=sonnet', 'works without a session');
  const old = fakeCli(dir, 'claude-old', `
process.stdin.resume(); process.stdin.on('end', () => {
  if (process.argv.includes('--effort')) { console.error("error: unknown option '--effort'"); process.exit(1); }
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'old ok' }));
});`);
  const session = {};
  assert.equal((await L.complete(s({ effort: 'medium', claudeCodePath: old }), req, {}, session)).text, 'old ok');
  assert.deepEqual(session.noEffort, { 'claude-code': true });
  assert.equal((await L.complete(s({ effort: 'medium', claudeCodePath: old }), req, {}, session)).text, 'old ok');
  // an unrelated failure is not retried
  const broken = fakeCli(dir, 'claude-broken', `process.stdin.resume(); process.stdin.on('end', () => { console.error('boom'); process.exit(2); });`);
  await assert.rejects(L.complete(s({ effort: 'medium', claudeCodePath: broken }), req, {}, {}), /stopped with an error: boom/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Effort, ChatGPT subscription: Codex gets -c model_reasoning_effort=…, before the "-" that reads stdin', { skip: !posix }, async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lagrange-cli-'));
  const exe = fakeCli(dir, 'codex', `
process.stdin.resume(); process.stdin.on('end', () => {
  const a = process.argv.slice(2), i = a.indexOf('-c');
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: (i < 0 ? 'none' : a[i + 1]) + (a[a.length - 1] === '-' ? ' stdin-last' : ' WRONG') } }));
});`);
  const req = { system: '', messages: [{ role: 'user', content: 'x' }] };
  const s = over => Object.assign({}, L.DEFAULT_SETTINGS, { provider: 'codex', codexPath: exe }, over);
  assert.equal((await L.complete(s({}), req, {}, {})).text, 'none stdin-last');
  assert.equal((await L.complete(s({ effort: 'high' }), req, {}, {})).text, 'model_reasoning_effort=high stdin-last');
  const picky = fakeCli(dir, 'codex-picky', `
process.stdin.resume(); process.stdin.on('end', () => {
  if (process.argv.includes('-c')) console.log(JSON.stringify({ type: 'error', message: 'unsupported value for reasoning effort' }));
  else console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'plain ok' } }));
});`);
  const session = {};
  assert.equal((await L.complete(s({ effort: 'low', codexPath: picky, codexModel: 'm1' }), req, {}, session)).text, 'plain ok');
  assert.deepEqual(session.noEffort, { 'codex:m1': true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('The footer’s picker: each provider’s models, a typed model, and where the choice is saved', () => {
  const s = over => Object.assign({}, L.DEFAULT_SETTINGS, over);
  let c = L.modelChoices(s({}));
  assert.deepEqual(c.options.map(o => o.value), ['sonnet', 'opus', 'haiku']);
  assert.equal(c.current, 'sonnet');
  assert.equal(c.free, true);
  c = L.modelChoices(s({ claudeCodeModel: 'claude-fable-5-2' }));
  assert.deepEqual(c.options.map(o => o.value), ['sonnet', 'opus', 'haiku', 'claude-fable-5-2'], 'a custom value is offered too');
  assert.equal(c.current, 'claude-fable-5-2');
  c = L.modelChoices(s({ provider: 'anthropic' }));
  assert.deepEqual(c.options.map(o => o.value), L.ANTHROPIC_MODELS.map(m => m.id));
  assert.deepEqual(c.options.map(o => o.label), L.ANTHROPIC_MODELS.map(m => m.name));
  c = L.modelChoices(s({ provider: 'anthropic', anthropicModel: 'custom', anthropicCustomModel: 'claude-opus-5' }));
  assert.equal(c.current, 'claude-opus-5');
  assert.equal(c.options.length, L.ANTHROPIC_MODELS.length + 1);
  c = L.modelChoices(s({ provider: 'codex', codexModel: 'gpt-5.2-codex' }));
  assert.deepEqual(c.options.map(o => o.value), ['', 'gpt-5.2-codex']);
  assert.deepEqual(L.modelChoices(s({ provider: 'codex' })).options.map(o => o.value), ['']);
  assert.deepEqual(L.modelChoices(s({ provider: 'openai-api', openaiPlatformModel: 'gpt-5' })).options.map(o => o.value), ['gpt-5']);
  assert.deepEqual(L.modelChoices(s({ provider: 'openai' })).options, []);
  c = L.modelChoices(s({ provider: 'demo' }));
  assert.deepEqual([c.options.length, c.free], [0, false]);

  const a = s({ provider: 'anthropic' });
  L.setModel(a, 'claude-opus-5-5');
  assert.equal(a.anthropicModel, 'claude-opus-5-5');
  L.setModel(a, ' claude-opus-5 ');
  assert.deepEqual([a.anthropicModel, a.anthropicCustomModel, L.anthropicModelId(a)], ['custom', 'claude-opus-5', 'claude-opus-5']);
  L.setModel(a, '');
  assert.equal(L.anthropicModelId(a), 'claude-opus-5', 'an empty entry changes nothing');
  assert.equal(L.sanitizeSettings(a).anthropicModel, 'custom');
  assert.equal(L.setModel(s({}), 'opus').claudeCodeModel, 'opus');
  assert.equal(L.setModel(s({ provider: 'codex', codexModel: 'x' }), '').codexModel, '', 'Codex’s default');
  assert.equal(L.setModel(s({ provider: 'openai-api' }), 'o4-mini').openaiPlatformModel, 'o4-mini');
  assert.equal(L.setModel(s({ provider: 'openai' }), 'qwen2.5:14b').openaiModel, 'qwen2.5:14b');
  assert.deepEqual(L.setModel(s({ provider: 'demo' }), 'x'), s({ provider: 'demo' }));
});


// ---------------------------------------------------------------- the pen's script: mathematics and the trail
test('mathSegments: $…$ and $$…$$ as Obsidian reads them; prices, escapes and code are text', () => {
  const seg = t => L.mathSegments(t).map(g => (g.type === 'math' ? [g.display ? 'D' : 'I', g.source] : g.text));
  assert.deepEqual(seg('Energy is $E = mc^2$, always.'), ['Energy is ', ['I', 'E = mc^2'], ', always.']);
  assert.deepEqual(seg('$$\\int_0^1 x\\,dx = \\frac12$$'), [['D', '\\int_0^1 x\\,dx = \\frac12']]);
  assert.deepEqual(seg('So\n$$\na^2 + b^2 = c^2\n$$\nholds.'), ['So\n', ['D', 'a^2 + b^2 = c^2'], '\nholds.']);
  assert.deepEqual(seg('$a$ and $b$'), [['I', 'a'], ' and ', ['I', 'b']]);
  assert.deepEqual(seg('It costs $5 and $10.'), ['It costs $5 and $10.']);
  assert.deepEqual(seg('From $5 to $10 a head'), ['From $5 to $10 a head']);
  assert.deepEqual(seg('A lone $ sign, and \\$x\\$ escaped'), ['A lone $ sign, and \\$x\\$ escaped']);
  assert.deepEqual(seg('Code `$x$` and\n```\n$y$\n```\nstay'), ['Code `$x$` and\n```\n$y$\n```\nstay']);
  assert.deepEqual(seg('$x$\nnot $across\nlines$'), [['I', 'x'], '\nnot $across\nlines$']);
  assert.deepEqual(seg('$\\$5$'), [['I', '\\$5']]);
  assert.deepEqual(seg('$$ $$ and $$unclosed'), ['$$ $$ and $$unclosed']);
  assert.deepEqual(seg(''), []);
  assert.equal(L.hasMath('no sums here, only $5'), false);
  assert.equal(L.hasMath('but $x^2$ here'), true);
});

test('penScript: text is cut to the limit, an equation is kept whole; without a renderer the pen writes the source', () => {
  const show = s => s.map(g => (g.type === 'math' ? `<${g.source}>` : g.text)).join('');
  assert.equal(show(L.penScript('a   short\n line', 48)), 'a short line');
  const long = L.penScript('word '.repeat(30), 48);
  assert.ok(show(long).length <= 48);
  assert.match(show(long), / …$/);
  assert.equal(show(L.penScript('The Euler–Lagrange equation: $$\\frac{d}{dt}\\frac{\\partial L}{\\partial \\dot{q}} - \\frac{\\partial L}{\\partial q} = 0$$', 48)),
    'The Euler–Lagrange equation: <\\frac{d}{dt}\\frac{\\partial L}{\\partial \\dot{q}} - \\frac{\\partial L}{\\partial q} = 0>');
  assert.equal(show(L.penScript(`so $${'x+'.repeat(100)}y$ ends`, 48)), `so <${'x+'.repeat(100)}y> ends`, 'a long equation is not left out');
  assert.equal(show(L.penScript('$a$ then ' + 'word '.repeat(30), 48)).startsWith('<a> then word'), true);
  assert.deepEqual(L.penScript('', 48), []);
  // the fallback: no renderer, a renderer that throws, or one that returns no element
  const el = { nodeType: 1 };
  assert.equal(L.renderPenMath('x', false, undefined), null);
  assert.equal(L.renderPenMath('x', false, () => { throw new Error('MathJax is not loaded'); }), null);
  assert.equal(L.renderPenMath('x', false, () => null), null);
  assert.equal(L.renderPenMath('x', false, () => 'x'), null);
  const seen = [];
  assert.equal(L.renderPenMath('x^2', true, (src, display) => { seen.push([src, display]); return el; }), el);
  assert.deepEqual(seen, [['x^2', true]]);
  // Under Node, Obsidian's renderMath is a stub that cannot be called: the pen falls back rather than throwing.
  assert.equal(L.renderPenMath('x', false, stubs.obsidian.renderMath), null);
});

test('mathSegments: LaTeX delimiters \\(…\\), \\[…\\] and bare environments are mathematics; escaped brackets in prose are not', () => {
  const seg = t => L.mathSegments(t).map(g => (g.type === 'math' ? [g.display ? 'D' : 'I', g.source] : g.text));
  assert.deepEqual(seg('Momentum is \\(p = mv\\), and\n\n\\[ F = \\frac{dp}{dt} \\]'),
    ['Momentum is ', ['I', 'p = mv'], ', and\n\n', ['D', 'F = \\frac{dp}{dt}']]);
  assert.deepEqual(seg('\\[\na^2 + b^2 = c^2\n\\]'), [['D', 'a^2 + b^2 = c^2']]);
  assert.deepEqual(seg('for every \\(x\\) in \\(\\mathbb{R}\\)'), ['for every ', ['I', 'x'], ' in ', ['I', '\\mathbb{R}']]);
  // Markdown's escaped brackets, and things that only look like delimiters
  assert.deepEqual(seg('He wrote \\[sic\\] and \\(optional\\) and \\[1\\].'), ['He wrote \\[sic\\] and \\(optional\\) and \\[1\\].']);
  assert.deepEqual(seg('unclosed \\(x = 1 and \\[y = 2'), ['unclosed \\(x = 1 and \\[y = 2']);
  assert.deepEqual(seg('\\(x = 1\nacross lines\\)'), ['\\(x = 1\nacross lines\\)']);
  assert.deepEqual(seg('a line break \\\\(x = 1\\\\) is not math'), ['a line break \\\\(x = 1\\\\) is not math']);
  assert.deepEqual(seg('Code `\\(x = 1\\)` and\n```\n\\[y = 2\\]\n\\begin{align}a\\end{align}\n```\nstay'),
    ['Code `\\(x = 1\\)` and\n```\n\\[y = 2\\]\n\\begin{align}a\\end{align}\n```\nstay']);
  // a display environment with no dollars around it, as models sometimes write it
  const env = '\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}';
  assert.deepEqual(seg(`So\n${env}\nholds.`), ['So\n', ['D', env], '\nholds.']);
  assert.deepEqual(seg(`$$\n${env}\n$$`), [['D', env]]);
  assert.deepEqual(seg('\\begin{itemize}\\item x\\end{itemize}'), ['\\begin{itemize}\\item x\\end{itemize}']);
  assert.deepEqual(seg('\\begin{align} never closed'), ['\\begin{align} never closed']);
  // currency and code next to real mathematics
  assert.deepEqual(seg('It costs $5 and $10, so $x = 15$.'), ['It costs $5 and $10, so ', ['I', 'x = 15'], '.']);
  assert.deepEqual(seg('$5 for `a$b` and $c$'), ['$5 for `a$b` and ', ['I', 'c']]);
  assert.deepEqual(seg('price \\$5 and \\$10'), ['price \\$5 and \\$10']);
  // the source is put back exactly as it was written
  for (const t of ['$x^2$', '$$\\frac12$$', '\\(p = mv\\)', '\\[ F = ma \\]', '\\[\nF = ma\n\\]', env]) {
    const g = L.mathSegments(t);
    assert.equal(g.length, 1, t);
    assert.equal(L.mathSource(g[0]), t);
  }
  assert.equal(L.looksLikeMath('sic'), false);
  assert.equal(L.looksLikeMath('see p. 3-4'), false);
  assert.equal(L.looksLikeMath('a + b'), true);
  assert.equal(L.looksLikeMath('\\alpha'), true);
  assert.equal(L.hasMath('only \\(n\\) here'), true);
});

test('penScript: an equation is drawn wherever it comes in a long replacement, with the words that lead up to it', () => {
  const show = s => s.map(g => (g.type === 'math' ? `<${g.source}>` : g.text)).join('');
  const maths = t => L.penScript(t, 48).filter(g => g.type === 'math').map(g => g.source);
  // 1.2.0 cut the script at 48 characters of prose and dropped everything after, equations included
  const para = 'The kinetic energy of a moving body of mass $m$ and speed $v$ is $E_k = \\tfrac{1}{2}mv^2$, so it grows with the square of its speed.';
  assert.equal(show(L.penScript(para, 48)), 'The kinetic energy of a moving body of mass <m> and speed <v> is <E_k = \\tfrac{1}{2}mv^2> …');
  const maxwell = 'Maxwell\'s equations describe how electric and magnetic fields arise and change, and together they predict waves ' +
    'that travel at the speed of light, $c = 1/\\sqrt{\\mu_0 \\varepsilon_0}$:\n\n$$\n\\begin{align}\n\\nabla \\cdot \\mathbf{E} &= ' +
    '\\frac{\\rho}{\\varepsilon_0} \\\\\n\\nabla \\cdot \\mathbf{B} &= 0 \\\\\n\\nabla \\times \\mathbf{E} &= -\\frac{\\partial \\mathbf{B}}{\\partial t} \\\\\n' +
    '\\nabla \\times \\mathbf{B} &= \\mu_0 \\mathbf{J} + \\mu_0 \\varepsilon_0 \\frac{\\partial \\mathbf{E}}{\\partial t}\n\\end{align}\n$$';
  const m = L.penScript(maxwell, 48);
  assert.equal(m.filter(g => g.type === 'math').length, 2, 'the inline equation and the align block (longer than 160 characters) are both drawn');
  assert.equal(m[m.length - 1].display, true);
  assert.match(show(m), /^Maxwell's equations describe how electric and … speed of light, <c = /);
  // only an equation; an equation first; an equation last; LaTeX delimiters
  assert.deepEqual(maths('$$E = mc^2$$'), ['E = mc^2']);
  assert.deepEqual(maths(' $p = mv$'), ['p = mv']);
  assert.deepEqual(maths('word '.repeat(40) + 'and at last $z$'), ['z']);
  assert.match(show(L.penScript('word '.repeat(40) + 'and at last $z$', 48)), /^(word )+… word and at last <z>$/);
  assert.deepEqual(maths('Momentum is \\(p = mv\\), and\n\n\\[ F = \\frac{dp}{dt} \\]'), ['p = mv', 'F = \\frac{dp}{dt}']);
  // prose after the last equation, once the room is used up, is an ellipsis and no more
  assert.match(show(L.penScript('word '.repeat(12) + '$a$ ' + 'tail '.repeat(20), 48)), /<a> …$/);
  assert.ok(!/… ?…/.test(show(L.penScript('word '.repeat(12) + '$a$ ' + 'more '.repeat(8) + '$b$ ' + 'tail '.repeat(20), 48))), 'never two ellipses in a row');
  // a paragraph thick with equations: the first SCRIPT_EQUATIONS are drawn, then the script ends
  const thick = L.penScript('a $x$ b $y$ c $z$ '.repeat(6), 48);
  assert.equal(thick.filter(g => g.type === 'math').length, 8);
  assert.match(show(thick), / …$/);
  // code is still typed and never left out
  assert.deepEqual(L.penScript('so $x$ and `print(x)` then', 48).map(g => g.type), ['text', 'math', 'text', 'code', 'text']);
});

test('equationPlan: an equation is drawn when MathJax typeset it, and written as its source (with a reason) when it could not', () => {
  const ok = { renderer: true, loaded: true, error: '', typeset: true, failed: false, symbols: 7 };
  assert.deepEqual(L.equationPlan(ok), { how: 'draw', why: '' });
  assert.equal(L.equationPlan(Object.assign({}, ok, { symbols: 400 })).how, 'draw', 'however long it is');
  const why = env => { const p = L.equationPlan(Object.assign({}, ok, env)); assert.equal(p.how, 'text'); assert.ok(p.why); return p.why; };
  assert.match(why({ renderer: false }), /no renderMath/);                 // an Obsidian without it
  assert.match(why({ loaded: false }), /did not load in time/);            // MathJax still loading after the wait
  assert.match(why({ error: 'offline', loaded: false }), /did not load \(offline\)/);
  assert.match(why({ typeset: false }), /could not typeset/);              // renderMath threw or gave nothing
  assert.match(why({ failed: true }), /TeX error/);
  assert.match(why({ symbols: 0 }), /no symbols/);
  assert.equal(L.equationPlan().how, 'text');
  assert.equal(L.equationPlan(null).how, 'text');
});

test('repairJsonLatex: LaTeX that was not escaped for JSON is put right; escaped LaTeX and ordinary text are left alone', () => {
  const fix = raw => JSON.parse(L.repairJsonLatex(raw));
  // \f, \t and \b would be a form feed, a tab and a backspace; \a and \s are not JSON at all
  assert.deepEqual(fix('[{"append": "$$E = \\frac{1}{2}mv^2 \\times \\beta$$"}]'), [{ append: '$$E = \\frac{1}{2}mv^2 \\times \\beta$$' }]);
  assert.deepEqual(fix('[{"append": "so $\\alpha \\ne \\nu$ and \\"q\\"\\n\\n$$\\n\\nabla \\cdot E = \\rho \\\\ x$$"}]'),
    [{ append: 'so $\\alpha \\ne \\nu$ and "q"\n\n$$\n\\nabla \\cdot E = \\rho \\\\ x$$' }]);
  assert.deepEqual(fix('[{"find": "a", "replace": "$\\sigma_x$ and\\nnot $\\theta$"}]'), [{ find: 'a', replace: '$\\sigma_x$ and\nnot $\\theta$' }]);
  // written as the prompt asks: nothing to do
  for (const good of ['[{"append": "$$E = \\\\frac{1}{2}$$\\nnot\\ttab"}]', '[{"append": "a\\nb \\u00e9 \\"c\\""}]', '[]', 'no backslash', '']) {
    assert.equal(L.repairJsonLatex(good), good);
  }
  assert.equal(L.repairJsonLatex(null), '');
  // through the parsers
  const reply = 'Adding it.\n\n```lagrange-edits\n[{"append": "$$E = \\frac{1}{2}mv^2$$"}]\n```\n';
  assert.deepEqual(L.parseAgentReply(reply).ops, [{ op: 'append', text: '$$E = \\frac{1}{2}mv^2$$', reason: '' }]);
  assert.equal(L.parseAgentReply('```lagrange-edits\n[{"append": "$\\alpha$"}]\n```').error, null);
  assert.deepEqual(L.parseEdits('[{"find": "x", "replace": "$\\beta$", "reason": "r"}]').edits, [{ find: 'x', replace: '$\\beta$', reason: 'r' }]);
});

test('inkOffset: the pen starts at the first written character, past white space and what opens a block', () => {
  assert.equal(L.inkOffset('Plain words'), 0);
  assert.equal(L.inkOffset('\n\nA new paragraph'), 2);
  assert.equal(L.inkOffset(' and more'), 1);
  assert.equal(L.inkOffset('## A heading'), 3);
  assert.equal(L.inkOffset('\n- an item'), 3);
  assert.equal(L.inkOffset('\n12. an item'), 5);
  assert.equal(L.inkOffset('> quoted'), 2);
  assert.equal(L.inkOffset('> - quoted item'), 4);
  assert.equal(L.inkOffset('\n\n$$E = mc^2$$'), 2);
  assert.equal(L.inkOffset('-dash, not a list'), 0);
  assert.equal(L.inkOffset('*emphasis* first'), 0);
  assert.equal(L.inkOffset('#tag first'), 0);
  assert.equal(L.inkOffset('  \n '), 4, 'nothing to write: the whole length');
  assert.equal(L.inkOffset(''), 0);
  assert.equal(L.inkOffset(null), 0);
});

test('penLines and penPace: three lines of a long edit, fewer late in a long run, and long lines written faster', () => {
  assert.equal(L.DEFAULT_SETTINGS.penLines, 3);
  assert.equal(L.penLines(3, 7, 0, 1), 3, 'a paragraph: three lines are written');
  assert.equal(L.penLines(3, 2, 0, 1), 2, 'never more lines than the text takes');
  assert.equal(L.penLines(3, 1, 0, 1), 1);
  assert.equal(L.penLines(5, 9, 0, 1), 5);
  assert.equal(L.penLines(undefined, 9, 0, 1), 3);
  assert.equal(L.penLines(99, 20, 0, 1), 8);
  assert.equal(L.penLines(0, 0, 0, 1), 1);
  // a run of many edits: once its handwriting has taken PEN_RUN_MS (at speed 1), one line each
  assert.equal(L.penLines(3, 7, L.PEN_RUN_MS - 1, 1), 3);
  assert.equal(L.penLines(3, 7, L.PEN_RUN_MS, 1), 1);
  assert.equal(L.penLines(3, 7, L.PEN_RUN_MS / 2, 2), 1, 'a faster pen reaches it in less time');
  assert.equal(L.penLines(3, 7, L.PEN_RUN_MS, 0.5), 3);
  // pace: short pieces as before (9 ms a px); three 700 px lines in 2.5 to 4 s
  assert.equal(L.penPace(100), 9);
  const three = 3 * 700 * L.penPace(3 * 700);
  assert.ok(three >= 2500 && three <= 4000, `three lines take ${three} ms`);
  assert.ok(L.penPace(100000) >= 1.2);
  assert.equal(L.penPace(0), 9);
  assert.equal(L.sanitizeSettings({ penLines: 5 }).penLines, 5);
  assert.equal(L.sanitizeSettings({ penLines: 0 }).penLines, 3);
  assert.equal(L.sanitizeSettings({ penLines: 2.5 }).penLines, 3);
});

test('penLanes: edits that stand apart on the page are written at once, each by a pen; edits too near one another wait for the pen that is there', () => {
  const LH = 24, GAP = Math.max(L.PEN_GAP_LINES * LH, L.PEN_GAP_PX);
  const page = { top: 100, bottom: 700, lineHeight: LH, width: 600 };                 // room for three pens
  const e = (top, para, o) => Object.assign({ top, bottom: top + LH, para, paraEnd: para, grow: 0 }, o);
  const none = { lanes: [], count: 0 };
  const lanes = (edits, pens, pg) => L.penLanes(edits, pg || page, { pens: pens == null ? 3 : pens });
  // three edits in three paragraphs, well apart: a pen each, from the top of the page down
  assert.deepEqual(lanes([e(150, 3), e(320, 5), e(500, 7)]), { lanes: [[0], [1], [2]], count: 3 });
  assert.deepEqual(lanes([e(150, 3), e(320, 5)]), { lanes: [[0], [1]], count: 2 });
  // one pen is the pen as it always was: no lanes
  assert.deepEqual(lanes([e(150, 3)]), none);
  assert.deepEqual(lanes([]), none);
  assert.deepEqual(lanes([e(150, 3), e(320, 5), e(500, 7)], 1), none, '“Several pens at once” is off');
  assert.deepEqual(lanes([e(150, 3), e(320, 5), e(500, 7)], 0), none);
  assert.deepEqual(L.penLanes([e(150, 3), e(320, 5)], page), none, 'no setting, no pens');
  assert.deepEqual(L.penLanes([e(150, 3), e(320, 5)], null, { pens: 3 }), none, 'no page');
  // “Pens at most”: the edits past the last pen's wait for the next round
  assert.deepEqual(lanes([e(150, 3), e(320, 5), e(500, 7)], 2), { lanes: [[0], [1]], count: 2 });
  // two edits in one paragraph go to one pen, however far apart they are in it; alone, they are no lanes at all
  assert.deepEqual(lanes([e(150, 3), e(400, 3)]), none);
  assert.deepEqual(lanes([e(150, 3), e(400, 3), e(600, 9)]), { lanes: [[0, 1], [2]], count: 3 });
  assert.deepEqual(lanes([e(150, 3), e(320, 5), e(420, 5)]), { lanes: [[0], [1, 2]], count: 3 });
  // an edit that runs over several paragraphs holds them all
  assert.deepEqual(lanes([e(150, 3, { paraEnd: 5, bottom: 150 + 4 * LH }), e(400, 5), e(600, 9)]), { lanes: [[0, 1], [2]], count: 3 });
  // different paragraphs, but fewer than PEN_GAP_LINES clear lines between them: one pen, the second after the first
  assert.equal(L.PEN_GAP_LINES, 2.5);
  assert.equal(L.PEN_GAP_PX, 76);
  assert.equal(GAP, 76, 'in type as small as this the gap is the pen’s own height: more than two and a half lines');
  const below = 150 + LH;                                                             // where the first edit ends
  assert.deepEqual(lanes([e(150, 3), e(below + GAP - 1, 5)]), none);
  assert.deepEqual(lanes([e(150, 3), e(below + GAP, 5)]), { lanes: [[0], [1]], count: 2 }, 'exactly that many clear lines will do');
  assert.deepEqual(lanes([e(150, 3), e(below + LH, 4), e(500, 7)]), { lanes: [[0, 1], [2]], count: 3 }, 'the very next line: it waits for the pen above it');
  // the distance is counted from where the lane's words end, whichever of its edits reaches lowest
  assert.deepEqual(lanes([e(150, 3, { bottom: 150 + 5 * LH }), e(180, 3), e(150 + 5 * LH + GAP - 1, 5), e(600, 9)]), { lanes: [[0, 1, 2], [3]], count: 4 });
  // only what is in view: the first edit that is not ends the list, and it and all after it wait
  assert.deepEqual(lanes([e(150, 3), e(320, 5), e(800, 7)]), { lanes: [[0], [1]], count: 2 });
  assert.deepEqual(lanes([e(150, 3), e(800, 5), e(500, 7)]), none);
  assert.deepEqual(lanes([e(50, 3), e(320, 5), e(500, 7)]), none, 'the first is above the page');
  assert.deepEqual(lanes([e(150, 3), e(700 - LH + 1, 5)]), none, 'the second ends below the page');
  assert.deepEqual(lanes([e(150, 3), e(700 - LH, 5)]), { lanes: [[0], [1]], count: 2 });
  // an edit that cannot be measured (off screen, in a table) ends the list too
  assert.deepEqual(lanes([e(150, 3), e(320, 5), null, e(600, 9)]), { lanes: [[0], [1]], count: 2 });
  assert.deepEqual(lanes([e(150, 3), null, e(600, 9)]), none);
  assert.deepEqual(lanes([null, e(320, 5), e(600, 9)]), none);
  // an edit pushes down what stands below it: text that would leave the page that way waits
  assert.deepEqual(lanes([e(150, 3, { grow: 4 * LH }), e(320, 5), e(600, 9)]), { lanes: [[0], [1]], count: 2 });
  assert.deepEqual(lanes([e(150, 3, { grow: 2 * LH }), e(320, 5), e(600, 9)]), { lanes: [[0], [1], [2]], count: 3 });
  assert.deepEqual(lanes([e(150, 3), e(640, 5, { grow: 3 * LH })]), none, 'nor may its own text leave the page as it grows');
  assert.deepEqual(lanes([e(150, 3, { grow: -500 }), e(320, 5)]), { lanes: [[0], [1]], count: 2 }, 'text that shrinks pushes nothing');
  // never more pens than one for every PEN_LANE_PX of the page, nor than PEN_MAX
  assert.equal(L.PEN_LANE_PX, 180);
  assert.equal(L.PEN_MAX, 4);
  const four = [e(150, 3), e(320, 5), e(500, 7), e(660, 9), e(820, 11)];
  const tall = { top: 100, bottom: 100 + 4 * L.PEN_LANE_PX + 100, lineHeight: LH, width: 600 };
  assert.deepEqual(lanes(four, 4, tall), { lanes: [[0], [1], [2], [3]], count: 4 });
  assert.deepEqual(lanes(four, 9, tall), { lanes: [[0], [1], [2], [3]], count: 4 });
  assert.deepEqual(lanes(four, 3, tall), { lanes: [[0], [1], [2]], count: 3 }, 'four only when the setting says so');
  assert.deepEqual(lanes(four, 4), { lanes: [[0], [1], [2]], count: 3 }, 'and only on a tall page');
  assert.deepEqual(lanes(four, 4, { top: 100, bottom: 100 + 2 * L.PEN_LANE_PX, lineHeight: LH, width: 600 }), { lanes: [[0], [1]], count: 2 });
  assert.deepEqual(lanes([e(150, 3), e(320, 5)], 3, { top: 100, bottom: 100 + 2 * L.PEN_LANE_PX - 1, lineHeight: LH, width: 600 }), none, 'a short pane: one pen');
  // when every pen has its lane, an edit near the last one still joins it; the next one apart waits
  assert.deepEqual(lanes([e(150, 3), e(320, 5), e(340, 5), e(600, 9)], 2), { lanes: [[0], [1, 2]], count: 3 });
  // a narrow column is written by one pen
  assert.equal(L.PEN_MIN_WIDTH, 440);
  assert.deepEqual(lanes([e(150, 3), e(320, 5)], 3, Object.assign({}, page, { width: L.PEN_MIN_WIDTH - 1 })), none);
  assert.deepEqual(lanes([e(150, 3), e(320, 5)], 3, Object.assign({}, page, { width: L.PEN_MIN_WIDTH })), { lanes: [[0], [1]], count: 2 });
  // the gap is counted in the page's own lines
  assert.deepEqual(lanes([e(150, 3), e(150 + LH + 2.5 * 40 - 1, 5)], 3, Object.assign({}, page, { lineHeight: 40 })), none);
  assert.deepEqual(lanes([e(150, 3), e(150 + LH + 2.5 * 40, 5)], 3, Object.assign({}, page, { lineHeight: 40 })), { lanes: [[0], [1]], count: 2 });
  // pure: what it is given is left as it was
  const given = [e(150, 3), e(320, 5), e(500, 7)], copy = JSON.stringify(given);
  lanes(given);
  assert.equal(JSON.stringify(given), copy);
  // every edit is in exactly one lane, in order, and the lanes go down the page
  const many = lanes([e(150, 3), e(160, 3), e(320, 5), e(330, 6), e(520, 9), e(530, 9)]);
  assert.deepEqual(many, { lanes: [[0, 1], [2, 3], [4, 5]], count: 6 });
  assert.deepEqual(many.lanes.flat(), [0, 1, 2, 3, 4, 5]);
});

test('textLines: about how many lines a piece of text takes, for the pens’ planning', () => {
  // type of 20 px: about 9 px a character
  assert.equal(L.textLines('', 0, 460, 20), 1);
  assert.equal(L.textLines('A short line.', 0, 460, 20), 1);
  assert.equal(L.textLines('x'.repeat(51), 0, 460, 20), 1);
  assert.equal(L.textLines('x'.repeat(52), 0, 460, 20), 2);
  assert.equal(L.textLines('x'.repeat(100), 0, 460, 20), 2);
  assert.equal(L.textLines('x'.repeat(100), 100, 460, 20), 3, 'set from part of the way into its first line');
  assert.equal(L.textLines('one\n\nthree', 0, 460, 20), 3, 'a line of the note is a line of the page, an empty one too');
  assert.equal(L.textLines('one\n' + 'x'.repeat(60), 400, 460, 20), 3, 'the indent is the first line’s alone');
  assert.equal(L.textLines(null, 0, 460, 20), 1);
  assert.equal(L.textLines('x'.repeat(100), 0, 0, 20), Math.ceil(100 / 8), 'a column with no width is taken as eight characters wide');
});

test('penRoom: how many lines the pen needs under an edit’s start (an edit low on the screen with less room than that is brought to the middle first)', () => {
  const W = 460, F = 20;                                 // about 51 characters to a line
  assert.equal(L.penRoom('Short sentence here.', 3, W, F), 1);
  assert.equal(L.penRoom('x'.repeat(120), 3, W, F), 3, 'three lines of text');
  assert.equal(L.penRoom('x'.repeat(600), 3, W, F), 3, 'a long text: only the lines the pen writes');
  assert.equal(L.penRoom('x'.repeat(600), 5, W, F), 5);
  assert.equal(L.penRoom('x'.repeat(600), undefined, W, F), 3);
  assert.equal(L.penRoom('\n\n' + 'x'.repeat(600), 3, W, F), 5, 'and the empty lines it opens with');
  const code = '\n\nThe distance, with `hill_radius(m1, m2, r)`:\n\n```python\ndef hill_radius(m1, m2, r):\n    return r * (m2 / (3 * m1)) ** (1 / 3)\n```';
  assert.equal(L.penRoom(code, 3, W, F), 8, 'a code block: every line of it (two empty lines, a sentence, an empty line, the fence and its code)');
  assert.equal(L.penRoom('A span of `code` in a sentence.', 3, W, F), 1, 'a code span is in its line');
  const long = '```js\n' + Array.from({ length: 40 }, (_, i) => `line${i}();`).join('\n') + '\n```';
  assert.equal(L.penRoom(long, 3, W, F), 3 + 8, 'a long block: no more than the pen types of it');
  assert.equal(L.penRoom('Force is the rate of change of momentum:\n\n$$F = \\frac{dp}{dt}$$', 3, W, F), 3);
  assert.equal(L.penRoom('\n\n$$\n\\int_0^\\infty e^{-x^2}\\,dx\n$$\n\nwhich is the sum of all of it, and of ' + 'x'.repeat(300), 3, W, F), 8, 'a displayed equation takes room of its own');
  assert.equal(L.penRoom('', 3, W, F), 1);
  assert.equal(L.penRoom(null, 3, W, F), 1);
  const js = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8');
  assert.match(js, /return c\.top \+ penRoom\(text, settings && settings\.penLines, box\.width, size\) \* line <= s\.bottom;/);
});

test('Several pens at once: on by default, three pens at most, both settings; the pen says how many it has, and each pen shows its own text', () => {
  assert.equal(L.DEFAULT_SETTINGS.severalPens, true);
  assert.equal(L.DEFAULT_SETTINGS.maxPens, 3);
  assert.equal(L.sanitizeSettings({ severalPens: false }).severalPens, false);
  assert.equal(L.sanitizeSettings({ severalPens: 'no' }).severalPens, true);
  for (const n of [2, 3, 4]) assert.equal(L.sanitizeSettings({ maxPens: n }).maxPens, n);
  for (const n of [0, 1, 5, 2.5, '3', null]) assert.equal(L.sanitizeSettings({ maxPens: n }).maxPens, 3, String(n));
  assert.ok(L.PEN_STAGGER_MS >= 150 && L.PEN_STAGGER_MS <= 300, 'the pens set out a moment after one another');
  const js = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8');
  assert.match(js, /setName\('Several pens at once'\)/);
  assert.match(js, /setName\('Pens at most'\)/);
  assert.match(js, /const showPens = valued\(pens, s\.maxPens/, 'the slider’s value is shown beside it');
  assert.match(js, /pens: this\.settings\.severalPens \? this\.settings\.maxPens : 1/, 'the run is told how many pens it may use');
  assert.match(js, /pens: PEN_MAX,/, 'and the pen says how many it has');
  assert.match(js, /opts\.pens > 1 && opts\.pen\.pens > 1 && !prefersReducedMotion\(win\)/, 'one pen with reduced motion, and with a pen that writes one edit at a time');
  // every wait and every trail of a sheet runs from one animation frame, and the sheet is measured once in it
  const pen = js.slice(js.indexOf('==== LAGRANGE PEN (replaceable) ===='), js.indexOf('==== END LAGRANGE PEN ===='));
  assert.equal(pen.split('requestAnimationFrame(').length - 1, 2, 'the pen asks for a frame in one place only (runFrame, and onFrame which starts it)');
  assert.match(pen, /if \(S\.inFrame && S\.o\) return S\.o;/);
  // a pen's own change moves the places the other pens hold, and spoils none of them
  assert.match(pen, /if \(p\.view === update\.view && p !== owner\) p\.map\(tr\.changes, true\)/);
  // finish() ends every edit being written
  assert.match(pen, /for \(const me of all\) \{ try \{ me\.finish\(\); \}/);
  // each pen's unwritten text is its own, and shows when that pen is done
  const css = fs.readFileSync(path.join(PLUGIN, 'styles.css'), 'utf8');
  for (let i = 0; i < L.PEN_MAX; i++) {
    assert.ok(css.includes(`.lagrange-pen-revealing-${i} .lagrange-pen-unwritten.lagrange-pen-of-${i}`), `pen ${i}`);
    assert.ok(css.includes(`.cm-editor:not(.lagrange-pen-revealing-${i}) .lagrange-pen-of-${i}`), `pen ${i}: the boxes of its lines`);
  }
  assert.ok(!css.includes(`lagrange-pen-of-${L.PEN_MAX}`) && !css.includes(`lagrange-pen-revealing-${L.PEN_MAX}`));
  assert.doesNotMatch(css, /\.lagrange-pen-revealing[ ,{]/, 'no rule shows every pen’s text at once');
  assert.doesNotMatch(js, /'lagrange-pen-revealing'/);
});

test('trailBands: the newest ink is the darkest and widest, old ink is dropped, and the strokes join up', () => {
  assert.deepEqual(L.trailBands([], 1000, 500, 5), []);
  assert.deepEqual(L.trailBands([{ x: 0, y: 0, t: 990 }], 1000, 500, 5), []);
  const pts = [];
  for (let i = 0; i <= 60; i++) pts.push({ x: i * 2, y: 10, t: 400 + i * 10 });     // t = 400 … 1000
  const bands = L.trailBands(pts, 1000, 500, 5);
  assert.equal(bands.length, 5);
  for (let i = 1; i < bands.length; i++) {
    assert.ok(bands[i].opacity < bands[i - 1].opacity);
    assert.ok(bands[i].width < bands[i - 1].width);
    // each older stroke ends where the newer one starts
    assert.equal(bands[i].d.split('L').pop(), bands[i - 1].d.slice(1).split('L')[0]);
  }
  assert.ok(bands[0].opacity <= 0.5);
  assert.match(bands[0].d, /^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+)+$/);
  assert.ok(bands[0].d.endsWith('L120.0 10.0'), 'the newest stroke ends at the nib');
  const xs = bands.flatMap(b => b.d.slice(1).split('L').map(p => Number(p.split(' ')[0])));
  assert.equal(Math.min(...xs), 20, 'points older than the trail’s life are gone');
  assert.deepEqual(L.trailBands(pts, 5000, 500, 5), [], 'all of it fades');
});


// ---------------------------------------------------------------- code is typed, not written
test('code in an edit: fenced blocks and code spans of a few characters are the typewriter’s; the rest is the pen’s', () => {
  const seg = t => L.mathSegments(t, { code: true }).map(g => (g.type === 'code' ? [g.block ? 'B' : 'S', g.text, g.lang] : g.type === 'math' ? ['M', g.source] : g.text));
  assert.deepEqual(seg('Call `print(x)` here.'), ['Call ', ['S', 'print(x)', ''], ' here.']);
  assert.deepEqual(seg('A short `x` and `ab` stay with the pen.'), ['A short `x` and `ab` stay with the pen.']);
  assert.deepEqual(seg('Intro:\n\n```python\ndef f(x):\n    return x\n```\nAfter.'), ['Intro:\n\n', ['B', 'def f(x):\n    return x', 'python'], '\nAfter.']);
  assert.deepEqual(seg('```\nplain\n```'), [['B', 'plain', '']]);
  assert.deepEqual(seg('```js\nlet a = `$x$`;\n```'), [['B', 'let a = `$x$`;', 'js']], 'no math, and no span, inside a block');
  assert.deepEqual(seg('`$notmath$` and $x^2$'), [['S', '$notmath$', ''], ' and ', ['M', 'x^2']]);
  assert.deepEqual(seg('``a `tick` inside``'), [['S', 'a `tick` inside', '']]);
  assert.deepEqual(seg('an `unclosed span'), ['an `unclosed span']);
  // without the option nothing changes: code is text
  assert.deepEqual(L.mathSegments('Call `print(x)` here.'), [{ type: 'text', text: 'Call `print(x)` here.' }]);
  assert.equal(L.hasCode('Call `print(x)` here.'), true);
  assert.equal(L.hasCode('```\na\n```'), true);
  assert.equal(L.hasCode('A `b` c, and $5.'), false);
  assert.equal(L.hasCode('plain prose'), false);
});

test('penScript with code: the code keeps its lines and is never left out; long code is cut with an ellipsis', () => {
  const show = s => s.map(g => (g.type === 'code' ? `[${g.block ? 'B' : 'S'}:${g.text}]` : g.type === 'math' ? `<${g.source}>` : g.text)).join('');
  assert.equal(show(L.penScript('Use `printf("%d", n)`   to   print.', 48)), 'Use [S:printf("%d", n)] to print.');
  const long = 'The distance to the first Lagrange point, with `hill_radius(m1, m2, r)`:\n\n```python\ndef hill_radius(m1, m2, r):\n    return r\n```';
  assert.equal(show(L.penScript(long, 48)), 'The distance to the first Lagrange point, with [S:hill_radius(m1, m2, r)] …[B:def hill_radius(m1, m2, r):\n    return r]');
  const tall = '```\n' + Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n```';
  const block = L.penScript(tall, 48)[0];
  assert.equal(block.type, 'code');
  assert.deepEqual(block.text.split('\n'), ['line 0', 'line 1', 'line 2', 'line 3', 'line 4', '…']);
  const wide = L.penScript('```\n' + 'x'.repeat(200) + '\n\tindented\n```', 48)[0].text.split('\n');
  assert.equal(wide[0].length, 56);
  assert.ok(wide[0].endsWith('…'));
  assert.equal(wide[1], '  indented', 'a tab becomes two spaces');
  // prose and equations are as before
  assert.equal(show(L.penScript('a   short\n line', 48)), 'a short line');
  assert.equal(show(L.penScript('so $x^2$ it is', 48)), 'so <x^2> it is');
});

test('typeCadence: one pause per character, uneven but repeatable, a carriage return at line ends, within the budget', () => {
  const text = 'def f(x):\n    return x * 2\n';
  const a = L.typeCadence(text, 0, 7), b = L.typeCadence(text, 0, 7), c = L.typeCadence(text, 0, 8);
  assert.equal(a.length, text.length);
  assert.deepEqual(a, b, 'the same seed gives the same rhythm');
  assert.notDeepEqual(a, c);
  assert.ok(new Set(a.map(v => Math.round(v))).size > 6, 'the pauses are not all alike');
  assert.ok(a.every(v => v >= 30 && v <= 200));
  [...text].forEach((ch, i) => { if (ch === '\n') assert.equal(a[i], 190); });
  const fast = L.typeCadence('x'.repeat(1000), 3000, 1);
  assert.ok(Math.abs(fast.reduce((p, q) => p + q, 0) - 3000) < 1, 'a long text is typed faster, to fit the budget');
  assert.deepEqual(L.typeCadence('', 1000, 1), []);
});


// ---------------------------------------------------------------- undo, redo and rewinding a conversation
test('Undo and Redo choose the right run: the latest still in the note; the one most lately taken back', () => {
  const a = { name: 'a', undone: false, redo: null, undoneAt: 0 }, b = { name: 'b', undone: false, redo: null, undoneAt: 0 }, c = { name: 'c', undone: false, redo: null, undoneAt: 0 };
  const runs = [a, b, c];
  assert.equal(L.undoTarget([]), null);
  assert.equal(L.redoTarget(runs), null);
  assert.equal(L.undoTarget(runs), c);
  Object.assign(c, { undone: true, redo: {}, undoneAt: 1 });
  assert.equal(L.undoTarget(runs), b);
  assert.equal(L.redoTarget(runs), c);
  Object.assign(b, { undone: true, redo: {}, undoneAt: 2 });
  assert.equal(L.undoTarget(runs), a);
  assert.equal(L.redoTarget(runs), b, 'the one undone last is redone first');
  b.redo = null;                                       // the note moved on: b can't be made again
  assert.equal(L.redoTarget(runs), c);
  Object.assign(a, { undone: true, undoneAt: 3 });
  assert.equal(L.undoTarget(runs), null);
});

test('Rewind: the conversation is cut back to just before the message, for the model as well', () => {
  const history = ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'].map((c, i) => ({ role: i % 2 ? 'assistant' : 'user', content: c }));
  const cps = [0, 2, 4].map((n, i) => ({ text: `u${i + 1}`, historyLength: n, path: 'N.md', before: 'x', after: null }));
  const back = L.rewindTo(history, cps, 1);
  assert.deepEqual(back.history.map(m => m.content), ['u1', 'a1']);
  assert.deepEqual(back.checkpoints, [cps[0]]);
  assert.equal(history.length, 6, 'the originals are not changed');
  assert.deepEqual(L.rewindTo(history, cps, 0), { history: [], checkpoints: [] });
  assert.deepEqual(L.rewindTo(history, cps, 2).history.map(m => m.content), ['u1', 'a1', 'u2', 'a2']);
  // a turn that failed left no reply: its checkpoint still cuts where it began
  const odd = [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }];
  assert.deepEqual(L.rewindTo(odd, [{ historyLength: 0 }, { historyLength: 2 }], 1).history, odd);
  assert.equal(L.rewindTo(history, cps, 9).history.length, 6, 'an unknown checkpoint changes nothing');
});

test('Rewind: Lagrange’s own changes since a message are told from the writer’s', () => {
  const cp = (before, after, path) => ({ path: path || 'N.md', before, after: after === undefined ? null : after });
  // three turns: a question (no change), an edit A -> B, an edit B -> C
  const turns = [cp('A'), cp('A', 'B'), cp('B', 'C')];
  for (const k of [0, 1, 2]) assert.equal(L.userChangedSince(turns, k, 'C'), false, `from ${k}: only Lagrange changed it`);
  assert.equal(L.userChangedSince(turns, 0, 'C and more'), true, 'typing after the last turn');
  assert.equal(L.userChangedSince(turns, 2, 'B'), true, 'the last edit was undone: the note is not as the turn left it');
  // the writer typed between the second and third turns
  const typed = [cp('A'), cp('A', 'B'), cp('B typed', 'C')];
  assert.equal(L.userChangedSince(typed, 0, 'C'), true);
  assert.equal(L.userChangedSince(typed, 1, 'C'), true);
  assert.equal(L.userChangedSince(typed, 2, 'C'), false, 'nothing of the writer’s after the third message');
  // a turn about another note is not this note's business
  assert.equal(L.userChangedSince([cp('A', 'B'), cp('zzz', 'yyy', 'Other.md'), cp('B', 'C')], 0, 'C'), false);
  // an expired copy: it cannot be told, so the writer is asked
  assert.equal(L.userChangedSince([cp(null), cp('A', 'B')], 0, 'B'), true);
  assert.equal(L.userChangedSince([cp('A', 'B'), cp(null)], 0, 'B'), true);
  assert.equal(L.userChangedSince(turns, 7, 'C'), true);
});

test('Rewind: only the newest checkpoints keep their copy of the note, and the old ones say so', () => {
  const make = n => Array.from({ length: n }, (_, i) => ({ path: 'N.md', before: `note ${i}`, after: i % 2 ? `after ${i}` : null, expired: false }));
  let cps = make(25);
  let gone = L.pruneCheckpoints(cps, 20, 1e9);
  assert.equal(gone.length, 5);
  assert.deepEqual(cps.map(c => c.expired), Array.from({ length: 25 }, (_, i) => i < 5));
  assert.ok(cps.slice(0, 5).every(c => c.before === null && c.after === null));
  assert.ok(cps.slice(5).every(c => typeof c.before === 'string'));
  assert.deepEqual(L.pruneCheckpoints(cps, 20, 1e9), [], 'pruning again finds nothing more');
  // by size: three notes of 1000 characters, room for 2500
  cps = [0, 1, 2].map(() => ({ path: 'N.md', before: 'x'.repeat(1000), after: null, expired: false }));
  gone = L.pruneCheckpoints(cps, 20, 2500);
  assert.deepEqual(cps.map(c => c.expired), [true, false, false]);
  // the newest keeps its copy even if it alone is over the limit
  cps = [{ path: 'N.md', before: 'x'.repeat(10), after: null, expired: false }, { path: 'N.md', before: 'x'.repeat(5000), after: null, expired: false }];
  L.pruneCheckpoints(cps, 20, 100);
  assert.deepEqual(cps.map(c => c.expired), [true, false]);
  assert.equal(L.CHECKPOINTS_KEPT, 20);
});

test('Rewind: the note is put back with one small change', () => {
  const apply = (a, c) => (c ? a.slice(0, c.from) + c.insert + a.slice(c.to) : a);
  const cases = [
    ['The quick brown fox.', 'The quick red fox.'], ['abc', 'abc'], ['', 'new text'], ['old text', ''], ['aaa', 'aa'], ['aa', 'aaa'],
    ['one\ntwo\nthree\n', 'one\nTWO\nthree\nfour\n'], ['x', 'y'], ['same start, différent end', 'same start, different end'],
    ['emoji 😀 here', 'emoji 😁 here'], ['😀', '😁😀'], ['abab', 'ab'],
  ];
  for (const [a, b] of cases) {
    const c = L.spliceChange(a, b);
    assert.equal(apply(a, c), b, `${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    if (a === b) assert.equal(c, null);
    else assert.ok(c.from <= c.to && c.to <= a.length);
  }
  assert.deepEqual(L.spliceChange('The quick brown fox.', 'The quick red fox.'), { from: 10, to: 15, insert: 'red' });
  const pair = L.spliceChange('emoji 😀 here', 'emoji 😁 here');
  assert.ok(!/[\uD800-\uDBFF]$/.test('emoji 😀 here'.slice(0, pair.from)), 'no surrogate pair is cut in two');
});

// ---------------------------------------------------------------- drawing a drop cap
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test('Draw a drop cap: which way each provider draws, and what it is asked for', () => {
  const s = over => Object.assign({}, L.DEFAULT_SETTINGS, over);
  assert.equal(L.DEFAULT_SETTINGS.openaiImageModel, 'gpt-image-2.5-sunburst');
  assert.equal(L.dropcapRoute(s({ provider: 'openai-api' })), 'image-api');
  assert.equal(L.dropcapRoute(s({ provider: 'codex' })), 'codex-image');
  for (const p of ['claude-code', 'anthropic', 'openai', 'demo']) assert.equal(L.dropcapRoute(s({ provider: p })), 'svg', p);
  assert.match(L.dropcapRouteNote(s({ provider: 'openai-api' })), /gpt-image-2\.5-sunburst.*charges for each image.*Experimental: this route has not been tried against the live API/);
  assert.match(L.dropcapRouteNote(s({ provider: 'codex' })), /Codex’s image tool, on your subscription/);
  assert.match(L.dropcapRouteNote(s({ provider: 'claude-code' })), /no image model.*line drawing \(SVG\).*Canva/);
  assert.match(L.dropcapRouteNote(s({ provider: 'demo' })), /one drawing of its own/);
  for (const [text, want] of [['t', 'T'], [' “Quietly', 'Q'], ['Élan', 'E'], ['7', ''], ['', ''], ['数', '']]) assert.equal(L.dropcapLetter(text), want, text);

  const fresh = L.dropcapImagePrompt({ letter: 'T', style: 'a woodcut initial with oak leaves', mono: true });
  assert.match(fresh, /capital letter T/);
  assert.match(fresh, /Style: a woodcut initial with oak leaves\./);
  assert.match(fresh, /Pure black ink only, on a plain white ground/);
  assert.match(fresh, /no other letters, words/);
  assert.match(L.dropcapImagePrompt({ letter: 'T', style: '', mono: false }), /Style: a woodcut initial with vine leaves\. On a plain, even ground/);
  const changed = L.dropcapImagePrompt({ letter: 'T', mono: true, change: 'add a small owl' });
  assert.match(changed, /^This image is an ornamental drop cap: the capital letter T/);
  assert.match(changed, /Change it as follows, keeping the letter and the manner of the drawing otherwise: add a small owl\./);

  assert.match(L.DROPCAP_SVG_SYSTEM, /no <text>, no fonts/);
  assert.match(L.DROPCAP_SVG_SYSTEM, /no scripts, links, images, external references/);
  assert.match(L.dropcapSvgMessage({ letter: 'G', style: '', mono: true }), /capital letter G as a drop cap.*pure black only/);
  assert.match(L.dropcapSvgMessage({ letter: 'G', mono: false, change: 'thicker frame', base: '<svg><path d="M0 0"/></svg>' }), /<svg><path d="M0 0"\/><\/svg>\n\nChange it as follows.*thicker frame\. Use a few flat colours/);

  assert.equal(L.extractSvg('Here you are:\n```svg\n<svg viewBox="0 0 4 4"><path d="M0 0h4"/></svg>\n```\nEnjoy.'), '<svg viewBox="0 0 4 4"><path d="M0 0h4"/></svg>');
  assert.equal(L.extractSvg('<SVG><g><svg/></g></SVG> trailing'), '<SVG><g><svg/></g></SVG>');
  assert.equal(L.extractSvg('I cannot draw.'), '');
  assert.equal(L.extractSvg('<svg> never closed'), '');
  const demo = L.demoDropcapSvg('w');
  assert.match(demo, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 400 400">.*>W<\/text><\/svg>$/);
  assert.doesNotMatch(demo, /script|href|url\(/i);

  assert.deepEqual(Array.from(L.bytesFromBase64(L.base64FromBytes(PNG))), Array.from(PNG));
  assert.equal(L.base64FromBytes(Uint8Array.from([104, 105])), 'aGk=');
  const big = new Uint8Array(70000).map((_, i) => i % 251);
  assert.deepEqual(L.bytesFromBase64(L.base64FromBytes(big)), big);
  assert.equal(L.isPng(PNG), true);
  assert.equal(L.isPng(new TextEncoder().encode('<html>not an image</html>')), false);
  assert.equal(L.isPng(null), false);
});

test('Draw a drop cap, OpenAI API: the Images API is asked for one PNG, and an existing image goes to edits (a stand-in for the API; not tried live)', async () => {
  const s = Object.assign({}, L.DEFAULT_SETTINGS, { provider: 'openai-api', openaiPlatformKey: 'sk-test', openaiPlatformModel: 'gpt-x' });
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return jsonResponse(200, { created: 1, data: [{ b64_json: L.base64FromBytes(PNG) }] });
  };
  const made = await L.drawDropcap(s, { letter: 'T', style: 'oak leaves', mono: true }, { fetch });
  assert.deepEqual([made.kind, made.model, Array.from(made.bytes)], ['png', 'gpt-image-2.5-sunburst', Array.from(PNG)]);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/images/generations');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['background', 'model', 'n', 'output_format', 'prompt', 'size']);
  assert.deepEqual([calls[0].body.model, calls[0].body.n, calls[0].body.size, calls[0].body.output_format, calls[0].body.background],
    ['gpt-image-2.5-sunburst', 1, '1024x1024', 'png', 'opaque']);
  assert.match(calls[0].body.prompt, /capital letter T.*oak leaves/);
  // in colour: a clear ground is asked for; another image model, from the settings
  await L.drawDropcap(Object.assign({}, s, { openaiImageModel: 'gpt-image-2' }), { letter: 'T', style: '', mono: false }, { fetch });
  assert.deepEqual([calls[1].body.model, calls[1].body.background], ['gpt-image-2', 'transparent']);
  // changing the present image
  await L.drawDropcap(s, { letter: 'T', mono: true, change: 'add a small owl', base: { bytes: PNG, kind: 'png' } }, { fetch });
  assert.equal(calls[2].url, 'https://api.openai.com/v1/images/edits');
  assert.deepEqual(calls[2].body.images, [{ image_url: `data:image/png;base64,${L.base64FromBytes(PNG)}` }]);
  assert.match(calls[2].body.prompt, /add a small owl/);
  await assert.rejects(L.drawDropcap(s, { letter: 'T', mono: true, change: 'x', base: { bytes: new TextEncoder().encode('<svg/>'), kind: 'svg' } }, { fetch }), /line drawing \(SVG\), which an image model cannot be handed/);
  assert.equal(calls.length, 3, 'nothing is sent for that');

  // what can go wrong
  await assert.rejects(L.drawDropcap(Object.assign({}, s, { openaiPlatformKey: '' }), { letter: 'T' }, { fetch }), /Add your OpenAI API key/);
  await assert.rejects(L.drawDropcap(s, { letter: '7' }, { fetch }), /one letter, A to Z/);
  await assert.rejects(L.drawDropcap(s, { letter: 'T' }, { fetch: async () => jsonResponse(200, { data: [] }) }), /answered without an image/);
  await assert.rejects(L.drawDropcap(s, { letter: 'T' }, { fetch: async () => jsonResponse(200, { data: [{ b64_json: 'aGVsbG8gd29ybGQh' }] }) }), /not a PNG image/);
  await assert.rejects(L.drawDropcap(s, { letter: 'T' }, { fetch: async () => jsonResponse(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }) }),
    e => e instanceof L.LagrangeError && e.status === 401);
  await assert.rejects(L.drawDropcap(s, { letter: 'T' }, { fetch: async () => { throw new TypeError('Failed to fetch'); } }), e => e instanceof L.LagrangeError && e.kind === 'network');
  let tries = 0;
  const after = await L.drawDropcap(s, { letter: 'T' }, { retryDelays: [1, 1], fetch: async () => (++tries < 2 ? jsonResponse(503, {}) : jsonResponse(200, { data: [{ b64_json: L.base64FromBytes(PNG) }] })) });
  assert.deepEqual([tries, after.kind], [2, 'png']);
});

test('Draw a drop cap, ChatGPT subscription: Codex paints in an empty folder it may write to, and the image is read from there', { skip: !posix }, async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lagrange-cli-'));
  const exe = fakeCli(dir, 'codex', `
let input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
  const fs = require('fs'), path = require('path'), a = process.argv.slice(2);
  const cwd = a[a.indexOf('-C') + 1];
  const ok = a[0] === 'exec' && a.includes('--json') && a.includes('--ephemeral') && a.includes('--skip-git-repo-check') && a[a.indexOf('-s') + 1] === 'workspace-write'
    && a[a.length - 1] === '-' && fs.readdirSync(cwd).filter(f => f !== 'present.png').length === 0 && /lagrange-dropcap-/.test(cwd);
  fs.writeFileSync(${JSON.stringify(path.join('DIR', 'seen.json')).replace('DIR', "' + __dirname + '").replace(/^"/, "'").replace(/"$/, "'")}, JSON.stringify({ ok, cwd, input, image: a.includes('-i') ? Array.from(fs.readFileSync(a[a.indexOf('-i') + 1])) : null }));
  if (!input.includes('NOPE')) fs.writeFileSync(path.join(cwd, 'dropcap.png'), Buffer.from(input.includes('JUNK') ? 'not an image' : ${JSON.stringify(Array.from(PNG))}));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: input.includes('NOPE') ? 'NO-IMAGE-TOOL' : 'Saved dropcap.png' } }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
});`);
  const s = Object.assign({}, L.DEFAULT_SETTINGS, { provider: 'codex', codexPath: exe });
  const seen = () => JSON.parse(fs.readFileSync(path.join(dir, 'seen.json'), 'utf8'));
  const made = await L.drawDropcap(s, { letter: 'T', style: 'oak leaves', mono: true }, {});
  assert.deepEqual([made.kind, Array.from(made.bytes)], ['png', Array.from(PNG)]);
  assert.equal(seen().ok, true, 'the flags, and an empty folder of its own');
  assert.match(seen().input, /built-in image generation tool \(do not write code, a script or an SVG\)[\s\S]*capital letter T[\s\S]*oak leaves[\s\S]*Save it in the current directory as dropcap\.png/);
  assert.equal(seen().image, null);
  assert.equal(fs.existsSync(seen().cwd), false, 'the folder is removed afterwards');
  // changing the present image: it is attached
  await L.drawDropcap(s, { letter: 'T', mono: true, change: 'add a small owl', base: { bytes: PNG, kind: 'png' } }, {});
  assert.deepEqual(seen().image, Array.from(PNG));
  assert.match(seen().input, /a changed version of the attached image[\s\S]*add a small owl/);
  await assert.rejects(L.drawDropcap(s, { letter: 'T', mono: true, style: 'NOPE' }, {}), /This Codex has no image tool/);
  await assert.rejects(L.drawDropcap(s, { letter: 'T', mono: true, style: 'JUNK' }, {}), /not a PNG image/);
  await assert.rejects(L.drawDropcap(Object.assign({}, s, { codexPath: path.join(dir, 'absent') }), { letter: 'T' }, {}), /Codex wasn’t found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Draw a drop cap, the other providers: the model writes an SVG; the Demo has its own', async () => {
  const demo = Object.assign({}, L.DEFAULT_SETTINGS, { provider: 'demo' });
  const d = await L.drawDropcap(demo, { letter: 'Q', style: 'anything', mono: true }, {});
  assert.equal(d.kind, 'svg');
  assert.equal(new TextDecoder().decode(d.bytes), L.demoDropcapSvg('Q'));
  // an OpenAI-compatible server stands in for any language model
  const s = Object.assign({}, L.DEFAULT_SETTINGS, { provider: 'openai', openaiBaseUrl: 'http://localhost:1/v1', openaiModel: 'm' });
  const bodies = [];
  const reply = text => async (url, init) => { bodies.push(JSON.parse(init.body)); return jsonResponse(200, { choices: [{ message: { content: text }, finish_reason: 'stop' }] }); };
  const drawn = await L.drawDropcap(s, { letter: 'G', style: 'ivy', mono: true }, { fetch: reply('Here:\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><path d="M0 0h9"/></svg>\nDone.') });
  assert.equal(new TextDecoder().decode(drawn.bytes), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><path d="M0 0h9"/></svg>');
  assert.equal(bodies[0].messages[0].content, L.DROPCAP_SVG_SYSTEM);
  assert.match(bodies[0].messages[1].content, /capital letter G as a drop cap\. Style: ivy\./);
  // changing one: the present SVG goes back as text; a picture cannot
  const base = { bytes: new TextEncoder().encode('<svg><circle r="3"/></svg>'), kind: 'svg' };
  await L.drawDropcap(s, { letter: 'G', mono: true, change: 'a thicker frame', base }, { fetch: reply('<svg><circle r="4"/></svg>') });
  assert.match(bodies[1].messages[1].content, /<svg><circle r="3"\/><\/svg>[\s\S]*a thicker frame/);
  await assert.rejects(L.drawDropcap(s, { letter: 'G', mono: true, change: 'x', base: { bytes: PNG, kind: 'png' } }, { fetch: reply('') }), /can only change a line drawing/);
  await assert.rejects(L.drawDropcap(s, { letter: 'G', mono: true }, { fetch: reply('I would rather not draw.') }),
    e => e instanceof L.LagrangeError && /no SVG drawing/.test(e.message) && e.reply === 'I would rather not draw.');
});



/* ---------- 1.2.4: the pen under scrolling, clicks and typing; the chat's log; no hover bubbles ---------- */

test('penScript and wordCut: what is cut ends at a whole word, never inside one', () => {
  assert.equal(L.wordCut('alpha beta gamma', 100), 'alpha beta gamma');
  assert.equal(L.wordCut('alpha beta gamma', 12), 'alpha beta', 'the cut fell inside "gamma"');
  assert.equal(L.wordCut('alpha beta gamma', 10), 'alpha beta', 'the cut fell at the end of a word');
  assert.equal(L.wordCut('alpha beta gamma', 11), 'alpha beta', 'the cut fell on a space');
  assert.equal(L.wordCut('incomprehensibilities', 8), 'incompre', 'a single word longer than the room is cut: there is nothing else to write');
  assert.equal(L.wordCut('', 5), '');
  const show = s => s.map(g => (g.type === 'math' ? `<${g.source}>` : g.text)).join('');
  const para = 'Energy is never lost, only moved about: what a falling stone loses in height it gains in speed, and what it gains in speed it gives up, when it lands, as heat and sound.';
  for (const limit of [20, 48, 97, 150, 151, 152, 153, 154]) {
    const out = show(L.penScript(para, limit));
    assert.match(out, / …$/, `limit ${limit}`);
    const head = out.replace(/ …$/, '');
    assert.ok(para.startsWith(head), `limit ${limit}: a prefix of the text`);
    assert.ok(/[\s]/.test(para[head.length]), `limit ${limit}: “${head.slice(-12)}” ends at a whole word`);
  }
});

test('lineStarts: where each line of laid-out handwriting begins', () => {
  // three lines at heights 10, 30, 50; white space at a line's end takes no room (null) and belongs to the line before
  const tops = [10, 10, 10, null, 30, 30, null, null, 50];
  assert.deepEqual(L.lineStarts(tops, 8), [0, 4, 8]);
  assert.deepEqual(L.lineStarts([10, 11, 9.5, 10.4], 8), [0], 'the wobble of a baseline is not a new line');
  assert.deepEqual(L.lineStarts([], 8), [0]);
  assert.deepEqual(L.lineStarts([null, null], 8), [0]);
  assert.deepEqual(L.lineStarts([10, 30], 8), [0, 1]);
});

test('The pen’s lines: each is a box of its own with room for its letters’ tails, shown through a soft edge, inside the note’s scroller', () => {
  const css = fs.readFileSync(path.join(PLUGIN, 'styles.css'), 'utf8');
  const rule = sel => { const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(css); assert.ok(m, `a rule for ${sel}`); return m[1]; };
  const seg = rule('.lagrange-pen-seg');
  assert.match(seg, /display:\s*inline-block/);
  assert.match(seg, /visibility:\s*hidden/, 'unseen until the pen comes to it');
  const pad = /padding:\s*([\d.]+)em\s+([\d.]+)em/.exec(seg), margin = /margin:\s*-([\d.]+)em\s+-([\d.]+)em/.exec(seg);
  assert.ok(pad && margin, 'padding for the ascenders, descenders and swashes, taken back by the margin');
  assert.deepEqual([pad[1], pad[2]], [margin[1], margin[2]], 'so the line does not move');
  assert.ok(Number(pad[1]) >= 0.5 && Number(pad[2]) >= 0.35);
  assert.match(rule('.lagrange-pen-seg.is-writing'), /mask-image:\s*linear-gradient\(to right, #000 calc\(var\(--lagrange-pen-x, 0px\) - \d+px\), transparent var\(--lagrange-pen-x, 0px\)\)/);
  const sheet = rule('.lagrange-pen-sheet');
  assert.match(sheet, /position:\s*absolute/);
  assert.match(sheet, /overflow:\s*hidden/);
  assert.match(sheet, /pointer-events:\s*none/);
  assert.match(rule('.lagrange-pen-hand'), /position:\s*absolute/);
  assert.ok(!/\.lagrange-pen-(layer|hand)\s*\{[^}]*position:\s*fixed/.test(css), 'nothing of the pen is fixed to the window: it scrolls with the note');
  const js = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8');
  assert.match(js, /view\.scrollDOM\.appendChild\(sheet\)/);
  assert.ok(!/doc\.body\.appendChild\((svg|hand)\)/.test(js));
});

test('isEditKey: which key presses in the note end the pen’s animation', () => {
  const k = (key, mods) => Object.assign({ key }, mods);
  for (const key of ['a', 'Z', '1', ' ', 'é', '😀', 'Enter', 'Backspace', 'Delete', 'Tab', 'Process', 'Dead']) assert.equal(L.isEditKey(k(key)), true, key);
  for (const key of ['ArrowLeft', 'ArrowDown', 'PageDown', 'Home', 'End', 'Shift', 'Control', 'Alt', 'Meta', 'Escape', 'F5', 'CapsLock']) assert.equal(L.isEditKey(k(key)), false, key);
  for (const key of ['v', 'x', 'z', 'y', 'V', 'Z']) {
    assert.equal(L.isEditKey(k(key, { ctrlKey: true })), true, `Ctrl+${key}`);
    assert.equal(L.isEditKey(k(key, { metaKey: true })), true, `Cmd+${key}`);
  }
  for (const key of ['c', 'a', 'f', 'p', 's', 'ArrowLeft']) assert.equal(L.isEditKey(k(key, { ctrlKey: true })), false, `Ctrl+${key} changes nothing`);
  assert.equal(L.isEditKey(k('a', { isComposing: true })), true);
  assert.equal(L.isEditKey(k('@', { altKey: true })), true, 'AltGr characters');
  assert.equal(L.isEditKey(null), false);
});

test('mapOffset: a position carried through changes, as CodeMirror carries it', () => {
  const changes = [{ from: 5, to: 5, insert: 'XYZ' }, { from: 10, to: 14, insert: 'q' }, { from: 20, to: 22, insert: '' }];
  assert.equal(L.mapOffset(changes, 0), 0);
  assert.equal(L.mapOffset(changes, 4), 4);
  assert.equal(L.mapOffset(changes, 5), 5, 'at an insertion: before it by default');
  assert.equal(L.mapOffset(changes, 5, -1), 5);
  assert.equal(L.mapOffset(changes, 5, 1), 8, 'or after it');
  assert.equal(L.mapOffset(changes, 6), 9);
  assert.equal(L.mapOffset(changes, 10), 13, 'the start of replaced text');
  assert.equal(L.mapOffset(changes, 10, 1), 13);
  assert.equal(L.mapOffset(changes, 12), 13, 'inside replaced text: the start of what replaced it');
  assert.equal(L.mapOffset(changes, 12, 1), 14, 'or its end');
  assert.equal(L.mapOffset(changes, 14), 14, 'the end of replaced text');
  assert.equal(L.mapOffset(changes, 15), 15);
  assert.equal(L.mapOffset(changes, 21), 20, 'inside deleted text');
  assert.equal(L.mapOffset(changes, 30), 28);
  assert.equal(L.mapOffset([{ from: 3, to: 3, insert: 4 }], 9), 13, 'an insert may be given as a length');
  assert.equal(L.mapOffset([], 7), 7);
});

test('remapEdit: an edit still to be written follows its words through what the writer types; changed words are skipped', () => {
  const doc = 'One two three. Four five six. Seven eight nine.';
  const edit = { from: 15, to: 29, matched: 'Four five six.', replace: '4 5 6.' };
  const apply = (text, changes) => { let out = '', at = 0; for (const c of changes) { out += text.slice(at, c.from) + c.insert; at = c.to; } return out + text.slice(at); };
  const through = changes => { const now = apply(doc, changes); return L.remapEdit(edit, (p, a) => L.mapOffset(changes, p, a), (a, b) => now.slice(a, b)); };
  assert.deepEqual(through([]), { from: 15, to: 29 });
  assert.deepEqual(through([{ from: 0, to: 0, insert: 'Zero. ' }]), { from: 21, to: 35 }, 'typing before it moves it');
  assert.deepEqual(through([{ from: 40, to: 40, insert: 'and ' }]), { from: 15, to: 29 }, 'typing after it does not');
  assert.deepEqual(through([{ from: 15, to: 15, insert: 'Also: ' }]), { from: 21, to: 35 }, 'typing right before its first word');
  assert.deepEqual(through([{ from: 29, to: 29, insert: ' Yes.' }]), { from: 15, to: 29 }, 'typing right after its last');
  assert.deepEqual(through([{ from: 20, to: 24, insert: 'FIVE' }]), { skip: 'the text changed' }, 'the writer changed its words');
  assert.deepEqual(through([{ from: 22, to: 22, insert: '!' }]), { skip: 'the text changed' }, 'the writer typed inside them');
  assert.deepEqual(through([{ from: 10, to: 35, insert: '' }]), { skip: 'the text changed' }, 'the writer deleted them');
  // an insertion is never spoiled: it goes where its place went
  const ins = { from: 14, to: 14, matched: '', replace: ' More.' };
  assert.deepEqual(L.remapEdit(ins, (p, a) => L.mapOffset([{ from: 0, to: 4, insert: '' }], p, a), () => ''), { from: 10, to: 10 });
  assert.deepEqual(L.remapEdit(ins, (p, a) => L.mapOffset([{ from: 14, to: 14, insert: 'abc' }], p, a), () => ''), { from: 17, to: 17 }, 'after what the writer typed at the same place');
});

test('stickAfterScroll: the chat keeps to its bottom until the writer scrolls up, and takes hold again at the bottom', () => {
  const H = 1000, C = 400;                       // the bottom is at scrollTop 600
  assert.equal(L.stickAfterScroll(true, 600, 600, H, C), true);
  assert.equal(L.stickAfterScroll(true, 600, 590, H, C), true, 'a nudge within the slack');
  assert.equal(L.stickAfterScroll(true, 600, 300, H, C), false, 'the writer scrolled up');
  assert.equal(L.stickAfterScroll(false, 300, 320, H, C), false, 'and part of the way down again');
  assert.equal(L.stickAfterScroll(false, 320, 560, H, C), true, 'back at the bottom');
  // The bug this replaced: the log scrolled itself to the bottom, the loader then made it 200 px taller, and the
  // scroll event (which arrives late) found the log "not at the bottom" and let go.
  assert.equal(L.stickAfterScroll(true, 0, 600, H + 200, C), true, 'the log’s own scroll down never lets go, whatever was added since');
  assert.equal(L.stickAfterScroll(true, 600, 600, H + 200, C), true, 'nor does growing');
  assert.equal(L.stickAfterScroll(false, 600, 600, H + 200, C), false, 'a writer who had let go is left alone');
  assert.equal(L.stickAfterScroll(true, 600, 590, H, C, 5), false, 'the slack can be set');
});

test('No hover bubbles: the panel, the modals and the settings turn Obsidian’s tooltips off, keep their labels, and have no title attributes', () => {
  const css = fs.readFileSync(path.join(PLUGIN, 'styles.css'), 'utf8');
  const m = /([^{}]*)\{\s*--no-tooltip:\s*true;\s*\}/.exec(css);
  assert.ok(m, 'Obsidian shows no tooltip for an element whose --no-tooltip is true');
  for (const sel of ['.lagrange-view', '.lagrange-modal', '.lagrange-settings', '.lagrange-notice-undo']) assert.ok(m[1].split('*/').pop().split(',').map(x => x.trim()).includes(sel), sel);
  const js = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8');
  assert.ok(!/setAttribute\('title'|\btitle:\s*'|setTooltip\(|setDynamicTooltip\(/.test(js), 'no title attribute and no tooltip call');
  for (const label of ['Proofread the note', 'Undo Lagrange’s last edits', 'Redo Lagrange’s edits', 'Clear the conversation', 'Message to Lagrange', 'Rewind to here']) {
    assert.ok(js.includes(label), `the accessible name “${label}” stays`);
  }
  assert.match(js, /setAttribute\('aria-label', `Model: /);
});

test('Editing while the pen writes: off by default, a setting, and a run never locks or reconfigures the editor', () => {
  assert.equal(L.DEFAULT_SETTINGS.editWhileWriting, false);
  assert.equal(L.sanitizeSettings({ editWhileWriting: true }).editWhileWriting, true);
  assert.equal(L.sanitizeSettings({ editWhileWriting: 'yes' }).editWhileWriting, false);
  const js = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8');
  assert.match(js, /setName\('Let me edit while the pen writes'\)/);
  assert.ok(!/readOnly\.of\(true\)|editable\.of\(false\)|\.reconfigure\(/.test(js), 'the editor stays editable, and is not reconfigured (which makes Typewriter Mode scroll back to the cursor)');
  for (const type of ['pointerdown', 'mousedown', 'beforeinput', 'paste', 'drop', 'compositionstart', 'keydown']) assert.ok(js.includes(`'${type}'`), `${type} is listened for`);
  // Obsidian replaces a note's first character by itself to have it highlighted afresh: that is not the writer typing
  assert.equal(js.split('tr.startState.doc.eq(tr.state.doc)').length - 1, 2, 'a change that leaves the text as it was neither ends a run nor moves the pen');
  // text the pen has yet to write is unseen, and so are the boxes around it (a code block's tint, a code span's)
  const css = fs.readFileSync(path.join(PLUGIN, 'styles.css'), 'utf8');
  assert.match(css, /\.cm-line\.lagrange-pen-unwritten-line \{[^}]*background-color: transparent !important/);
  assert.match(css, /span:has\(> \.lagrange-pen-of-3\):not\(\.lagrange-pen-unwritten\) \{[^}]*background-color: transparent !important/);
});

test('Rewind: a turn during which the writer typed is not taken for Lagrange’s alone', () => {
  const turns = [{ path: 'N.md', before: 'A', after: 'B', userTyped: true }];
  assert.equal(L.userChangedSince(turns, 0, 'B'), true, 'the writer is asked before their typing is taken back');
  assert.equal(L.userChangedSince([{ path: 'N.md', before: 'A', after: 'B', userTyped: false }], 0, 'B'), false);
});

test('Undo records: one that no longer fits the editor’s text is forgotten, not composed with', () => {
  // (another note opened in the same tab: Obsidian sets a new text without a change; composing a record of the old
  // text with later changes threw, and every later record of that editor stopped following the writer's typing)
  const js = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8');
  assert.match(js, /kept\.newLength !== update\.startState\.doc\.length\) \{ \(lost \|\| \(lost = \[\]\)\)\.push\(r\); continue; \}/);
  assert.match(js, /this\.edits = this\.edits\.filter\(r => !lost\.includes\(r\)\)/);
  // the handwriting's font is waited for before the hand is measured
  assert.match(js, /doc\.fonts\.load\(font\)/);
});


// ---------- Centred and right-aligned text (Scriptorium's "::: center" and "::: right") ----------

test('every system prompt tells the model how text is centred, to centre verse always, and to ask for no drop cap there', () => {
  const note = { title: 'Verse' }, clip = { text: 'Some text.', clipped: false, total: 10 };
  const prompts = {
    'chat (with the pen)': L.chatSystemPrompt(note, clip, true), 'chat (talk only)': L.chatSystemPrompt(note, clip, false),
    'chat (no note)': L.chatSystemPrompt(null, null, true), revise: L.REVISE_SYSTEM, proofread: L.PROOFREAD_SYSTEM,
  };
  for (const [name, text] of Object.entries(prompts)) assert.ok(text.includes(L.ALIGN_STYLE), name);
  const a = L.ALIGN_STYLE;
  assert.match(a, /"::: center"/);
  assert.match(a, /"::: right"/);
  assert.match(a, /":::" on a line of its own/);
  assert.match(a, /blank line before the opening marker and after the closing one/);
  assert.match(a, /Always centre poetry and verse/);
  assert.match(a, /epigraph/);
  assert.match(a, /attribution or a signature[^.]*to the right with "::: right" when the writer asks/);
  assert.match(a, /never write "dropcap" on a marker line[^.]*unless the writer asks for a drop cap/);
  assert.match(a, /never use HTML or a callout to align text/);
  // the proofreader is told that the markers are syntax, before it is told what to reply with
  assert.ok(L.PROOFREAD_SYSTEM.indexOf(L.ALIGN_STYLE) < L.PROOFREAD_SYSTEM.indexOf('Reply with only a JSON array'));
  // and the instruction is one constant, in each prompt once
  for (const text of Object.values(prompts)) assert.equal(text.split(L.ALIGN_STYLE).length, 2);
});

test('the pen and aligned text: a marker line is no text (the pen starts after it, and never writes one)', () => {
  for (const line of ['::: center', ':::center', '::: right', '::: centre dropcap', '::: {.center .dropcap}', ':::', '  :::: ', '::: right :::']) assert.ok(L.ALIGN_MARK.test(line), line);
  for (const line of ['::: note', ':: center', 'a ::: center', '::: rightly', 'Tyger Tyger', '']) assert.ok(!L.ALIGN_MARK.test(line), line);
  assert.equal(L.inkOffset('::: center\nTyger Tyger'), 11);
  assert.equal(L.inkOffset('\n\n::: right\n— Blake\n:::'), 12);
  assert.equal(L.inkOffset('\n:::\n\n::: right\n— Blake\n:::'), 16, 'one block is closed and another opened');
  assert.equal(L.inkOffset('::: center\n## A heading'), 14, 'and then what opens a block, as ever');
  assert.equal(L.inkOffset('\n:::'), 4, 'a closing marker alone: nothing to write');
  assert.equal(L.inkOffset('::: note\ntext'), 0, 'another kind of container is text');
  assert.equal(L.inkOffset(':::: not a marker line'), 0);
  const show = segs => segs.map(g => (g.type === 'math' ? `<${g.source}>` : g.text)).join('');
  assert.equal(show(L.penScript('::: center\nTyger Tyger, burning bright,\nIn the forests of the night;\n:::', 80)), 'Tyger Tyger, burning bright, In the forests of the night;');
  assert.equal(show(L.penScript('Prose first.\n\n::: right\n— Blake\n:::', 80)), 'Prose first. — Blake');
  assert.equal(show(L.penScript('a ::: b', 80)), 'a ::: b', 'colons inside a line are text');
  assert.deepEqual(L.penScript(':::', 80), []);
});

// ---------------------------------------------------------------- looking at the page
// A page as measurePage records it (what a real page measures like is checked in Obsidian itself; here, what is
// made of the measurements).
const PAGE = { width: 836, height: 1969, column: { left: 38, width: 760 }, theme: 'dark', font: 'EB Garamond', size: 22, margin: false };
const BLOCKS = [
  { kind: 'title', text: 'Look check', top: 32, bottom: 75, align: 'center', font: 'EB Garamond', size: 35.6, lines: 1 },
  { kind: 'heading', level: 6, text: 'A synthetic note', from: 5, to: 5, top: 80, bottom: 143, align: 'center', font: 'EB Garamond', size: 26.4, italic: true, lines: 1 },
  { kind: 'paragraph', text: 'Quietly the compositor sets his stick, and the first line falls into small capitals.', from: 10, to: 10, top: 288, bottom: 416,
    align: 'left', font: 'EB Garamond', size: 22, lines: 4, dropcap: { letter: 'Q', font: 'Scriptorium Yinit', size: 80.7, deep: 3 }, firstLineCaps: true,
    math: ['e^{i\\pi} + 1 = 0'], notes: [{ label: '1', where: 'margin' }] },
  { kind: 'paragraph', text: 'A second paragraph follows.', from: 12, to: 12, top: 415, bottom: 511, align: 'justify', font: 'EB Garamond', size: 22, lines: 3 },
  { kind: 'heading', level: 2, text: 'A displayed equation', from: 14, to: 14, top: 566, bottom: 605, align: 'center', font: 'EB Garamond', size: 32.2, smallCaps: true, lines: 1 },
  { kind: 'math', text: '', from: 16, to: 18, top: 643, bottom: 710, align: 'center', math: ['\\int_0^1 x^2 \\, dx = \\frac{1}{3}'] },
  { kind: 'picture', text: '', from: 26, to: 26, top: 906, bottom: 1041, align: 'center', images: [{ alt: 'A synthetic plate', width: 240, height: 135 }] },
  { kind: 'heading', level: 3, text: 'A list and a table', from: 28, to: 28, top: 1096, bottom: 1134, align: 'center', font: 'EB Garamond', size: 29, lines: 1 },
  { kind: 'code', language: 'js', text: 'const look = 1;', from: 39, to: 41, top: 1431, bottom: 1532, align: 'left', font: 'Scriptorium Mono', size: 18.5, lines: 2, overflow: 212, scrolls: true },
  { kind: 'heading', level: 2, text: 'The second chapter', from: 45, to: 45, top: 1647, bottom: 1686, align: 'center', font: 'EB Garamond', size: 32.2, lines: 1 },
  { kind: 'paragraph', text: 'Second chapters open with a drop cap too.', from: 47, to: 47, top: 1724, bottom: 1788, align: 'left', font: 'EB Garamond', size: 22, lines: 2, dropcap: { letter: 'S', image: true, size: 91 } },
];
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
function lookOf(over) {
  const look = Object.assign({ spec: { target: 'note' }, label: 'the whole note', title: 'Look check', path: 'Look check.md', page: PAGE, blocks: BLOCKS,
    pictures: [{ mediaType: 'image/png', data: PNG_B64, width: 836, height: 1536, top: 0, bottom: 1536 }, { mediaType: 'image/png', data: PNG_B64, width: 836, height: 433, top: 1536, bottom: 1969 }],
    more: 0, remarks: [], problem: '' }, over);
  look.description = L.describeLook(look, L.LOOK_DESCRIPTION_CHARS);
  return look;
}

test('Look contract: a reply’s look block is read in its several shapes, and comes out of the prose', () => {
  const a = L.parseLookReply('Let me see how it sits.\n\n```lagrange-look\n{"target": "section", "heading": "De litteris"}\n```');
  assert.equal(a.text, 'Let me see how it sits.');
  assert.deepEqual(a.look, { target: 'section', heading: 'De litteris' });
  assert.equal(a.open, false);
  assert.deepEqual(L.parseLookReply('No block here: a plain answer.'), { text: 'No block here: a plain answer.', look: null, open: false });
  // every target the contract names
  const of = body => L.parseLookReply(`x\n\n${FENCE}lagrange-look\n${body}\n${FENCE}`).look;
  assert.deepEqual(of('{"target": "note"}'), { target: 'note' });
  assert.deepEqual(of('{"target": "view"}'), { target: 'view' });
  assert.deepEqual(of('{"target": "passage", "near": "sets his stick"}'), { target: 'passage', near: 'sets his stick' });
  assert.deepEqual(of('{"target": "lines", "from": 12, "to": 40}'), { target: 'lines', from: 12, to: 40 });
  // and what models write instead
  assert.deepEqual(of('{"target":"viewport"}'), { target: 'view' });
  assert.deepEqual(of('{"heading": "## De litteris"}'), { target: 'section', heading: 'De litteris' });
  assert.deepEqual(of('{"lines": [40, 12]}'), { target: 'lines', from: 12, to: 40 });
  assert.deepEqual(of('{"lines": "12-40"}'), { target: 'lines', from: 12, to: 40 });
  assert.deepEqual(of('{"target": "lines", "from": 7}'), { target: 'lines', from: 7, to: 7 });
  assert.deepEqual(of('[{"target": "note"}]'), { target: 'note' });
  assert.deepEqual(of('{"target": "note", "heading": "ignored"}'), { target: 'note' });
  assert.deepEqual(of('note'), { target: 'note' });
  assert.deepEqual(of('the whole note'), { target: 'note' });
  assert.deepEqual(of('section: De litteris'), { target: 'section', heading: 'De litteris' });
  assert.deepEqual(of('lines 12-40'), { target: 'lines', from: 12, to: 40 });
  // a block that says nothing readable still gets a look: the whole note if it is short, else what is on screen
  for (const junk of ['', '{}', '{"target": "section"}', 'whatever you think best', '{"target": "lines", "from": 0, "to": -3}']) assert.deepEqual(of(junk), { target: 'auto' }, junk);
  // tags instead of a fence; a block still streaming is kept out of the prose
  assert.deepEqual(L.parseLookReply('See.\n<lagrange-look>{"target": "view"}</lagrange-look>').look, { target: 'view' });
  const streaming = L.parseLookReply('Let me look.\n\n```lagrange-look\n{"target": "no');
  assert.equal(streaming.text, 'Let me look.');
  assert.equal(streaming.open, true);
  // with an edits block in the same reply: the look comes out, the edits stay for parseAgentReply
  const both = L.parseLookReply('Done, and checking.\n\n```lagrange-edits\n[{"append": "A line."}]\n```\n\n```lagrange-look\n{"target": "note"}\n```');
  assert.deepEqual(both.look, { target: 'note' });
  const edits = L.parseAgentReply(both.text);
  assert.equal(edits.text, 'Done, and checking.');
  assert.deepEqual(edits.ops, [{ op: 'append', text: 'A line.', reason: '' }]);
  // the edits block alone is read as before
  assert.deepEqual(L.splitAgentReply('A.\n\n```lagrange-edits\n[]\n```'), L.splitBlocks('A.\n\n```lagrange-edits\n[]\n```', 'lagrange-edits'));
  assert.equal(L.lookLabel({ target: 'note' }), 'the whole note');
  assert.equal(L.lookLabel({ target: 'view' }), 'what is on screen');
  assert.equal(L.lookLabel({ target: 'section', heading: 'De litteris' }), 'the section “De litteris”');
  assert.equal(L.lookLabel({ target: 'lines', from: 3, to: 9 }), 'lines 3 to 9');
  assert.match(L.lookLabel({ target: 'passage', near: 'sets his stick' }), /^the passage near “sets his stick”$/);
});

test('Look contract: the chat prompt names it when looking is on and a note is open, and only then', () => {
  const note = { title: 'Tides', text: 'The sea.' }, clip = L.clipText(note.text, 1000);
  const on = L.chatSystemPrompt(note, clip, true, true);
  assert.ok(on.includes(L.CHAT_LOOK));
  assert.match(on, /```lagrange-look\n\{"target": "note"\}\n```/);
  for (const target of ['"target": "view"', '"target": "section", "heading"', '"target": "passage", "near"', '"target": "lines", "from": 12, "to": 40']) assert.ok(on.includes(target), target);
  assert.match(on, /at most twice for one message/);
  assert.equal(L.LOOKS_PER_MESSAGE, 2);
  assert.match(on, /A reply may hold an edits block and, after it, a look block: your pen writes the edits first, and the look then shows the page as it stands after them/);
  assert.ok(on.indexOf('lagrange-edits') < on.indexOf('lagrange-look') && on.indexOf('lagrange-look') < on.indexOf('<note>'), 'after the pen’s contract, before the note');
  const talk = L.chatSystemPrompt(note, clip, false, true);
  assert.ok(talk.includes(L.CHAT_LOOK));
  assert.doesNotMatch(talk, /your pen writes the edits first/);
  for (const off of [L.chatSystemPrompt(note, clip, true, false), L.chatSystemPrompt(note, clip, true), L.chatSystemPrompt(null, null, true, true)]) assert.doesNotMatch(off, /lagrange-look/);
});

test('Look settings: on by default; pictures where the model takes them, words otherwise, on a phone, in the demo and when turned off', () => {
  assert.equal(L.DEFAULT_SETTINGS.lookAtPage, true);
  assert.equal(L.DEFAULT_SETTINGS.lookPictures, 'auto');
  assert.equal(L.sanitizeSettings({ lookAtPage: false }).lookAtPage, false);
  assert.equal(L.sanitizeSettings({ lookAtPage: 'no' }).lookAtPage, true);
  assert.equal(L.sanitizeSettings({ lookPictures: 'sometimes' }).lookPictures, 'auto');
  for (const v of L.LOOK_PICTURES) assert.equal(L.sanitizeSettings({ lookPictures: v }).lookPictures, v);
  const s = over => Object.assign({}, L.DEFAULT_SETTINGS, over);
  const takes = over => L.picturesSupported(s(over));
  assert.equal(takes({ provider: 'claude-code' }), true);
  assert.equal(takes({ provider: 'codex' }), true);
  for (const m of L.ANTHROPIC_MODELS) assert.equal(takes({ provider: 'anthropic', anthropicModel: m.id }), true, m.id);
  assert.equal(takes({ provider: 'anthropic', anthropicModel: 'custom', anthropicCustomModel: 'claude-opus-4-8' }), true);
  assert.equal(takes({ provider: 'anthropic', anthropicModel: 'custom', anthropicCustomModel: 'claude-2.1' }), false);
  for (const m of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-5', 'gpt-5.2-mini', 'o3', 'o4-mini']) assert.equal(takes({ provider: 'openai-api', openaiPlatformModel: m }), true, m);
  for (const m of ['gpt-3.5-turbo', 'o1-mini', 'o3-mini', 'gpt-4o-audio-preview', 'text-embedding-3-large', '']) assert.equal(takes({ provider: 'openai-api', openaiPlatformModel: m }), false, m);
  for (const m of ['llava:13b', 'llama3.2-vision', 'qwen2.5vl:7b', 'gemma3:12b', 'minicpm-v']) assert.equal(takes({ provider: 'openai', openaiModel: m }), true, m);
  for (const m of ['llama3.1', 'qwen2.5:14b', 'mistral', '']) assert.equal(takes({ provider: 'openai', openaiModel: m }), false, m);
  assert.equal(takes({ provider: 'demo' }), false);
  const sends = (over, desktop, session) => L.lookSendsPictures(s(over), desktop, session);
  assert.equal(sends({ provider: 'anthropic' }, true), true);
  assert.equal(sends({ provider: 'anthropic' }, false), false, 'no picture is taken on a phone or tablet');
  assert.equal(sends({ provider: 'anthropic', lookPictures: 'off' }, true), false);
  assert.equal(sends({ provider: 'openai', openaiModel: 'llama3.1' }, true), false);
  assert.equal(sends({ provider: 'openai', openaiModel: 'llama3.1', lookPictures: 'on' }, true), true, 'the writer says the model takes them');
  assert.equal(sends({ provider: 'demo', lookPictures: 'on' }, true), false);
  // a provider that has turned pictures down this session is not sent them again
  const mine = s({ provider: 'openai', openaiModel: 'llama3.1', lookPictures: 'on' });
  assert.equal(L.providerKey(mine), 'openai:llama3.1');
  assert.equal(sends(mine, true, { noPictures: { 'openai:llama3.1': true } }), false);
  assert.equal(sends(mine, true, { noPictures: { 'openai:llava': true } }), true);
  assert.equal(L.providerKey(s({ provider: 'openai-api', openaiPlatformModel: 'gpt-5' })), 'openai:gpt-5');
  assert.equal(L.providerKey(s({ provider: 'claude-code' })), 'claude-code');
  assert.equal(L.providerKey(s({ provider: 'codex', codexModel: 'gpt-5' })), 'codex:gpt-5');
  // the setting, its neighbour and what they promise are in the settings page; the command is registered
  const js = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8');
  assert.match(js, /setName\('Let Lagrange look at the rendered page'\)/);
  assert.match(js, /setName\('Pictures of the page'\)/);
  assert.match(js, /to the provider chosen above ` \+\n\s*'and to no one else\. It does so only while Lagrange is answering a message of yours/);
  assert.match(js, /Off: the page is never rendered or captured\./);
  assert.match(js, /id: 'show-page',\n\s*name: 'Show Lagrange the rendered page'/);
  assert.match(js, /if \(!this\.settings\.lookAtPage\) throw new LagrangeError\('looking at the page is turned off/, 'nothing is rendered with the setting off');
});

test('Look caps: a picture is no wider than LOOK_WIDTH, a look no more than LOOK_PAGES pictures, cut where blocks end', () => {
  assert.equal(L.lookScale(836), 1);
  assert.equal(L.lookScale(L.LOOK_WIDTH), 1);
  assert.equal(L.lookScale(2048), 0.5);
  assert.ok(L.LOOK_WIDTH <= 1568 && L.LOOK_HEIGHT <= 1568, 'within the long edge Claude’s standard tier takes without shrinking the page');
  assert.equal(L.LOOK_PAGES, 4);
  // a short page is one picture
  assert.deepEqual(L.lookPages(0, 900, [100, 400], 1536, 4, 50), { pages: [{ top: 0, bottom: 900 }], more: 0 });
  // a longer one is cut at the last block that begins in the second half of the picture
  const two = L.lookPages(0, 1969, BLOCKS.map(b => b.top), 1536, 4, 50);
  assert.deepEqual(two, { pages: [{ top: 0, bottom: 1431 }, { top: 1431, bottom: 1969 }], more: 0 });
  // a block taller than a picture is cut through, and the next picture begins a little before the cut
  const tall = L.lookPages(0, 4000, [], 1536, 4, 50);
  assert.deepEqual(tall.pages.map(p => [p.top, p.bottom]), [[0, 1536], [1486, 3022], [2972, 4000]]);
  assert.equal(tall.more, 0);
  // the cap: four pictures, and how many more the rest would have taken
  const long = L.lookPages(0, 20000, [], 1536, 4, 0);
  assert.equal(long.pages.length, 4);
  assert.equal(long.pages[3].bottom, 4 * 1536);
  assert.equal(long.more, Math.ceil(20000 / 1536) - 4);
  for (const p of L.lookPages(120, 9000, [500, 2000, 2100, 5000, 7777], 1536, 4, 60).pages) assert.ok(p.bottom - p.top <= 1536 && p.bottom > p.top);
  // a note too long to render whole is rendered around the part asked for, front matter kept, cut at blank lines
  const para = n => `Paragraph ${n}. ${'word '.repeat(40).trim()}`;
  const text = `---\ndropcap: goudy\n---\n${Array.from({ length: 400 }, (_, i) => para(i + 1)).join('\n\n')}\n`;
  assert.deepEqual(L.lookSource('short', 1, 1000), { text: 'short', shift: 0, cut: false });
  const part = L.lookSource(text, 603, 6000);            // line 603 is paragraph 301
  assert.equal(part.cut, true);
  assert.ok(part.text.length <= 6000 + 30);
  assert.ok(part.text.startsWith('---\ndropcap: goudy\n---\n'));
  assert.match(part.text, /Paragraph 301\./);
  assert.doesNotMatch(part.text, /Paragraph 1\./);
  const lines = part.text.split('\n'), all = text.split('\n');
  const k = lines.findIndex(l => l.startsWith('Paragraph 301.'));
  assert.equal(all[k + part.shift], lines[k], 'a line of the part, plus the shift, is that line of the note');
  assert.match(lines[3], /^Paragraph \d+\./, 'the part begins with a whole paragraph');
});

test('Look: the source lines of each rendered block, from Obsidian’s sections', () => {
  const S = spec => spec.split(' ').map(x => { const [type, a, b] = x.split(/[:-]/); return { type, from: Number(a), to: Number(b) }; });
  // (the pairs below were read off Obsidian 1.15: its parser's sections against its renderer's elements)
  assert.deepEqual(L.alignSections(S('heading:0-0 paragraph:2-2 paragraph:4-4'), ['h1', 'p', 'p']), [{ from: 1, to: 1 }, { from: 3, to: 3 }, { from: 5, to: 5 }]);
  assert.deepEqual(L.alignSections(S('yaml:0-2 thematicBreak:4-4 paragraph:6-6'), ['pre', 'hr', 'p']), [{ from: 1, to: 3 }, { from: 5, to: 5 }, { from: 7, to: 7 }]);
  // a comment, a footnote's definition and a link's definition render nothing; the footnotes come last, as one section
  assert.deepEqual(L.alignSections(S('paragraph:0-0 comment:6-8 paragraph:10-10'), ['p', 'p']), [{ from: 1, to: 1 }, { from: 11, to: 11 }]);
  assert.deepEqual(L.alignSections(S('paragraph:0-0 footnoteDefinition:2-2 paragraph:4-4 text:5-5 element:5-5'), ['p', 'p', 'section']), [{ from: 1, to: 1 }, { from: 5, to: 5 }, null]);
  assert.deepEqual(L.alignSections(S('paragraph:0-0 definition:2-2 paragraph:4-4'), ['p', 'p']), [{ from: 1, to: 1 }, { from: 5, to: 5 }]);
  assert.deepEqual(L.alignSections(S('math:0-4 callout:6-7 code:9-11 html:13-13'), ['div', 'div', 'pre', 'center']).map(r => r.from), [1, 7, 10, 14]);
  // where they do not go together, nothing is said: an HTML block with blank lines in it is one element, three sections
  assert.equal(L.alignSections(S('html:0-0 paragraph:2-2 html:4-4 paragraph:6-6'), ['div', 'p']), null);
  assert.equal(L.alignSections(S('heading:0-0 paragraph:2-2'), ['p', 'h1']), null);
  assert.equal(L.alignSections(S('paragraph:0-0'), ['p', 'p']), null);
  assert.equal(L.alignSections(null, ['p']), null);
  assert.deepEqual(L.alignSections([], []), []);
});

test('Look: the part of the page a look is of', () => {
  const at = (spec, ctx) => { const r = L.lookRange(spec, BLOCKS, ctx || {}); return [BLOCKS[r.first].text || BLOCKS[r.first].kind, BLOCKS[r.last].text || BLOCKS[r.last].kind, r.remark]; };
  assert.deepEqual(at({ target: 'note' }), ['Look check', 'Second chapters open with a drop cap too.', '']);
  assert.deepEqual(at({ target: 'auto' }), ['Look check', 'Second chapters open with a drop cap too.', '']);
  // a section runs to the next heading of its level or above; one under it is part of it
  assert.deepEqual(at({ target: 'section', heading: 'A displayed equation' }), ['A displayed equation', 'const look = 1;', '']);
  assert.deepEqual(at({ target: 'section', heading: 'a list AND a table' }), ['A list and a table', 'const look = 1;', '']);
  assert.deepEqual(at({ target: 'section', heading: 'second chapter' }), ['The second chapter', 'Second chapters open with a drop cap too.', '']);
  assert.deepEqual(at({ target: 'section', heading: 'Look check' }), ['Look check', 'Second chapters open with a drop cap too.', ''], 'the title is the whole note');
  const missing = at({ target: 'section', heading: 'No such heading' });
  assert.equal(missing[0], 'Look check');
  assert.match(missing[2], /No heading reads “No such heading”, so this is the whole note\./);
  // lines: the blocks that hold them; between blocks, the block that follows
  assert.deepEqual(at({ target: 'lines', from: 10, to: 14 }), ['Quietly the compositor sets his stick, and the first line falls into small capitals.', 'A displayed equation', '']);
  assert.deepEqual(at({ target: 'lines', from: 17, to: 17 }), ['math', 'math', '']);
  assert.deepEqual(at({ target: 'lines', from: 20, to: 22 }), ['picture', 'picture', '']);
  assert.deepEqual(at({ target: 'lines', from: 900, to: 950 }), ['Second chapters open with a drop cap too.', 'Second chapters open with a drop cap too.', '']);
  // a passage comes with its neighbours
  assert.deepEqual(at({ target: 'passage', near: 'second paragraph' }, { near: { from: 12, to: 12 } }), ['Quietly the compositor sets his stick, and the first line falls into small capitals.', 'A displayed equation', '']);
  assert.match(at({ target: 'passage', near: 'not in the note' }, { near: null })[2], /not found in the note/);
  // what is on screen: by lines in the editor, by the first and last block's words in Reading view
  assert.deepEqual(at({ target: 'view' }, { seen: { from: 26, to: 41 } }), ['picture', 'const look = 1;', '']);
  assert.deepEqual(at({ target: 'view' }, { seen: { texts: ['A  second paragraph follows.', 'A displayed equation', '∫x²dx', '', 'A list and a table'] } }), ['A second paragraph follows.', 'A list and a table', '']);
  // (a block without words, at either end of what is in sight, is placed by its neighbours: here the equation and the picture)
  assert.deepEqual(at({ target: 'view' }, { seen: { texts: ['', 'A list and a table'] } }), ['picture', 'A list and a table', '']);
  assert.deepEqual(at({ target: 'view' }, { seen: { texts: ['A displayed equation', '∫x²dx', ''] } }), ['A displayed equation', 'picture', '']);
  assert.match(at({ target: 'view' }, { seen: { texts: ['words that are nowhere on the page'] } })[2], /could not be told/);
  assert.match(at({ target: 'view' }, { seen: null })[2], /could not be told/);
  // a page whose lines cannot be told (see alignSections) shows the whole note, and says so
  const unlined = BLOCKS.map(b => Object.assign({}, b, { from: undefined, to: undefined }));
  assert.match(L.lookRange({ target: 'lines', from: 10, to: 14 }, unlined, {}).remark, /could not be matched to the note’s lines/);
  assert.equal(L.lookRange({ target: 'note' }, [], {}), null);
  assert.deepEqual(L.passageLines('one\ntwo words here\nthree', 'words here'), { from: 2, to: 2 });
  assert.deepEqual(L.passageLines('one\ntwo words\nhere three', 'words\nhere'), { from: 2, to: 3 });
  assert.equal(L.passageLines('one\ntwo', 'absent'), null);
  assert.equal(L.headingLine('# One\n\ntext\n\n## The *second* chapter ##\n', 'The second chapter'), 5);
  assert.equal(L.headingLine('# One\n', 'Two'), 0);
});

test('Look fallback: the page in words says what was measured, block by block, within its length', () => {
  const look = lookOf({});
  const d = look.description.split('\n');
  assert.match(d[0], /^The page: “Look check”, set as in Reading view \(dark theme\); pane 836 px wide; text column 760 px wide, 38 px from the left; body text EB Garamond 22 px\.$/);
  assert.equal(d.length, 1 + BLOCKS.length);
  assert.match(d[1], /^1\. title: “Look check” \| centred \| EB Garamond 35\.6 px \| 1 line \| picture 1$/);
  assert.match(d[2], /^2\. heading 6, line 5: “A synthetic note” \| centred \| EB Garamond 26\.4 px italic \| 1 line/);
  // alignment, the drop cap and which, the first line, the font and size, the lines, the mathematics as its source, the note in the margin
  assert.equal(d[3], '3. paragraph, line 10: “Quietly the compositor sets his stick, … mall capitals.” | flush left | drop cap “Q” (Scriptorium Yinit, 80.7 px, 3 lines deep) | ' +
    'first line in small capitals | EB Garamond 22 px | 4 lines | math $e^{i\\pi} + 1 = 0$ | footnote 1 in the margin | picture 1');
  assert.match(d[4], /justified \| EB Garamond 22 px \| 3 lines/);
  assert.match(d[5], /heading 2, line 14: “A displayed equation” \| centred \| EB Garamond 32\.2 px small capitals/);
  assert.equal(d[6], '6. math, lines 16–18 | centred | math $\\int_0^1 x^2 \\, dx = \\frac{1}{3}$ | picture 1');
  assert.equal(d[7], '7. picture, line 26 | centred | picture “A synthetic plate” 240×135 px | picture 1');
  assert.match(d[9], /^9\. code \(js\), lines 39–41: “const look = 1;” \| flush left \| Scriptorium Mono 18\.5 px \| 2 lines \| 212 px too wide for its column \(it scrolls\) \| picture 1$/);
  assert.match(d[10], /heading 2, line 45: “The second chapter” .* picture 2$/);
  assert.match(d[11], /drop cap “S” \(a picture, 91 px\)/);
  // a page with notes in the margin says so; one picture needs no "picture 1"
  assert.match(lookOf({ page: Object.assign({}, PAGE, { margin: true, theme: 'light' }) }).description, /\(light theme\)[^\n]*\nFootnotes and margin notes are set in the right margin/);
  assert.doesNotMatch(lookOf({ pictures: [look.pictures[0]] }).description, /picture 1$/m);
  // the cap: the blocks that do not fit are counted, not listed
  const many = Array.from({ length: 300 }, (_, i) => Object.assign({}, BLOCKS[3], { text: `Paragraph number ${i + 1} of a long note, which goes on.`, from: i * 2 + 1, to: i * 2 + 1 }));
  const long = L.describeLook(Object.assign({}, look, { blocks: many }), L.LOOK_DESCRIPTION_CHARS);
  assert.ok(long.length <= L.LOOK_DESCRIPTION_CHARS, `${long.length} characters`);
  const last = /… and (\d+) more blocks, not described\.$/.exec(long);
  assert.ok(last);
  assert.equal(long.split('\n').length - 2 + Number(last[1]), 300);
  // other kinds of block
  const kinds = L.describeLook(Object.assign({}, look, { pictures: [], blocks: [
    { kind: 'list', items: 3, text: 'First item', from: 30, to: 32, align: 'left', font: 'EB Garamond', size: 22, lines: 3 },
    { kind: 'table', rows: 3, cols: 2, text: 'Left Right', from: 34, to: 37, align: 'left', font: 'EB Garamond', size: 22 },
    { kind: 'callout', callout: 'note', text: 'A callout', align: 'justify', font: 'EB Garamond', size: 19.8, lines: 2 },
    { kind: 'callout', callout: 'margin', inMargin: true, text: 'A marginal note', align: 'justify', font: 'EB Garamond', size: 18.7, lines: 1 },
    { kind: 'picture', text: '', align: 'full', images: [{ alt: '', width: 760, height: 400, remote: true }, { alt: 'gone', width: 24, height: 24, broken: true }] },
    { kind: 'rule', text: '' },
  ] }), 6000).split('\n');
  assert.match(kinds[1], /^1\. list of 3 items, lines 30–32: “First item” \| flush left/);
  assert.match(kinds[2], /^2\. table, 3 rows by 2, lines 34–37/);
  assert.match(kinds[3], /^3\. callout \(note\): “A callout” \| justified/);
  assert.match(kinds[4], /^4\. margin note: “A marginal note” \| set in the margin \|/);
  assert.match(kinds[5], /the full width of the column \| picture 760×400 px \(from the web\) \| picture “gone” 24×24 px \(did not load\)/);
  assert.equal(kinds[6], '6. rule');
});

test('Look message: pictures and words for a model that takes pictures, words alone otherwise; the pictures are not kept', () => {
  const look = lookOf({});
  const m = L.lookMessage(look, { left: 1 });
  assert.equal(m.content.length, 3);
  assert.deepEqual(m.content.slice(0, 2), [{ type: 'image', mediaType: 'image/png', data: PNG_B64 }, { type: 'image', mediaType: 'image/png', data: PNG_B64 }]);
  const text = m.content[2].text;
  assert.match(text, /^<rendered_page>\nThe page of “Look check” as Reading view renders it: the whole note\. The note’s properties are not shown on the page\. 2 pictures of it are attached, in reading order\. What follows was measured on the page\.\n\nThe page: /);
  assert.ok(text.includes(look.description));
  assert.match(text, /<\/rendered_page>\n\nThat is your look at the page\. You may look once more for this message, if you need another part of it\. Now carry on with your reply to the writer\.$/);
  // in words alone, for a provider that turns the pictures down, and for the conversation afterwards
  assert.equal(typeof m.alt, 'string');
  assert.match(m.alt, /It could not be shown to you as a picture: here it is in words, as measured on the page\./);
  assert.ok(m.alt.includes(look.description));
  assert.equal(typeof m.kept, 'string');
  assert.match(m.kept, /2 pictures of it were shown to you at this point; they are not kept in the conversation\./);
  assert.ok(!m.kept.includes(PNG_B64) && !m.alt.includes(PNG_B64));
  assert.match(L.lookMessage(look, { left: 0 }).content[2].text, /You cannot look again for this message\. Now carry on/);
  // a look without pictures (a phone, a model that reads text only, "Never"): one text, the same three times
  const words = L.lookMessage(lookOf({ pictures: [] }), { left: 1 });
  assert.equal(typeof words.content, 'string');
  assert.match(words.content, /There is no picture of it: here it is in words, as measured on the page\./);
  assert.equal(words.alt, words.content);
  assert.equal(words.kept, words.content);
  assert.match(L.lookMessage(lookOf({ pictures: [], problem: 'the page could not be drawn' }), { left: 0 }).content, /No picture of it could be taken \(the page could not be drawn\), so here it is in words/);
  // more pages than one look holds; a remark about what is shown instead of what was asked
  const capped = L.lookMessage(lookOf({ more: 5, remarks: ['No heading reads “X”, so this is the whole note.'] }), { left: 1 }).content[2].text;
  assert.match(capped, /They are the first 2 of 7 pages of it: look at a section, a passage or a range of lines to see further on\./);
  assert.match(capped, /\nNo heading reads “X”, so this is the whole note\.\n\nThe page: /);
  // the writer's own showing of the page goes with their message
  const shown = L.lookMessage(look, { by: 'writer', text: 'Why is the title so large?' });
  assert.match(shown.content[2].text, /<\/rendered_page>\n\nThe writer has shown you the page as it is rendered, above\. Their message:\n\nWhy is the title so large\?$/);
  assert.match(shown.kept, /Their message:\n\nWhy is the title so large\?$/);
  // a look that could not be had: the model is told, and carries on from the source
  const failed = L.lookMessage(null, { left: 1, failed: 'the note is no longer open.' });
  assert.equal(failed.content, failed.kept);
  assert.match(failed.content, /^<rendered_page>\nThe page could not be looked at: the note is no longer open\.\n<\/rendered_page>\n\nCarry on with your reply to the writer from the note’s source/);
  // the helpers the providers use
  const msgs = [{ role: 'user', content: 'Is it centred?' }, { role: 'assistant', content: 'Let me look.' }, { role: 'user', content: m.content, alt: m.alt }];
  assert.equal(L.messagePictures(msgs).length, 2);
  assert.equal(L.messagePictures(msgs.slice(0, 2)).length, 0);
  assert.match(L.messageText(msgs[2]), /^\[Picture 1 of the page is attached\.\]\n\n\[Picture 2 of the page is attached\.\]\n\n<rendered_page>/);
  assert.equal(L.messageText(msgs[0]), 'Is it centred?');
  assert.deepEqual(L.withoutPictures(msgs), [msgs[0], msgs[1], { role: 'user', content: m.alt }]);
  assert.equal(L.lookCaption(look), 'The whole note, in 2 pictures and its measurements');
  assert.equal(L.lookCaption(lookOf({ more: 3 })), 'The whole note, in 2 pictures (the first 2 of 5 pages) and its measurements');
  assert.equal(L.lookCaption(lookOf({ pictures: [], label: 'the section “De litteris”' })), 'The section “De litteris”, in words');
  assert.match(L.lookRecipient(baseSettings()), /^A look goes to Anthropic \(Claude Sonnet 5\.5\) with the conversation, and to no one else\.$/);
  assert.match(L.lookRecipient(Object.assign({}, L.DEFAULT_SETTINGS, { provider: 'openai', openaiModel: 'llava', openaiBaseUrl: 'http://localhost:11434/v1' })), /your server at http:\/\/localhost:11434\/v1 \(llava\)/);
  assert.match(L.lookRecipient(Object.assign({}, L.DEFAULT_SETTINGS, { provider: 'demo' })), /nothing is sent anywhere/);
});

// One turn with a look, as the chat sends it: the question, the reply that asks to look, the look.
function lookTurn(over) {
  const m = L.lookMessage(lookOf(over || {}), { left: 1 });
  return { m, messages: [
    { role: 'user', content: 'Is the title centred?' },
    { role: 'assistant', content: 'Let me look.\n\n```lagrange-look\n{"target": "note"}\n```' },
    { role: 'user', content: m.content, alt: m.alt },
  ] };
}

test('Look, Anthropic: the pictures go as base64 image blocks before the words; other messages are untouched', async () => {
  const { m, messages } = lookTurn();
  let body;
  const res = await L.streamAnthropic(baseSettings(), { system: 'S', messages, cache: true }, {
    fetch: async (url, init) => { body = JSON.parse(init.body); return streamResponse([ANTHROPIC_STREAM]); },
  }, {});
  assert.equal(res.text, 'Ink on “paper”.');
  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[0].content, 'Is the title centred?');
  assert.equal(body.messages[1].content, messages[1].content);
  assert.deepEqual(body.messages[2].content.slice(0, 2), [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
  ]);
  assert.deepEqual(body.messages[2].content[2], { type: 'text', text: m.content[2].text });
  assert.deepEqual(Object.keys(body.messages[2]), ['role', 'content'], 'the words-only form stays at home');
  assert.deepEqual(body.cache_control, { type: 'ephemeral' });
  assert.equal(body.system, 'S');
  // a JPEG says so
  const jpeg = L.anthropicMessages([{ role: 'user', content: [{ type: 'image', mediaType: 'image/jpeg', data: 'AAAA' }, { type: 'text', text: 't' }] }]);
  assert.equal(jpeg[0].content[0].source.media_type, 'image/jpeg');
});

test('Look, OpenAI and compatible servers: image_url parts; a server that turns pictures down is sent the words, and the session remembers', async () => {
  const chunks = ['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'];
  const { m, messages } = lookTurn();
  const s = Object.assign({}, L.DEFAULT_SETTINGS, { provider: 'openai', openaiBaseUrl: 'http://localhost:11434/v1', openaiModel: 'llava' });
  const calls = [];
  const run = (fetch, session) => L.complete(s, { system: 'S', messages }, {
    fetch: async (url, init) => { calls.push(JSON.parse(init.body)); return fetch ? fetch(JSON.parse(init.body)) : streamResponse(chunks); },
  }, session);
  const session = {};
  const res = await run(null, session);
  assert.equal(res.text, 'ok');
  assert.equal(res.picturesRefused, false);
  assert.deepEqual(calls[0].messages[0], { role: 'system', content: 'S' });
  assert.equal(calls[0].messages[1].content, 'Is the title centred?');
  assert.deepEqual(calls[0].messages[3].content.slice(0, 2), [
    { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
  ]);
  assert.deepEqual(calls[0].messages[3].content[2], { type: 'text', text: m.content[2].text });
  assert.equal(session.noPictures, undefined);
  // a model that reads text only: 400, then the same turn in words
  calls.length = 0;
  const picky = body => (JSON.stringify(body).includes('image_url') ? jsonResponse(400, { error: { message: 'this model does not support image input' } }) : streamResponse(chunks));
  const again = await run(picky, session);
  assert.equal(again.text, 'ok');
  assert.equal(again.picturesRefused, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].messages[3].content, m.alt);
  assert.deepEqual(session.noPictures, { 'openai:llava': true });
  assert.equal(L.lookSendsPictures(Object.assign({}, s, { lookPictures: 'on' }), true, session), false, 'the next look is in words from the start');
  // a 400 for another reason, with no pictures in the request, is still an error; so is one that the words do not cure
  await assert.rejects(L.complete(s, { system: 'S', messages: messages.slice(0, 1) }, { fetch: async () => jsonResponse(400, { error: { message: 'bad request' } }) }, {}), L.LagrangeError);
  calls.length = 0;
  await assert.rejects(run(() => jsonResponse(400, { error: { message: 'context length exceeded' } }), {}), L.LagrangeError);
  assert.equal(calls.length, 2, 'tried once more in words, and no further');
  // OpenAI's own API takes the same parts
  calls.length = 0;
  const api = Object.assign({}, L.DEFAULT_SETTINGS, { provider: 'openai-api', openaiPlatformKey: 'sk-x', openaiPlatformModel: 'gpt-5' });
  await L.complete(api, { system: 'S', messages }, { fetch: async (url, init) => { calls.push(JSON.parse(init.body)); return streamResponse(chunks); } }, {});
  assert.equal(calls[0].messages[3].content[0].type, 'image_url');
});

test('Look, Claude subscription: the pictures go in on stdin as image blocks, with no tool turned on and nothing written to disk', { skip: !posix }, async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lagrange-cli-'));
  const exe = fakeCli(dir, 'claude', `
let input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
  const a = process.argv.slice(2);
  const tools = a[a.indexOf('--tools') + 1] === '' && a.includes('--no-session-persistence') && a[a.indexOf('--setting-sources') + 1] === '' && a.includes('--strict-mcp-config');
  const format = a.includes('--input-format') ? a[a.indexOf('--input-format') + 1] : 'text';
  let said;
  if (format === 'stream-json') {
    const lines = input.trim().split('\\n'), msg = JSON.parse(lines[0]);
    const c = msg.message.content;
    said = [lines.length, msg.type, msg.message.role, c.map(p => p.type).join('+'), c[0].source.type, c[0].source.media_type, c[0].source.data.length, c[c.length - 1].text.includes('<conversation_so_far>') && c[c.length - 1].text.includes('[Picture 1 of the page is attached.]') && c[c.length - 1].text.includes('<rendered_page>')].join(' ');
  } else said = 'text ' + input.includes('[Picture') + ' ' + input.includes('It could not be shown to you as a picture');
  console.log(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: (tools ? 'tools off; ' : 'TOOLS ON; ') + said } } }));
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'x' }));
});`);
  const { messages } = lookTurn();
  const before = fs.readdirSync(require('node:os').tmpdir()).filter(f => f.startsWith('lagrange-look-')).length;
  const res = await L.streamClaudeCode({ claudeCodePath: exe, claudeCodeModel: 'haiku' }, { system: 'S', messages }, {}, {});
  assert.equal(res.text, `tools off; 1 user user image+image+text base64 image/png ${PNG_B64.length} true`);
  assert.equal(res.picturesRefused, false);
  assert.equal(fs.readdirSync(require('node:os').tmpdir()).filter(f => f.startsWith('lagrange-look-')).length, before, 'no picture file is written for Claude Code');
  // without pictures it is run as before: plain text on stdin, no input format
  const plain = await L.streamClaudeCode({ claudeCodePath: exe, claudeCodeModel: 'haiku' }, { system: 'S', messages: messages.slice(0, 1) }, {}, {});
  assert.equal(plain.text, 'tools off; text false false');
  // a Claude Code that does not know the input format: the page goes in words, and the session remembers
  const old = fakeCli(dir, 'claude-old', `
let input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
  if (process.argv.includes('--input-format')) { console.error("error: unknown option '--input-format'"); process.exit(1); }
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'in words: ' + input.includes('It could not be shown to you as a picture') + ' ' + input.includes('[Picture') }));
});`);
  const session = {};
  const r = await L.streamClaudeCode({ claudeCodePath: old, claudeCodeModel: '' }, { system: 'S', messages }, {}, session);
  assert.equal(r.text, 'in words: true false');
  assert.equal(r.picturesRefused, true);
  assert.deepEqual(session.noPictures, { 'claude-code': true });
  const one = JSON.parse(L.claudeCodeInput([{ role: 'user', content: 'Hello' }], [{ mediaType: 'image/jpeg', data: 'AAAA' }]));
  assert.deepEqual(one, { type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }, { type: 'text', text: 'Hello' }] } });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Look, ChatGPT subscription: the pictures are files in a folder of their own, attached with -i, read-only, and deleted afterwards', { skip: !posix }, async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lagrange-cli-'));
  const exe = fakeCli(dir, 'codex', `
const fs = require('fs'), path = require('path');
let input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
  const a = process.argv.slice(2);
  const files = a.map((x, i) => (x === '-i' ? a[i + 1] : null)).filter(Boolean);
  const ok = a[0] === 'exec' && a.includes('--ephemeral') && a[a.indexOf('-s') + 1] === 'read-only' && a[a.length - 1] === '-';
  const first = files.length ? a.indexOf('-i') < a.indexOf('-C') : null;   // each -i is followed by another option, never by the prompt's "-"

  const png = files.every(f => fs.readFileSync(f).subarray(1, 4).toString() === 'PNG');
  const home = files.length ? path.dirname(files[0]) : '';
  const mode = home ? (fs.statSync(home).mode & 0o777).toString(8) : '';
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ ok, first, n: files.length, names: files.map(f => path.basename(f)), png, home, mode, same: files.every(f => path.dirname(f) === home), marks: input.includes('[Picture 2 of the page is attached.]') }) } }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
});`);
  const { messages } = lookTurn();
  const res = await L.streamCodex({ codexPath: exe, codexModel: '' }, { system: 'S', messages }, {}, {});
  const seen = JSON.parse(res.text);
  assert.deepEqual({ ok: seen.ok, first: seen.first, n: seen.n, names: seen.names, png: seen.png, same: seen.same, marks: seen.marks },
    { ok: true, first: true, n: 2, names: ['page-1.png', 'page-2.png'], png: true, same: true, marks: true });
  assert.match(path.basename(seen.home), /^lagrange-look-/);
  assert.equal(seen.mode, '700', 'only this user can read the folder');
  assert.equal(fs.existsSync(seen.home), false, 'the folder and the pictures are deleted when Codex has finished');
  assert.equal(res.picturesRefused, false);
  // without pictures: no -i, no folder
  const plain = JSON.parse((await L.streamCodex({ codexPath: exe, codexModel: '' }, { system: 'S', messages: messages.slice(0, 1) }, {}, {})).text);
  assert.deepEqual([plain.ok, plain.first, plain.n, plain.home], [true, null, 0, '']);
  // a Codex that will not take them: the words go instead, and the folder is still deleted
  const picky = fakeCli(dir, 'codex-picky', `
let input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
  const a = process.argv.slice(2);
  if (a.includes('-i')) { require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'where'))}, require('path').dirname(a[a.indexOf('-i') + 1])); console.error("error: unexpected argument '-i' found"); process.exit(2); }
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'in words: ' + input.includes('It could not be shown to you as a picture') } }));
});`);
  const session = {};
  const r = await L.streamCodex({ codexPath: picky, codexModel: 'gpt-5' }, { system: 'S', messages }, {}, session);
  assert.equal(r.text, 'in words: true');
  assert.equal(r.picturesRefused, true);
  assert.deepEqual(session.noPictures, { 'codex:gpt-5': true });
  assert.equal(fs.existsSync(fs.readFileSync(path.join(dir, 'where'), 'utf8')), false);
  // stopped while Codex runs: the folder is deleted all the same
  const slow = fakeCli(dir, 'codex-slow', `const a = process.argv.slice(2); require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'where2'))}, require('path').dirname(a[a.indexOf('-i') + 1])); setInterval(() => {}, 1000);`);
  const ac = new AbortController(); setTimeout(() => ac.abort(), 300);
  await assert.rejects(L.streamCodex({ codexPath: slow, codexModel: '' }, { system: 'S', messages }, { signal: ac.signal }, {}), e => e.name === 'AbortError');
  assert.equal(fs.existsSync(fs.readFileSync(path.join(dir, 'where2'), 'utf8')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Look, Demo: the demo asks to look when the message is about how the page looks, and then reports what was measured', async () => {
  const note = { title: 'Lorem Ipsum', text: LOREM };
  const ask = L.demoChatReply('How does the page look? Is the title centred?', note, true, true);
  assert.deepEqual(L.parseLookReply(ask).look, { target: 'note' });
  assert.match(L.parseLookReply(ask).text, /Let me look at the page of \*\*Lorem Ipsum\*\*/);
  for (const q of ['Is the heading centered?', 'does the drop cap come out right', 'What is in the margin?']) assert.ok(L.parseLookReply(L.demoChatReply(q, note, true, true)).look, q);
  // not when looking is off, when no note is open, or when the message is about something else
  assert.equal(L.parseLookReply(L.demoChatReply('How does the page look?', note, true, false)).look, null);
  assert.equal(L.parseLookReply(L.demoChatReply('How does the page look?', null, true, true)).look, null);
  assert.equal(L.parseLookReply(L.demoChatReply('What is this note about?', note, true, true)).look, null);
  assert.ok(L.parseAgentReply(L.demoChatReply('Fix the typography.', note, true, true)).ops.length > 0, 'the demo still edits');
  const said = L.demoLookReply(lookOf({}));
  assert.match(said, /^\*Demo mode: this is what was measured on the page, not a model’s reading of it\.\* I looked at the page of \*\*Look check\*\* \(the whole note\): 11 blocks, among them 4 headings and 3 paragraphs, in a column 760 px wide\./);
  assert.match(said, /The title, “Look check”, is centred\./);
  assert.match(said, /2 paragraphs open with a drop cap: “Q”, “S”\./);
  assert.match(said, /1 block is too wide for the column \(code\)\./);
  assert.match(L.demoLookReply(null), /could not be looked at/);
  // through the demo provider, as a turn's second reply
  const res = await L.complete(Object.assign({}, L.DEFAULT_SETTINGS, { provider: 'demo' }), { purpose: 'proofread', system: '', messages: lookTurn().messages, demo: () => said }, {});
  assert.equal(res.text, said);
});

test('Look: the page is drawn from markup an XML parser takes, with nothing left to fetch', () => {
  assert.equal(L.xmlSafe('a\u0000b\u000Bc\u000Cd￾e\tf\ng'), 'abcde\tf\ng');
  assert.equal(L.xmlSafe('Quietly “é” 𝑒 — ok'), 'Quietly “é” 𝑒 — ok');
  assert.equal(L.xmlSafe('lone \uD800 surrogate'), 'lone  surrogate');
  assert.equal(L.xmlSafe(null), '');
  const svg = L.pageSvg('<html xmlns="http://www.w3.org/1999/xhtml"><body>a\u000Cb</body></html>', 835.5, 1968.2, '22px');
  assert.equal(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="836" height="1969" viewBox="0 0 836 1969" style="font-size:22px">' +
    '<foreignObject x="0" y="0" width="836" height="1969"><html xmlns="http://www.w3.org/1999/xhtml"><body>ab</body></html></foreignObject></svg>');
  assert.doesNotMatch(L.pageSvg('<p/>', 10, 10, '16px" onload="x'), /onload="/);
  assert.deepEqual(L.cssUrls('@font-face { font-family: MJX; src: url("/lib/mathjax/a.woff2") format("woff2"), url(b.woff); }'),
    [{ whole: 'url("/lib/mathjax/a.woff2")', url: '/lib/mathjax/a.woff2' }, { whole: 'url(b.woff)', url: 'b.woff' }]);
  assert.deepEqual(L.cssUrls("--scriptorium-dropcap-light: url('app://x/a b.png'); mask: url(#clip); background: url(data:image/png;base64,AAAA)"),
    [{ whole: "url('app://x/a b.png')", url: 'app://x/a b.png' }]);
  assert.deepEqual(L.cssUrls(''), []);
  // the page is set in a page of its own, never in the note's view, and no Electron or Node module takes its picture
  const js = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8');
  const section = js.slice(js.indexOf(' * 7. The page as rendered'), js.indexOf(' * 8. The chat view'));
  assert.ok(section.length > 5000);
  assert.doesNotMatch(section, /nodeModule\(|require\(|capturePage|setViewState|createLeaf|\.dispatch\(/);
  assert.match(section, /position:fixed;left:-100000px/);
  assert.match(section, /animation: none !important/);
  // a picture from the web is not fetched again: only the vault's own files and Obsidian's are read
  assert.match(section, /const local = url => \/\^\(\?:app\|capacitor\|file\|blob\):\/i\.test\(url\)/);
  const css = fs.readFileSync(path.join(PLUGIN, 'styles.css'), 'utf8');
  assert.match(css, /\.lagrange-look-thumb img \{[^}]*object-fit: cover/);
  assert.match(css, /\.lagrange-look-modal \{/);
});

// Live, only when asked (LAGRANGE_LIVE_CLI=1): the real tools are shown a picture through Lagrange. Uses a little of the plan.
test('live: the real Claude Code and Codex read a picture handed to them as a look hands it', { skip: process.env.LAGRANGE_LIVE_CLI !== '1' || !process.env.LAGRANGE_LIVE_PICTURE }, async () => {
  // LAGRANGE_LIVE_PICTURE: a PNG that shows a number; LAGRANGE_LIVE_ANSWER: the number
  const data = fs.readFileSync(process.env.LAGRANGE_LIVE_PICTURE).toString('base64');
  const messages = [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data }, { type: 'text', text: 'What number is written in the picture? Reply with only the number.' }], alt: 'There is no picture.' }];
  const want = new RegExp(process.env.LAGRANGE_LIVE_ANSWER || '\\d');
  const c = await L.streamClaudeCode({ claudeCodePath: '', claudeCodeModel: 'haiku' }, { system: 'You are terse.', messages }, {}, {});
  assert.match(c.text, want);
  assert.equal(c.picturesRefused, false);
  const x = await L.streamCodex({ codexPath: '', codexModel: '' }, { system: 'You are terse.', messages }, {}, {});
  assert.match(x.text, want);
  assert.equal(x.picturesRefused, false);
});

test('A look at the page: Scriptorium’s marks for aligned text go where Reading view has them, and hidden marker lines are not read out', () => {
  // Written all at once, a block carries Scriptorium's alignment marks itself; Reading view has them on the <div>
  // around the block, which is where the snippet's rules for drop caps look. Every one of Scriptorium's marks moves.
  const sc = fs.readFileSync(path.join(ROOT, 'vault', '.obsidian', 'plugins', 'scriptorium', 'main.js'), 'utf8');
  const list = /const ALIGN_CLASSES = \[([^\]]+)\]/.exec(sc);
  assert.ok(list, 'Scriptorium lists its alignment classes');
  const marks = list[1].split(',').map(c => c.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.ok(marks.includes('scriptorium-align-center') && marks.includes('scriptorium-opens'));
  assert.deepEqual(L.frameMarks(marks), marks, 'each of them is moved to the frame');
  assert.deepEqual(L.frameMarks(['scriptorium-align', 'has-list-bullet', 'scriptorium-dropcap-goudy', 'scriptorium-aligned', 'scriptorium-opens-x', 'math']), ['scriptorium-align']);
  assert.deepEqual(L.frameMarks([]), []);
  assert.deepEqual(L.frameMarks(null), []);
  const js = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8');
  assert.match(js, /for \(const c of frameMarks\(Array\.from\(el\.classList\)\)\) \{ block\.classList\.add\(c\); el\.classList\.remove\(c\); \}/);
  // the description gives a block's words as shown (Scriptorium hides the "::: center" lines), and takes a drop cap's letter from them
  assert.match(js, /text: tidy\(shown\(el\)\)\.slice\(0, 200\)/);
  assert.match(js, /exec\(shown\(p\)\)/);
});

test('Edits that build on one another: an edit is looked for in the note as the edits before it leave it, and joined to the one it touches', () => {
  const doc = 'One two three. Four five six. Seven.\n';
  const apply = (d, l) => { let out = '', at = 0; for (const e of l) { out += d.slice(at, e.from) + e.replace; at = e.to; } return out + d.slice(at); };
  const ops = list => L.parseAgentReply('```lagrange-edits\n' + JSON.stringify(list) + '\n```').ops;
  const run = list => { const r = L.locateOps(doc, ops(list)); return { text: apply(doc, r.located), n: r.located.length, skipped: r.skipped.map(x => x.why), located: r.located }; };
  // an insertion after words an earlier edit wrote
  let r = run([{ find: 'Four five six.', replace: '4 5 6.' }, { insert_after: '4 5 6.', text: ' And more.' }]);
  assert.deepEqual([r.text, r.n, r.skipped], ['One two three. 4 5 6. And more. Seven.\n', 1, []]);
  assert.equal(r.located[0].matched, 'Four five six.', 'one change of the note as it is');
  assert.equal(doc.slice(r.located[0].from, r.located[0].to), r.located[0].matched);
  // a replacement that straddles an earlier edit's text and the note's own
  r = run([{ find: 'Four five six.', replace: '4 5 6.' }, { find: '5 6. Seven', replace: '5, 6; seven' }]);
  assert.deepEqual([r.text, r.n, r.skipped], ['One two three. 4 5, 6; seven.\n', 1, []]);
  // a replacement of what an append wrote (a poem appended, then centred)
  r = run([{ append: 'A poem line.' }, { find: 'A poem line.', replace: '::: center\nA poem line.\n:::' }]);
  assert.deepEqual([r.text, r.skipped], ['One two three. Four five six. Seven.\n\n::: center\nA poem line.\n:::', []]);
  // three in a chain
  r = run([{ find: 'two', replace: '2' }, { insert_after: 'One 2', text: ' (two)' }, { find: '(two) three', replace: '(two), 3' }]);
  assert.deepEqual([r.text, r.n, r.skipped], ['One 2 (two), 3. Four five six. Seven.\n', 1, []]);
  // an edit that touches no earlier edit's text but is found only loosely there stays its own edit; what is nowhere is still skipped, and says so
  r = run([{ find: 'two', replace: '2' }, { find: 'nowhere', replace: 'x' }, { insert_after: '2 three.', text: ' (sic)' }]);
  assert.deepEqual([r.text, r.skipped], ['One 2 three. (sic) Four five six. Seven.\n', ['not found in the note']]);
  // words that an earlier edit makes ambiguous are not guessed at
  r = run([{ find: 'Seven.', replace: 'Eight. Eight.' }, { insert_after: 'Eight.', text: '!' }]);
  assert.equal(r.n, 1);
  assert.match(r.skipped[0], /^the place was not found in the note, and 2 times in the note as the edits before it leave it$/);
  // edits that are all found in the note are located exactly as before
  r = run([{ find: 'two', replace: '2' }, { find: 'five', replace: '5' }]);
  assert.deepEqual([r.text, r.n], ['One 2 three. Four 5 six. Seven.\n', 2]);
  // the pure pieces
  const w = L.workingText(doc, [{ from: 4, to: 7, replace: '2' }]);
  assert.deepEqual([w.text, w.spans.map(x => [x.start, x.end])], ['One 2 three. Four five six. Seven.\n', [[4, 5]]]);
  assert.deepEqual(L.foldEdit(doc, [{ from: 4, to: 7, replace: '2', matched: 'two' }], 6, 11, 'THREE', {}).map(e => [e.from, e.to, e.replace]), [[4, 7, '2'], [8, 13, 'THREE']], 'an untouched change keeps to the note’s own offsets');
});

test('plainInline: the pen writes prose as the page shows it, without the Markdown marks the rendered text hides', () => {
  const eq = (a, b) => assert.equal(L.plainInline(a), b, a);
  eq('*Songs of Experience* (1794)', 'Songs of Experience (1794)');
  eq('a **bold** word, an _italic_ one, and __both__ *again*', 'a bold word, an italic one, and both again');
  eq('***very*** ~~gone~~ ==marked==', 'very gone marked');
  eq('snake_case_name and 2 * 3 * 4 stay', 'snake_case_name and 2 * 3 * 4 stay');
  eq('an \\*escaped\\* star and \\_underscore\\_', 'an *escaped* star and _underscore_');
  eq('see [the paper](https://example.org/a_b) and [[Note|its note]] and [[Other]]', 'see the paper and its note and Other');
  eq('a `code` span', 'a code span');
  eq('## A heading\n\n> quoted *words*', 'A heading\n\nquoted words');
  eq('a %%hidden%% comment and <u>underlined</u>', 'a  comment and underlined');
  eq('an unclosed *star and a lone _ and 5 < 6', 'an unclosed *star and a lone _ and 5 < 6');
  eq('', '');
  const show = s => s.map(g => (g.type === 'math' ? `<${g.source}>` : g.text)).join('');
  assert.equal(show(L.penScript('— William Blake, *Songs of Experience* (1794)', 80, true)), '— William Blake, Songs of Experience (1794)');
  assert.equal(show(L.penScript('— William Blake, *Songs of Experience* (1794)', 80)), '— William Blake, *Songs of Experience* (1794)', 'in Source mode the marks are on the page, and are written');
  assert.equal(show(L.penScript('the *mass* $m_1 * m_2$ of **both**', 80, true)), 'the mass <m_1 * m_2> of both', 'mathematics is not touched');
});

test('A look: the properties are said to be on the page when the view shows them, and a web picture that cannot be read is a labelled box', () => {
  const js = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8');
  assert.match(js, /img\.crossOrigin = 'anonymous'/, 'a web picture is read only if its server lets a page read it');
  assert.match(js, /blank\(r\.width, r\.height, 'picture from the web, not shown here'\)/);
  assert.match(js, /from the web could not be read for the picture of the page/);
  assert.match(js, /header\.appendChild\(copy\)/, 'the view’s own properties box is copied under the title');
  assert.match(js, /The note’s properties stand above its text, as the view shows them/);
  // a look never waits without end on Obsidian's promise for mathematics (it does not settle in a session that has typeset none)
  assert.match(js, /host\.querySelector\('\.math'\)\) await Promise\.race\(\[obsidian\.finishRenderMath\(\), sleep\(3000, signal\)\]\)/);
});

test('Diagrams: TikZ figures and Excalidraw drawings in an edit are told from the text the pen writes, and drawn shapes first', () => {
  const tikz = '```tikz\n\\begin{document}\n\\begin{tikzpicture}\n\\draw (0,0) circle (1);\n\\end{tikzpicture}\n\\end{document}\n```';
  assert.deepEqual(L.figureKinds(`Before.\n\n${tikz}\n\nAfter.`), { tikz: 1, sketch: 0 });
  assert.deepEqual(L.figureKinds(`${tikz}\n\n~~~tikz\nx\n~~~\n\n![[Orbit.excalidraw]] and ![[Sub/Two.excalidraw.md|300]]`), { tikz: 2, sketch: 2 });
  assert.deepEqual(L.figureKinds('```python\nprint(1)\n```\n\n![[photo.png]] and the word tikz'), { tikz: 0, sketch: 0 });
  assert.deepEqual(L.figureKinds(null), { tikz: 0, sketch: 0 });
  assert.equal(L.withoutFigures(`Before.\n\n${tikz}\n\nAfter ![[Orbit.excalidraw]] it.`), 'Before.\n\n\n\nAfter  it.');
  assert.equal(L.withoutFigures('```python\nprint(1)\n```'), '```python\nprint(1)\n```', 'other code is still typed');
  assert.deepEqual(L.figureOrder([{ text: false }, { text: true }, { text: false }, { text: true }, { text: false }]), [0, 2, 4, 1, 3], 'labels last, each kind in the figure’s own order');
  assert.deepEqual(L.figureOrder([]), []);
  const css = fs.readFileSync(path.join(PLUGIN, 'styles.css'), 'utf8');
  assert.match(css, /\.lagrange-pen-figures :is\(\.block-language-tikz svg, \.excalidraw-embedded-img svg, svg\.excalidraw-svg\):not\(\[data-lagrange-seen\]\) \{ opacity: 0 !important; \}/);
});

test('Diagrams: a drawing in a reply is read and made safe; the prompt says what the vault can draw', () => {
  const ops = list => L.parseAgentReply('```lagrange-edits\n' + JSON.stringify(list) + '\n```').ops;
  const [a, b] = ops([
    { insert_after: 'hardly moving.', sketch: { name: 'Two/bodies: a?', elements: [
      { type: 'ellipse', x: 0, y: 20, w: 90, h: 90, text: 'M' }, { type: 'arrow', points: [[95, 65], [295, 65]] }, { type: 'text', x: 170, y: 30, text: 'r' },
      { type: 'rect', x: 0, y: 0, w: -5, h: 10 }, { type: 'image', src: 'file:///etc/passwd' }, { type: 'line', points: [[0, 0]] }, 'junk'] } },
    { sketch: { elements: [{ type: 'rectangle', x: 1, y: 2, width: 30, height: 40 }] } },
  ]);
  assert.equal(a.op, 'insert');
  assert.equal(a.after, 'hardly moving.');
  assert.equal(a.sketch.name, 'Two bodies a');
  assert.deepEqual(a.sketch.elements.map(e => e.type), ['ellipse', 'arrow', 'text'], 'what cannot be drawn is left out');
  assert.equal(b.op, 'append');
  assert.deepEqual(b.sketch, { name: 'Drawing', elements: [{ type: 'rect', x: 1, y: 2, w: 30, h: 40 }] });
  assert.equal(ops([{ insert_after: 'x', sketch: { elements: [] } }]).length, 0, 'an empty drawing is no edit');
  assert.equal(L.sketchSpec({ elements: Array.from({ length: 200 }, (_, i) => ({ type: 'text', x: i, y: 0, text: 't' })) }).elements.length, 80);
  // the prompt: both, one, neither
  const both = L.diagramStyle({ tikz: true, sketch: true });
  assert.match(both, /```tikz/);
  assert.match(both, /\\begin\{document\}/);
  assert.match(both, /"sketch": \{"name"/);
  assert.match(L.diagramStyle({ tikz: true }), /Excalidraw plugin, which this vault does not have turned on/);
  assert.match(L.diagramStyle({ sketch: true }), /do not write a tikz block/);
  assert.match(L.diagramStyle({}), /neither the TikZJax plugin .* nor the Excalidraw plugin/);
  const note = { title: 'N', path: 'N.md', text: 'x' };
  assert.ok(L.chatSystemPrompt(note, { text: 'x' }, true, false, { tikz: true, sketch: false }).includes('Diagrams: '));
  assert.ok(!L.chatSystemPrompt(note, { text: 'x' }, false, false, { tikz: true }).includes('Diagrams: '), 'a chat that only talks draws nothing');
});

test('The loader’s plates come in turn: the first by chance, then each next one, round and round', () => {
  const names = ['clockwork', 'alchemy', 'orbit'];
  assert.equal(L.nextPlate(names, null, () => 0), 'clockwork');
  assert.equal(L.nextPlate(names, null, () => 0.5), 'alchemy');
  assert.equal(L.nextPlate(names, null, () => 0.999999), 'orbit');
  assert.equal(L.nextPlate(names, null, () => 1), 'orbit', 'a chance of exactly 1 is still a plate');
  assert.equal(L.nextPlate(names, 'clockwork'), 'alchemy');
  assert.equal(L.nextPlate(names, 'alchemy'), 'orbit');
  assert.equal(L.nextPlate(names, 'orbit'), 'clockwork');
  for (const start of [0, 0.4, 0.9]) {
    const seen = [];
    let last = null;
    for (let i = 0; i < 7; i++) seen.push(last = L.nextPlate(names, last, () => start));
    assert.equal(new Set(seen.slice(0, 3)).size, 3, 'three in a row are three different plates');
    assert.deepEqual(seen.slice(3, 6), seen.slice(0, 3), 'and then the same round again');
    assert.equal(seen[6], seen[0]);
  }
  assert.equal(L.DEFAULT_SETTINGS.loaderTheme, 'cycle');
  assert.equal(L.sanitizeSettings({ loaderTheme: 'random' }).loaderTheme, 'cycle', 'the old default becomes the new one');
  assert.equal(L.sanitizeSettings({ loaderTheme: 'orbit' }).loaderTheme, 'orbit', 'a plate that was chosen stays chosen');
});

test('splitStable: a streaming reply is cut at whole blocks, never inside code or a displayed formula', () => {
  const cut = t => { const r = L.splitStable(t); assert.equal(r.done + r.open, t, 'nothing is lost'); return [r.done, r.open]; };
  assert.deepEqual(cut('One paragraph, still com'), ['', 'One paragraph, still com']);
  assert.deepEqual(cut('First.\n\nSecond, still com'), ['First.\n\n', 'Second, still com']);
  assert.deepEqual(cut('First.\n\n```js\nconst a = 1;\n\nconst b'), ['First.\n\n', '```js\nconst a = 1;\n\nconst b'], 'a blank line inside open code is not a place to cut');
  assert.deepEqual(cut('```js\na\n\nb\n```\n\nAfter'), ['```js\na\n\nb\n```\n\n', 'After']);
  assert.deepEqual(cut('~~~tikz\n\\draw;\n```\n\n~~~\n\nx'), ['~~~tikz\n\\draw;\n```\n\n~~~\n\n', 'x'], 'a fence closes with its own kind');
  assert.deepEqual(cut('Before.\n\n$$\na = b\n\n+ c'), ['Before.\n\n', '$$\na = b\n\n+ c']);
  assert.deepEqual(cut('$$\na\n\n$$\n\nAfter $$x$$ one line.\n\nz'), ['$$\na\n\n$$\n\nAfter $$x$$ one line.\n\n', 'z']);
  assert.deepEqual(cut('Done.\n\n'), ['', 'Done.\n\n'], 'a paragraph is whole only once the next block has begun (it may yet be a list that goes on)');
  assert.deepEqual(cut('```js\na\n```'), ['```js\na\n```', ''], 'code that began at the margin is whole as soon as it closes');
  // lists: the items of one list are never set apart, nor an indented continuation from its item
  assert.deepEqual(cut('- a\n\n- b\n\n  more of b\n\n- c'), ['', '- a\n\n- b\n\n  more of b\n\n- c']);
  assert.deepEqual(cut('1. a\n\n2. b\n\nAfter the list.\n\nx'), ['1. a\n\n2. b\n\nAfter the list.\n\n', 'x']);
  assert.deepEqual(cut('Para.\n\n-'), ['', 'Para.\n\n-'], 'a lone "-" may yet be an item, a rule or a word');
  assert.deepEqual(cut('Para.\n\n- item'), ['Para.\n\n', '- item']);
  assert.deepEqual(cut('Para.\n\n    indented'), ['', 'Para.\n\n    indented']);
  // Lagrange's own blocks are never shown, not even the first letters of their opening line as it arrives
  for (const start of ['```', '```l', '```lagrange-', '```lagrange-edit', '~~~lagrange-loo']) {
    const r = L.splitStable('I will change it.\n\n' + start);
    assert.equal(r.done + r.tail, 'I will change it.\n\n', start);
    assert.equal(r.done + r.open, 'I will change it.\n\n' + start);
  }
  assert.equal(L.splitStable('Look:\n\n```py').tail, '```py', 'any other block shows as it is written');
  assert.equal(L.splitStable('Look:\n\n```lagrange-edits-not').tail, '```lagrange-edits-not');
  // what reaches across blocks is left to one render of the whole
  assert.equal(L.needsWholeRender('A claim.[^1]\n\n[^1]: The source.'), true);
  assert.equal(L.needsWholeRender('See [it][x].\n\n[x]: https://example.org'), true);
  assert.equal(L.needsWholeRender('<details>\n\ntext\n\n</details>'), true);
  assert.equal(L.needsWholeRender('Plain **prose**.\n\n```js\n[a]: b\n```\n\n$$x$$'), true, 'erring towards the whole is harmless');
  assert.equal(L.needsWholeRender('Plain **prose** with <b>inline</b> HTML.\n\n- a list\n\n$$x$$'), false);
  assert.deepEqual(cut(''), ['', '']);
  // the rendered part only ever grows by whole blocks
  const full = 'Intro.\n\n```py\nprint(1)\n\nprint(2)\n```\n\nThen $$\nx\n$$ and\n\nlast';
  let prev = '';
  for (const doc of [full, '1. one\n\n2. two\n\n   - nested\n\nThen prose - with a dash.\n\n- a\n- b\n\n12 monkeys.\n\n---\n\n> quote\n\n~~~\ncode\n~~~\nend']) {
    prev = '';
    for (let i = 0; i <= doc.length; i++) { const d = L.splitStable(doc.slice(0, i)).done; assert.ok(d.startsWith(prev), `at ${i}: ${JSON.stringify(doc.slice(0, i))}`); prev = d; }
  }
  const js = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8');
  assert.match(js, /if \(fresh\.trim\(\)\) this\.renderChat\(fresh, stream\.box\.createDiv\(/, 'only what is new is rendered while a reply streams');
  const css = fs.readFileSync(path.join(PLUGIN, 'styles.css'), 'utf8');
  assert.match(css, /pre \{ max-width: 100%; overflow-x: auto;/);
});

/* ---------- the chat: what is shown, and what is attached ---------- */

test('chatMarkdown: a diagram whose plugin is off shows as its source with a line that says so; nothing a reply holds is run or fetched', () => {
  const all = { tikz: true, sketch: true, acts: n => ['tikz', 'dataviewjs', 'dataview', 'base'].includes(n), inlineRun: ['$=', '='] };
  const tikz = 'A figure:\n\n```tikz\n\\begin{document}\n\\draw (0,0) circle (1);\n\\end{document}\n```\n\nAfter.';
  assert.equal(L.chatMarkdown(tikz, all), tikz, 'with TikZJax on, the block goes to it as it is');
  const off = L.chatMarkdown(tikz, Object.assign({}, all, { tikz: false }));
  assert.ok(off.includes('```tikz\n\\begin{document}'), 'the source stays, in its code block');
  assert.match(off, /```\n\n<small class="lagrange-chat-degraded">TikZJax is not enabled in this vault, so the figure is shown as its source\.<\/small>\n\nAfter\./);
  assert.equal((off.match(/lagrange-chat-degraded/g) || []).length, 1, 'one line');
  // Excalidraw: an embed on a line of its own becomes a code block and a line; one inside a sentence, inline code
  const sk = 'The drawing:\n\n![[Two bodies.excalidraw|300]]\n\nand ![[x.excalidraw.md]] here, but ![[photo.png]] is a picture.';
  assert.equal(L.chatMarkdown(sk, all), sk);
  const noSk = L.chatMarkdown(sk, Object.assign({}, all, { sketch: false }));
  assert.match(noSk, /```text\n!\[\[Two bodies\.excalidraw\|300\]\]\n```\n\n<small class="lagrange-chat-degraded">Excalidraw is not enabled in this vault/);
  assert.ok(noSk.includes('`![[x.excalidraw.md]]` <small'));
  assert.ok(noSk.includes('![[photo.png]] is a picture'), 'any other embed is left to Obsidian');
  // Mermaid draws; a block some plugin would act on is shown as text, and says what it was
  const mer = '```mermaid\ngraph LR\nA-->B\n```';
  assert.equal(L.chatMarkdown(mer, all), mer);
  const dv = L.chatMarkdown('Run this:\n\n```dataviewjs\ndv.paragraph(app.vault.getName())\n```\n\n~~~base\nviews: []\n~~~', all);
  assert.ok(!/```dataviewjs|~~~base/.test(dv), 'no plugin is handed the block');
  assert.ok(dv.includes('```text\ndv.paragraph(app.vault.getName())\n```'));
  assert.ok(dv.includes('A “dataviewjs” block: the chat shows its source and runs nothing.'));
  assert.ok(dv.includes('A “base” block'));
  assert.equal(L.chatMarkdown('```python\nprint(1)\n```\n\n```js {1}\nx\n```', all), '```python\nprint(1)\n```\n\n```js {1}\nx\n```', 'ordinary code keeps its name, and so its colours');
  // inline code a plugin would run
  assert.equal(L.chatMarkdown('The answer is `$= 6 * 7` and `= this.file.name`, and `x = 1` is code.', all), 'The answer is `​$= 6 * 7` and `​= this.file.name`, and `x = 1` is code.');
  assert.equal(L.chatMarkdown('`$= 1`', { tikz: true, sketch: true }), '`$= 1`', 'where no plugin runs inline code, it is left alone');
  // nothing is fetched from the web because a reply says so
  const web = L.chatMarkdown('See ![chart](https://evil.example/c.png?d=secret) and ![[local.png]] and ![d](data:image/png;base64,AAAA) and ![v](Media/pic.png).', all);
  assert.ok(web.includes('[chart (a picture on the web, not loaded)](https://evil.example/c.png?d=secret)'));
  assert.ok(!/!\[chart\]/.test(web));
  assert.ok(web.includes('![[local.png]]') && web.includes('![d](data:image/png;base64,AAAA)') && web.includes('![v](Media/pic.png)'), 'pictures of the vault and data: pictures are shown');
  assert.equal(L.chatMarkdown('![a][r] and ![[w]]\n\n[r]: https://x.example/a.png', all), '[a][r] and ![[w]]\n\n[r]: https://x.example/a.png', 'a picture by reference becomes a link');
  const html = L.chatMarkdown('<iframe src="https://x.example"></iframe> <img src="https://x.example/p.gif"> <img src="data:image/gif;base64,R0"> <video src="//x.example/v.mp4"> `<iframe>` <form action="/x">', all);
  assert.equal(html, '`<iframe src="https://x.example"></iframe>` `<img src="https://x.example/p.gif">` <img src="data:image/gif;base64,R0"> `<video src="//x.example/v.mp4">` `<iframe>` `<form action="/x">`');
  // inside code, everything is as it was written
  const code = '```html\n<iframe src="https://x.example"></iframe>\n![a](https://x.example/a.png) `$= 1` ![[d.excalidraw]]\n```';
  assert.equal(L.chatMarkdown(code, Object.assign({}, all, { sketch: false })), code);
  // a block left open at the end (a reply cut off) still gets its line
  assert.match(L.chatMarkdown('```tikz\n\\draw;', { tikz: false }), /\\draw;\n```\n\n<small[^>]*>TikZJax is not enabled/);
  const js = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8');
  assert.match(js, /\(apart \? renderApart : renderMarkdown\)\(this\.app, chatMarkdown\(md, opts\), el,/, 'every message goes through it (one with a TikZ figure comes into the log whole, so that TikZJax meets the figure once)');
  assert.ok(!/render(Markdown|Apart)\(this\.app, (?!chatMarkdown)/.test(js.slice(js.indexOf('class LagrangeChatView'), js.indexOf('class RewindModal'))), 'and none goes round it');
});

const bytesOf = (...parts) => Uint8Array.from(parts.flatMap(p => (typeof p === 'string' ? Array.from(Buffer.from(p, 'latin1')) : p)));
const PNG_HEAD = bytesOf([0x89], 'PNG\r\n', [0x1a, 0x0a, 0, 0, 0, 13], 'IHDR');
const JPEG_HEAD = bytesOf([0xff, 0xd8, 0xff, 0xe0, 0, 16], 'JFIF');
const MP4_HEAD = bytesOf([0, 0, 0, 0x20], 'ftypisom', [0, 0, 2, 0], 'isomiso2avc1mp41');
const WEBM_HEAD = bytesOf([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1]);
const PDF_HEAD = bytesOf('%PDF-1.4\n%', [0xe2, 0xe3, 0xcf, 0xd3]);

test('Attachments: a file is known by its first bytes, then its type, then its name; what Lagrange cannot read is refused', () => {
  const kind = (...a) => { const k = L.attachmentKind(...a); return k ? `${k.kind} ${k.mediaType}` : null; };
  assert.equal(kind('shot.png', 'image/png', PNG_HEAD), 'image image/png');
  assert.equal(kind('image.png', '', JPEG_HEAD), 'image image/jpeg', 'the bytes have the last word on the kind of picture');
  assert.equal(kind('notes.txt', 'text/plain', PNG_HEAD), 'image image/png', 'a picture is a picture, whatever it is called');
  assert.equal(kind('a.gif', '', bytesOf('GIF89a', [1, 0, 1, 0])), 'image image/gif');
  assert.equal(kind('a.webp', '', bytesOf('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 ')), 'image image/webp');
  assert.equal(kind('clip.mp4', 'video/mp4', MP4_HEAD), 'video video/mp4');
  assert.equal(kind('clip.mov', '', bytesOf([0, 0, 0, 0x14], 'ftypqt  ', [0, 0, 0, 0])), 'video video/quicktime');
  assert.equal(kind('clip.webm', 'video/webm', WEBM_HEAD), 'video video/webm');
  assert.equal(kind('IMG_1.HEIC', 'image/heic', bytesOf([0, 0, 0, 0x18], 'ftypheic', [0, 0, 0, 0])), null, 'a HEIC picture cannot be shown in Obsidian');
  assert.equal(kind('paper.pdf', 'application/pdf', PDF_HEAD), 'pdf application/pdf');
  assert.equal(kind('paper', '', PDF_HEAD), 'pdf application/pdf');
  for (const [name, type] of [['notes.md', ''], ['data.csv', 'text/csv'], ['conf.json', 'application/json'], ['main.py', 'text/x-python'], ['Makefile', ''], ['.gitignore', ''], ['strange.xyz', '']]) {
    assert.equal((L.attachmentKind(name, type, bytesOf('# Title\n\nSome text, with é.\n')) || {}).kind, 'text', name);
  }
  assert.equal(kind('logo.svg', 'image/svg+xml', bytesOf('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'image image/svg+xml');
  // not text, and nothing known: refused
  assert.equal(kind('blob.bin', 'application/octet-stream', Uint8Array.from({ length: 256 }, (_, i) => i)), null);
  assert.equal(kind('archive.zip', 'application/zip', bytesOf('PK', [3, 4, 20, 0, 0, 0, 8, 0])), null);
  assert.equal(kind('broken.png', 'image/png', bytesOf('this is not a picture')), null, 'called a picture, but is not one');
  assert.equal(kind('song.mp3', 'audio/mpeg', bytesOf('ID3', [4, 0, 0, 0, 0, 0, 0])), null);
  assert.equal(kind('latin1.txt', 'text/plain', bytesOf('caf', [0xe9], ' au lait, na', [0xef], 've')), null, 'not UTF-8: it would be sent as garbage');
  // a file of the vault is taken by its name until it is read
  assert.equal(kind('Notes/idea.md', '', null), 'text text/plain');
  assert.equal(kind('Media/photo.JPG', '', null), 'image image/jpeg');
  assert.equal(kind('Media/clip.webm', '', null), 'video video/webm');
  assert.equal(kind('Papers/x.pdf', '', null), 'pdf application/pdf');
  assert.equal(kind('thing.docx', '', null), null);
  assert.equal(kind('scan.tiff', 'image/tiff', null), null);
  assert.equal(L.fileExt('a/b/Photo.Final.JPEG'), 'jpeg');
  assert.equal(L.formatBytes(999), '999 B');
  assert.equal(L.formatBytes(2400), '2.4 kB');
  assert.equal(L.formatBytes(18424), '18 kB');
  assert.equal(L.formatBytes(3200000), '3.2 MB');
  assert.equal(L.attachmentLabel({ kind: 'image', name: 'a.png', size: 2400 }), 'PNG picture · 2.4 kB');
  assert.equal(L.attachmentLabel({ kind: 'pdf', name: 'paper.pdf', size: 698 }), 'PDF · 698 B');
  assert.equal(L.attachmentLabel({ kind: 'text', name: 'notes.md', size: 73, path: 'Media/notes.md' }), 'MD file · 73 B · in the vault');
  assert.equal(L.attachmentLabel({ kind: 'video', name: 'clip.mp4', size: 18424 }), 'MP4 video · 18 kB');
});

test('Attachments: limits on how many and how large, each refusal with its reason', () => {
  const f = (name, kind, size) => ({ name, kind, size });
  const r = L.admitAttachments(0, [f('a.png', 'image', 1000), f('blob.bin', null, 10), f('huge.png', 'image', L.ATTACH_BYTES.image + 1), f('b.md', 'text', 5)]);
  assert.deepEqual(r.take, [0, 3]);
  assert.equal(r.refused.length, 2);
  assert.match(r.refused[0].why, /cannot read this kind of file/);
  assert.match(r.refused[1].why, /^it is 20 MB, and a picture may be 20 MB at most$/);
  const many = L.admitAttachments(L.ATTACH_MAX - 2, [f('1.md', 'text', 1), f('2.md', 'text', 1), f('3.md', 'text', 1), f('4.md', 'text', 1)]);
  assert.deepEqual(many.take, [0, 1]);
  assert.deepEqual(many.refused.map(x => x.name), ['3.md', '4.md']);
  assert.match(many.refused[0].why, new RegExp(`a message takes ${L.ATTACH_MAX} attachments at most`));
  assert.equal(L.ATTACH_MAX, 8);
  // sizes
  assert.deepEqual(L.fitWithin(3200, 2000, 1568), { width: 1568, height: 980, scale: 0.49 });
  assert.deepEqual(L.fitWithin(320, 200, 1568), { width: 320, height: 200, scale: 1 }, 'never enlarged');
  assert.deepEqual(L.fitWithin(100, 5000, 1568), { width: 31, height: 1568, scale: 0.3136 });
  // text
  assert.deepEqual(L.clipAttachmentText('﻿a\r\nb', 100), { text: 'a\nb', clipped: false, total: 3 });
  const long = Array.from({ length: 400 }, (_, i) => `line ${i} of the file`).join('\n');
  const c = L.clipAttachmentText(long, 1000);
  assert.equal(c.clipped, true);
  assert.equal(c.total, long.length);
  assert.ok(c.text.length <= 1000 && c.text.length > 950 && long.startsWith(c.text) && long[c.text.length] === '\n', 'cut at the end of a line');
  assert.equal(L.clipAttachmentText('x'.repeat(5000), 1000).text.length, 1000);
  // a video's frames
  assert.deepEqual(L.frameTimes(4, 6), [0.5, 1.5, 2.5, 3.5], 'one a second for a short video');
  assert.deepEqual(L.frameTimes(60, 6), [5, 15, 25, 35, 45, 55]);
  assert.deepEqual(L.frameTimes(0.4, 6), [0.2]);
  assert.deepEqual(L.frameTimes(NaN, 6), [0]);
  assert.deepEqual(L.frameTimes(Infinity, 6), [0]);
});

test('Attachments: a paste of a copied file or picture is attached, a paste of text is not; a drop from the file explorer names files of the vault', () => {
  const png = { name: 'image.png', type: 'image/png', size: 10 }, doc = { name: 'report.pdf', type: 'application/pdf', size: 10 };
  assert.deepEqual(L.pastedFiles({ files: [png], getData: () => '' }), [png]);
  assert.deepEqual(L.pastedFiles({ files: [], items: [{ kind: 'string' }, { kind: 'file', getAsFile: () => png }], getData: () => '' }), [png], 'a clipboard that only offers items');
  assert.deepEqual(L.pastedFiles({ files: [], getData: () => 'just words' }), []);
  assert.deepEqual(L.pastedFiles({ files: [png], getData: () => 'cells\tcopied\tfrom a sheet' }), [], 'text that comes with a picture of itself is pasted as text');
  assert.deepEqual(L.pastedFiles({ files: [doc], getData: () => 'report.pdf' }), [doc], 'a copied file is attached although its name comes as text');
  assert.deepEqual(L.pastedFiles(null), []);
  assert.deepEqual(L.vaultPathsFromDrop('obsidian://open?vault=My%20vault&file=Notes%2FAn%20idea\nobsidian://open?vault=My%20vault&file=Media%2Fclip.mp4'), ['Notes/An idea', 'Media/clip.mp4']);
  assert.deepEqual(L.vaultPathsFromDrop('some text\nhttps://example.org'), []);
});

/* A stand-in for the browser (attachmentEnv): pictures 3200×2000, a video of 4 s, a PDF of two pages. */
function fakeEnv(log) {
  return {
    decodeImage: async (bytes, mediaType) => ({ width: bytes.length > 64 ? 3200 : 320, height: bytes.length > 64 ? 2000 : 200,
      encode: (w, h) => { log.push(`encode ${w}x${h}`); return { mediaType: 'image/jpeg', data: `JPEG${w}x${h}` }; } }),
    videoFrames: async (bytes, mediaType, n, edge) => { log.push(`frames n=${n} edge=${edge}`); return { duration: 4, frames: L.frameTimes(4, n).map(at => ({ mediaType: 'image/jpeg', data: `F${at}`, at })) }; },
    pdfText: async (bytes, max) => { log.push(`pdf max=${max}`); return { pages: 2, more: 0, text: 'Page one text.\n\nPage two text.' }; },
  };
}
const att = (kind, name, bytes, mediaType) => ({ kind, name, mediaType, size: bytes.length, read: async () => bytes });

test('Attachments: prepared to be sent: a small picture as it is, a large one scaled down, a video as frames, a PDF with its text, a text file cut at its cap', async () => {
  const log = [], env = fakeEnv(log);
  const small = await L.prepareAttachment(att('image', 'small.png', PNG_HEAD, 'image/png'), env);
  assert.deepEqual(small, { kind: 'image', name: 'small.png', image: { mediaType: 'image/png', data: Buffer.from(PNG_HEAD).toString('base64'), width: 320, height: 200, scaled: false } });
  assert.deepEqual(log, [], 'not re-encoded');
  const bigBytes = bytesOf(Array.from(PNG_HEAD), Array.from({ length: 100 }, () => 7));
  const big = await L.prepareAttachment(att('image', 'big.png', bigBytes, 'image/png'), env);
  assert.deepEqual(big.image, { mediaType: 'image/jpeg', data: 'JPEG1568x980', width: 1568, height: 980, scaled: true });
  assert.deepEqual(log, ['encode 1568x980']);
  // a picture models do not take as it is (an SVG) is drawn, at its own size
  const svg = await L.prepareAttachment(att('image', 'logo.svg', bytesOf('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'), env);
  assert.deepEqual(svg.image, { mediaType: 'image/jpeg', data: 'JPEG320x200', width: 320, height: 200, scaled: false });
  const video = await L.prepareAttachment(att('video', 'clip.mp4', MP4_HEAD, 'video/mp4'), env);
  assert.equal(video.duration, 4);
  assert.deepEqual(video.frames.map(f => f.at), [0.5, 1.5, 2.5, 3.5]);
  assert.ok(log.includes(`frames n=${L.ATTACH_FRAMES} edge=768`));
  const pdf = await L.prepareAttachment(att('pdf', 'paper.pdf', PDF_HEAD, 'application/pdf'), env);
  assert.deepEqual(pdf, { kind: 'pdf', name: 'paper.pdf', data: Buffer.from(PDF_HEAD).toString('base64'), pages: 2, text: 'Page one text.\n\nPage two text.', clipped: false, total: 30 });
  const text = await L.prepareAttachment(att('text', 'notes.md', bytesOf('# Notes\r\n\r\nBody.'), ''), env);
  assert.deepEqual(text, { kind: 'text', name: 'notes.md', text: '# Notes\n\nBody.', clipped: false, total: 14 });
  const longText = await L.prepareAttachment(att('text', 'long.txt', new TextEncoder().encode('word '.repeat(20000)), 'text/plain'), env);
  assert.equal(longText.clipped, true);
  assert.equal(longText.total, 100000);
  assert.equal(longText.text.length, L.ATTACH_TEXT_CHARS);
  // what cannot be read comes back with the reason, never as nothing
  const gone = await L.prepareAttachment({ kind: 'text', name: 'gone.md', read: async () => { throw new Error('ENOENT'); } }, env);
  assert.deepEqual(gone, { kind: 'text', name: 'gone.md', problem: 'the file could not be opened' });
  const liar = await L.prepareAttachment(att('image', 'photo.png', bytesOf('not a picture at all'), 'image/png'), env);
  assert.equal(liar.problem, 'it is not a picture Lagrange can read');
  const undecodable = await L.prepareAttachment(att('image', 'x.png', PNG_HEAD, 'image/png'), { decodeImage: async () => { throw new Error('decode'); } });
  assert.equal(undecodable.problem, 'it could not be read as a picture');
  const unplayable = await L.prepareAttachment(att('video', 'x.mkv', WEBM_HEAD, 'video/x-matroska'), { videoFrames: async () => { throw new Error('codec'); } });
  assert.equal(unplayable.problem, 'Obsidian could not play it to take frames from it');
  const scan = await L.prepareAttachment(att('pdf', 'scan.pdf', PDF_HEAD, 'application/pdf'), { pdfText: async () => { throw new Error('no reader'); } });
  assert.equal(scan.text, '');
  assert.ok(scan.data, 'it can still go as a document');
});

async function preparedSet() {
  const env = fakeEnv([]);
  return Promise.all([
    L.prepareAttachment(att('image', 'photo.png', PNG_HEAD, 'image/png'), env),
    L.prepareAttachment(att('video', 'clip.mp4', MP4_HEAD, 'video/mp4'), env),
    L.prepareAttachment(att('pdf', 'paper.pdf', PDF_HEAD, 'application/pdf'), env),
    L.prepareAttachment(att('text', 'notes.md', bytesOf('# Notes\n\nMEDLAR.'), ''), env),
  ]);
}

test('Attachments: what each provider takes, and the message made for it (pictures, a video as frames, a PDF as a document or as text, files as text)', async () => {
  const S = o => Object.assign({}, L.DEFAULT_SETTINGS, o);
  const inputs = o => { const i = L.providerInputs(S(o), {}); return `${i.images ? 'pictures' : 'no pictures'}, pdf as ${i.pdf}, ${i.video ? 'video' : 'no video'}`; };
  assert.equal(inputs({ provider: 'anthropic' }), 'pictures, pdf as document, no video');
  assert.equal(inputs({ provider: 'anthropic', anthropicModel: 'custom', anthropicCustomModel: 'claude-2.1' }), 'no pictures, pdf as text, no video');
  assert.equal(inputs({ provider: 'openai-api', openaiPlatformModel: 'gpt-5' }), 'pictures, pdf as document, no video');
  assert.equal(inputs({ provider: 'openai-api', openaiPlatformModel: 'o3-mini' }), 'no pictures, pdf as text, no video');
  assert.equal(inputs({ provider: 'openai', openaiModel: 'llava' }), 'pictures, pdf as text, no video');
  assert.equal(inputs({ provider: 'openai', openaiModel: 'llama3.1' }), 'no pictures, pdf as text, no video');
  assert.equal(inputs({ provider: 'openai', openaiModel: 'llama3.1', lookPictures: 'on' }), 'pictures, pdf as text, no video', 'the writer says the model takes pictures');
  assert.equal(inputs({ provider: 'claude-code' }), 'pictures, pdf as text, no video');
  assert.equal(inputs({ provider: 'codex' }), 'pictures, pdf as text, no video');
  assert.equal(inputs({ provider: 'demo' }), 'no pictures, pdf as text, no video');
  assert.equal(L.providerInputs(S({ provider: 'openai', openaiModel: 'llava' }), { noPictures: { 'openai:llava': true } }).images, false, 'a model that turned pictures down this session is not sent them again');

  const items = await preparedSet();
  // a provider that takes pictures and documents
  const full = L.attachmentMessage('What do you make of these?', items, L.providerInputs(S({ provider: 'anthropic' }), {}));
  assert.deepEqual(full.parts.map(p => `${p.type} ${p.label || p.name}`), ['image photo.png', 'image clip.mp4, frame 1 of 4, at 0.5 s', 'image clip.mp4, frame 2 of 4, at 1.5 s',
    'image clip.mp4, frame 3 of 4, at 2.5 s', 'image clip.mp4, frame 4 of 4, at 3.5 s', 'document paper.pdf']);
  assert.equal(full.parts[5].mediaType, 'application/pdf');
  assert.ok(full.parts[5].alt.includes('Page one text.'), 'the document carries its text, for a provider that turns it down');
  assert.match(full.text, /^<attachments>\nThe writer attached these to the message:\n- “photo\.png” \(a picture, 320×200 pixels\): attached\.\n- “clip\.mp4” \(a video of 4 seconds\): you cannot be given video, so 4 frames taken from it \(at 0\.5, 1\.5, 2\.5, 3\.5 s\) are attached as pictures, in order\./);
  assert.ok(full.text.includes('- “paper.pdf” (a PDF, 2 pages): attached as a document.'));
  assert.ok(full.text.includes('<attached_file name="notes.md">\n# Notes\n\nMEDLAR.\n</attached_file>'));
  assert.ok(full.text.endsWith('\n\nWhat do you make of these?'));
  assert.ok(!full.text.includes('Page one text.'), 'the PDF is not sent twice');
  assert.deepEqual(full.notes, ['Claude takes no video, so “clip.mp4” (4 s) was sent as 4 frames taken from it, without its sound.'], 'the writer is told what did not go as it is');
  // the same in words alone
  assert.ok(full.alt.includes('- “photo.png” (a picture, 320×200 pixels): it could not be shown to you, since the model in use reads text only.'));
  assert.ok(full.alt.includes('- “clip.mp4” (a video of 4 seconds): it could not be shown to you.'));
  assert.ok(full.alt.includes('<attached_file name="paper.pdf" pages="2" as="text taken from the PDF">\nPage one text.\n\nPage two text.\n</attached_file>'));
  assert.ok(full.alt.includes('MEDLAR.') && full.alt.endsWith('What do you make of these?'));
  // a local model that takes pictures: the PDF goes as its text
  const local = L.attachmentMessage('Q', items, L.providerInputs(S({ provider: 'openai', openaiModel: 'llava' }), {}));
  assert.equal(local.parts.length, 5);
  assert.ok(local.parts.every(p => p.type === 'image'));
  assert.ok(local.text.includes('- “paper.pdf” (a PDF, 2 pages): the text taken from it is below; its pictures and layout are not.'));
  assert.ok(local.text.includes('Page two text.'));
  assert.ok(local.notes.some(n => n === '“paper.pdf” was given to the model on your server as the text taken from it, without its pictures and layout.'));
  assert.ok(local.notes.some(n => n === 'The model on your server takes no video, so “clip.mp4” (4 s) was sent as 4 frames taken from it, without its sound.'), 'a line begins with a capital');
  // a model that reads text only: nothing is dropped in silence
  const blind = L.attachmentMessage('Q', items, L.providerInputs(S({ provider: 'openai', openaiModel: 'llama3.1' }), {}));
  assert.deepEqual(blind.parts, []);
  assert.equal(blind.text, blind.alt);
  assert.equal(blind.notes.length, 3);
  assert.match(blind.notes[0], /takes no pictures, so “photo\.png” was not shown to it/);
  assert.match(blind.notes[1], /takes neither video nor pictures, so “clip\.mp4” was not shown to it/);
  // the demo sends nothing
  const demo = L.attachmentMessage('Q', items, L.providerInputs(S({ provider: 'demo' }), {}));
  assert.deepEqual(demo.parts, []);
  assert.deepEqual(demo.notes, ['photo.png', 'clip.mp4', 'paper.pdf', 'notes.md'].map(n => `“${n}” was not sent anywhere (demo mode).`));
  assert.match(L.demoAttachmentLine(items), /^You attached \*\*photo\.png\*\* \(a picture, 320×200\), \*\*clip\.mp4\*\* \(a video of 4 s, 4 frames taken\), \*\*paper\.pdf\*\* \(a PDF, 2 pages, 30 characters of text\), \*\*notes\.md\*\* \(a text file, 16 characters\)\. In demo mode nothing is sent anywhere/);
  // a file cut short, a PDF with no text, a file that could not be read, a message of attachments alone
  const env = fakeEnv([]);
  const odd = [
    await L.prepareAttachment(att('text', 'long.txt', new TextEncoder().encode('word '.repeat(20000)), 'text/plain'), env),
    await L.prepareAttachment(att('pdf', 'scan.pdf', PDF_HEAD, 'application/pdf'), { pdfText: async () => ({ pages: 3, more: 0, text: '  ' }) }),
    await L.prepareAttachment({ kind: 'image', name: 'gone.png', read: async () => { throw new Error('x'); } }, env),
  ];
  const o = L.attachmentMessage('', odd, L.providerInputs(S({ provider: 'openai', openaiModel: 'llava' }), {}));
  assert.ok(o.text.includes('[The file is cut here: these are the first 60,000 of its 100,000 characters.]\n</attached_file>'));
  assert.ok(o.text.includes('- “scan.pdf” (a PDF, 3 pages): no text could be taken from it (it may be a scan), so you are not given it.'));
  assert.ok(o.text.includes('- “gone.png” (picture): it could not be read (the file could not be opened), so you are not given it.'));
  assert.ok(o.text.endsWith('(The writer sent the attachments without a message.)'));
  assert.deepEqual(o.notes, ['“long.txt” is long (100,000 characters), so Lagrange was given its first 60,000.',
    'No text could be taken from “scan.pdf” (it may be a scan), and the model on your server takes no PDF as it is, so Lagrange was not given it.',
    '“gone.png” could not be read (the file could not be opened), so Lagrange was not given it.']);
  // …but a scan still goes as a document where documents are taken
  const scanDoc = L.attachmentMessage('Q', odd.slice(1, 2), L.providerInputs(S({ provider: 'anthropic' }), {}));
  assert.equal(scanDoc.parts.length, 1);
  assert.deepEqual(scanDoc.notes, []);
});

/* A mock server for the provider tests: an OpenAI-compatible /chat/completions and an Anthropic-like /v1/messages on
   127.0.0.1, which record what they are sent. answer(body, n) may return {status, error} to turn a request down. */
async function withMockServer(answer, run) {
  const http = require('node:http');
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push({ url: req.url, headers: req.headers, body });
      const a = answer ? answer(body, requests.length) : null;
      if (a && a.status) { res.writeHead(a.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: a.error, type: 'invalid_request_error' } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (req.url.endsWith('/chat/completions')) res.end('data: {"choices":[{"delta":{"content":"seen"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      else res.end(ANTHROPIC_STREAM);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { return await run(`http://127.0.0.1:${server.address().port}`, requests); } finally { await new Promise(r => server.close(r)); }
}

test('Attachments, sent to a mock server: image_url parts for pictures and frames, the text of files in the message; a server that turns pictures down gets the words', async () => {
  const items = await preparedSet();
  await withMockServer(null, async (base, requests) => {
    const s = Object.assign({}, L.DEFAULT_SETTINGS, { provider: 'openai', openaiBaseUrl: `${base}/v1`, openaiModel: 'llava' });
    const made = L.attachmentMessage('What is this?', items, L.providerInputs(s, {}));
    const message = { role: 'user', content: made.parts.concat([{ type: 'text', text: made.text }]), alt: made.alt };
    const res = await L.complete(s, { system: 'S', messages: [{ role: 'user', content: 'Earlier.' }, { role: 'assistant', content: 'Yes.' }, message] }, {}, {});
    assert.equal(res.text, 'seen');
    assert.equal(res.picturesRefused, false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/v1/chat/completions');
    const content = requests[0].body.messages[3].content;
    assert.deepEqual(content.map(p => p.type), ['image_url', 'image_url', 'image_url', 'image_url', 'image_url', 'text']);
    assert.equal(content[0].image_url.url, `data:image/png;base64,${Buffer.from(PNG_HEAD).toString('base64')}`, 'the picture arrives byte for byte');
    assert.equal(content[1].image_url.url, 'data:image/jpeg;base64,F0.5');
    assert.ok(content[5].text.includes('a video of 4 seconds') && content[5].text.includes('MEDLAR.') && content[5].text.includes('Page one text.') && content[5].text.endsWith('What is this?'));
    assert.deepEqual(Object.keys(requests[0].body.messages[3]), ['role', 'content'], 'the words-only form stays at home');
  });
  // the text-only fallback
  await withMockServer(body => (JSON.stringify(body).includes('image_url') ? { status: 400, error: 'this model does not support image input' } : null), async (base, requests) => {
    const s = Object.assign({}, L.DEFAULT_SETTINGS, { provider: 'openai', openaiBaseUrl: `${base}/v1`, openaiModel: 'llava' });
    const made = L.attachmentMessage('What is this?', items, L.providerInputs(s, {}));
    const session = {};
    const res = await L.complete(s, { system: 'S', messages: [{ role: 'user', content: made.parts.concat([{ type: 'text', text: made.text }]), alt: made.alt }] }, {}, session);
    assert.equal(res.picturesRefused, true);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body.messages[1].content, made.alt, 'the second request is the words alone');
    assert.ok(!JSON.stringify(requests[1].body).includes('image_url'));
    assert.ok(made.alt.includes('MEDLAR.') && made.alt.includes('Page one text.') && made.alt.includes('“photo.png” (a picture, 320×200 pixels): it could not be shown to you'));
    assert.deepEqual(session.noPictures, { 'openai:llava': true });
    assert.equal(L.providerInputs(s, session).images, false, 'and the next message is made in words from the start');
  });
});

test('Attachments, the shapes for the other providers: a PDF as an Anthropic document block and an OpenAI file part; Claude Code and Codex get pictures and the PDF’s text', async () => {
  const items = await preparedSet();
  const pdfB64 = Buffer.from(PDF_HEAD).toString('base64');
  const an = Object.assign({}, L.DEFAULT_SETTINGS, { provider: 'anthropic', anthropicApiKey: 'sk-ant-x' });
  const made = L.attachmentMessage('Q', items, L.providerInputs(an, {}));
  const messages = [{ role: 'user', content: made.parts.concat([{ type: 'text', text: made.text }]), alt: made.alt }];
  let bodies = [];
  const res = await L.streamAnthropic(an, { system: 'S', messages }, { fetch: async (url, init) => { bodies.push(JSON.parse(init.body)); return streamResponse([ANTHROPIC_STREAM]); } }, {});
  assert.equal(res.picturesRefused, false);
  const c = bodies[0].messages[0].content;
  assert.deepEqual(c.map(p => p.type), ['image', 'image', 'image', 'image', 'image', 'document', 'text']);
  assert.deepEqual(c[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(PNG_HEAD).toString('base64') } });
  assert.deepEqual(c[5], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 }, title: 'paper.pdf' });
  // Anthropic turns the document down: once more in words, and the reply says so
  bodies = [];
  const session = {};
  const again = await L.streamAnthropic(an, { system: 'S', messages }, {
    fetch: async (url, init) => { const b = JSON.parse(init.body); bodies.push(b); return Array.isArray(b.messages[0].content) ? jsonResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Could not process PDF document' } }) : streamResponse([ANTHROPIC_STREAM]); },
  }, session);
  assert.equal(again.picturesRefused, true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].messages[0].content, made.alt);
  // an error that is not about what was attached is still an error
  await assert.rejects(L.streamAnthropic(an, { system: 'S', messages }, { fetch: async () => jsonResponse(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens too large' } }) }, {}), L.LagrangeError);
  // OpenAI's API: a file part
  const oa = L.openaiMessages(messages)[0].content;
  assert.deepEqual(oa[5], { type: 'file', file: { filename: 'paper.pdf', file_data: `data:application/pdf;base64,${pdfB64}` } });
  // the subscriptions: pictures as pictures (messagePictures), the PDF as text in the one prompt they take
  const cc = Object.assign({}, L.DEFAULT_SETTINGS, { provider: 'claude-code' });
  const forCli = L.attachmentMessage('Q', items, L.providerInputs(cc, {}));
  const cliMessages = [{ role: 'user', content: forCli.parts.concat([{ type: 'text', text: forCli.text }]), alt: forCli.alt }];
  assert.equal(L.messagePictures(cliMessages).length, 5);
  const prompt = L.transcriptPrompt(cliMessages);
  assert.ok(prompt.startsWith('[Attached picture 1: photo.png.]\n\n[Attached picture 2: clip.mp4, frame 1 of 4, at 0.5 s.]'));
  assert.ok(prompt.includes('Page one text.') && prompt.includes('MEDLAR.'));
  const line = JSON.parse(L.claudeCodeInput(cliMessages, L.messagePictures(cliMessages)));
  assert.deepEqual(line.message.content.map(p => p.type), ['image', 'image', 'image', 'image', 'image', 'text']);
  // a conversation that moved to a provider of words: a document left in it reads as its text
  assert.ok(L.messageText(messages[0]).includes('<attached_file name="paper.pdf" pages="2" as="text taken from the PDF">'));
});

test('Attachments stay in the conversation, but only the last few messages keep their pictures and documents', () => {
  const pic = n => ({ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA', label: `p${n}.png` }, { type: 'text', text: `with picture ${n}` }], alt: `words for ${n}` });
  const history = [pic(1), { role: 'assistant', content: 'a' }, pic(2), { role: 'assistant', content: 'b' }, pic(3), { role: 'assistant', content: 'c' }, { role: 'user', content: 'plain' }];
  const out = L.recentBinaries(history, 2);
  assert.equal(out[0].content, 'words for 1');
  assert.deepEqual(Object.keys(out[0]), ['role', 'content']);
  assert.equal(out[2], history[2]);
  assert.equal(out[4], history[4]);
  assert.equal(out[6], history[6]);
  assert.ok(Array.isArray(history[0].content), 'the conversation itself is not changed');
  assert.equal(L.recentBinaries(history, 5).filter(m => Array.isArray(m.content)).length, 3);
  assert.equal(L.hasBinaryParts(history), true);
  assert.equal(L.hasBinaryParts(L.recentBinaries(history, 0)), false);
  assert.equal(L.hasBinaryParts([{ role: 'user', content: [{ type: 'text', text: 'x' }] }]), false);
  assert.ok(L.ATTACH_KEPT >= 3, 'a message with attachments and its two looks all keep their pictures');
});

test('TikZJax: how a figure stands on the page, and what is said of one that does not come', () => {
  const block = has => ({ querySelector: sel => (has.includes(sel) ? {} : null) });
  assert.equal(L.tikzState(block(['script[type="text/tikz"]'])), 'waiting');
  assert.equal(L.tikzState(block(['svg', 'svg > circle > animate'])), 'waiting', 'the spinner is an svg too');
  assert.equal(L.tikzState(block(['svg'])), 'drawn');
  assert.equal(L.tikzState(block(['img'])), 'failed');
  assert.equal(L.tikzState(block([])), 'waiting');
  assert.equal(L.tikzState(null), 'waiting');
  assert.match(L.tikzTrouble('failed', 'chat'), /error in its TikZ.*Its source:$/);
  assert.match(L.tikzTrouble('late', 'chat'), /after 30 seconds, so its source is shown:$/);
  assert.match(L.tikzTrouble('late', 'chat', 5000), /after 5 seconds/);
  assert.match(L.tikzTrouble('failed', 'note'), /broken-picture mark/);
  assert.match(L.tikzTrouble('late', 'note'), /after 30 seconds/);
  assert.equal(L.TIKZ_WAIT, 30000);
});

test('TikZJax: the model is told what the plugin takes (each point was tried in Obsidian with TikZJax 0.5.2)', () => {
  const told = L.diagramStyle({ tikz: true, sketch: true });
  assert.match(told, /\\usetikzlibrary\{…\} line naming every TikZ library/);
  assert.match(told, /arrows\.meta, calc, positioning, shapes\.geometric, matrix/);
  assert.match(told, /No \\documentclass/);
  assert.match(told, /\\foreach/);
  assert.match(told, /\\text needs amsmath and \\mathbb needs amssymb/);
  assert.match(told, /never the Unicode character/);
  assert.match(told, /only these packages exist/);
  assert.doesNotMatch(L.diagramStyle({ sketch: true }), /usetikzlibrary/);
});

test('Demo mode: a diagram for the pen where TikZJax is on, and a reply with mathematics, code and a figure', () => {
  const note = { title: 'On Balance', text: 'A note.\n' };
  const draw = L.parseAgentReply(L.demoChatReply('Draw a diagram', note, true, false, { tikz: true }));
  assert.equal(draw.ops.length, 1);
  assert.deepEqual(L.figureKinds(draw.ops[0].text || draw.ops[0].append || JSON.stringify(draw.ops[0]).replace(/\\n/g, '\n').replace(/\\\\/g, '\\')), { tikz: 1, sketch: 0 });
  assert.deepEqual(L.parseAgentReply(L.demoChatReply('Draw a diagram', note, true, false, { tikz: false })).ops, [], 'no figure is written where TikZJax is off');
  assert.deepEqual(L.parseAgentReply(L.demoChatReply('Draw a diagram', note, true, false)).ops, []);
  // the figure keeps to what TikZJax takes: a whole document body, no \documentclass, no library, no blank line, ASCII
  const fig = L.DEMO_FIGURE;
  assert.match(fig, /^```tikz\n\\begin\{document\}\n\\begin\{tikzpicture\}/);
  assert.match(fig, /\\end\{tikzpicture\}\n\\end\{document\}\n```$/);
  assert.doesNotMatch(fig, /\\documentclass|\\usetikzlibrary|\n\n|[^\x00-\x7f]/);
  const told = L.demoChatReply('Explain the first point', note, true, true, { tikz: true });
  assert.deepEqual(L.parseAgentReply(told).ops, [], 'an explanation edits nothing');
  assert.match(told, /\$\$\\frac\{M_1\}/);
  assert.match(told, /```python\ndef hill_radius/);
  assert.equal(L.figureKinds(told).tikz, 1);
  assert.equal(L.figureKinds(L.demoChatReply('Explain the first point', note, true, true, { tikz: false })).tikz, 0);
  assert.equal(L.figureKinds(L.demoChatReply('Explain the first point', note, true, true)).tikz, 0);
});
