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
  assert.deepEqual(L.LOADER_THEMES, ['random', 'clockwork', 'alchemy', 'orbit']);
  assert.deepEqual(Object.keys(L.LOADER_CAPTIONS).sort(), ['alchemy', 'clockwork', 'orbit']);
  assert.equal(L.sanitizeSettings({ loaderTheme: 'trebuchet' }).loaderTheme, 'random');
  const kept = L.sanitizeSettings({ loaderTheme: 'trebuchet', provider: 'demo', penSpeed: 2 });
  assert.equal(kept.provider, 'demo', 'the rest of the saved settings are kept');
  assert.equal(kept.penSpeed, 2);
  const js = fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8');
  const css = fs.readFileSync(path.join(PLUGIN, 'styles.css'), 'utf8');
  // The word survives only in the comment on the fallback.
  assert.deepEqual(js.split('\n').filter(l => /trebuchet/i.test(l)).map(l => l.trim()),
    ["// A plate that no longer exists (a saved 'trebuchet', from 0.1) falls back to 'random'."]);
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
  assert.equal(s.loaderTheme, 'random');
  for (const t of ['clockwork', 'alchemy', 'orbit', 'random']) assert.equal(L.sanitizeSettings({ loaderTheme: t }).loaderTheme, t);
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
  assert.equal(show(L.penScript(`so $${'x+'.repeat(100)}y$ ends`, 48)), 'so  …', 'an equation too long to draw ends the script');
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
