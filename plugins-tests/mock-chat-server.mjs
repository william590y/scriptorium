// A mock OpenAI-compatible server for plugins-tests/chat-render.harness.js (chat completions, streamed as SSE).
// It listens on 127.0.0.1 only, makes no request of its own and writes no file.
//
//   node plugins-tests/mock-chat-server.mjs [port]        (default 48914; prints "port N")
//
//   POST /__queue     a JSON array: the replies of the next turns, in order (the last one is repeated). Each is a
//                     string, or {text, chunk: characters per event, delay: ms between events, first: ms before the
//                     first}, or {status, error} to answer with an HTTP error. Forgets the requests seen so far.
//   GET  /__requests  the bodies of the chat requests received since the last /__queue, as a JSON array.
//   POST /v1/chat/completions   answers with the next reply.
//
// And a transcription server, for plugins-tests/voice.harness.js (OpenAI's /audio/transcriptions):
//   POST /__audio_queue     a JSON array: what the next phrases are heard as, in order (the last one is repeated). Each
//                           is a string, or {text, delay: ms before answering}, or {status, error}. Forgets the requests.
//   GET  /__audio_requests  what was received since the last /__audio_queue: [{contentType, auth, fields, file: {name,
//                           type, bytes}, wav: {rate, channels, bits, seconds, rms} or null}].
//   POST /v1/audio/transcriptions   answers {"text": …} with the next one.
//
// Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).
import http from 'node:http';

let queue = ['ok'], seen = [];
let audioQueue = [''], audioSeen = [];
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const wait = ms => new Promise(r => setTimeout(r, ms));
const readBytes = req => new Promise(resolve => { const parts = []; req.on('data', d => parts.push(d)); req.on('end', () => resolve(Buffer.concat(parts))); });

// The parts of a multipart/form-data body: {name: {filename, type, data: Buffer}}.
function formParts(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  if (!m) return {};
  const sep = Buffer.from(`--${m[1] || m[2]}`), out = {};
  let at = body.indexOf(sep);
  while (at >= 0) {
    const next = body.indexOf(sep, at + sep.length);
    if (next < 0) break;
    const part = body.subarray(at + sep.length + 2, next - 2);   // after CRLF, before CRLF
    const head = part.indexOf('\r\n\r\n');
    if (head > 0) {
      const h = part.subarray(0, head).toString('utf8'), data = part.subarray(head + 4);
      const name = /name="([^"]*)"/.exec(h), file = /filename="([^"]*)"/.exec(h), type = /content-type:\s*([^\r\n]+)/i.exec(h);
      if (name) out[name[1]] = { filename: file ? file[1] : null, type: type ? type[1].trim() : null, data };
    }
    at = next;
  }
  return out;
}

// What a WAV file holds: {rate, channels, bits, seconds, rms} (16-bit PCM), or null.
function wavInfo(b) {
  if (!b || b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  let at = 12, fmt = null;
  while (at + 8 <= b.length) {
    const id = b.toString('ascii', at, at + 4), size = b.readUInt32LE(at + 4), body = at + 8;
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    if (id === 'data' && fmt) {
      const n = Math.floor(Math.min(size, b.length - body) / 2);
      let sq = 0;
      for (let i = 0; i < n; i++) { const v = b.readInt16LE(body + i * 2) / 32768; sq += v * v; }
      return Object.assign(fmt, { seconds: n / fmt.channels / fmt.rate, rms: n ? Math.sqrt(sq / n) : 0 });
    }
    at = body + size + (size % 2);
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const path = req.url.split('?')[0];
  if (path === '/__requests') { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(seen)); return; }
  if (path === '/__audio_requests') { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(audioSeen)); return; }
  const bytes = await readBytes(req), body = bytes.toString('utf8');
  if (path === '/__audio_queue') {
    try { const q = JSON.parse(body); if (!Array.isArray(q) || !q.length) throw new Error('an array is needed'); audioQueue = q; audioSeen = []; }
    catch (e) { res.writeHead(400, cors); res.end(String(e.message)); return; }
    res.writeHead(200, cors); res.end('ok'); return;
  }
  if (path === '/v1/audio/transcriptions' && req.method === 'POST') {
    const parts = formParts(bytes, req.headers['content-type']), file = parts.file;
    const fields = {};
    for (const [k, v] of Object.entries(parts)) if (k !== 'file') fields[k] = v.data.toString('utf8');
    audioSeen.push({ contentType: req.headers['content-type'] || '', auth: req.headers.authorization || '', fields,
      file: file ? { name: file.filename, type: file.type, bytes: file.data.length } : null, wav: file ? wavInfo(file.data) : null });
    const next = audioQueue[Math.min(audioSeen.length, audioQueue.length) - 1];
    const o = next && typeof next === 'object' ? next : { text: String(next == null ? '' : next) };
    await wait(o.delay == null ? 150 : o.delay);
    if (o.status) { res.writeHead(o.status, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: o.error || 'bad request' } })); return; }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: o.text || '' }));
    return;
  }
  if (path === '/__queue') {
    try { const q = JSON.parse(body); if (!Array.isArray(q) || !q.length) throw new Error('an array of replies is needed'); queue = q; seen = []; }
    catch (e) { res.writeHead(400, cors); res.end(String(e.message)); return; }
    res.writeHead(200, cors); res.end('ok'); return;
  }
  if (req.method !== 'POST') { res.writeHead(404, cors); res.end(); return; }
  let parsed = null;
  try { parsed = JSON.parse(body); } catch (e) { /* kept as text */ }
  seen.push(parsed === null ? body : parsed);
  const next = queue[Math.min(seen.length, queue.length) - 1];
  if (next && typeof next === 'object' && next.status) {
    await wait(200);
    res.writeHead(next.status, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: next.error || 'bad request' } }));
    return;
  }
  const o = next && typeof next === 'object' ? next : { text: String(next) };
  await wait(o.first == null ? 300 : o.first);
  res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
  const parts = String(o.text).match(new RegExp(`[\\s\\S]{1,${o.chunk || 24}}`, 'g')) || [];
  for (const p of parts) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
    await wait(o.delay == null ? 8 : o.delay);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  res.end();
});
server.listen(Number(process.argv[2] || 48914), '127.0.0.1', () => { console.log('port', server.address().port); });
