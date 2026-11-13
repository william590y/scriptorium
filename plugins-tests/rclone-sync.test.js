// Tests for the Scriptorium plugin's Google Drive sync (vault/.obsidian/plugins/scriptorium/main.js, "Syncing with
// Google Drive, through rclone") that need no rclone: where things live on Windows, macOS and Linux, finding and
// downloading rclone (the SHA-256 check, the zip), how rclone is run (no shell, awkward paths and names), the
// config file and the sign-in up to the browser (with a pretend rclone, fake-rclone.js), the folder browser, the
// commands that are built, how rclone's output is read, every failure in plain words, the lock, the timer, the
// status bar and the diagnostic report. The sync itself is tested with the real rclone in rclone-real.test.js.
// Run: node --test plugins-tests/rclone-sync.test.js
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
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

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

const FAKE = path.join(__dirname, 'fake-rclone.js');
const WIN = process.platform === 'win32';
/* Runs the pretend rclone as the plugin would run the real one: `exe` is what the plugin thinks it runs. */
const fakeSpawn = (exe, args, opts) => spawn(process.execPath, [FAKE].concat(args), opts);

function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `scriptorium-sync-test-${name || ''}`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fakeApi(t, env, more) {
  const user = tmp(t, 'user'), paths = S.syncPaths(path, user, process.platform), runs = [];
  const api = S.rcloneApi(Object.assign({ spawn: fakeSpawn, fs, path, exe: 'rclone', paths, env: Object.assign({}, process.env, env), log: r => runs.push(r) }, more));
  return { api, paths, runs, user };
}
const signedIn = paths => fs.writeFileSync(paths.conf, '[scriptorium-drive]\ntype = drive\nscope = drive\ntoken = {"access_token":"ya29.x","refresh_token":"1//y"}\n');
const L = (msg, level) => ({ level: level || 'error', msg, object: '', stats: null });

/* ---------- Where things live ---------- */

test('Scriptorium’s own folder: per user, outside every vault, on Windows, macOS and Linux', () => {
  const w = path.win32, p = path.posix;
  assert.equal(S.syncUserDir(w, { LOCALAPPDATA: 'C:\\Users\\Ada L\\AppData\\Local' }, 'win32', 'C:\\Users\\Ada L'), 'C:\\Users\\Ada L\\AppData\\Local\\Scriptorium');
  assert.equal(S.syncUserDir(w, {}, 'win32', 'C:\\Users\\Ada'), 'C:\\Users\\Ada\\AppData\\Local\\Scriptorium');
  assert.equal(S.syncUserDir(w, { LOCALAPPDATA: 'relative' }, 'win32', 'C:\\Users\\Ada'), 'C:\\Users\\Ada\\AppData\\Local\\Scriptorium');
  assert.equal(S.syncUserDir(p, { XDG_DATA_HOME: '/ignored/on/mac' }, 'darwin', '/Users/ada'), '/Users/ada/Library/Application Support/Scriptorium');
  assert.equal(S.syncUserDir(p, {}, 'linux', '/home/ada'), '/home/ada/.local/share/scriptorium');
  assert.equal(S.syncUserDir(p, { XDG_DATA_HOME: '/data/ada' }, 'linux', '/home/ada'), '/data/ada/scriptorium');
  assert.equal(S.syncUserDir(p, { SCRIPTORIUM_USER_DIR: '/elsewhere/s' }, 'linux', '/home/ada'), '/elsewhere/s');
  const paths = S.syncPaths(w, 'C:\\Users\\Ada\\AppData\\Local\\Scriptorium', 'win32');
  assert.equal(paths.conf, 'C:\\Users\\Ada\\AppData\\Local\\Scriptorium\\rclone.conf');
  assert.equal(paths.exe, `C:\\Users\\Ada\\AppData\\Local\\Scriptorium\\rclone\\v${S.RCLONE.version}\\rclone.exe`);
  assert.ok(S.syncPaths(p, '/home/ada/.local/share/scriptorium', 'linux').exe.endsWith(`/rclone/v${S.RCLONE.version}/rclone`));
});

test('a vault’s short name is the same for the same folder, whatever the capitals on Windows and macOS', () => {
  const id = (p, dir, platform) => S.syncVaultId(crypto, p, dir, platform);
  assert.equal(id(path.win32, 'C:\\Users\\Ada\\Notes', 'win32'), id(path.win32, 'c:\\users\\ada\\notes\\', 'win32'));
  assert.equal(id(path.posix, '/Users/ada/Notes', 'darwin'), id(path.posix, '/users/ADA/notes/', 'darwin'));
  assert.notEqual(id(path.posix, '/home/ada/Notes', 'linux'), id(path.posix, '/home/ada/notes', 'linux'));
  assert.match(id(path.posix, '/home/ada/Notes', 'linux'), /^[0-9a-f]{16}$/);
});

test('which Drive folder goes with which vault is kept in Scriptorium’s folder, not in the vault', t => {
  const dir = tmp(t), file = path.join(dir, 'deep', 'sync-vaults.json');
  assert.equal(S.syncLink(fs, file, 'a'), null);
  S.syncSaveLink(fs, path, file, 'a', { root: 'my', path: 'Vaults/A', first: 'x' });
  S.syncSaveLink(fs, path, file, 'b', { root: 'shared', path: 'B' });
  assert.deepEqual(S.syncLink(fs, file, 'a'), { root: 'my', path: 'Vaults/A', first: 'x' });
  S.syncSaveLink(fs, path, file, 'a', null);
  assert.equal(S.syncLink(fs, file, 'a'), null);
  assert.equal(S.syncLink(fs, file, 'b').path, 'B');
  fs.writeFileSync(file, 'not json');
  assert.equal(S.syncLink(fs, file, 'b'), null, 'a damaged file is no link, not an exception');
  if (!WIN) assert.equal(fs.statSync(file).mode & 0o777, fs.statSync(file).mode & 0o777);
});

test('settings: defaults, and nonsense is refused', () => {
  assert.deepEqual(S.syncSettings({}), { auto: true, minutes: 5, obsidian: true, maxDelete: 50, keepDays: 30 });
  assert.deepEqual(S.syncSettings({ sync: { auto: false, minutes: 30, obsidian: false, maxDelete: 10, keepDays: 7 } }), { auto: false, minutes: 30, obsidian: false, maxDelete: 10, keepDays: 7 });
  assert.deepEqual(S.syncSettings({ sync: { minutes: 0, maxDelete: 500, keepDays: 'x' } }), { auto: true, minutes: 5, obsidian: true, maxDelete: 50, keepDays: 30 });
});

/* ---------- Finding rclone ---------- */

test('where rclone is looked for: the settings’ path, Scriptorium’s own copy, PATH, the usual places; rclone.exe on Windows', () => {
  const w = S.rcloneCandidates({ path: path.win32, platform: 'win32', home: 'C:\\Users\\Ada', exe: 'C:\\S\\rclone.exe',
    env: { Path: 'C:\\Windows\\system32;"C:\\Program Files\\Tools";relative\\dir;', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local', ProgramData: 'C:\\ProgramData' } });
  assert.deepEqual(w.slice(0, 3), [{ file: 'C:\\S\\rclone.exe', kind: 'downloaded' }, { file: 'C:\\Windows\\system32\\rclone.exe', kind: 'path' }, { file: 'C:\\Program Files\\Tools\\rclone.exe', kind: 'path' }]);
  const files = w.map(c => c.file);
  for (const f of ['C:\\Program Files\\rclone\\rclone.exe', 'C:\\Users\\Ada\\AppData\\Local\\Microsoft\\WinGet\\Links\\rclone.exe', 'C:\\Users\\Ada\\scoop\\shims\\rclone.exe', 'C:\\ProgramData\\chocolatey\\bin\\rclone.exe']) assert.ok(files.includes(f), f);
  assert.ok(files.every(f => f.endsWith('rclone.exe')) && !files.some(f => f.startsWith('relative')));
  const m = S.rcloneCandidates({ path: path.posix, platform: 'darwin', home: '/Users/ada', exe: '/S/rclone', env: { PATH: '/usr/bin:/bin' } }).map(c => c.file);
  assert.deepEqual(m.slice(0, 3), ['/S/rclone', '/usr/bin/rclone', '/bin/rclone']);
  assert.ok(m.includes('/opt/homebrew/bin/rclone') && m.includes('/usr/local/bin/rclone'), 'Homebrew’s folders, which a program started from the Dock is not told about');
  // a path in the settings is the only place looked in; a folder, a missing .exe and quotes are forgiven
  assert.deepEqual(S.rcloneCandidates({ path: path.win32, platform: 'win32', home: 'C:\\Users\\Ada', exe: 'C:\\S\\rclone.exe', custom: '"D:\\My Tools\\rclone"', env: { Path: 'C:\\x' } }).map(c => c.file),
    ['D:\\My Tools\\rclone', 'D:\\My Tools\\rclone.exe', 'D:\\My Tools\\rclone\\rclone.exe']);
  assert.deepEqual(S.rcloneCandidates({ path: path.posix, platform: 'linux', home: '/home/ada', custom: '~/bin/rclone', env: {} }).map(c => c.file), ['/home/ada/bin/rclone', '/home/ada/bin/rclone/rclone']);
});

test('the first candidate that is a program is taken', { skip: WIN && 'the test makes files executable' }, t => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'a folder')); fs.mkdirSync(path.join(dir, 'a folder', 'rclone'));
  fs.writeFileSync(path.join(dir, 'not-a-program'), 'x', { mode: 0o644 });
  fs.writeFileSync(path.join(dir, 'rclone'), '#!/bin/sh\n', { mode: 0o755 });
  const list = [{ file: path.join(dir, 'missing'), kind: 'path' }, { file: path.join(dir, 'a folder', 'rclone'), kind: 'path' }, { file: path.join(dir, 'not-a-program'), kind: 'path' }, { file: path.join(dir, 'rclone'), kind: 'usual' }];
  assert.deepEqual(S.findRclone(fs, list, 'linux'), { file: path.join(dir, 'rclone'), kind: 'usual' });
  assert.equal(S.findRclone(fs, list.slice(0, 3), 'linux'), null);
});

test('versions: read from what rclone prints; older than 1.66 is too old', () => {
  assert.deepEqual(S.rcloneVersion('rclone v1.76.0\n- os/version: ubuntu 24.04 (64 bit)'), [1, 76, 0]);
  assert.deepEqual(S.rcloneVersion('rclone v1.69.1-DEV'), [1, 69, 1]);
  assert.equal(S.rcloneVersion('hello'), null);
  assert.equal(S.rcloneOldEnough([1, 66, 0]), true);
  assert.equal(S.rcloneOldEnough([1, 65, 2]), false);
  assert.equal(S.rcloneOldEnough([2, 0, 0]), true);
  assert.equal(S.rcloneOldEnough(null), false);
});

test('the pinned builds: one version, official names, a SHA-256 and a size each, for Windows, macOS and Linux', () => {
  assert.match(S.RCLONE.version, /^\d+\.\d+\.\d+$/);
  for (const key of ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']) {
    const [platform, arch] = key.split('-'), a = S.rcloneAsset(platform, arch);
    assert.match(a.file, new RegExp(`^rclone-v${S.RCLONE.version.replace(/\./g, '\\.')}-(windows|osx|linux)-(amd64|arm64)\\.zip$`));
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.ok(a.bytes > 20e6 && a.bytes < 60e6);
    assert.equal(a.exe, platform === 'win32' ? 'rclone.exe' : 'rclone');
    assert.deepEqual(a.urls, [`https://downloads.rclone.org/v${S.RCLONE.version}/${a.file}`, `https://github.com/rclone/rclone/releases/download/v${S.RCLONE.version}/${a.file}`]);
  }
  assert.equal(new Set(Object.values(S.RCLONE.assets).map(a => a[2])).size, Object.keys(S.RCLONE.assets).length);
  assert.equal(S.rcloneAsset('freebsd', 'x64'), null);
});

/* ---------- Downloading rclone ---------- */

/* A zip file with the given entries, as rclone's are laid out: a folder, then files in it. */
function makeZip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, data, stored] of entries) {
    const raw = Buffer.from(data), packed = stored ? raw : zlib.deflateRawSync(raw), n = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(n.length, 26); head.writeUInt16LE(4, 28);
    const extra = Buffer.from([1, 2, 3, 4]);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(stored ? 0 : 8, 10); c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, n);
    parts.push(head, n, extra, packed);
    offset += 30 + n.length + 4 + packed.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(parts.concat([dir, end]));
}
const PROGRAM = Buffer.concat([Buffer.from('#!/bin/sh\necho "rclone v1.76.0"\n'), crypto.randomBytes(5000)]);
function zipAsset(exe) {
  const zip = makeZip([['rclone-v1.76.0-test/', ''], ['rclone-v1.76.0-test/README.txt', 'read me'], [`rclone-v1.76.0-test/${exe || 'rclone'}`, PROGRAM], ['rclone-v1.76.0-test/rclone.1', 'man']]);
  return { zip, asset: { file: 'rclone-v1.76.0-test.zip', bytes: zip.length, sha256: crypto.createHash('sha256').update(zip).digest('hex'), exe: exe || 'rclone', urls: ['https://downloads.rclone.org/a.zip', 'https://github.com/rclone/rclone/releases/download/a.zip'] } };
}
const serve = bytes => async (o, url, file) => { fs.writeFileSync(file, bytes); if (o.onProgress) o.onProgress(bytes.length, o.asset.bytes); return { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }; };

test('a zip file’s entry is found wherever it is, packed or stored', () => {
  const zip = makeZip([['d/', ''], ['d/a.txt', 'aaaa'], ['d/rclone', PROGRAM], ['d/stored.bin', 'kept as it is', true]]);
  const readAt = (pos, len) => zip.subarray(pos, pos + len);
  const e = S.zipEntry(readAt, zip.length, 'rclone');
  assert.deepEqual([e.size, e.method], [PROGRAM.length, 8]);
  assert.ok(zlib.inflateRawSync(zip.subarray(e.offset, e.offset + e.packed)).equals(PROGRAM));
  const s = S.zipEntry(readAt, zip.length, 'stored.bin');
  assert.equal(zip.toString('utf8', s.offset, s.offset + s.packed), 'kept as it is');
  assert.throws(() => S.zipEntry(readAt, zip.length, 'rclone.exe'), /no rclone\.exe/);
  const junk = Buffer.from('this is not a zip file at all, just some text that is long enough');
  assert.throws(() => S.zipEntry((p, l) => junk.subarray(p, p + l), junk.length, 'rclone'), /not a zip/);
});

test('rclone is downloaded, checked against the pinned SHA-256, and unpacked as a program', async t => {
  const dir = tmp(t), { zip, asset } = zipAsset(WIN ? 'rclone.exe' : 'rclone');
  const exe = path.join(dir, 'Scriptorium dir', 'rclone', 'v1.76.0', asset.exe);
  let seen = 0;
  const asked = [];
  await S.rcloneInstall({ fs, path, crypto, zlib, asset, exe, onProgress: n => { seen = n; }, fetch: (o, url, file) => { asked.push(url); return serve(zip)(o, url, file); } });
  assert.ok(fs.readFileSync(exe).equals(PROGRAM));
  assert.equal(seen, zip.length);
  assert.deepEqual(asked, [asset.urls[0]], 'rclone’s own server first');
  assert.deepEqual(fs.readdirSync(path.dirname(exe)), [asset.exe], 'neither the zip nor a half-unpacked file is left');
  if (!WIN) assert.equal(fs.statSync(exe).mode & 0o111, 0o111, 'marked as a program');
});

test('a download whose SHA-256 or size is wrong is deleted and never unpacked; the mirror is tried when the first server fails', async t => {
  const dir = tmp(t), { zip, asset } = zipAsset();
  const exe = path.join(dir, 'rclone', 'v', 'rclone');
  const tampered = Buffer.from(zip); tampered[40] ^= 0xff;
  await assert.rejects(S.rcloneInstall({ fs, path, crypto, zlib, asset, exe, fetch: serve(tampered) }), e => {
    assert.equal(e.kind, 'checksum');
    assert.match(e.message, /is not the rclone that Scriptorium expects, so it was deleted and not run/);
    assert.ok(e.cause2 && e.next);
    return true;
  });
  assert.deepEqual(fs.readdirSync(path.dirname(exe)), []);
  await assert.rejects(S.rcloneInstall({ fs, path, crypto, zlib, asset, exe, fetch: serve(zip.subarray(0, zip.length - 100)) }), e => e.kind === 'checksum');
  assert.deepEqual(fs.readdirSync(path.dirname(exe)), []);
  // the first server is down: GitHub's copy is fetched, and checked the same way
  const asked = [];
  await S.rcloneInstall({ fs, path, crypto, zlib, asset, exe, fetch: (o, url, file) => { asked.push(url); if (url.includes('downloads.rclone.org')) throw new Error('the server answered 503'); return serve(zip)(o, url, file); } });
  assert.deepEqual(asked, asset.urls);
  assert.ok(fs.readFileSync(exe).equals(PROGRAM));
  // neither can be reached: said in plain words, with what to do
  await assert.rejects(S.rcloneInstall({ fs, path, crypto, zlib, asset, exe: path.join(dir, 'x', 'rclone'), fetch: async () => { throw new Error('getaddrinfo ENOTFOUND downloads.rclone.org'); } }),
    e => e.kind === 'network' && /could not be downloaded/.test(e.message) && /rclone\.org\/downloads/.test(e.next));
  // a zip that passes the check but has no program in it (it cannot happen with rclone's; the code does not trust that)
  const empty = makeZip([['d/', ''], ['d/README.txt', 'x']]);
  await assert.rejects(S.rcloneInstall({ fs, path, crypto, zlib, exe: path.join(dir, 'y', 'rclone'), fetch: serve(empty),
    asset: Object.assign({}, asset, { bytes: empty.length, sha256: crypto.createHash('sha256').update(empty).digest('hex') }) }), e => e.kind === 'disk' && /could not be unpacked/.test(e.message));
});

test('the download follows redirects only to rclone’s and GitHub’s servers, over https', async t => {
  const dir = tmp(t), { asset } = zipAsset();
  const answers = { 'https://github.com/a': [302, 'https://evil.example/rclone.zip'], 'https://github.com/b': [302, 'http://downloads.rclone.org/x.zip'], 'https://github.com/c': [404, ''] };
  const fakeHttps = { get(u, opts, cb) {
    const [status, location] = answers[u.toString()] || [500, ''];
    const req = { on() { return req; }, setTimeout() {}, destroy() {} };
    setImmediate(() => cb({ statusCode: status, headers: { location }, resume() {}, on() {} }));
    return req;
  } };
  const o = { https: fakeHttps, fs, crypto, asset };
  await assert.rejects(S.syncFetch(o, 'https://github.com/a', path.join(dir, 'f')), /evil\.example, which is not one of rclone’s servers/);
  await assert.rejects(S.syncFetch(o, 'https://github.com/b', path.join(dir, 'f')), /not one of rclone’s servers/);
  await assert.rejects(S.syncFetch(o, 'https://github.com/c', path.join(dir, 'f')), /answered 404/);
  await assert.rejects(S.syncFetch(o, 'https://elsewhere.example/x', path.join(dir, 'f')), /not one of rclone’s servers/);
  assert.ok(!fs.existsSync(path.join(dir, 'f')));
});

/* ---------- Running rclone ---------- */

test('rclone is run without a shell: arguments with spaces, quotes, ampersands and accents arrive as they are', async () => {
  const odd = ['C:\\Users\\Ada L\\My "Vault" & notes', 'scriptorium-drive:Écrits d’été/100% “done” (v2); rm -rf ~ | echo $HOME `id` ^caret', '--filters-file', '/tmp/a b/c\'d.txt', '', '*'];
  const r = await S.rcloneExec({ spawn: fakeSpawn, exe: 'rclone', args: odd, env: Object.assign({}, process.env, { FAKE_RCLONE_ECHO: '1', RCLONE_CONFIG: '/home/someone/.config/rclone/rclone.conf', RCLONE_DRIVE_CLIENT_ID: 'x', rclone_password: 'y' }) });
  assert.equal(r.code, 0);
  const got = JSON.parse(r.out);
  assert.deepEqual(got.args, odd);
  assert.deepEqual(got.env, ['FAKE_RCLONE_ECHO'].filter(k => /^RCLONE_/i.test(k)), 'no RCLONE_ setting of the writer’s reaches rclone');
  // what spawn is given
  let seen = null;
  const fake = { stdout: { setEncoding() {}, on() {} }, stderr: { setEncoding() {}, on() {} }, on(ev, f) { if (ev === 'close') setImmediate(() => f(0, null)); }, kill() {} };
  await S.rcloneExec({ spawn: (exe, args, opts) => { seen = { exe, args, opts }; return fake; }, exe: 'C:\\Program Files\\rclone\\rclone.exe', args: ['version'], env: { PATH: 'x', RCLONE_CONFIG: 'y' } });
  assert.equal(seen.exe, 'C:\\Program Files\\rclone\\rclone.exe', 'the path is not quoted or changed');
  assert.equal(seen.opts.shell, false);
  assert.equal(seen.opts.windowsHide, true);
  assert.deepEqual(seen.opts.env, { PATH: 'x' });
});

test('a program in a folder with spaces and quotes in its name is run as it is', { skip: WIN && 'needs a shell script' }, async t => {
  const dir = path.join(tmp(t), 'My "Tools" & more (x86)');
  fs.mkdirSync(dir);
  const exe = path.join(dir, 'rclone');
  fs.writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const r = await S.rcloneExec({ spawn, exe, args: ['version'], env: process.env });
  assert.deepEqual(S.rcloneVersion(r.out), [1, 76, 0]);
});

test('a program that is not there, a stop and a timeout are told apart; nothing is thrown', async () => {
  const none = await S.rcloneExec({ spawn, exe: path.join(os.tmpdir(), 'no-such-rclone-here'), args: ['version'], env: process.env });
  assert.equal(none.failed.code, 'ENOENT');
  assert.equal(S.syncExplain(none, 'version').kind, 'rclone');
  const ctl = new AbortController();
  const hang = { FAKE_RCLONE_AUTH: 'hang' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-sync-test-hang'));
  const conf = path.join(dir, 'rclone.conf');
  fs.writeFileSync(conf, '[scriptorium-drive]\ntype = drive\n');
  const lines = [];
  const p = S.rcloneExec({ spawn: fakeSpawn, exe: 'rclone', args: ['--config', conf, 'config', 'update', 'scriptorium-drive', 'scope=drive'], env: Object.assign({}, process.env, hang), signal: ctl.signal,
    onLine: l => { lines.push(l); if (/Waiting for code/.test(l.msg)) ctl.abort(); } });
  const stopped = await p;
  assert.equal(stopped.stopped, true);
  assert.equal(lines.length, 4);
  const late = await S.rcloneExec({ spawn: fakeSpawn, exe: 'rclone', args: ['--config', conf, 'config', 'update', 'scriptorium-drive', 'scope=drive'], env: Object.assign({}, process.env, hang), timeout: 300 });
  assert.equal(late.timedOut, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rclone’s log is read line by line: JSON lines, lines that are not JSON, and progress', () => {
  assert.deepEqual(S.syncLogLine('{"time":"2026-11-12T21:07:37-05:00","level":"info","msg":"Copied (new)","object":"Notes/a.md","objectType":"*local.Object"}'), { level: 'info', msg: 'Copied (new)', object: 'Notes/a.md', stats: null });
  assert.deepEqual(S.syncLogLine('2026/11/12 21:00:00 NOTICE: plain text'), { level: 'text', msg: '2026/11/12 21:00:00 NOTICE: plain text', object: '', stats: null });
  assert.equal(S.syncLogLine('{"level":"info","msg":"x\\n","stats":{"bytes":5,"totalBytes":10}}').stats.totalBytes, 10);
  assert.equal(S.syncLogLine('{not json').level, 'text');
});

/* ---------- The config file and the sign-in ---------- */

test('the config file is Scriptorium’s own: written without a token, readable by the writer alone, other sections kept', t => {
  const dir = tmp(t), file = path.join(dir, 'new folder', 'rclone.conf');
  S.syncConfPrepare(fs, path, file, null);
  assert.equal(fs.readFileSync(file, 'utf8'), '[scriptorium-drive]\ntype = drive\nscope = drive\n');
  if (!WIN) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(S.syncConnection(fs, file), { connected: false, own: false, client: '', type: 'drive' });
  fs.appendFileSync(file, 'token = {"access_token":"ya29.SECRET","refresh_token":"1//SECRET"}\n\n[another]\ntype = alias\nremote = /x\n');
  assert.deepEqual(S.syncConnection(fs, file), { connected: true, own: false, client: '', type: 'drive' });
  assert.ok(!JSON.stringify(S.syncConnection(fs, file)).includes('SECRET'), 'the token is never handed on');
  // signing in again, with a client ID of the writer's: the old token goes, the other section stays
  S.syncConfPrepare(fs, path, file, { id: '123-abc.apps.googleusercontent.com', secret: 'GOCSPX-s3cret\n' });
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text, '[another]\ntype = alias\nremote = /x\n\n[scriptorium-drive]\ntype = drive\nscope = drive\nclient_id = 123-abc.apps.googleusercontent.com\nclient_secret = GOCSPX-s3cret\n');
  assert.deepEqual(S.syncConnection(fs, file), { connected: false, own: true, client: '123-abc.apps.googleusercontent.com', type: 'drive' });
  assert.deepEqual(S.syncConnection(fs, path.join(dir, 'none.conf')), { connected: false, own: false, client: '', type: '' });
});

test('a pasted client ID: alone, or Google’s JSON file; slips are said in plain words', () => {
  assert.deepEqual(S.syncParseClient(' 1234567890-abc_def.apps.googleusercontent.com ', ' GOCSPX-abc '), { id: '1234567890-abc_def.apps.googleusercontent.com', secret: 'GOCSPX-abc', problem: '' });
  assert.deepEqual(S.syncParseClient('{"installed":{"client_id":"12-ab.apps.googleusercontent.com","client_secret":"GOCSPX-x"}}', ''), { id: '12-ab.apps.googleusercontent.com', secret: 'GOCSPX-x', problem: '' });
  assert.match(S.syncParseClient('{"web":{"client_id":"12-ab.apps.googleusercontent.com"}}', '').problem, /Desktop app/);
  assert.match(S.syncParseClient('{broken', '').problem, /not a client ID/);
  assert.match(S.syncParseClient('my-project-123', 'x').problem, /looks like/);
  assert.match(S.syncParseClient('12-ab.apps.googleusercontent.com', '').problem, /client secret/);
  assert.match(S.syncParseClient('', '').problem, /Paste/);
});

test('the sign-in with a pretend rclone: the config is prepared, the browser’s address is passed on, the token lands in the config only', async t => {
  const tree = path.join(tmp(t), 'tree.json');
  fs.writeFileSync(tree, JSON.stringify({ '': ['Notes'] }));
  const record = path.join(tmp(t), 'calls.txt');
  const { api, paths, runs } = fakeApi(t, { FAKE_RCLONE_AUTH: 'ok', FAKE_RCLONE_TREE: tree, FAKE_RCLONE_RECORD: record });
  assert.equal(api.connection().connected, false);
  const links = [];
  await api.connect(null, url => links.push(url));
  assert.deepEqual(links, ['http://127.0.0.1:53682/auth?state=fAkEsTaTe0123456789abc']);
  assert.equal(api.connection().connected, true);
  const calls = fs.readFileSync(record, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(calls[0], ['config', 'update', 'scriptorium-drive', 'scope=drive'], 'rclone’s own sign-in, on Scriptorium’s remote');
  assert.equal(calls[1][0], 'lsjson', 'then Drive is asked something, to be sure the sign-in works');
  assert.ok(!JSON.stringify(calls).includes('ya29') && !JSON.stringify(calls).includes('GOCSPX'), 'no token or secret is ever an argument');
  assert.ok(!JSON.stringify(runs).includes('ya29'));
  // with a client ID of the writer's: it is in the config file, not on the command line
  fs.writeFileSync(record, '');
  await api.connect({ id: '99-own.apps.googleusercontent.com', secret: 'GOCSPX-mine' }, () => {});
  assert.ok(!fs.readFileSync(record, 'utf8').includes('GOCSPX-mine') && !fs.readFileSync(record, 'utf8').includes('99-own'));
  assert.match(fs.readFileSync(paths.conf, 'utf8'), /client_id = 99-own\.apps\.googleusercontent\.com\nclient_secret = GOCSPX-mine\ntoken = \{/);
  assert.deepEqual([api.connection().connected, api.connection().own], [true, true]);
  // disconnecting removes it (this rclone cannot withdraw it at Google: that is not a failure)
  await api.disconnect();
  assert.equal(api.connection().connected, false);
  assert.ok(!fs.readFileSync(paths.conf, 'utf8').includes('token'));
});

test('a sign-in that fails says why in plain words: refused, the app deleted, the port taken, stopped', async t => {
  for (const [how, kind, words] of [['denied', 'connect', /did not give access/], ['deleted', 'client', /refused the app/], ['busy', 'busy', /Another sign-in is already waiting/]]) {
    const { api } = fakeApi(t, { FAKE_RCLONE_AUTH: how });
    await assert.rejects(api.connect(null, () => {}), e => {
      assert.equal(e.kind, kind, how);
      assert.match(e.message, words);
      assert.ok(e.cause2 && e.next, 'a likely cause and a next step');
      assert.ok(!/oauth2|Fatal error|bind:|access_denied|deleted_client/.test(e.message), 'none of rclone’s own words in the sentence');
      assert.ok(e.tail.some(l => /Fatal error/.test(l)), 'they are kept for the details');
      assert.equal(api.connection().connected, false);
      return true;
    });
  }
  const { api } = fakeApi(t, { FAKE_RCLONE_AUTH: 'hang' });
  const ctl = new AbortController();
  await assert.rejects(api.connect(null, () => ctl.abort(), ctl.signal), e => e.kind === 'stopped' && e.message === 'The sign-in was stopped.');
});

test('rclone’s version is checked before anything: too old, or not rclone at all', async t => {
  await assert.rejects(fakeApi(t, { FAKE_RCLONE_VERSION: '1.60.1' }).api.version(), e => e.kind === 'rclone' && /version 1\.60\.1, which is too old/.test(e.message) && /download its own/.test(e.next));
  await assert.rejects(fakeApi(t, { FAKE_RCLONE_VERSION: 'none' }).api.version(), e => e.kind === 'rclone' && /does not behave like rclone/.test(e.message));
  assert.deepEqual(await fakeApi(t, {}).api.version(), [1, 76, 0]);
  const gone = S.rcloneApi({ spawn, fs, path, exe: path.join(os.tmpdir(), 'no-rclone-here'), paths: S.syncPaths(path, tmp(t), process.platform), env: process.env });
  await assert.rejects(gone.version(), e => e.kind === 'rclone' && /not where Scriptorium expected/.test(e.message));
});

/* ---------- The Drive folder ---------- */

test('the folder as rclone is told it: My Drive, things shared with me, a shared drive', () => {
  assert.deepEqual(S.syncTarget({ root: 'my', path: 'Vaults/Mine' }), { fs: 'scriptorium-drive:Vaults/Mine', flags: [] });
  assert.deepEqual(S.syncTarget({ root: 'shared', path: '/From Ada/Book/' }), { fs: 'scriptorium-drive:From Ada/Book', flags: ['--drive-shared-with-me'] });
  assert.deepEqual(S.syncTarget({ root: 'drive', driveId: '0ABCdef', driveName: 'Press', path: 'Books' }), { fs: 'scriptorium-drive:Books', flags: ['--drive-team-drive', '0ABCdef'] });
  assert.equal(S.syncWhere({ root: 'my', path: 'Vaults/Mine' }), 'My Drive › Vaults › Mine');
  assert.equal(S.syncWhere({ root: 'drive', driveName: 'Press', path: 'Books' }), 'Press › Books');
  assert.equal(S.syncWhere({ root: 'shared', path: 'X' }), 'Shared with me › X');
});

test('rclone’s list of folders is read: folders only, in a reader’s order; nonsense is not a list', () => {
  const text = '[\n{"Path":"b10","Name":"b10","IsDir":true,"ID":"1"},\n{"Path":"file.md","Name":"file.md","IsDir":false},\n{"Path":"B2","Name":"B2","IsDir":true,"ID":"2"},\n{"Path":"Éa","Name":"Éa","IsDir":true}\n]';
  assert.deepEqual(S.syncParseDirs(text), [{ name: 'B2', id: '2' }, { name: 'b10', id: '1' }, { name: 'Éa', id: '' }]);
  assert.deepEqual(S.syncParseDirs('[]'), []);
  assert.deepEqual(S.syncParseDirs(''), []);
  assert.equal(S.syncParseDirs('{"error":1}'), null);
  assert.equal(S.syncParseDirs('<html>'), null);
});

test('the folder browser: in and out, the other roots, a new folder, what can be chosen', async t => {
  const tree = path.join(tmp(t), 'tree.json');
  fs.writeFileSync(tree, JSON.stringify({ '': ['Scriptorium', 'Photos'], Scriptorium: ['Old vault'], 'Scriptorium/Old vault': [], Photos: [], 'shared:': ['From Ada'], 'shared:From Ada': [], 'drive:0A1:': ['Books'], 'drive:0A1:Books': [],
    drives: [{ id: '0A1', kind: 'drive#teamDrive', name: 'Press' }] }));
  const record = path.join(tmp(t), 'calls.txt');
  const { api, paths } = fakeApi(t, { FAKE_RCLONE_TREE: tree, FAKE_RCLONE_RECORD: record });
  signedIn(paths);
  const b = new S.SyncBrowser(api);
  assert.deepEqual((await b.list()).map(d => d.name), ['Photos', 'Scriptorium']);
  assert.equal(b.canChoose(), false);
  b.enter('Scriptorium');
  assert.deepEqual(await b.list(), [{ name: 'Old vault', id: 'id-Old vault' }]);
  assert.equal(b.canChoose(), true);
  assert.deepEqual(b.link(), { root: 'my', driveId: '', driveName: '', path: 'Scriptorium' });
  b.enter('Old vault');
  assert.equal(b.where(), 'My Drive › Scriptorium › Old vault');
  b.jump(1);
  assert.equal(b.where(), 'My Drive › Scriptorium');
  await b.create('  New vault ');
  assert.equal(b.link().path, 'Scriptorium/New vault');
  b.up();
  assert.deepEqual((await b.list()).map(d => d.name), ['New vault', 'Old vault'], 'the new folder is listed (the list was read again)');
  const before = fs.readFileSync(record, 'utf8').split('\n').length;
  await b.list();
  assert.equal(fs.readFileSync(record, 'utf8').split('\n').length, before, 'a folder already read is not asked for again');
  assert.deepEqual((await b.roots()).map(r => r.name), ['My Drive', 'Shared with me', 'Press']);
  b.setRoot('shared');
  assert.deepEqual((await b.list()).map(d => d.name), ['From Ada']);
  await assert.rejects(b.create('X'), e => e.kind === 'name' && /shared with you/.test(e.message));
  b.setRoot('drive', { id: '0A1', name: 'Press' });
  assert.deepEqual((await b.list()).map(d => d.name), ['Books']);
  b.enter('Books');
  assert.deepEqual(b.link(), { root: 'drive', driveId: '0A1', driveName: 'Press', path: 'Books' });
  const calls = fs.readFileSync(record, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(calls[0], ['lsjson', 'scriptorium-drive:', '--dirs-only', '--no-modtime', '--no-mimetype', '--drive-skip-gdocs']);
  assert.ok(calls.some(c => c[0] === 'lsjson' && c.includes('--drive-shared-with-me')));
  assert.ok(calls.some(c => c[0] === 'lsjson' && c.join(' ').includes('--drive-team-drive 0A1')));
  // names that will not do
  for (const [name, words] of [['', /Give the folder a name/], ['a/b', /cannot have/], ['..', /cannot be used/], ['x'.repeat(201), /too long/], ['old VAULT', /already a folder/]]) {
    b.setRoot('my'); b.enter('Scriptorium');
    await assert.rejects(b.create(name), e => e.kind === 'name' && words.test(e.message), name);
  }
  // a folder that has gone: plain words, and rclone's in the details
  b.enter('Vanished');
  await assert.rejects(b.list(), e => e.kind === 'folder' && e.message === 'The Drive folder was not found.' && e.tail.some(l => /directory not found/.test(l)));
});

/* ---------- What is synced, and the commands ---------- */

test('the filter rules: what is left out, Obsidian’s settings in or out, the same text every time', () => {
  const on = S.syncFilters(S.syncSettings({})), off = S.syncFilters(S.syncSettings({ sync: { obsidian: false } }));
  assert.equal(on, S.syncFilters(S.syncSettings({ sync: { minutes: 99, auto: false, maxDelete: 3 } })), 'only what is synced changes the rules');
  const rules = on.split('\n').filter(l => /^[-+] /.test(l));
  for (const r of ['- /.obsidian/workspace*', '- /.obsidian/plugins/lagrange/data.json', '- /.trash/**', '- /scriptorium-manifest.json', '- /_trash/**', '- scriptorium-backup-*/**', '- .DS_Store', '- .*/**']) assert.ok(rules.includes(r), r);
  assert.ok(rules.indexOf('- /.obsidian/workspace*') < rules.indexOf('+ /.obsidian/**') && rules.indexOf('- /.obsidian/plugins/lagrange/data.json') < rules.indexOf('+ /.obsidian/**'), 'the first rule that matches decides');
  assert.ok(rules.indexOf('+ /.obsidian/**') < rules.indexOf('- .*/**'));
  assert.ok(off.includes('- /.obsidian/**') && !off.includes('+ /.obsidian/**'));
  assert.ok(!rules.some(r => r.includes(S.SYNC_SENTINEL)), 'the check file is synced like a note');
});

test('the sync’s command: every guard is on it; the first sync, “Sync anyway” and Windows paths', () => {
  const paths = S.syncPaths(path.win32, 'C:\\Users\\Ada\\AppData\\Local\\Scriptorium', 'win32');
  const o = { path: path.win32, local: 'C:\\Users\\Ada L\\Documents\\My Vault', link: { root: 'my', path: 'Vaults/My Vault' }, paths, id: 'abcd', settings: S.syncSettings({}), stamp: '2026-11-12' };
  const a = S.syncBisyncArgs(o);
  assert.deepEqual(a.slice(0, 3), ['bisync', 'C:\\Users\\Ada L\\Documents\\My Vault', 'scriptorium-drive:Vaults/My Vault']);
  const pair = (flag, value) => { const i = a.indexOf(flag); assert.ok(i > 0, flag); if (value !== undefined) assert.equal(a[i + 1], value, flag); };
  pair('--workdir', 'C:\\Users\\Ada\\AppData\\Local\\Scriptorium\\bisync\\abcd');
  pair('--filters-file', 'C:\\Users\\Ada\\AppData\\Local\\Scriptorium\\filters\\abcd.txt');
  pair('--check-access'); pair('--check-filename', '.scriptorium-sync');
  pair('--resilient'); pair('--recover'); pair('--max-lock', '2m');
  pair('--conflict-resolve', 'newer'); pair('--conflict-loser', 'num'); pair('--conflict-suffix', 'conflict'); pair('--suffix-keep-extension');
  pair('--max-delete', '50');
  pair('--backup-dir1', 'C:\\Users\\Ada\\AppData\\Local\\Scriptorium\\replaced\\abcd\\2026-11-12');
  pair('--drive-skip-gdocs'); pair('--create-empty-src-dirs'); pair('--skip-links');
  for (const never of ['--resync', '--force', '--dry-run', '--delete-excluded', '--inplace', '--remove-empty-dirs']) assert.ok(!a.includes(never), never);
  assert.ok(a.every(x => typeof x === 'string'));
  const first = S.syncBisyncArgs(Object.assign({}, o, { resync: true }));
  assert.deepEqual(first.slice(-3), ['--resync', '--resync-mode', 'newer']);
  assert.deepEqual(S.syncBisyncArgs(Object.assign({}, o, { resync: true, mode: 'path2' })).slice(-1), ['path2']);
  assert.ok(S.syncBisyncArgs(Object.assign({}, o, { force: true })).includes('--force'));
  const shared = S.syncBisyncArgs(Object.assign({}, o, { link: { root: 'drive', driveId: '0A1', path: 'Books' }, settings: S.syncSettings({ sync: { maxDelete: 20 } }) }));
  assert.deepEqual(shared.slice(2, 5), ['scriptorium-drive:Books', '--drive-team-drive', '0A1']);
  assert.equal(shared[shared.indexOf('--max-delete') + 1], '20');
  // every call carries Scriptorium's own config
  let seen = null;
  const api = S.rcloneApi({ spawn: (exe, args) => { seen = args; throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, fs, path, exe: 'rclone', paths: S.syncPaths(path, os.tmpdir(), process.platform), env: {} });
  return api.bisync(a).catch(() => { assert.deepEqual(seen.slice(0, 5), ['--config', path.join(os.tmpdir(), 'rclone.conf'), '--color', 'NEVER', '--use-json-log']); });
});

test('how the two sides compare is read from rclone’s check; the check file is not counted', () => {
  const r = S.syncParseCheck('= Notes/same.md\n+ only here.md\n- only in drive.md\n* Notes/differs.md\n! unreadable.md\n= .scriptorium-sync\n+ name with = and + signs.md\n\n');
  assert.deepEqual(r, { same: ['Notes/same.md'], local: ['only here.md', 'name with = and + signs.md'], drive: ['only in drive.md'], differ: ['Notes/differs.md'], unread: ['unreadable.md'] });
});

test('the name of a kept copy: before the extension, the first number that is free', () => {
  const taken = new Set(['a/note.conflict1.md']);
  assert.equal(S.syncConflictName('a/note.md', taken), 'a/note.conflict2.md');
  assert.equal(S.syncConflictName('a/note.md', taken), 'a/note.conflict3.md');
  assert.equal(S.syncConflictName('README', new Set()), 'README.conflict1');
  assert.equal(S.syncConflictName('.hidden', new Set()), '.hidden.conflict1');
  assert.equal(S.syncConflictName('x/archive.tar.gz', new Set()), 'x/archive.tar.conflict1.gz');
  for (const n of ['a/note.conflict2.md', 'README.conflict1', 'x.conflict12.png']) assert.ok(S.SYNC_CONFLICT.test(n), n);
  for (const n of ['a/conflict.md', 'note.conflict.md', 'my.conflict1/notes.md']) assert.ok(!S.SYNC_CONFLICT.test(n), n);
});

test('what a run did is counted from its log', () => {
  const s = S.syncSummary([L('Copied (new)', 'info'), L('Copied (new)', 'info'), L('Copied (replaced existing)', 'info'), L('Deleted', 'info'),
    L('- WARNING           New or changed in both paths                - Book/ch 2.md', 'notice'), L('- WARNING           New or changed in both paths                - Book/ch 2.md', 'notice'), L('Bisync successful', 'info')]);
  assert.deepEqual(s, { copied: 2, replaced: 1, deleted: 1, conflicts: ['Book/ch 2.md'], ok: true, nothing: false });
  assert.equal(S.syncSummaryText(s), '2 new files copied, 1 file updated, 1 file removed, 1 file changed on both sides (both versions kept)');
  assert.equal(S.syncSummaryText(S.syncSummary([L('No changes found', 'info'), L('Bisync successful', 'info')])), 'nothing had changed');
});

/* ---------- Failures, in plain words ---------- */

test('every failure is a plain sentence with a likely cause and a next step; rclone’s own words stay in the details', () => {
  const run = (msgs, more) => Object.assign({ code: 1, out: '', lines: msgs.map(m => L(m)), failed: null, stopped: false, timedOut: false }, more);
  const cases = [
    [['Failed to create file system for "scriptorium-drive:": didn\'t find section in config file ("scriptorium-drive")'], 'list', 'connect'],
    [['Failed to create file system for "scriptorium-drive:": drive: failed when making oauth client: failed to create oauth client: empty token found - please run "rclone config reconnect scriptorium-drive:"'], 'sync', 'connect'],
    [['couldn\'t fetch token: invalid_grant: maybe token expired? - try refreshing with "rclone config reconnect scriptorium-drive:"'], 'sync', 'connect'],
    [['oauth2: "invalid_grant" "Token has been expired or revoked."'], 'sync', 'connect'],
    [['Fatal error: config failed to refresh token: failed to get token: oauth2: "deleted_client" "The OAuth client was deleted."'], 'sign-in', 'client'],
    [['oauth2: "invalid_client" "The OAuth client was not found."'], 'sync', 'client'],
    [['googleapi: Error 403: Google Drive API has not been used in project 1234567 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=1234567, accessNotConfigured'], 'list', 'client'],
    [['Fatal error: config failed to refresh token: failed to start auth webserver: listen tcp 127.0.0.1:53682: bind: address already in use'], 'sign-in', 'busy'],
    [['failed to start auth webserver: listen tcp 127.0.0.1:53682: bind: Only one usage of each socket address (protocol/network address/port) is normally permitted.'], 'sign-in', 'busy'],
    [['googleapi: Error 403: The user\'s Drive storage quota has been exceeded., storageQuotaExceeded'], 'sync', 'quota'],
    [['googleapi: Error 403: User rate limit exceeded., userRateLimitExceeded'], 'sync', 'rate'],
    [['googleapi: Error 429: Too Many Requests'], 'sync', 'rate'],
    [['Get "https://www.googleapis.com/drive/v3/files": dial tcp: lookup www.googleapis.com: no such host'], 'list', 'network'],
    [['Post "https://oauth2.googleapis.com/token": dial tcp 142.250.0.1:443: connect: network is unreachable'], 'sync', 'network'],
    [['read tcp 10.0.0.2:5123->142.250.0.1:443: wsarecv: An existing connection was forcibly closed by the remote host. connection reset'], 'sync', 'network'],
    [['too many deletes (>50%, 7 of 11) on Path1 "local{HK82T}:/home/ada/Vault/". Run with --force if desired.', 'Bisync aborted. Please try again.'], 'sync', 'deletes'],
    [['Access test failed: Path1 count 1, Path2 count 0 - .scriptorium-sync', 'Bisync critical error: check file check failed', 'Bisync aborted. Error is retryable without --resync due to --resilient mode.'], 'sync', 'check'],
    [['Empty current Path2 listing. Cannot sync to an empty directory: /x/y.path2.lst-new', 'Bisync critical error: empty current Path2 listing: /x'], 'sync', 'empty'],
    [['Empty current Path1 listing. Cannot sync to an empty directory: /x/y.path1.lst-new'], 'sync', 'empty'],
    [['error listing: directory not found', 'Failed to lsjson with 2 errors: last error was: error in ListJSON: directory not found'], 'list', 'folder'],
    [['Failed to bisync: prior lock file found: /x/y.lck'], 'sync', 'busy'],
    [['Bisync critical error: cannot find prior Path1 or Path2 listings, likely due to critical error on prior run', 'Bisync aborted. Must run --resync to recover.'], 'sync', 'resync'],
    [['Bisync aborted. Must run --resync to recover.'], 'sync', 'resync'],
    [['Failed to copy: write /home/ada/Vault/big.wav: no space left on device'], 'sync', 'disk'],
    [['Failed to copy: open C:\\Users\\Ada\\Vault\\a.md: The process cannot access the file because it is being used by another process.'], 'sync', 'disk'],
    [['Failed to copy: open /home/ada/Vault/x: permission denied'], 'sync', 'disk'],
    [['Fatal error: unknown flag: --conflict-resolve'], 'sync', 'rclone'],
    [['something nobody has seen before: 0xDEADBEEF {"weird":true}'], 'sync', 'unknown'],
    [['something nobody has seen before'], 'copy', 'unknown'],
    [['something nobody has seen before'], 'list', 'unknown'],
  ];
  for (const [msgs, what, kind] of cases) {
    const e = S.syncExplain(run(msgs), what);
    assert.equal(e.kind, kind, msgs[0]);
    for (const text of [e.message, e.cause2, e.next]) {
      assert.ok(text && text.length > 10, `${kind}: every part is said`);
      assert.ok(!/googleapi:|oauth2|Path[12]\b|--resync|--force|\.lst|\.lck|bind:|dial tcp|0xDEAD|\{"|exit code|ENOENT|EACCES|local\{/i.test(text), `${kind}: “${text}” has none of rclone’s words`);
      assert.match(text, /[.!?…”)]$/, 'a whole sentence');
    }
    assert.ok(e.tail.length >= 1 && e.tail.some(l => msgs.includes(l)), 'rclone’s words are kept for the details');
  }
  // the numbers of a safety stop are read out of rclone's line
  const d = S.syncExplain(run(['too many deletes (>25%, 40 of 120) on Path2 "scriptorium-drive:Vault/". Run with --force if desired.']), 'sync');
  assert.match(d.message, /^40 of the 120 files and folders that are synced disappeared in the Drive folder since the last sync, which is more than the safety limit \(25%\)/);
  assert.deepEqual([d.deleted, d.side], [40, 'drive']);
  assert.match(S.syncExplain(run(['Access test failed: Path1 count 0, Path2 count 1 - .scriptorium-sync']), 'sync').message, /missing in this vault/);
  // rclone could not be started at all
  for (const [code, words] of [['ENOENT', /not where Scriptorium expected/], ['EACCES', /would not let rclone run/], ['EPERM', /would not let rclone run/], ['UNKNOWN', /could not be started/]]) {
    const e = S.syncExplain(run([], { code: null, failed: Object.assign(new Error(`spawn ${code}`), { code }) }), 'sync');
    assert.equal(e.kind, 'rclone');
    assert.match(e.message, words);
    assert.ok(!e.message.includes(code) && !e.cause2.includes(code) && e.next);
  }
  assert.match(S.syncExplain(run([], { timedOut: true }), 'sign-in').message, /did not arrive in ten minutes/);
  assert.equal(S.syncExplain(run([], { timedOut: true }), 'sync').kind, 'network');
  assert.match(S.syncExplain(run([], { stopped: true }), 'sync').next, /carries on from there/);
});

/* ---------- One run at a time, and when ---------- */

test('the lock: one holder; a holder that is gone, or six hours old, is replaced', t => {
  const dir = tmp(t), file = path.join(dir, 'locks', 'v.lock');
  const yes = () => true, no = () => false;
  assert.equal(S.syncLock(fs, path, file, 100, 1000, yes), true);
  assert.equal(S.syncLock(fs, path, file, 200, 2000, yes), false, 'another program has it');
  assert.equal(S.syncLock(fs, path, file, 100, 2000, yes), false, 'and so has another run in this program');
  S.syncUnlock(fs, file, 200);
  assert.ok(fs.existsSync(file), 'only the holder releases it');
  S.syncUnlock(fs, file, 100);
  assert.ok(!fs.existsSync(file));
  assert.equal(S.syncLock(fs, path, file, 100, 1000, yes), true);
  assert.equal(S.syncLock(fs, path, file, 200, 2000, no), true, 'the holder is gone');
  assert.equal(S.syncLock(fs, path, file, 300, 2000 + S.SYNC_TIMES.lockStale + 1, yes), true, 'the lock is older than six hours');
  fs.writeFileSync(file, 'half writ');
  assert.equal(S.syncLock(fs, path, file, 400, 5000, yes), true, 'a damaged lock is replaced');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 400);
});

test('rclone’s own lock is cleared only when its rclone is gone; old replaced files are pruned by date', t => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'a..b.lck'), JSON.stringify({ Session: 'x', PID: '4242', TimeRenewed: 'x', TimeExpires: 'y' }));
  fs.writeFileSync(path.join(dir, 'a..b.path1.lst'), 'listing');
  assert.equal(S.syncClearStale(fs, path, dir, pid => pid === 4242), 0);
  assert.ok(fs.existsSync(path.join(dir, 'a..b.lck')));
  assert.equal(S.syncClearStale(fs, path, dir, () => false), 1);
  assert.deepEqual(fs.readdirSync(dir), ['a..b.path1.lst']);
  assert.equal(S.syncClearStale(fs, path, path.join(dir, 'missing'), () => false), 0);
  const kept = path.join(dir, 'kept');
  for (const d of ['2026-09-01', '2026-10-20', '2026-11-11', 'not-a-date']) { fs.mkdirSync(path.join(kept, d), { recursive: true }); fs.writeFileSync(path.join(kept, d, 'f.md'), 'x'); }
  assert.equal(S.syncPrune(fs, path, kept, 30, new Date(2026, 10, 12).getTime()), 1);
  assert.deepEqual(fs.readdirSync(kept).sort(), ['2026-10-20', '2026-11-11', 'not-a-date']);
  assert.equal(S.syncStamp(new Date(2026, 0, 5)), '2026-01-05');
});

/* A clock whose timers run when the test says so. */
function clock() {
  let now = 1000000, next = 1;
  const timers = new Map();
  return {
    now: () => now,
    timers: { set(f, ms) { const id = next++; timers.set(id, { f, at: now + ms }); return id; }, clear(id) { timers.delete(id); } },
    pending: () => Array.from(timers.values()).map(t => t.at - now).sort((a, b) => a - b),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = Array.from(timers.entries()).filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].f();
        await new Promise(r => setImmediate(r));
      }
      now = end;
      await new Promise(r => setImmediate(r));
    },
  };
}
function engine(over) {
  const c = clock(), runs = [], states = [];
  const o = Object.assign({ linked: true, settings: S.syncSettings({}), result: () => ({ summary: S.syncSummary([L('Bisync successful', 'info')]) }) }, over);
  const e = new S.SyncEngine({
    run: async (reason, opts) => { runs.push(reason + (opts && opts.force ? '+force' : '')); if (o.gate) await o.gate; return o.result(reason); },
    settings: () => o.settings, linked: () => o.linked, onState: s => states.push(s.status), timers: c.timers, now: c.now,
  });
  return { e, c, runs, states, o };
}
const MIN = 60000;

test('the timer: soon after Obsidian starts, then every five minutes; off when not linked or not automatic', async () => {
  const { e, c, runs, states } = engine();
  e.start(true);
  assert.deepEqual(c.pending(), [S.SYNC_TIMES.onStart]);
  await c.advance(S.SYNC_TIMES.onStart);
  assert.deepEqual(runs, ['start']);
  assert.deepEqual(c.pending(), [5 * MIN]);
  await c.advance(5 * MIN); await c.advance(5 * MIN);
  assert.deepEqual(runs, ['start', 'timer', 'timer']);
  assert.equal(e.state.status, 'idle');
  assert.ok(e.state.last > 0 && states.includes('syncing'));
  e.stop();
  assert.deepEqual(c.pending(), []);
  const off = engine({ linked: false });
  off.e.start(true);
  assert.deepEqual([off.c.pending(), off.e.state.status], [[], 'off']);
  assert.deepEqual(await off.e.run('manual'), { skipped: 'off' });
  const manual = engine({ settings: S.syncSettings({ sync: { auto: false } }) });
  manual.e.start(true); manual.e.touch();
  assert.deepEqual(manual.c.pending(), [], 'nothing by itself');
  await manual.e.run('manual');
  assert.deepEqual([manual.runs, manual.c.pending()], [['manual'], []]);
  const slow = engine({ settings: S.syncSettings({ sync: { minutes: 30 } }) });
  slow.e.start(false);
  assert.deepEqual(slow.c.pending(), [30 * MIN]);
});

test('a change is synced a little after the last one, and the regular timer is not put off by a long spell of writing', async () => {
  const { e, c, runs } = engine();
  e.start(false);
  for (let i = 0; i < 20; i++) { e.touch(); await c.advance(20000); }   // typing for almost seven minutes, a change every 20 s
  assert.deepEqual(runs, ['timer'], 'the five-minute timer still ran; no run after each keystroke');
  await c.advance(S.SYNC_TIMES.onChange);
  assert.deepEqual(runs, ['timer', 'change']);
  assert.equal(e.pending(), false);
  e.touch();
  assert.deepEqual(c.pending(), [S.SYNC_TIMES.onChange, 5 * MIN - 20000]);
  assert.equal(e.pending(), true, 'something is waiting (asked before Obsidian quits)');
});

test('a change made while a run is going is synced by one more run after it', async () => {
  let open;
  const x = engine({});
  x.o.gate = new Promise(r => { open = r; });
  x.e.start(false);
  const first = x.e.run('timer');
  x.e.touch(); x.e.touch();
  assert.deepEqual([x.runs, x.c.pending(), x.e.pending()], [['timer'], [], true]);
  x.o.gate = null; open();
  await first;
  assert.deepEqual(x.c.pending(), [S.SYNC_TIMES.onChange, 5 * MIN]);
  await x.c.advance(S.SYNC_TIMES.onChange);
  assert.deepEqual(x.runs, ['timer', 'change']);
  assert.deepEqual(x.c.pending(), [5 * MIN], 'and that run, which changed nothing, is not followed by another');
});

test('never two runs at once: a request during a run waits for it, and one more run follows', async () => {
  let open;
  const x = engine({});
  x.o.gate = new Promise(r => { open = r; });
  x.e.start(false);
  const first = x.e.run('manual');
  const second = x.e.run('manual', { force: true });
  const third = x.e.run('timer');
  assert.equal(first, second); assert.equal(first, third);
  assert.deepEqual(x.runs, ['manual'], 'one run, whatever was asked meanwhile');
  x.o.gate = null; open();
  await first;
  assert.deepEqual(x.c.pending(), [S.SYNC_TIMES.again, 5 * MIN]);
  await x.c.advance(S.SYNC_TIMES.again);
  assert.deepEqual(x.runs, ['manual', 'manual+force'], 'the writer’s request made during the run is honoured after it');
});

test('a failure that needs the writer pauses the timer; any other is tried again, more slowly each time', async () => {
  let problem = S.syncProblem('network', 'Google Drive could not be reached.', 'Offline.', 'Wait.');
  const x = engine({ result: () => { if (problem) throw problem; return { summary: S.syncSummary([]) }; } });
  x.e.start(false);
  await x.c.advance(5 * MIN);
  assert.equal(x.e.state.status, 'problem');
  assert.deepEqual(x.c.pending(), [10 * MIN], 'tried again, after twice as long');
  await x.c.advance(10 * MIN);
  assert.deepEqual(x.c.pending(), [20 * MIN]);
  problem = null;
  await x.c.advance(20 * MIN);
  assert.deepEqual([x.e.state.status, x.e.state.problem, x.c.pending()], ['idle', null, [5 * MIN]]);
  for (const kind of ['connect', 'client', 'deletes', 'check', 'empty', 'resync', 'folder', 'rclone', 'quota']) {
    problem = S.syncProblem(kind, 'Something the writer must see.', 'A cause.', 'A step.');
    await x.c.advance(5 * MIN);
    assert.equal(x.e.state.status, 'problem', kind);
    assert.deepEqual(x.c.pending(), [], `${kind}: nothing runs by itself until the writer acts`);
    x.e.touch();
    assert.deepEqual(x.c.pending(), []);
    problem = null;
    await x.e.run('manual');
    assert.deepEqual([x.e.state.status, x.c.pending()], ['idle', [5 * MIN]]);
  }
  // an exception that is not a problem in plain words becomes one
  const y = engine({ result: () => { throw new TypeError("Cannot read properties of undefined (reading 'x')"); } });
  const r = await y.e.run('manual');
  assert.equal(r.problem.kind, 'unknown');
  assert.ok(!/TypeError|undefined/.test(r.problem.message + r.problem.cause2 + r.problem.next));
  assert.ok(r.problem.tail.join(' ').includes('Cannot read properties'));
  // a stop, or a lock held elsewhere, is not a failure
  const z = engine({ result: () => { throw S.syncProblem('stopped', 'Stopped.', '', ''); } });
  await z.e.run('manual');
  assert.equal(z.e.state.status, 'idle');
  const busy = engine({ result: () => ({ skipped: 'busy' }) });
  await busy.e.run('manual');
  assert.deepEqual([busy.e.state.status, busy.e.state.last], ['idle', 0]);
});

test('the status bar: ready, syncing, synced at hh:mm, needs a look', () => {
  const at = new Date(2026, 10, 12, 9, 5).getTime(), now = new Date(2026, 10, 12, 9, 30).getTime();
  assert.deepEqual(S.syncStatusText({ status: 'off' }, now), { text: '', title: '' });
  assert.equal(S.syncStatusText({ status: 'idle', last: 0 }, now).text, 'Drive: ready');
  assert.equal(S.syncStatusText({ status: 'syncing' }, now).text, 'Drive: syncing…');
  const done = S.syncStatusText({ status: 'idle', last: at, summary: S.syncSummary([L('Copied (new)', 'info')]) }, now);
  assert.equal(done.text, 'Drive: synced 09:05');
  assert.match(done.title, /1 new file copied/);
  assert.notEqual(S.syncStatusText({ status: 'idle', last: at - 3 * 86400000 }, now).text, 'Drive: synced 09:05', 'another day is said as a date');
  const bad = S.syncStatusText({ status: 'problem', problem: S.syncProblem('network', 'Google Drive could not be reached.', 'c', 'n') }, now);
  assert.equal(bad.text, 'Drive: needs a look');
  assert.match(bad.title, /could not be reached\. Click for what to do\./);
});

/* ---------- The diagnostic report ---------- */

test('the diagnostic report has rclone’s words but no token, secret, account or name of a file', () => {
  const home = '/home/ada';
  const runs = [
    { at: '21:00:01', what: 'sign-in', ms: 5300, code: 0, lines: [L('If your browser doesn\'t open automatically go to the following link: http://127.0.0.1:53682/auth?state=Zm9vYmFyYmF6cXV4MTIzNDU2', 'notice')] },
    { at: '21:01:00', what: 'sync', ms: 2100, code: 7, lines: [
      L('- Path1             File was deleted                            - Diary/My secret plans.md', 'info'),
      L('Access test failed: Path1 count 1, Path2 count 0 - .scriptorium-sync'),
      L('couldn\'t fetch token: Post "https://oauth2.googleapis.com/token": refresh_token=1//0gABCDEFGHIJKLMNOPQRSTUVWX client_secret=GOCSPX-abcdefghijklmnop access_token: ya29.a0AbCdEfGhIjKlMnOpQrStUvWxYz'),
      L('Failed to copy: open /home/ada/Vaults/Novel/Chapter One.md: permission denied'),
      L('error reading "My Drive/Vaults/Novel": user ada.lovelace@example.com, client 123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com'),
    ] },
    { at: '21:02:00', what: 'version', ms: 12, code: null, failed: 'ENOENT', lines: [] },
  ];
  const text = S.syncReport({ version: '1.2.3', obsidian: '1.15.0', platform: 'linux', arch: 'x64', release: '6.8', rclone: { kind: 'downloaded', version: '1.76.0' }, connected: true, own: true, type: 'drive',
    linked: true, first: true, where: 'My Drive, 2 folders deep', settings: S.syncSettings({}), state: { status: 'problem', problem: S.syncProblem('check', 'The file that proves both sides are there is missing.', 'c', 'n') } },
  runs, home, ['/home/ada/Vaults/Novel', 'Vaults/Novel', 'Novel']);
  for (const secret of ['1//0gABCDEF', 'GOCSPX-abcdefghijklmnop', 'ya29.a0AbCdEf', 'Zm9vYmFyYmF6cXV4MTIzNDU2', 'ada.lovelace', '123456789012-abcdefghijklmnopqrstuvwxyz012345', 'My secret plans', 'Chapter One', '/home/ada', 'Novel']) {
    assert.ok(!text.includes(secret), `the report does not hold ${secret}`);
  }
  for (const kept of ['Scriptorium 1.2.3', 'Obsidian 1.15.0', 'rclone: v1.76.0 (downloaded by Scriptorium)', 'Signed in: yes', 'a client ID of the writer’s own', 'linked (My Drive, 2 folders deep)', 'every 5 min', 'delete limit 50%',
    'sync: ended with 7 after 2.1 s', 'Access test failed: Path1 count 1, Path2 count 0', 'permission denied', 'version: could not start (ENOENT)', 'sign-in: ended with 0', 'problem (check:']) {
    assert.ok(text.includes(kept), `the report says “${kept}”`);
  }
  assert.ok(!text.includes('127.0.0.1:53682/auth'), 'a sign-in that worked adds no lines');
  const none = S.syncReport({ version: '1.2.3', platform: 'win32', rclone: {}, connected: false, linked: false, type: '' }, [], 'C:\\Users\\Ada', []);
  assert.ok(none.includes('rclone: not found') && none.includes('Signed in: no') && none.includes('not linked') && none.includes('nothing yet'));
  assert.ok(S.syncReport({ rclone: {}, connected: true, type: 'alias' }, [], '', []).includes('NOT GOOGLE DRIVE'), 'a test set-up says so');
  assert.equal(S.driveRedact('C:\\Users\\Ada\\Vault and C:/Users/Ada/x', 'C:\\Users\\Ada'), '~\\Vault and ~/x');
});

test('sizes and counts are said the way a reader says them', () => {
  assert.deepEqual([S.driveBytes(0), S.driveBytes(999), S.driveBytes(1500), S.driveBytes(32193987), S.driveBytes(5.2e9)], ['0 B', '999 B', '1.5 kB', '32 MB', '5.2 GB']);
  assert.deepEqual([S.driveCount(1, 'file'), S.driveCount(2, 'file'), S.driveCount(0, 'file is', 'files are')], ['1 file', '2 files', '0 files are']);
});
