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
// Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).
import http from 'node:http';

let queue = ['ok'], seen = [];
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const wait = ms => new Promise(r => setTimeout(r, ms));
const read = req => new Promise(resolve => { let body = ''; req.on('data', d => { body += d; }); req.on('end', () => resolve(body)); });

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const path = req.url.split('?')[0];
  if (path === '/__requests') { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(seen)); return; }
  const body = await read(req);
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
