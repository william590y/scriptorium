// Tests for the Scriptorium plugin's direct Google Drive connection (vault/.obsidian/plugins/scriptorium/main.js,
// "Google Drive, directly"): the sign-in (OAuth 2.0 for installed apps, PKCE, a loopback listener), tokens, the Drive
// REST calls (uploads in one request and in resumable parts, updates in place, paging, backoff, downloads with
// Range), whole backups and retrievals, Windows names and paths, and the diagnostic report. Everything runs against a
// pretend Google on 127.0.0.1 (fake-google.js): no request leaves this computer, and nothing here shows that the
// real Google behaves the same.
// Run: node --test plugins-tests/drive-direct.test.js
//
// Copyright (C) 2026 William Liaw. Licensed under the GNU General Public License, version 3 or later (see LICENSE).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { fakeGoogle, FOLDER, SCOPE } = require('./fake-google.js');

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'obsidian') {
    class Stub {}
    return { Plugin: Stub, PluginSettingTab: Stub, Setting: Stub, MarkdownView: Stub, MarkdownRenderer: Stub, Component: Stub, Scope: Stub, Modal: Stub, Notice: Stub, Platform: {} };
  }
  return realLoad.call(this, request, ...rest);
};
const S = require(path.join(__dirname, '..', 'vault', '.obsidian', 'plugins', 'scriptorium', 'main.js'));
Module._load = realLoad;

const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const KIB = 1024;

function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `scriptorium-direct-test-${name || ''}`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(dir, rel, data) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}
function vaultFiles(dir) {
  const out = {};
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child); else out[child] = sha(fs.readFileSync(path.join(dir, child)));
    }
  };
  walk('');
  return out;
}
const noise = (n, seed) => { const out = Buffer.alloc(n); let x = seed || 1; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = x >> 16; } return out; };

/* A pretend Google, and a kit (driveKit) that talks to it: signed in unless o.signedOut. Waits are recorded, not
   waited. Small limits make a file of a megabyte "large". */
async function setup(t, o = {}) {
  const g = await fakeGoogle(o.google).start();
  t.after(() => g.stop());
  const home = tmp(t, 'home-');
  const sleeps = [];
  const kit = S.driveKit({
    fs, path, os, crypto, http, https, env: { SCRIPTORIUM_DRIVE_TEST_SERVER: g.url }, platform: 'linux', file: path.join(home, 'config', S.DRIVE_AUTH_FILE), seal: o.seal || null,
    sleep: async ms => { sleeps.push(ms); }, random: () => 0, log: e => kit.requests.push(e),
    direct: Object.assign({}, S.DRIVE_DIRECT, { chunk: 256 * KIB, single: 256 * KIB, memory: 512 * KIB, tries: 5, timeoutMs: 5000, signInMs: 3000 }, o.direct),
  });
  kit.requests = [];
  assert.equal(kit.endpoints.test, g.url, 'the tests must never reach the real Google');
  kit.store.save({ clientId: g.clientId, clientSecret: g.clientSecret });
  if (!o.signedOut) await kit.signIn({ open: url => g.browser(url) });
  return { g, kit, sleeps, home };
}

function device(t, kit, dir, name, more) {
  const work = tmp(t, 'work-');
  return () => new S.DriveSync(Object.assign({
    fs, path, crypto, dir, work, vault: 'My Vault', folder: 'Scriptorium', device: name, limits: S.DRIVE_DIRECT_LIMITS, now: () => new Date(2026, 10, 12, 15, 0, 0),
    run: kit.runner({ work, sessions: S.driveSessions(fs, path.join(dir, S.DRIVE_UPLOADS)) }),
  }, more));
}

function sampleVault(dir) {
  write(dir, 'Welcome.md', '# Welcome\n');
  write(dir, 'Notes/One.md', 'one\n');
  write(dir, 'Notes/Deep/Two.md', 'two\n');
  write(dir, 'Notes/It’s “quoted”.md', 'quoted\n');
  write(dir, 'Attachments/picture.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]));
  write(dir, 'Attachments/recording.m4a', noise(700 * KIB, 7));   // larger than `single`: goes up in parts
  write(dir, 'Empty.md', '');
  write(dir, '.obsidian/app.json', '{"baseFontSize":22}\n');
  write(dir, '.obsidian/plugins/scriptorium/data.json', '{"fancyMode":true,"drive":{"transport":"direct"}}\n');
  write(dir, '.obsidian/plugins/lagrange/data.json', '{"anthropicKey":"sk-secret"}');
  write(dir, '.obsidian/plugins/scriptorium/main.js', '// code');
  write(dir, '.obsidian/workspace.json', '{}');
}
const SAMPLE = ['.obsidian/app.json', '.obsidian/plugins/scriptorium/data.json', 'Attachments/picture.png', 'Attachments/recording.m4a', 'Empty.md',
  'Notes/Deep/Two.md', 'Notes/It’s “quoted”.md', 'Notes/One.md', 'Welcome.md'];

/* ---------- small things ---------- */

test('direct: until it is checked against the real Google, the direct connection is opt-in, and no client ID is built in', () => {
  assert.equal(S.DRIVE_DEFAULT_TRANSPORT, 'claude');
  assert.deepEqual(S.DRIVE_DEFAULT_CLIENT, { id: '', secret: '' });
  assert.equal(S.driveTransport({}), 'claude');
  assert.equal(S.driveTransport({ drive: { transport: 'direct' } }), 'direct');
  assert.equal(S.driveTransport({ drive: { transport: 'nonsense' } }), 'claude');
  assert.equal(S.DRIVE_SCOPE, 'https://www.googleapis.com/auth/drive.file');
});

test('direct: files keep their real type, so Drive shows a picture as a picture', () => {
  assert.equal(S.driveRealMime('a.png'), 'image/png');
  assert.equal(S.driveRealMime('A.JPG'), 'image/jpeg');
  assert.equal(S.driveRealMime('note.md'), 'text/markdown');
  assert.equal(S.driveRealMime('scan.pdf'), 'application/pdf');
  for (const name of ['noextension', '.hidden', 'a.constructor', 'a.unknown']) assert.equal(S.driveRealMime(name), 'application/octet-stream', name);
});

test('direct: requests go to Google, and to a test server only if it is on this computer', () => {
  assert.equal(S.driveEndpoints({}), S.GOOGLE_ENDPOINTS);
  assert.equal(S.GOOGLE_ENDPOINTS.token, 'https://oauth2.googleapis.com/token');
  assert.equal(S.GOOGLE_ENDPOINTS.auth, 'https://accounts.google.com/o/oauth2/v2/auth');
  for (const bad of ['https://evil.example', 'http://127.0.0.1.evil.example:80', 'http://localhost:8080', 'http://127.0.0.1:8080/x', 'http://10.0.0.1:8080', 'http://127.0.0.1:8080@evil.example']) {
    assert.equal(S.driveEndpoints({ SCRIPTORIUM_DRIVE_TEST_SERVER: bad }), S.GOOGLE_ENDPOINTS, bad);
  }
  const e = S.driveEndpoints({ SCRIPTORIUM_DRIVE_TEST_SERVER: 'http://127.0.0.1:8080' });
  assert.equal(e.token, 'http://127.0.0.1:8080/token');
  assert.equal(e.test, 'http://127.0.0.1:8080');
});

test('direct: the sign-in is kept per user, outside every vault, on Windows, macOS and Linux', () => {
  assert.equal(S.driveAuthFile(path.win32, { APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' }, 'win32', 'C:\\Users\\Ada'), 'C:\\Users\\Ada\\AppData\\Roaming\\Scriptorium\\scriptorium-google-drive.json');
  assert.equal(S.driveAuthFile(path.win32, {}, 'win32', 'C:\\Users\\Ada'), 'C:\\Users\\Ada\\AppData\\Roaming\\Scriptorium\\scriptorium-google-drive.json');
  assert.equal(S.driveAuthFile(path.posix, {}, 'darwin', '/Users/ada'), '/Users/ada/Library/Application Support/Scriptorium/scriptorium-google-drive.json');
  assert.equal(S.driveAuthFile(path.posix, {}, 'linux', '/home/ada'), '/home/ada/.config/scriptorium/scriptorium-google-drive.json');
  assert.equal(S.driveAuthFile(path.posix, { XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/ada'), '/cfg/scriptorium/scriptorium-google-drive.json');
  assert.equal(S.driveAuthFile(path.posix, { XDG_CONFIG_HOME: 'relative' }, 'linux', '/home/ada'), '/home/ada/.config/scriptorium/scriptorium-google-drive.json');
  // Were a vault to hold that folder, the file is still never backed up, nor copied by "Set up another vault".
  for (const rel of ['scriptorium-google-drive.json', 'AppData/Roaming/Scriptorium/scriptorium-google-drive.json', '.obsidian/plugins/scriptorium/drive-uploads.json', '.obsidian/plugins/scriptorium/drive-sync.json']) {
    assert.equal(S.driveRule(rel), false, rel);
    assert.equal(S.setupRule(rel), null, rel);
  }
});

test('direct: a client ID is taken as typed, or from the JSON file Google gives', () => {
  const id = '1234567890-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com';
  assert.deepEqual(S.driveParseClient(`  ${id}\n`, ' GOCSPX-abc '), { id, secret: 'GOCSPX-abc', problem: '' });
  assert.deepEqual(S.driveParseClient(JSON.stringify({ installed: { client_id: id, client_secret: 'GOCSPX-xyz', redirect_uris: ['http://localhost'] } }), ''), { id, secret: 'GOCSPX-xyz', problem: '' });
  assert.match(S.driveParseClient(JSON.stringify({ web: { client_id: id, client_secret: 's' } })).problem, /Web application.*Desktop app/);
  assert.match(S.driveParseClient('{not json').problem, /not a client ID/);
  assert.match(S.driveParseClient('my-client').problem, /apps\.googleusercontent\.com/);
  assert.match(S.driveParseClient(id, 'has space').problem, /secret/);
  assert.deepEqual(S.driveParseClient('', 'x'), { id: '', secret: '', problem: '' });
  assert.deepEqual(S.driveClient({ clientId: id, clientSecret: 's' }), { id, secret: 's', own: true });
  assert.deepEqual(S.driveClient({}), { id: '', secret: '', own: false });
});

test('direct: the engine\'s searches, in Drive\'s words', () => {
  assert.equal(S.driveQuery(`title = 'It\\'s' and parentId = 'root' and mimeType = '${FOLDER}'`), `name = 'It\\'s' and 'root' in parents and mimeType = '${FOLDER}' and trashed = false`);
  assert.equal(S.driveQuery("title = 'scriptorium-manifest.json' and parentId = 'abc'"), "name = 'scriptorium-manifest.json' and 'abc' in parents and trashed = false");
});

test('direct: what is tried again, and after how long', () => {
  const res = (status, reason) => ({ status, headers: {}, body: Buffer.from(JSON.stringify({ error: { code: status, message: 'm', errors: [{ reason }] } })) });
  for (const [status, reason] of [[429, 'rateLimitExceeded'], [500, 'backendError'], [502, ''], [503, ''], [504, ''], [403, 'userRateLimitExceeded'], [403, 'rateLimitExceeded']]) assert.equal(S.driveRetryable(res(status, reason)), true, `${status} ${reason}`);
  for (const [status, reason] of [[400, 'badRequest'], [401, 'authError'], [403, 'storageQuotaExceeded'], [403, 'insufficientFilePermissions'], [403, 'accessNotConfigured'], [404, 'notFound'], [200, '']]) assert.equal(S.driveRetryable(res(status, reason)), false, `${status} ${reason}`);
  const l = { baseMs: 500, maxMs: 32000 };
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(n => S.driveDelay(n, null, l, () => 0)), [500, 1000, 2000, 4000, 8000, 16000, 32000, 32000]);
  assert.equal(S.driveDelay(0, null, l, () => 0.5), 750);
  assert.equal(S.driveDelay(0, { headers: { 'retry-after': '7' } }, l, () => 0), 7000);
  assert.match(S.driveExplain(res(403, 'accessNotConfigured')), /Drive API is not turned on/);
  assert.match(S.driveExplain(res(403, 'storageQuotaExceeded')), /full/);
  assert.match(S.driveExplain(res(404, 'notFound')), /not found.*404/);
});

/* ---------- signing in ---------- */

test('direct: signing in. PKCE, a listener on 127.0.0.1, one scope, and a token that is saved where only the user reads it', async t => {
  const { g, kit } = await setup(t, { signedOut: true });
  assert.equal(kit.status().connected, false);
  let url = '';
  const got = await kit.signIn({ onUrl: u => { url = u; }, open: u => g.browser(u) });
  const q = new URL(url).searchParams;
  assert.equal(new URL(url).origin + new URL(url).pathname, `${g.url}/o/oauth2/v2/auth`);
  assert.equal(q.get('scope'), SCOPE, 'drive.file and nothing else');
  assert.match(q.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.match(q.get('code_challenge'), /^[\w-]{43}$/);
  assert.ok(q.get('state').length >= 16);
  // The exchange carried the verifier that hashes to the challenge, and the same redirect address.
  const sent = g.lastTokenRequest;
  assert.equal(crypto.createHash('sha256').update(sent.code_verifier).digest('base64url'), q.get('code_challenge'));
  assert.equal(sent.redirect_uri, q.get('redirect_uri'));
  assert.equal(sent.grant_type, 'authorization_code');
  assert.equal(got.email, 'ada.writer@example.com');
  const st = kit.status();
  assert.deepEqual([st.connected, st.email, st.name], [true, 'ada.writer@example.com', 'Ada Writer']);
  // On disk: the refresh token, for this user only; never the access token.
  const saved = fs.readFileSync(kit.store.file, 'utf8');
  assert.ok(saved.includes(got.refresh));
  assert.ok(!saved.includes(got.access));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(kit.store.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(kit.store.file)).mode & 0o777, 0o700);
  }
  // The listener is gone once the sign-in is over.
  await new Promise(r => setTimeout(r, 400));
  await assert.rejects(new Promise((resolve, reject) => http.get(q.get('redirect_uri'), resolve).on('error', reject)), /ECONNREFUSED/);
});

test('direct: with a keychain, the token on disk is sealed; a seal that no longer opens means connecting again', async t => {
  const seal = { enc: s => Buffer.from(s, 'utf8').reverse().toString('base64'), dec: b => Buffer.from(b, 'base64').reverse().toString('utf8') };
  const { kit } = await setup(t, { seal });
  const s = kit.store.load();
  assert.ok(s.refresh.startsWith('1//'));
  assert.ok(!fs.readFileSync(kit.store.file, 'utf8').includes(s.refresh), 'the token itself is not in the file');
  const broken = S.driveAuthStore({ fs, path, file: kit.store.file, seal: { enc: seal.enc, dec: () => { throw new Error('keychain changed'); } } });
  assert.equal(broken.load().refresh, undefined);
  assert.match(broken.load().problem, /keychain.*Connect again/);
});

test('direct: the listener answers only its own sign-in; a refusal, a wrong client and a cancel are each said plainly', async t => {
  const { g, kit } = await setup(t, { signedOut: true });
  // Another page on the computer calls the listener with a made-up code: refused, and the real sign-in still works.
  const got = await kit.signIn({
    open: async url => {
      const redirect = new URL(url).searchParams.get('redirect_uri');
      const forged = await new Promise(resolve => http.get(`${redirect}/?code=stolen&state=wrong`, r => { r.resume(); resolve(r.statusCode); }));
      assert.equal(forged, 400);
      const other = await new Promise(resolve => http.get(`${redirect}/favicon.ico`, r => { r.resume(); resolve(r.statusCode); }));
      assert.equal(other, 404);
      return g.browser(url);
    },
  });
  assert.ok(got.refresh);
  g.approve = false;
  await assert.rejects(kit.signIn({ open: url => g.browser(url) }), e => e.kind === 'google' && /did not allow it|test users/.test(e.message));
  g.approve = true;
  // Cancelled while the browser is open.
  const stop = new AbortController();
  await assert.rejects(kit.signIn({ signal: stop.signal, open: () => { setTimeout(() => stop.abort(), 20); } }), e => e.name === 'AbortError');
  // A wrong secret: Google's token address refuses the exchange.
  kit.store.save({ clientSecret: 'GOCSPX-wrong' });
  await assert.rejects(kit.signIn({ open: url => g.browser(url) }), e => e.kind === 'client' && /client ID.*secret is not right/.test(e.message));
  kit.store.save({ clientSecret: g.clientSecret });
  // Google grants the sign-in but not the Drive permission.
  g.grantScope = 'openid';
  await assert.rejects(kit.signIn({ open: url => g.browser(url) }), /without permission for the files/);
  g.grantScope = SCOPE;
  // The browser never comes back.
  await assert.rejects(kit.signIn({ open: () => {}, limits: { signInMs: 50 } }), /No answer came back from the browser/);
  // No client ID at all.
  kit.store.save({ clientId: '', clientSecret: '' });
  await assert.rejects(kit.signIn({ open: url => g.browser(url) }), e => e.kind === 'client');
});

test('direct: access tokens are renewed with the refresh token, once for many callers, and a withdrawn sign-in says so', async t => {
  const { g, kit } = await setup(t, { google: { accessSeconds: 30 } });   // shorter than the minute of margin: always renewed
  const before = g.count('token:refresh_token');
  const [a, b, c] = await Promise.all([kit.tokens.get(false), kit.tokens.get(false), kit.tokens.get(false)]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(g.count('token:refresh_token'), before + 1, 'one renewal for three callers');
  // A token that Google stops accepting (401) is renewed once, and the call goes through.
  g.accessSeconds = 3600;
  await kit.tokens.get(true);
  g.access.clear();
  const res = await kit.api({ method: 'GET', url: `${kit.endpoints.api}/about` }, {});
  assert.equal(res.status, 200);
  // Withdrawn at Google: said plainly, and forgotten here, so the next page asks to connect.
  g.refresh.clear();
  g.access.clear();
  await assert.rejects(kit.api({ method: 'GET', url: `${kit.endpoints.api}/about` }, {}), e => e.kind === 'signin' && /no longer accepts this sign-in.*seven days.*Connect again/.test(e.message));
  assert.equal(kit.status().connected, false);
  assert.equal(kit.store.load().clientId, g.clientId, 'the client ID is kept');
});

test('direct: Disconnect withdraws the token at Google and deletes it here', async t => {
  const { g, kit } = await setup(t);
  const token = kit.store.load().refresh;
  assert.ok(g.refresh.has(token));
  assert.deepEqual(await kit.disconnect(), { revoked: true });
  assert.equal(g.count('revoke'), 1);
  assert.ok(!g.refresh.has(token));
  const file = fs.readFileSync(kit.store.file, 'utf8');
  assert.ok(!file.includes(token) && !file.includes('token'));
  assert.equal(kit.status().connected, false);
  await assert.rejects(kit.tokens.get(false), e => e.kind === 'signin');
  // Google unreachable: still deleted here, and said.
  const { kit: kit2 } = await setup(t);
  const closed = await fakeGoogle().start();
  await closed.stop();
  const dead = S.driveKit({ fs, path, os, crypto, http, https, env: { SCRIPTORIUM_DRIVE_TEST_SERVER: closed.url }, platform: 'linux', file: kit2.store.file });
  assert.equal(dead.endpoints.test, closed.url, 'the test must never reach the real Google');
  const r = await dead.disconnect();
  assert.equal(r.revoked, false);
  assert.equal(dead.status().connected, false);
});

/* ---------- whole backups ---------- */

test('direct: a first backup, a second one that updates files in place, and a retrieval that checks every file', async t => {
  const { g, kit } = await setup(t);
  const dir = tmp(t, 'vault-');
  sampleVault(dir);
  const token = kit.store.load().refresh, access = await kit.tokens.get(false);
  const first = device(t, kit, dir, 'laptop')();
  const info = await first.prepare();
  assert.equal(info.first, true);
  assert.deepEqual(info.plan.upload, SAMPLE);
  assert.deepEqual(info.skipped, [], 'no file is too large for the direct connection');
  const s = await first.sync();
  assert.deepEqual([s.uploaded, s.failed.length, s.cost], [9, 0, 0]);
  const tree = g.tree();
  assert.deepEqual(Object.keys(tree).sort(), SAMPLE.filter(r => r !== 'Empty.md').map(r => `Scriptorium/My Vault/${r}`).concat(['Scriptorium/My Vault/scriptorium-manifest.json']).sort());
  for (const rel of SAMPLE.filter(r => r !== 'Empty.md')) assert.equal(sha(tree[`Scriptorium/My Vault/${rel}`].bytes), sha(fs.readFileSync(path.join(dir, rel))), rel);
  assert.equal(tree['Scriptorium/My Vault/Attachments/picture.png'].mimeType, 'image/png');
  assert.equal(tree['Scriptorium/My Vault/Notes/One.md'].mimeType, 'text/markdown');
  assert.equal(g.count('upload:resumable'), 1, 'the recording went up in parts');
  assert.equal(g.count('upload:chunk'), 3);
  const manifest = JSON.parse(tree['Scriptorium/My Vault/scriptorium-manifest.json'].bytes.toString('utf8'));
  assert.equal(manifest.via, 'direct');
  assert.equal(manifest.files['Empty.md'].id, null);
  // No token, secret or client ID anywhere in Drive, in the vault, or in what this device remembers.
  const everything = Buffer.concat([...g.files.values()].filter(f => f.bytes).map(f => f.bytes).concat(Object.keys(vaultFiles(dir)).map(rel => fs.readFileSync(path.join(dir, rel))))).toString('latin1');
  for (const secret of [token, access, g.clientSecret, g.clientId]) assert.ok(!everything.includes(secret), 'a secret was written where it must not be');
  assert.ok(!Object.keys(vaultFiles(dir)).some(rel => rel.endsWith(S.DRIVE_AUTH_FILE)));

  // Second backup: a changed note and a changed recording keep their Drive files; nothing is uploaded anew or trashed.
  const ids = Object.fromEntries(Object.entries(tree).map(([k, f]) => [k, f.id]));
  write(dir, 'Notes/One.md', 'one, revised\n');
  write(dir, 'Attachments/recording.m4a', noise(800 * KIB, 9));
  write(dir, 'Notes/New.md', 'new\n');
  fs.unlinkSync(path.join(dir, 'Welcome.md'));
  const filesBefore = g.files.size;
  const s2 = await device(t, kit, dir, 'laptop')().sync();
  assert.deepEqual([s2.uploaded, s2.deletedThere, s2.failed.length], [3, 1, 0]);
  const tree2 = g.tree();
  for (const rel of ['Notes/One.md', 'Attachments/recording.m4a', 'scriptorium-manifest.json']) assert.equal(tree2[`Scriptorium/My Vault/${rel}`].id, ids[`Scriptorium/My Vault/${rel}`], `${rel} was updated in place`);
  assert.equal(tree2['Scriptorium/My Vault/Notes/One.md'].bytes.toString(), 'one, revised\n');
  assert.equal(sha(tree2['Scriptorium/My Vault/Attachments/recording.m4a'].bytes), sha(noise(800 * KIB, 9)));
  assert.equal([...g.files.values()].filter(f => f.trashed).length, 0, 'nothing went to Drive\'s trash');
  assert.equal(g.files.size, filesBefore + 3, 'one new note, and the _trash folders');
  assert.ok(tree2['Scriptorium/My Vault/_trash/2026-11-12/Welcome.md'], 'a deleted file is moved, not removed');
  assert.ok(g.count('upload:multipart:update') >= 2 && g.count('upload:resumable:update') === 1);
  // Nothing changed: nothing is sent.
  const again = await device(t, kit, dir, 'laptop')().prepare();
  assert.equal(again.nothing, true);

  // Another computer retrieves it.
  const dir2 = tmp(t, 'retrieved-');
  const lister = device(t, kit, tmp(t, 'list-'), 'desktop', { vault: '' })();
  const vaults = await lister.vaults();
  assert.deepEqual(vaults.map(v => [v.name, v.files, v.device, v.via]), [['My Vault', 9, 'laptop', 'direct']]);
  assert.equal(vaults[0].bytes, Object.values(JSON.parse(tree2['Scriptorium/My Vault/scriptorium-manifest.json'].bytes).files).reduce((n, f) => n + f.size, 0));
  const r = await device(t, kit, dir2, 'desktop')().retrieve(vaults[0]);
  assert.deepEqual([r.downloaded, r.failed.length], [9, 0]);
  const want = vaultFiles(dir), have = vaultFiles(dir2);
  for (const rel of Object.keys(JSON.parse(tree2['Scriptorium/My Vault/scriptorium-manifest.json'].bytes).files)) assert.equal(have[rel], want[rel], rel);
  assert.equal(have['.obsidian/plugins/lagrange/data.json'], undefined);
  assert.equal(fs.readdirSync(dir2).filter(n => n.endsWith('.scriptorium-tmp')).length, 0);
  // And it syncs from there: nothing to do.
  assert.equal((await device(t, kit, dir2, 'desktop')().prepare()).nothing, true);
});

test('direct: a large upload broken off by the network carries on from where Google has it, sending nothing twice', async t => {
  const { g, kit, sleeps } = await setup(t);
  const dir = tmp(t, 'vault-');
  const big = noise(5 * 256 * KIB + 1000, 3);
  write(dir, 'big.bin', big);
  // The second part: the connection breaks after 256 KiB of nothing kept; the fourth: Google answers 503.
  g.fault = e => (e.kind === 'upload:chunk' && e.n === 2 ? { cut: 0 } : e.kind === 'upload:chunk' && e.n === 5 ? { status: 503 } : null);
  const s = await device(t, kit, dir, 'laptop')().sync();
  assert.deepEqual([s.uploaded, s.failed.length], [1, 0]);
  assert.equal(sha(g.tree()['Scriptorium/My Vault/big.bin'].bytes), sha(big));
  assert.equal(g.count('upload:resumable'), 1, 'one session');
  assert.equal(g.count('upload:status'), 2, 'asked where it stood after each break');
  assert.equal(g.received - Object.values(g.tree()).filter(f => f.name.endsWith('.json')).reduce((n, f) => n + f.bytes.length, 0), big.length, 'no byte was taken twice');
  assert.ok(sleeps.length >= 2, 'it waited before carrying on');
});

test('direct: a large upload stopped by the writer is carried on by the next run, in the same session', async t => {
  const { g, kit } = await setup(t);
  const dir = tmp(t, 'vault-');
  const big = noise(6 * 256 * KIB + 77, 5);
  write(dir, 'Recordings/big.wav', big);
  const stop = new AbortController();
  g.fault = e => { if (e.kind === 'upload:chunk' && e.n === 3) stop.abort(); return null; };
  await assert.rejects(device(t, kit, dir, 'laptop', { signal: stop.signal })().sync(), e => e.name === 'AbortError');
  assert.equal(g.tree()['Scriptorium/My Vault/Recordings/big.wav'], undefined);
  const sessions = JSON.parse(fs.readFileSync(path.join(dir, S.DRIVE_UPLOADS), 'utf8'));
  assert.equal(Object.keys(sessions).length, 1, 'the session is remembered, in a file that is not backed up');
  assert.equal(S.driveRule(S.DRIVE_UPLOADS), false);
  g.fault = null;
  const chunksBefore = g.count('upload:chunk');
  const s = await device(t, kit, dir, 'laptop')().sync();
  assert.deepEqual([s.uploaded, s.failed.length], [1, 0]);
  assert.equal(g.count('upload:resumable'), 1, 'no second session');
  assert.equal(g.count('upload:chunk') - chunksBefore, 4, 'only the parts that were missing (7 in all, 3 had arrived)');
  assert.equal(sha(g.tree()['Scriptorium/My Vault/Recordings/big.wav'].bytes), sha(big));
  assert.equal(fs.existsSync(path.join(dir, S.DRIVE_UPLOADS)), false, 'forgotten once done');
  // A session Google has dropped (404) is begun again.
  write(dir, 'Recordings/other.wav', noise(3 * 256 * KIB, 6));
  g.fault = e => { if (e.kind === 'upload:chunk' && e.n === chunksBefore + 4 + 2) { g.sessions.clear(); } return null; };
  const s3 = await device(t, kit, dir, 'laptop')().sync();
  assert.deepEqual([s3.uploaded, s3.failed.length], [1, 0]);
  assert.equal(sha(g.tree()['Scriptorium/My Vault/Recordings/other.wav'].bytes), sha(noise(3 * 256 * KIB, 6)));
});

test('direct: rate limits and server errors are waited out with a doubling wait; other refusals are not tried again', async t => {
  const { g, kit, sleeps } = await setup(t);
  const dir = tmp(t, 'vault-');
  write(dir, 'a.md', 'a\n');
  let n = 0;
  g.fault = e => {
    if (e.kind !== 'upload:multipart') return null;
    n++;
    return n === 1 ? { status: 429, reason: 'rateLimitExceeded' } : n === 2 ? { status: 403, reason: 'userRateLimitExceeded' } : n === 3 ? { status: 503 } : n === 4 ? { drop: true } : null;
  };
  sleeps.length = 0;
  const s = await device(t, kit, dir, 'laptop')().sync();
  assert.deepEqual([s.uploaded, s.failed.length], [1, 0]);
  assert.deepEqual(sleeps, [500, 1000, 2000, 4000]);
  // Retry-After is honoured.
  write(dir, 'b.md', 'b\n');
  n = 0;
  g.fault = e => (e.kind === 'upload:multipart' && ++n === 1 ? { status: 429, reason: 'rateLimitExceeded', retryAfter: 3 } : null);
  sleeps.length = 0;
  await device(t, kit, dir, 'laptop')().sync();
  assert.deepEqual(sleeps, [3000]);
  // A full Drive is not a thing to try again at once: the file is reported, with the reason, and nothing is lost.
  write(dir, 'c.md', 'c\n');
  g.fault = e => (e.kind === 'upload:multipart' ? { status: 403, reason: 'storageQuotaExceeded' } : null);
  sleeps.length = 0;
  const full = await device(t, kit, dir, 'laptop')().sync();
  assert.deepEqual(sleeps, []);
  assert.equal(full.failed.length, 1);
  assert.match(full.failed[0].why, /Uploading: your Google Drive is full/);
  // A Google that stays down: it gives up after the tries, with the reason.
  g.fault = e => (e.kind === 'upload:multipart' ? { status: 500 } : null);
  sleeps.length = 0;
  const down = await device(t, kit, dir, 'laptop')().sync();
  assert.match(down.failed[0].why, /busy or limiting requests \(500/);
  assert.equal(sleeps.length, 3 * 4, 'five tries, three times over');
});

test('direct: the Drive API switched off in the Cloud project is said in so many words', async t => {
  const { g, kit } = await setup(t);
  g.apiOn = false;
  const dir = tmp(t, 'vault-');
  write(dir, 'a.md', 'a\n');
  await assert.rejects(device(t, kit, dir, 'laptop')().prepare(), /Drive API is not turned on in the Google Cloud project.*Enable/);
  // And signing in notices it.
  const got = await kit.signIn({ open: url => g.browser(url) });
  assert.equal(got.apiOff, true);
});

test('direct: listing goes through every page', async t => {
  const { g, kit } = await setup(t, { google: { pageCap: 2 } });
  for (const name of ['A', 'B', 'C', 'D', 'E']) {
    const dir = tmp(t, 'vault-');
    write(dir, 'note.md', `${name}\n`);
    await device(t, kit, dir, 'laptop', { vault: `Vault ${name}` })().sync();
  }
  const before = g.count('list');
  const vaults = await device(t, kit, tmp(t, 'list-'), 'desktop', { vault: '' })().vaults();
  assert.deepEqual(vaults.map(v => v.name), ['Vault A', 'Vault B', 'Vault C', 'Vault D', 'Vault E']);
  assert.ok(g.count('list') - before >= 3 + 5, 'three pages of folders');
});

test('direct: what does not match its checksum is never written, and never left in Drive as if it were the file', async t => {
  const { g, kit } = await setup(t);
  const dir = tmp(t, 'vault-');
  write(dir, 'Notes/a.md', 'alpha\n');
  write(dir, 'Notes/b.md', 'beta\n');
  write(dir, 'big.bin', noise(600 * KIB, 4));
  await device(t, kit, dir, 'laptop')().sync();
  const tree = g.tree();
  g.corruptDownloads.add(tree['Scriptorium/My Vault/Notes/a.md'].id);
  g.corruptDownloads.add(tree['Scriptorium/My Vault/big.bin'].id);
  const dir2 = tmp(t, 'retrieved-');
  const [v] = await device(t, kit, tmp(t, 'list-'), 'desktop', { vault: '' })().vaults();
  const r = await device(t, kit, dir2, 'desktop')().retrieve(v);
  assert.equal(r.downloaded, 1);
  assert.deepEqual(r.failed.map(f => f.path).sort(), ['Notes/a.md', 'big.bin']);
  for (const f of r.failed) assert.match(f.why, /does not match the backup’s SHA-256, so it was not written/);
  assert.deepEqual(Object.keys(vaultFiles(dir2)).filter(n => !n.startsWith('.obsidian')), ['Notes/b.md']);
  assert.equal(fs.readdirSync(os.tmpdir()).filter(n => n.includes('download-')).length, 0);
  // An upload that Drive stores wrongly is caught by Drive's own checksum, trashed, and reported.
  g.corruptUploads = true;
  write(dir, 'Notes/c.md', 'gamma\n');
  const s = await device(t, kit, dir, 'laptop')().sync();
  assert.equal(s.failed.length >= 1, true);
  assert.match(s.failed[0].why, /what arrived in Google Drive is not the file that was sent/);
  assert.equal(g.tree()['Scriptorium/My Vault/Notes/c.md'], undefined, 'the bad copy is in Drive\'s trash');
});

test('direct: a large download broken off carries on with Range, and is written from a file, not from memory', async t => {
  const { g, kit, sleeps } = await setup(t);
  const dir = tmp(t, 'vault-');
  const big = noise(900 * KIB, 8);   // larger than `memory`
  write(dir, 'film.mp4', big);
  await device(t, kit, dir, 'laptop')().sync();
  g.fault = e => (e.kind === 'download' && e.n === 2 ? { cut: 300 * KIB } : e.kind === 'download' && e.n === 3 ? { status: 503 } : null);
  const dir2 = tmp(t, 'retrieved-');
  const [v] = await device(t, kit, tmp(t, 'list-'), 'desktop', { vault: '' })().vaults();   // download 1: the manifest
  sleeps.length = 0;
  const r = await device(t, kit, dir2, 'desktop')().retrieve(v);
  assert.deepEqual([r.downloaded, r.failed.length], [1, 0]);
  assert.equal(sha(fs.readFileSync(path.join(dir2, 'film.mp4'))), sha(big));
  const ranges = g.log.filter(l => l.kind === 'download' && l.range).map(l => l.range);
  assert.equal(ranges.length, 2);
  assert.match(ranges[0], /^bytes=\d+-$/);
  assert.ok(Number(ranges[0].slice(6, -1)) > 0 && Number(ranges[0].slice(6, -1)) <= 300 * KIB);
  assert.ok(sleeps.length >= 2);
  // A server that ignores Range and sends the whole file again: taken from its first byte, still right.
  g.ignoreRange = true;
  const before = g.count('download');
  g.fault = e => (e.kind === 'download' && e.n === before + 1 ? { cut: 100 * KIB } : null);
  const dir3 = tmp(t, 'retrieved-');
  const r3 = await device(t, kit, dir3, 'desktop')().retrieve(v);
  assert.deepEqual([r3.downloaded, r3.failed.length], [1, 0]);
  assert.equal(sha(fs.readFileSync(path.join(dir3, 'film.mp4'))), sha(big));
});

/* ---------- the two ways, side by side ---------- */

test('direct: it cannot see a backup that Claude\'s connector made; a vault backed up that way before gets a new, complete backup', async t => {
  const { g, kit } = await setup(t);
  // What Scriptorium 1.2.0 left in the Drive, stored by another app.
  const root = g.seed({ name: 'Scriptorium', mimeType: FOLDER }, 'claude-connector');
  const folder = g.seed({ name: 'My Vault', mimeType: FOLDER, parents: [root.id] }, 'claude-connector');
  g.seed({ name: 'scriptorium-manifest.json', mimeType: 'application/json', parents: [folder.id], bytes: Buffer.from(JSON.stringify({ schema: 1, app: 'scriptorium', vault: 'My Vault', seq: 1, files: {}, folders: {} })) }, 'claude-connector');
  const lister = device(t, kit, tmp(t, 'list-'), 'desktop', { vault: '' })();
  assert.deepEqual(await lister.vaults(), [], 'invisible under drive.file');
  // The vault remembers the old backup's folder; the direct connection starts afresh instead of reading it as "deleted there".
  const dir = tmp(t, 'vault-');
  write(dir, 'a.md', 'a\n');
  write(dir, S.DRIVE_STATE, JSON.stringify({ schema: 1, rootName: 'Scriptorium', vault: 'My Vault', rootId: root.id, folderId: folder.id, seq: 1, manifestId: 'x', base: { 'a.md': sha('a\n'), 'gone.md': sha('gone') }, hashes: {} }));
  const sync = device(t, kit, dir, 'laptop')();
  assert.equal(sync.switched, 'claude');
  const info = await sync.prepare();
  assert.equal(info.first, true);
  assert.deepEqual(info.plan.upload, ['a.md']);
  assert.deepEqual(info.plan.deleteLocal, []);
  await sync.sync();
  assert.ok(g.tree(g.clientId)['Scriptorium/My Vault/a.md']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, S.DRIVE_STATE), 'utf8')).via, 'direct');
  assert.equal([...g.files.values()].filter(f => f.name === 'Scriptorium' && f.mimeType === FOLDER).length, 2, 'two folders of the same name: the old backup and the new');
  // A file of the old backup cannot be touched even by its id.
  const res = await kit.api({ method: 'GET', url: `${kit.endpoints.api}/files/${folder.id}?fields=id` }, {});
  assert.equal(res.status, 404);
});

test('direct: a backup made one way is not written, or retrieved, the other way', async t => {
  const { kit } = await setup(t);
  const dir = tmp(t, 'vault-');
  write(dir, 'a.md', 'a\n');
  await device(t, kit, dir, 'laptop')().sync();
  const [v] = await device(t, kit, tmp(t, 'list-'), 'desktop', { vault: '' })().vaults();
  // The same engine with a runner that has no `caps` is the Claude Code way.
  const claudeRun = async () => { throw new Error('no call may be made'); };
  const other = new S.DriveSync({ fs, path, crypto, dir: tmp(t, 'other-'), work: tmp(t, 'w-'), vault: 'My Vault', folder: 'Scriptorium', device: 'x', run: claudeRun });
  assert.equal(other.via, 'claude');
  await assert.rejects(other.retrieve(v), /made with the direct Google sign-in/);
  assert.match(S.driveOtherWay('claude'), /made through Claude Code/);
});

/* ---------- Windows and macOS ---------- */

test('direct: names that Windows refuses are said so, file by file, without asking Drive for them', async t => {
  assert.equal(S.driveNameProblem('Notes/What is this?.md', 'linux'), '');
  assert.equal(S.driveNameProblem('Notes/What is this?.md', 'darwin'), '');
  assert.match(S.driveNameProblem('Notes/What is this?.md', 'win32'), /Windows does not allow the character \? in a name \(“What is this\?\.md”\)/);
  assert.match(S.driveNameProblem('Talk: notes/a.md', 'win32'), /character :/);
  assert.match(S.driveNameProblem('Drafts./a.md', 'win32'), /ends with a full stop or a space/);
  assert.match(S.driveNameProblem('aux.md', 'win32'), /keeps the name “aux\.md” for itself/);
  assert.match(S.driveNameProblem('Folder/CON', 'win32'), /keeps the name/);
  for (const ok of ['Notes/It’s “quoted”.md', 'Notes/console.md', 'a b/c.d.md', 'Auxiliary.md', 'com10.md']) assert.equal(S.driveNameProblem(ok, 'win32'), '', ok);

  const { g, kit } = await setup(t);
  const dir = tmp(t, 'vault-');
  write(dir, 'Notes/What is this?.md', 'q\n');
  write(dir, 'Notes/Fine.md', 'fine\n');
  write(dir, 'Readme.md', 'upper\n');
  write(dir, 'readme.md', 'lower\n');
  await device(t, kit, dir, 'mac')().sync();
  const [v] = await device(t, kit, tmp(t, 'list-'), 'pc', { vault: '' })().vaults();
  const dir2 = tmp(t, 'retrieved-');
  const before = g.count('download');
  const sync = device(t, kit, dir2, 'pc', { platform: 'win32', folds: true })();
  const r = await sync.retrieve(v);
  assert.equal(r.downloaded, 2);
  assert.equal(g.count('download') - before, 2, 'the two that cannot be written were not downloaded');
  assert.deepEqual(r.failed.map(f => f.path).sort(), ['Notes/What is this?.md', 'readme.md']);
  assert.match(r.failed.find(f => f.path === 'readme.md').why, /same file as “Readme\.md”.*capital letters/);
  assert.match(r.failed.find(f => f.path !== 'readme.md').why, /Windows does not allow the character \?/);
  // What could not be written is not then taken for "deleted here" and removed from the backup.
  const next = await device(t, kit, dir2, 'pc', { platform: 'win32', folds: true })().prepare();
  assert.deepEqual(next.plan.deleteRemote, []);
});

test('direct: Windows paths. The folder typed for a retrieved vault, and a path with a colon in an upload', async t => {
  const w = path.win32;
  assert.equal(S.setupFolder(w, ' "C:\\Users\\Ada\\Documents\\My vault\\" '), 'C:\\Users\\Ada\\Documents\\My vault');
  assert.equal(S.setupFolder(w, 'C:/Users/Ada/Documents/My vault'), 'C:\\Users\\Ada\\Documents\\My vault');
  assert.equal(S.setupFolder(w, '\\\\server\\share\\Vaults\\Mine'), '\\\\server\\share\\Vaults\\Mine');
  assert.equal(S.setupFolder(w, 'D:\\'), 'D:\\');
  assert.equal(S.setupFolder(w, 'Documents\\My vault'), '', 'a relative path is refused');
  assert.equal(S.setupFolder(w, 'C:vault'), '', 'drive-relative is refused');
  assert.equal(S.setupFolder(path.posix, '/Users/ada/Documents/My vault/'), '/Users/ada/Documents/My vault');
  assert.equal(S.setupFolder(path.posix, '~/Documents'), '');
  // The folder a retrieval is put in.
  const base = tmp(t, 'target-');
  assert.equal(S.driveTargetProblem(fs, path, path.join(base, 'new', 'deeper'), 1000), '');
  write(base, 'full/a.md', 'x');
  assert.match(S.driveTargetProblem(fs, path, path.join(base, 'full'), 1000), /not empty/);
  assert.match(S.driveTargetProblem(fs, path, path.join(base, 'full', 'a.md'), 1000), /a file, not a folder/);
  assert.match(S.driveTargetProblem(fs, path, path.join(base, '.obsidian', 'x'), 1000), /inside a vault’s settings/);
  assert.match(S.driveTargetProblem(fs, path, path.join(base, 'new'), 1e18), /not enough room/);
  if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
    fs.mkdirSync(path.join(base, 'locked'), { mode: 0o500 });
    assert.match(S.driveTargetProblem(fs, path, path.join(base, 'locked', 'vault'), 1000), /Nothing can be written in .*locked \(EACCES\)/);
  }
  // An upload names its file as sha256:<hash>:<path>, and a Windows path has a colon of its own (C:/Users/…).
  if (process.platform !== 'win32') {
    const { g, kit } = await setup(t);
    const dir = path.join(tmp(t, 'vault-'), 'C:', 'Users', 'Ada');
    write(dir, 'a.md', 'colon\n');
    const s = await device(t, kit, dir, 'pc')().sync();
    assert.deepEqual([s.uploaded, s.failed.length], [1, 0]);
    assert.equal(g.tree()['Scriptorium/My Vault/a.md'].bytes.toString(), 'colon\n');
  }
});

/* ---------- the report ---------- */

test('direct: the diagnostic report has no token, secret, account, name of a file or note text in it', async t => {
  const { g, kit } = await setup(t);
  const home = '/home/ada';
  const d = S.driveDiagnostics({ version: '1.2.1', obsidian: '1.15.0', platform: 'win32', arch: 'x64', release: '10.0.26100', mode: 'retrieve', way: 'direct' });
  const st = kit.status(), token = kit.store.load().refresh, access = await kit.tokens.get(false);
  d.set({ client: `your own (${st.client.id})`, connected: true, email: st.email, encrypted: false, folder: true, vaults: 0, otherWay: 0 });
  d.note('started', 'retrieve, direct');
  d.note('sign-in failed', `Google refused: refresh_token=${token} access ${access} Bearer ${access} secret ${g.clientSecret} code=4/0AbCdEfGhIjKlMnOpQrStUv for ada.writer@example.com`);
  d.note('  a file failed', S.driveNameless('Downloading: Windows does not allow the character ? in a name (“My secret diary?.md”); rename it'));
  d.note('  a file failed', S.driveNameless("ENOENT: no such file or directory, open '/home/ada/Vaults/Private/My secret diary.md'"));
  d.note('  a file failed', S.driveNameless('EPERM: operation not permitted, rename C:\\Users\\Ada\\Vault\\Secret plan.md -> C:\\Users\\Ada\\Vault\\x'));
  d.note('exe', '/home/ada/.local/bin/claude');
  d.request({ method: 'GET', what: 'list files', status: 200, ms: 40, tries: 1 });
  d.request({ method: 'GET', what: 'list files', status: 200, ms: 60, tries: 3 });
  const text = S.driveReport(d, home);
  for (const secret of [token, access, g.clientSecret, g.clientId, 'ada.writer', 'My secret diary', 'Secret plan', 'Private', '/home/ada', '0AbCdEfGhIjKlMnOpQrStUv']) assert.ok(!text.includes(secret), `the report gives away ${secret}`);
  assert.match(text, /Scriptorium 1\.2\.1 · Obsidian 1\.15\.0 · win32 x64 10\.0\.26100/);
  assert.match(text, /Command: retrieve · Connection: Google sign-in, directly/);
  assert.match(text, /Client ID: your own \(1234…apps\.googleusercontent\.com\) · Signed in: yes · Account: a…@example\.com/);
  assert.match(text, /Vaults found: 0/);
  assert.match(text, /~\/\.local\/bin\/claude/);
  assert.match(text, /2 × GET list files → 200 \(50 ms each, 2 tried again\)/);
  assert.match(text, /Windows does not allow the character \? in a name \(“…”\)/);
  // The requests the direct connection logs carry no name and no id.
  const dir = tmp(t, 'vault-');
  write(dir, 'Secret plan.md', 'x\n');
  await device(t, kit, dir, 'laptop')().sync();
  assert.ok(kit.requests.length > 3);
  for (const e of kit.requests) assert.deepEqual(Object.keys(e).sort(), ['method', 'ms', 'status', 'tries', 'what']);
  assert.ok(!JSON.stringify(kit.requests).includes('Secret'));
  // The Claude Code way's lines.
  const c = S.driveDiagnostics({ version: '1.2.1', mode: 'retrieve', way: 'claude', lagrange: 'on', exe: 'C:\\Users\\Ada\\.local\\bin\\claude.exe', auth: 'claude.ai', connector: 'claude.ai Google Drive: - ! Needs authentication' });
  const ct = S.driveReport(c, 'C:\\Users\\Ada');
  assert.match(ct, /Claude Code: ~\\\.local\\bin\\claude\.exe/);
  assert.match(ct, /Google Drive connector: claude\.ai Google Drive: - ! Needs authentication/);
});
