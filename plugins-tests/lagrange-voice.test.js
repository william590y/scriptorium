// Unit tests for Lagrange's voice control: the pure helpers (resampling, the WAV file, telling speech from silence,
// the form sent to a transcription service, the commands said aloud, how dictated words join the note) and the
// transcription call itself (with a fake request function; no network, no microphone).
//
// Run from the repository root:   node --test plugins-tests/lagrange-voice.test.js
// The parts that need a microphone and Obsidian are checked by plugins-tests/voice.harness.js.
//
// Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const PLUGIN = path.join(path.resolve(__dirname, '..'), 'vault', '.obsidian', 'plugins', 'lagrange');
function stubModule() {
  return new Proxy({}, { get(target, key) { if (!(key in target)) target[key] = class { static define() { return {}; } }; return target[key]; } });
}
const stubs = { obsidian: stubModule(), '@codemirror/state': stubModule(), '@codemirror/view': stubModule() };
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};
const L = require(path.join(PLUGIN, 'main.js')).internals;
Module._load = realLoad;

const sine = (n, rate, hz, amp) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / rate));
const rms = a => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

/* ---------- settings ---------- */

test('Voice settings: off by default, the routes and pauses checked, the language made a code', () => {
  const d = L.sanitizeSettings({});
  assert.equal(d.voice, false);
  assert.equal(d.voiceRoute, 'openai');
  assert.equal(d.voicePause, 1);
  assert.equal(d.voiceLanguage, '');
  const s = L.sanitizeSettings({ voice: 'yes', voiceRoute: 'google', voicePause: 3, voiceLanguage: 'en-GB', voiceServerUrl: 5 });
  assert.equal(s.voice, false);                 // a string is not a switch
  assert.equal(s.voiceRoute, 'openai');
  assert.equal(s.voicePause, 1);
  assert.equal(s.voiceLanguage, 'en');
  assert.equal(s.voiceServerUrl, L.DEFAULT_SETTINGS.voiceServerUrl);
  assert.equal(L.sanitizeSettings({ voice: true, voiceRoute: 'server', voicePause: 0.6 }).voicePause, 0.6);
  assert.deepEqual(['', 'en', 'en', 'fr', '', '', 'pt'].map((x, i) => x), [null, 'en', 'EN-us', 'fr_CA', 'english', ' e ', 'pt'].map(L.voiceLanguage));
});

test('voiceProblem: what keeps each route from working, in words', () => {
  const s = Object.assign({}, L.DEFAULT_SETTINGS, { voice: true });
  assert.match(L.voiceProblem(s, { desktop: true }), /OpenAI API key/);
  assert.equal(L.voiceProblem(Object.assign({}, s, { openaiPlatformKey: 'sk-x' }), { desktop: true }), '');
  assert.equal(L.voiceProblem(Object.assign({}, s, { voiceRoute: 'server' }), {}), '');
  assert.match(L.voiceProblem(Object.assign({}, s, { voiceRoute: 'server', voiceServerUrl: '' }), {}), /address/);
  assert.match(L.voiceProblem(Object.assign({}, s, { voiceRoute: 'server', voiceServerUrl: 'localhost:8080' }), {}), /not a web address/);
  assert.match(L.voiceProblem(Object.assign({}, s, { voiceRoute: 'system' }), { desktop: true, system: true }), /on a computer/);
  assert.match(L.voiceProblem(Object.assign({}, s, { voiceRoute: 'system' }), { desktop: false, system: false }), /no speech recognition/);
  assert.equal(L.voiceProblem(Object.assign({}, s, { voiceRoute: 'system' }), { desktop: false, system: true }), '');
  assert.equal(L.voiceModel(s), 'gpt-4o-mini-transcribe');
  assert.equal(L.voiceModel(Object.assign({}, s, { voiceRoute: 'server' })), 'whisper-1');
  assert.equal(L.voiceModel(Object.assign({}, s, { voiceModel: ' gpt-4o-transcribe ' })), 'gpt-4o-transcribe');
});

/* ---------- sound ---------- */

test('resample: 48 kHz and 44.1 kHz down to 16 kHz keep a voice-band tone; up and same-rate work; nothing gives nothing', () => {
  for (const rate of [48000, 44100]) {
    const x = sine(rate, rate, 440, 0.5), y = L.resample(x, rate, 16000);
    assert.equal(y.length, 16000);
    assert.ok(Math.abs(rms(y) - 0.5 / Math.SQRT2) < 0.01, `rms ${rms(y)}`);
    // the tone is still at 440 Hz: count zero crossings
    let z = 0;
    for (let i = 1; i < y.length; i++) if ((y[i - 1] < 0) !== (y[i] < 0)) z++;
    assert.ok(Math.abs(z - 880) <= 4, `crossings ${z}`);
  }
  const hi = sine(48000, 48000, 12000, 0.5), lo = L.resample(hi, 48000, 16000);   // above the new Nyquist: mostly gone
  assert.ok(rms(lo) < 0.12, `aliased rms ${rms(lo)}`);
  const up = L.resample(Float32Array.from([0, 1, 0, -1]), 8000, 16000);
  assert.equal(up.length, 8);
  assert.deepEqual(Array.from(up.slice(0, 4)), [0, 0.5, 1, 0.5]);
  assert.deepEqual(Array.from(L.resample(Float32Array.from([0.25, -0.25]), 16000, 16000)), [0.25, -0.25]);
  assert.equal(L.resample(new Float32Array(0), 48000, 16000).length, 0);
  assert.equal(L.resample(Float32Array.from([1]), 0, 16000).length, 0);
  const dc = L.resample(new Float32Array(4410).fill(0.3), 44100, 16000);
  assert.ok(dc.every(v => Math.abs(v - 0.3) < 1e-6));
});

test('encodeWav: a 16-bit mono PCM file that reads back', () => {
  const samples = Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2, NaN]);
  const w = L.encodeWav(samples, 16000), v = new DataView(w.buffer);
  const tag = o => String.fromCharCode(...w.slice(o, o + 4));
  assert.equal(tag(0), 'RIFF'); assert.equal(tag(8), 'WAVE'); assert.equal(tag(12), 'fmt '); assert.equal(tag(36), 'data');
  assert.equal(v.getUint32(4, true), w.length - 8);
  assert.equal(v.getUint16(20, true), 1);       // PCM
  assert.equal(v.getUint16(22, true), 1);       // mono
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint32(28, true), 32000);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getUint32(40, true), samples.length * 2);
  const back = Array.from({ length: samples.length }, (_, i) => v.getInt16(44 + i * 2, true));
  assert.deepEqual(back, [0, 16384, -16384, 32767, -32768, 32767, -32768, 0]);
  assert.equal(L.encodeWav(new Float32Array(0), 16000).length, 44);
});

test('createVad: speech after silence is one phrase, dated from its first loud block; a click is not kept', () => {
  const vad = L.createVad({ silenceMs: 1000 });
  const events = [];
  const feed = (level, ms) => { for (let t = 0; t < ms; t += 20) { const e = vad.push(level, 20); if (e) events.push(e); } };
  feed(0.001, 1000);           // a quiet room
  assert.equal(events.length, 0);
  assert.ok(vad.floor < 0.002, `floor ${vad.floor}`);
  feed(0.08, 1500);            // a phrase
  feed(0.001, 1200);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'start');
  assert.equal(events[0].at, 1000);
  assert.equal(events[1].type, 'end');
  assert.equal(events[1].from, 1000);
  assert.equal(events[1].to, 2500);
  assert.equal(events[1].keep, true);
  events.length = 0;
  feed(0.3, 100);              // a click
  feed(0.001, 1100);
  assert.equal(events.length, 2);
  assert.equal(events[1].keep, false);
});

test('createVad: a soft syllable or a short gap does not end a phrase; a long phrase is cut and goes on', () => {
  const vad = L.createVad({ silenceMs: 800, maxMs: 5000 });
  const events = [];
  const feed = (level, ms) => { for (let t = 0; t < ms; t += 20) { const e = vad.push(level, 20); if (e) events.push(e); } };
  feed(0.001, 500);
  feed(0.1, 600); feed(0.005, 400); feed(0.1, 600);   // a 0.4 s gap inside the phrase
  feed(0.001, 900);
  assert.deepEqual(events.map(e => e.type), ['start', 'end']);
  events.length = 0;
  for (let k = 0; k < 40; k++) { feed(0.1, 240); feed(0.004, 60); }   // twelve seconds without a pause (words, short gaps)
  feed(0.001, 900);
  assert.deepEqual(events.map(e => e.type), ['start', 'cut', 'cut', 'end']);
  assert.ok(Math.abs(events[1].to - events[1].from - 5000) <= 20);
  assert.equal(events[2].from, events[1].to);
  assert.ok(events.slice(1).every(e => e.keep));
});

test('createVad: the noise floor follows a louder room, so its hum is not speech, and speech above it still is', () => {
  const vad = L.createVad({ silenceMs: 800 });
  const events = [];
  const feed = (level, ms) => { for (let t = 0; t < ms; t += 20) { const e = vad.push(level, 20); if (e) events.push(e); } };
  feed(0.001, 500);
  feed(0.012, 1000);           // a fan comes on: louder than the old threshold, for a moment speech…
  feed(0.012, 8000);           // …but the floor rises to it
  const settled = events.length;
  feed(0.012, 4000);
  assert.equal(events.length, settled, 'the hum alone starts no phrase once the floor has followed it');
  assert.ok(vad.floor > 0.008, `floor ${vad.floor}`);
  feed(0.15, 1000);
  feed(0.012, 1200);
  assert.deepEqual(events.slice(settled).map(e => e.type), ['start', 'end']);
});

/* ---------- the request ---------- */

test('multipartBody: a form that a standard parser reads back, the file byte for byte, empty fields left out', async () => {
  const bytes = L.encodeWav(sine(1600, 16000, 300, 0.3), 16000);
  const { body, contentType } = L.multipartBody({ model: 'whisper-1', language: '', response_format: 'json' }, { name: 'speech.wav', type: 'audio/wav', bytes }, 'XyZ123');
  assert.equal(contentType, 'multipart/form-data; boundary=XyZ123');
  const form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  assert.equal(form.get('model'), 'whisper-1');
  assert.equal(form.get('response_format'), 'json');
  assert.equal(form.has('language'), false);
  const file = form.get('file');
  assert.equal(file.name, 'speech.wav');
  assert.equal(file.type, 'audio/wav');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
});

test('transcriptionRequest: OpenAI with the OpenAI API key, or the server at its address (with its key, if any)', async () => {
  const wav = L.encodeWav(new Float32Array(160), 16000);
  const s = Object.assign({}, L.DEFAULT_SETTINGS, { voice: true, openaiPlatformKey: ' sk-test ', voiceLanguage: 'en' });
  const a = L.transcriptionRequest(s, wav, 'gpt-4o-mini-transcribe', 'B1');
  assert.equal(a.url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(a.method, 'POST');
  assert.equal(a.headers.Authorization, 'Bearer sk-test');
  assert.equal(a.headers['Content-Type'], 'multipart/form-data; boundary=B1');
  const fa = await new Response(a.body, { headers: { 'content-type': a.contentType } }).formData();
  assert.equal(fa.get('model'), 'gpt-4o-mini-transcribe');
  assert.equal(fa.get('language'), 'en');
  const b = L.transcriptionRequest(Object.assign({}, s, { voiceRoute: 'server', voiceServerUrl: 'http://127.0.0.1:8080/v1///', voiceLanguage: '' }), wav, 'whisper-1', 'B2');
  assert.equal(b.url, 'http://127.0.0.1:8080/v1/audio/transcriptions');
  assert.equal(b.headers.Authorization, undefined, 'the OpenAI key never goes to another server');
  const c = L.transcriptionRequest(Object.assign({}, s, { voiceRoute: 'server', voiceServerKey: 'gsk_1' }), wav, 'whisper-large-v3-turbo', 'B3');
  assert.equal(c.headers.Authorization, 'Bearer gsk_1');
});

test('transcriptText: OpenAI JSON, plain text, segments; markers for silence taken out', () => {
  assert.equal(L.transcriptText('{"text":" Hello there. "}'), 'Hello there.');
  assert.equal(L.transcriptText('Plain words\n'), 'Plain words');
  assert.equal(L.transcriptText('{"segments":[{"text":" One."},{"text":" Two."}]}'), 'One. Two.');
  assert.equal(L.transcriptText('{"text":"[BLANK_AUDIO]"}'), '');
  assert.equal(L.transcriptText(' (silence) Yes. [MUSIC]'), 'Yes.');
  assert.equal(L.transcriptText('{"text": 5}'), '');
  assert.equal(L.transcriptText(null), '');
});

/* ---------- transcribe ---------- */

function fakeRequest(answers) {
  const seen = [];
  const request = async req => {
    seen.push(req);
    const a = answers[Math.min(seen.length, answers.length) - 1];
    if (a instanceof Error) throw a;
    return a;
  };
  return { request, seen };
}
const WAV = L.encodeWav(sine(3200, 16000, 200, 0.2), 16000);
const OPENAI = Object.assign({}, L.DEFAULT_SETTINGS, { voice: true, voiceRoute: 'openai', openaiPlatformKey: 'sk-test' });

test('transcribe: the words come back; the request carries the WAV and the model', async () => {
  const f = fakeRequest([{ status: 200, text: '{"text":"The river was quiet."}' }]);
  assert.equal(await L.transcribe(OPENAI, WAV, { request: f.request }), 'The river was quiet.');
  assert.equal(f.seen.length, 1);
  const form = await new Response(f.seen[0].body, { headers: { 'content-type': f.seen[0].contentType } }).formData();
  assert.equal(form.get('model'), 'gpt-4o-mini-transcribe');
  assert.deepEqual(new Uint8Array(await form.get('file').arrayBuffer()), WAV);
});

test('transcribe: an OpenAI account without gpt-4o-mini-transcribe gets whisper-1, and keeps it for the session', async () => {
  const session = {};
  const f = fakeRequest([{ status: 404, text: '{"error":{"message":"The model `gpt-4o-mini-transcribe` does not exist","type":"invalid_request_error","code":"model_not_found"}}' },
    { status: 200, text: '{"text":"ok"}' }]);
  assert.equal(await L.transcribe(OPENAI, WAV, { request: f.request, session }), 'ok');
  const models = await Promise.all(f.seen.map(async r => (await new Response(r.body, { headers: { 'content-type': r.contentType } }).formData()).get('model')));
  assert.deepEqual(models, ['gpt-4o-mini-transcribe', 'whisper-1']);
  assert.equal(session.voiceModel, 'whisper-1');
  const g = fakeRequest([{ status: 200, text: '{"text":"again"}' }]);
  await L.transcribe(OPENAI, WAV, { request: g.request, session });
  assert.equal((await new Response(g.seen[0].body, { headers: { 'content-type': g.seen[0].contentType } }).formData()).get('model'), 'whisper-1');
  // a model the writer named is never swapped
  const h = fakeRequest([{ status: 404, text: '{"error":{"message":"no such model"}}' }]);
  await assert.rejects(L.transcribe(Object.assign({}, OPENAI, { voiceModel: 'my-model' }), WAV, { request: h.request }), /Not found \(404\)/);
  assert.equal(h.seen.length, 1);
});

test('transcribe: errors in plain words (the key, the server, the network); a missing key never makes a request', async () => {
  const bad = fakeRequest([{ status: 401, text: '{"error":{"message":"Incorrect API key provided"}}' }]);
  await assert.rejects(L.transcribe(OPENAI, WAV, { request: bad.request }), e => /did not accept the API key \(401\)/.test(e.message) && /Settings → Lagrange → Voice\./.test(e.message) && e.kind === 'http');
  const none = fakeRequest([]);
  await assert.rejects(L.transcribe(Object.assign({}, OPENAI, { openaiPlatformKey: '' }), WAV, { request: none.request }), e => e.kind === 'setup' && /OpenAI API key/.test(e.message));
  assert.equal(none.seen.length, 0);
  const server = Object.assign({}, OPENAI, { voiceRoute: 'server', voiceServerUrl: 'http://127.0.0.1:8080/v1' });
  const down = fakeRequest([new Error('net::ERR_CONNECTION_REFUSED')]);
  await assert.rejects(L.transcribe(server, WAV, { request: down.request }), e => e.kind === 'network' && /127\.0\.0\.1:8080/.test(e.message));
  const offline = fakeRequest([new Error('net::ERR_INTERNET_DISCONNECTED')]);
  await assert.rejects(L.transcribe(OPENAI, WAV, { request: offline.request }), /api\.openai\.com/);
  const busy = fakeRequest([{ status: 503, text: '' }, { status: 200, text: '{"text":"after a wait"}' }]);
  assert.equal(await L.transcribe(server, WAV, { request: busy.request, retryDelays: [1] }), 'after a wait');
  const broken = fakeRequest([{ status: 500, text: '' }]);
  await assert.rejects(L.transcribe(server, WAV, { request: broken.request, retryDelays: [1] }), /internal error \(500\)/);
  assert.equal(broken.seen.length, 2);
});

test('transcribe: a service that never answers is given up on, in words, and the phrase is dropped', async () => {
  const never = { request: () => new Promise(() => {}) };
  const server = Object.assign({}, OPENAI, { voiceRoute: 'server', voiceServerUrl: 'http://127.0.0.1:8080/v1' });
  const t0 = Date.now();
  await assert.rejects(L.transcribe(server, WAV, { request: never.request, timeout: 60 }), e => e.kind === 'network' && /did not answer within 0 seconds/.test(e.message));
  assert.ok(Date.now() - t0 < 1000);
});

/* ---------- what is said ---------- */

test('voiceParse: commands as phrases or sentences of their own; "Lagrange, …" goes to the chat', () => {
  assert.deepEqual(L.voiceParse('The river was quiet.'), [{ kind: 'text', text: 'The river was quiet.' }]);
  assert.deepEqual(L.voiceParse('New paragraph.'), [{ kind: 'paragraph' }]);
  assert.deepEqual(L.voiceParse('new line'), [{ kind: 'newline' }]);
  assert.deepEqual(L.voiceParse('Scratch that!'), [{ kind: 'scratch' }]);
  assert.deepEqual(L.voiceParse('Stop listening.'), [{ kind: 'stop' }]);
  assert.deepEqual(L.voiceParse('The river was quiet. New paragraph. It carried the boats.'),
    [{ kind: 'text', text: 'The river was quiet.' }, { kind: 'paragraph' }, { kind: 'text', text: 'It carried the boats.' }]);
  assert.deepEqual(L.voiceParse('It was late. Is it? Stop listening.'), [{ kind: 'text', text: 'It was late. Is it?' }, { kind: 'stop' }]);
  assert.deepEqual(L.voiceParse('Lagrange, make the first sentence more vivid.'), [{ kind: 'ask', text: 'Make the first sentence more vivid.' }]);
  assert.deepEqual(L.voiceParse('La Grange, proofread this.'), [{ kind: 'ask', text: 'Proofread this.' }]);
  assert.deepEqual(L.voiceParse('Hey Lagrange: what does this mean?'), [{ kind: 'ask', text: 'What does this mean?' }]);
  assert.deepEqual(L.voiceParse('Lagrange points are five.'), [{ kind: 'text', text: 'Lagrange points are five.' }], 'the name inside a sentence is just a word');
  assert.deepEqual(L.voiceParse('Lagrange. Stop listening.'), [{ kind: 'stop' }]);
  assert.deepEqual(L.voiceParse('A new paragraph begins here.'), [{ kind: 'text', text: 'A new paragraph begins here.' }]);
  assert.deepEqual(L.voiceParse('[BLANK_AUDIO]'), []);
  assert.deepEqual(L.voiceParse('...'), []);
});

test('voiceMessage: what a phrase said to Lagrange sends', () => {
  assert.equal(L.voiceMessage('please proofread the second paragraph.'), 'Please proofread the second paragraph.');
  assert.equal(L.voiceMessage('Lagrange, what rhymes with orange?'), 'What rhymes with orange?');
  assert.equal(L.voiceMessage('Stop listening.'), '');
  assert.equal(L.voiceMessage('Lagrange.'), '');
  assert.equal(L.voiceMessage(''), '');
});

test('dictationPoint: never into the middle of a word', () => {
  assert.equal(L.dictationPoint('The riv', 'er was'), 2);
  assert.equal(L.dictationPoint('The river ', 'was'), 0);
  assert.equal(L.dictationPoint('The river', ' was'), 0);
  assert.equal(L.dictationPoint('', 'Word'), 0);
  assert.equal(L.dictationPoint('do', "n't stop"), 3);
  assert.equal(L.dictationPoint('café', 'teria.'), 5);
});

test('dictationJoin: spaces and capitals where the words meet the note', () => {
  const j = L.dictationJoin;
  assert.equal(j('', 'the river was quiet.', ''), 'The river was quiet.');
  assert.equal(j('The river was quiet.', 'It carried the boats.', ''), ' It carried the boats.');
  assert.equal(j('The river was quiet. ', 'it carried the boats.', ''), 'It carried the boats.');
  assert.equal(j('The river was', 'Quiet in the morning.', ''), ' quiet in the morning.');
  assert.equal(j('Paris was grey. We went back to', 'Paris in May.', ''), ' Paris in May.', 'a name written before keeps its capital');
  assert.equal(j('The river was quiet and', 'The boats came.', ''), ' the boats came.', 'a common word is never a name');
  assert.equal(j('We met at', 'NASA again.', ''), ' NASA again.');
  assert.equal(j('She bought an', 'iPhone.', ''), ' iPhone.');
  assert.equal(j('So', "I'm leaving.", ''), " I'm leaving.");
  assert.equal(j('Then', 'I left.', ''), ' I left.');
  assert.equal(j('The river was quiet', ', and still.', ''), ', and still.');
  assert.equal(j('- ', 'buy bread', ''), 'Buy bread');
  assert.equal(j('1. ', 'first item', ''), 'First item');
  assert.equal(j('> ', 'a quotation', ''), 'A quotation');
  assert.equal(j('## ', 'the second part', ''), 'The second part');
  assert.equal(j('He said (', 'Quietly)', ''), 'quietly)');
  assert.equal(j('One', 'and two', 'three'), ' and two ');
  assert.equal(j('One', 'and two', '. Four'), ' and two');
  assert.equal(j('Was it?', 'yes.', ''), ' Yes.');
  assert.equal(j('“It is.”', 'she said so.', ''), ' She said so.');
  assert.equal(j('x', '   ', 'y'), '');
  assert.equal(j('The day began', 'And then it rained.', '. Next'), ' and then it rained');
  assert.equal(j('Is it', 'Really so?', '?'), ' really so');
});

test('micProblem: what a refused or missing microphone means, for each system', () => {
  assert.match(L.micProblem({ name: 'NotAllowedError' }, 'darwin'), /Privacy & Security → Microphone/);
  assert.match(L.micProblem({ name: 'NotAllowedError' }, 'win32'), /desktop apps/);
  assert.match(L.micProblem({ name: 'NotAllowedError' }, 'linux'), /PipeWire/);
  assert.match(L.micProblem({ name: 'NotFoundError' }), /No microphone was found/);
  assert.match(L.micProblem({ name: 'NotReadableError' }), /another program/);
  assert.match(L.micProblem({ name: 'Weird', message: 'boom' }), /\(boom\)/);
});

test('The commands said aloud are the ones the settings and README name', () => {
  assert.deepEqual(L.VOICE_COMMANDS.map(c => c.kind), ['paragraph', 'newline', 'scratch', 'stop']);
  assert.deepEqual(L.VOICE_ROUTES, ['openai', 'server', 'system']);
});
