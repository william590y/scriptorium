// A pretend Google for the tests of Scriptorium's direct Google Drive connection: the OAuth 2.0 sign-in for installed
// apps (authorization page, token and revoke addresses) and the part of the Drive REST API (v3) that Scriptorium uses,
// on http://127.0.0.1:<port>. No network beyond this computer. It keeps to what Google documents: PKCE (S256), codes
// that work once, access tokens that expire, drive.file (a client sees only the files it stored), multipart and
// resumable uploads (chunks in multiples of 256 KiB, 308 with Range, "bytes */total" to ask where an upload stands),
// files.update with content, paging, Range on downloads, md5Checksum and sha256Checksum. `g.fault` breaks things on
// purpose. Used by plugins-tests/drive-direct.test.js; run by hand (node plugins-tests/fake-google.js [port]) it
// serves until stopped, for trying the dialogs in Obsidian with SCRIPTORIUM_DRIVE_TEST_SERVER set.
//
// Copyright (C) 2026 William Liaw. Licensed under the GNU General Public License, version 3 or later (see LICENSE).
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');

const FOLDER = 'application/vnd.google-apps.folder';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const hash = (algorithm, data) => crypto.createHash(algorithm).update(data).digest('hex');

function fakeGoogle(options) {
  const g = Object.assign({
    clientId: '1234567890-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com', clientSecret: 'GOCSPX-pretend-secret',
    user: { displayName: 'Ada Writer', emailAddress: 'ada.writer@example.com' },
    files: new Map(), sessions: new Map(), codes: new Map(), refresh: new Map(), access: new Map(),
    log: [], n: 0, clock: Date.UTC(2026, 10, 12), accessSeconds: 3600, pageCap: 1000, apiOn: true, approve: true, grantScope: SCOPE,
    received: 0,       // bytes of file content taken in, over every kind of upload
    fault: null,       // (info) => null | {status, reason, retryAfter} | {drop: true} | {cut: bytes} (a download or a chunk broken off)
    corruptUploads: false, corruptDownloads: new Set(),
  }, options);

  const add = f => { f.id = `file${++g.n}`; f.createdTime = new Date(g.clock += 1000).toISOString(); f.trashed = false; g.files.set(f.id, f); return f; };
  const view = f => {
    const out = { id: f.id, name: f.name, parents: f.parents, mimeType: f.mimeType, createdTime: f.createdTime, trashed: f.trashed };
    if (f.bytes) Object.assign(out, { size: String(f.bytes.length), md5Checksum: hash('md5', f.bytes), sha256Checksum: hash('sha256', f.bytes) });
    return out;
  };
  /* Puts a file in the pretend Drive as another app would have (Claude's connector, the Drive web page): the client
     under test must not be able to see it. */
  const signKey = crypto.randomBytes(16);
  g.sign = id => crypto.createHmac('sha256', signKey).update(id).digest('hex');
  g.seed = (f, app) => add(Object.assign({ app: app || 'another-app', parents: ['root'] }, f));
  g.pathOf = f => { const parts = []; for (let x = f; x; x = g.files.get((x.parents || [])[0])) parts.unshift(x.name); return parts.join('/'); };
  g.tree = app => Object.fromEntries([...g.files.values()].filter(f => !f.trashed && f.mimeType !== FOLDER && (!app || f.app === app)).map(f => [g.pathOf(f), f]));
  g.count = kind => g.log.filter(l => l.kind === kind).length;

  const send = (res, status, body, headers) => {
    const data = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    res.writeHead(status, Object.assign({ 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json; charset=UTF-8', 'Content-Length': data.length }, headers));
    res.end(data);
  };
  const apiError = (res, status, reason, message, headers) => send(res, status, { error: { code: status, message: message || reason, errors: [{ domain: 'global', reason, message: message || reason }] } }, headers);
  const form = text => Object.fromEntries(new URLSearchParams(text));

  function clientOf(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const t = m && g.access.get(m[1]);
    return t && t.expires > Date.now() ? t.client : null;
  }

  function query(q, app) {
    const want = [];
    for (const part of String(q || '').split(' and ')) {
      let m;
      if ((m = /^name = '((?:[^'\\]|\\.)*)'$/.exec(part))) want.push(f => f.name === m[1].replace(/\\(.)/g, '$1'));
      else if ((m = /^'((?:[^'\\]|\\.)*)' in parents$/.exec(part))) want.push(f => (f.parents || []).includes(m[1].replace(/\\(.)/g, '$1')));
      else if ((m = /^mimeType = '([^']*)'$/.exec(part))) want.push(f => f.mimeType === m[1]);
      else if (part === 'trashed = false') want.push(f => !f.trashed);
      else if (part) return null;
    }
    return [...g.files.values()].filter(f => f.app === app && want.every(w => w(f))).sort((a, b) => (a.createdTime < b.createdTime ? -1 : 1));
  }

  function store(f, bytes) {
    g.received += 0;
    f.bytes = g.corruptUploads ? Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from([bytes[bytes.length - 1] ^ 1])]) : bytes;
    return f;
  }

  function handle(req, res, body) {
    const u = new URL(req.url, `http://${req.headers.host}`), p = u.pathname, q = u.searchParams;
    const kind = p === '/token' ? `token:${form(body.toString('utf8')).grant_type}` : p === '/revoke' ? 'revoke' : p.startsWith('/o/oauth2') ? 'auth'
      : p.startsWith('/upload/session/') ? (/\*\//.test(req.headers['content-range'] || '') ? 'upload:status' : 'upload:chunk')
      : p.startsWith('/upload/') ? `upload:${q.get('uploadType')}${req.method === 'PATCH' ? ':update' : ''}`
      : q.get('alt') === 'media' ? 'download' : p === '/drive/v3/files' && req.method === 'GET' ? 'list' : p === '/drive/v3/about' ? 'about' : `files:${req.method}`;
    const entry = { method: req.method, path: p, kind, n: g.log.filter(l => l.kind === kind).length + 1, range: req.headers.range || req.headers['content-range'] || '', auth: req.headers.authorization || '', bodyBytes: body.length };
    g.log.push(entry);
    const fault = g.fault ? g.fault(entry, req) : null;
    if (fault && fault.drop) { req.socket.destroy(); return; }
    if (fault && fault.status) { apiError(res, fault.status, fault.reason || 'backendError', fault.reason || 'pretend failure', fault.retryAfter ? { 'Retry-After': String(fault.retryAfter) } : {}); return; }

    /* ---- OAuth ---- */
    if (p === '/o/oauth2/v2/auth') {
      const redirect = q.get('redirect_uri') || '';
      const bad = q.get('client_id') !== g.clientId ? 'invalid_client' : !/^http:\/\/127\.0\.0\.1:\d+$/.test(redirect) ? 'redirect_uri_mismatch'
        : q.get('response_type') !== 'code' ? 'unsupported_response_type' : q.get('code_challenge_method') !== 'S256' || !/^[\w-]{43}$/.test(q.get('code_challenge') || '') ? 'invalid_request'
        : q.get('scope') !== SCOPE ? 'invalid_scope' : '';
      // As Google does: a wrong client or address is an error page in the browser, and nothing goes back to the app.
      if (bad) { send(res, 400, `<html><body>Error 400: ${bad}</body></html>`, { 'Content-Type': 'text/html' }); return; }
      if (!g.approve) { send(res, 302, '', { Location: `${redirect}/?error=access_denied&state=${encodeURIComponent(q.get('state') || '')}` }); return; }
      const code = `4/${crypto.randomBytes(18).toString('base64url')}`;
      g.codes.set(code, { challenge: q.get('code_challenge'), redirect, client: g.clientId });
      send(res, 302, '', { Location: `${redirect}/?code=${encodeURIComponent(code)}&state=${encodeURIComponent(q.get('state') || '')}&scope=${encodeURIComponent(g.grantScope)}` });
      return;
    }
    if (p === '/token' && req.method === 'POST') {
      const f = form(body.toString('utf8'));
      g.lastTokenRequest = f;
      const fail = (error, description) => send(res, error === 'invalid_client' ? 401 : 400, { error, error_description: description || error });
      if (f.client_id !== g.clientId || (f.client_secret || '') !== g.clientSecret) { fail('invalid_client', 'The OAuth client was not found.'); return; }
      const issue = more => {
        const access = `ya29.${crypto.randomBytes(24).toString('base64url')}`;
        g.access.set(access, { client: f.client_id, expires: Date.now() + g.accessSeconds * 1000 });
        send(res, 200, Object.assign({ access_token: access, expires_in: g.accessSeconds, scope: g.grantScope, token_type: 'Bearer' }, more));
      };
      if (f.grant_type === 'authorization_code') {
        const c = g.codes.get(f.code);
        g.codes.delete(f.code);   // a code works once
        if (!c || c.redirect !== f.redirect_uri) { fail('invalid_grant', 'Bad Request'); return; }
        if (crypto.createHash('sha256').update(f.code_verifier || '').digest('base64url') !== c.challenge) { fail('invalid_grant', 'Invalid code verifier.'); return; }
        const refresh = `1//${crypto.randomBytes(30).toString('base64url')}`;
        g.refresh.set(refresh, { client: f.client_id });
        issue({ refresh_token: refresh });
        return;
      }
      if (f.grant_type === 'refresh_token') {
        if (!g.refresh.has(f.refresh_token)) { fail('invalid_grant', 'Token has been expired or revoked.'); return; }
        issue({});
        return;
      }
      fail('unsupported_grant_type');
      return;
    }
    if (p === '/revoke' && req.method === 'POST') {
      const token = q.get('token') || form(body.toString('utf8')).token;
      if (!g.refresh.delete(token) && !g.access.delete(token)) { send(res, 400, { error: 'invalid_token' }); return; }
      g.access.clear();
      send(res, 200, {});
      return;
    }

    /* ---- an upload session's address needs no sign-in of its own; everything else in Drive does ---- */
    const session = /^\/upload\/session\/(\w+)$/.exec(p);
    const app = session ? (g.sessions.get(session[1]) || {}).app : clientOf(req);
    if (session) {
      const s = g.sessions.get(session[1]);
      if (!s || req.method !== 'PUT') { apiError(res, 404, 'notFound', 'Upload session not found'); return; }
      const range = String(req.headers['content-range'] || '');
      const ask = /^bytes \*\/(\d+|\*)$/.exec(range), part = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
      const incomplete = () => send(res, 308, '', s.bytes.length ? { Range: `bytes=0-${s.bytes.length - 1}` } : {});
      if (ask) { if (s.file) send(res, 200, view(s.file)); else incomplete(); return; }
      if (!part || Number(part[3]) !== s.total || Number(part[2]) - Number(part[1]) + 1 !== body.length) { apiError(res, 400, 'badRequest', 'Bad Content-Range'); return; }
      if (Number(part[1]) !== s.bytes.length) { apiError(res, 400, 'badRequest', `Expected the part from byte ${s.bytes.length}`); return; }
      const last = Number(part[2]) + 1 === s.total;
      if (!last && body.length % (256 * 1024)) { apiError(res, 400, 'badRequest', 'A part that is not the last must be a multiple of 256 KiB'); return; }
      // {cut: n}: the connection breaks after n bytes of this part have been kept.
      const keep = fault && fault.cut !== undefined ? body.subarray(0, fault.cut - (fault.cut % (256 * 1024))) : body;
      s.bytes = Buffer.concat([s.bytes, keep]);
      g.received += keep.length;
      if (fault && fault.cut !== undefined) { req.socket.destroy(); return; }
      if (!last) { incomplete(); return; }
      const f = s.fileId ? g.files.get(s.fileId) : add({ app: s.app, name: s.about.name, parents: s.about.parents, mimeType: s.about.mimeType || s.type });
      if (s.fileId) { if (s.about.name) f.name = s.about.name; if (s.about.mimeType) f.mimeType = s.about.mimeType; }
      s.file = store(f, s.bytes);
      send(res, 200, view(f));
      return;
    }
    // A signed download link needs no sign-in, and must not be sent one.
    const signed = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (signed && q.get('sig') && q.get('sig') === g.sign(decodeURIComponent(signed[1]))) {
      if (req.headers.authorization) { apiError(res, 400, 'badRequest', 'The sign-in was sent to another host'); return; }
      const f = g.files.get(decodeURIComponent(signed[1]));
      send(res, 200, f.bytes);
      return;
    }
    if (!app) { apiError(res, 401, 'authError', 'Invalid Credentials'); return; }
    if (!g.apiOn) { apiError(res, 403, 'accessNotConfigured', 'Google Drive API has not been used in project 1234567890 before or it is disabled.'); return; }
    const mine = id => { const f = g.files.get(id); return f && f.app === app ? f : null; };
    const parentsOk = list => (list || []).every(id => id === 'root' || (mine(id) && mine(id).mimeType === FOLDER));

    if (p === '/drive/v3/about') { send(res, 200, { user: g.user }); return; }
    if (p === '/drive/v3/files' && req.method === 'GET') {
      const found = query(q.get('q'), app);
      if (!found) { apiError(res, 400, 'invalid', 'Invalid Value'); return; }
      const size = Math.max(1, Math.min(Number(q.get('pageSize')) || 100, g.pageCap)), from = Number((/^page(\d+)$/.exec(q.get('pageToken') || '') || [])[1]) || 0;
      const out = { files: found.slice(from, from + size).map(view) };
      if (from + size < found.length) out.nextPageToken = `page${from + size}`;
      send(res, 200, out);
      return;
    }
    if (p === '/drive/v3/files' && req.method === 'POST') {
      let about;
      try { about = JSON.parse(body.toString('utf8')); } catch (e) { apiError(res, 400, 'parseError'); return; }
      if (!parentsOk(about.parents)) { apiError(res, 404, 'notFound', `File not found: ${about.parents}.`); return; }
      send(res, 200, view(add({ app, name: about.name, parents: about.parents || ['root'], mimeType: about.mimeType || 'application/octet-stream' })));
      return;
    }
    const upload = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(p);
    if (upload && (req.method === 'POST' || req.method === 'PATCH')) {
      const fileId = upload[1] ? decodeURIComponent(upload[1]) : null;
      if (Boolean(fileId) !== (req.method === 'PATCH')) { apiError(res, 400, 'badRequest'); return; }
      if (fileId && (!mine(fileId) || mine(fileId).trashed)) { apiError(res, 404, 'notFound', `File not found: ${fileId}.`); return; }
      if (q.get('uploadType') === 'resumable') {
        let about;
        try { about = JSON.parse(body.toString('utf8')); } catch (e) { apiError(res, 400, 'parseError'); return; }
        if (!fileId && !parentsOk(about.parents)) { apiError(res, 404, 'notFound'); return; }
        const sid = `s${crypto.randomBytes(8).toString('hex')}`;
        g.sessions.set(sid, { app, about, fileId, total: Number(req.headers['x-upload-content-length']), type: req.headers['x-upload-content-type'], bytes: Buffer.alloc(0), file: null });
        send(res, 200, '', { Location: `http://${req.headers.host}/upload/session/${sid}` });
        return;
      }
      if (q.get('uploadType') === 'multipart') {
        const b = /boundary=([^;]+)/.exec(req.headers['content-type'] || '');
        const text = body.toString('latin1'), mark = b ? `--${b[1]}` : null;
        const parts = mark ? text.split(mark).slice(1, -1) : [];
        if (parts.length !== 2) { apiError(res, 400, 'badContent', 'Malformed multipart body.'); return; }
        const content = part => Buffer.from(part.slice(part.indexOf('\r\n\r\n') + 4, part.length - 2), 'latin1');
        let about;
        try { about = JSON.parse(content(parts[0]).toString('utf8')); } catch (e) { apiError(res, 400, 'parseError'); return; }
        if (!fileId && !parentsOk(about.parents)) { apiError(res, 404, 'notFound'); return; }
        const bytes = content(parts[1]);
        g.received += bytes.length;
        const f = fileId ? mine(fileId) : add({ app, name: about.name, parents: about.parents || ['root'], mimeType: about.mimeType });
        if (fileId) { if (about.name) f.name = about.name; if (about.mimeType) f.mimeType = about.mimeType; }
        send(res, 200, view(store(f, bytes)));
        return;
      }
      apiError(res, 400, 'badRequest', 'uploadType');
      return;
    }
    const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (one) {
      const f = mine(decodeURIComponent(one[1]));
      if (!f) { apiError(res, 404, 'notFound', `File not found: ${decodeURIComponent(one[1])}.`); return; }
      if (req.method === 'GET' && q.get('alt') === 'media') {
        // g.redirectDownloads: the content is served from another address (and another host name), as a signed link.
        if (g.redirectDownloads && !q.get('sig')) { send(res, 302, '', { Location: `http://localhost:${g.server.address().port}/drive/v3/files/${f.id}?alt=media&sig=${g.sign(f.id)}` }); return; }
        let bytes = g.corruptDownloads.has(f.id) ? Buffer.concat([f.bytes.subarray(0, f.bytes.length - 1), Buffer.from([f.bytes[f.bytes.length - 1] ^ 1])]) : f.bytes;
        const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        let status = 200, headers = {};
        if (r && !g.ignoreRange) {
          const a = Number(r[1]), z = r[2] ? Math.min(Number(r[2]), bytes.length - 1) : bytes.length - 1;
          if (a >= bytes.length) { apiError(res, 416, 'requestedRangeNotSatisfiable'); return; }
          headers = { 'Content-Range': `bytes ${a}-${z}/${bytes.length}` };
          bytes = bytes.subarray(a, z + 1);
          status = 206;
        }
        if (fault && fault.cut !== undefined) {
          // Says how long the answer is, sends the beginning, and breaks the connection.
          res.writeHead(status, Object.assign({ 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length }, headers));
          res.write(bytes.subarray(0, fault.cut), () => req.socket.destroy());
          return;
        }
        send(res, status, bytes, headers);
        return;
      }
      if (req.method === 'GET') { send(res, 200, q.get('fields') === 'parents' ? { parents: f.parents } : view(f)); return; }
      if (req.method === 'PATCH') {
        let about = {};
        try { about = body.length ? JSON.parse(body.toString('utf8')) : {}; } catch (e) { apiError(res, 400, 'parseError'); return; }
        if (about.trashed !== undefined) f.trashed = Boolean(about.trashed);
        if (about.name) f.name = about.name;
        const addTo = (q.get('addParents') || '').split(',').filter(Boolean), remove = (q.get('removeParents') || '').split(',').filter(Boolean);
        if (!parentsOk(addTo)) { apiError(res, 404, 'notFound'); return; }
        f.parents = (f.parents || []).filter(x => !remove.includes(x)).concat(addTo.filter(x => !(f.parents || []).includes(x)));
        send(res, 200, view(f));
        return;
      }
    }
    apiError(res, 404, 'notFound', `No such address in the pretend Google: ${req.method} ${p}`);
  }

  g.server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => { try { handle(req, res, Buffer.concat(parts)); } catch (e) { g.crashed = e; try { send(res, 500, { error: { code: 500, message: `pretend Google broke: ${e.stack}` } }); } catch (x) { /* sent */ } } });
    req.on('error', () => { /* the client went away */ });
  });
  g.start = port => new Promise((resolve, reject) => {
    g.server.on('error', reject);
    g.server.listen(port || 0, '127.0.0.1', () => { g.url = `http://127.0.0.1:${g.server.address().port}`; resolve(g); });
  });
  g.stop = () => new Promise(resolve => { if (g.server.closeAllConnections) g.server.closeAllConnections(); g.server.close(() => resolve()); });
  /* What a browser does with the sign-in address when the user says yes: follows it to the app's listener. */
  g.browser = url => new Promise((resolve, reject) => {
    http.get(url, r => {
      r.resume();
      if (r.statusCode !== 302) { resolve({ status: r.statusCode, stayed: true }); return; }
      http.get(r.headers.location, r2 => { let t = ''; r2.setEncoding('utf8'); r2.on('data', c => { t += c; }); r2.on('end', () => resolve({ status: r2.statusCode, page: t, location: r.headers.location })); }).on('error', reject);
    }).on('error', reject);
  });
  return g;
}

module.exports = { fakeGoogle, FOLDER, SCOPE };

if (require.main === module) {
  fakeGoogle().start(Number(process.argv[2]) || 0).then(g => {
    console.log(`Pretend Google at ${g.url}\n  client ID:     ${g.clientId}\n  client secret: ${g.clientSecret}\nStart Obsidian with SCRIPTORIUM_DRIVE_TEST_SERVER=${g.url}`);
  });
}
