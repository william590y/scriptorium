// Tests for the Scriptorium plugin's Google Drive sync (vault/.obsidian/plugins/scriptorium/main.js, "Syncing with
// Google Drive, through rclone") with the REAL rclone and a second folder on this computer standing in for Google
// Drive (an rclone "alias" remote named scriptorium-drive): the first sync, steady syncing, conflicts, deletions,
// every safety stop, an interrupted run, the filters, large files, awkward names, two computers on one Drive
// folder, and retrieving a vault. Nothing here talks to Google, and no rclone configuration of the user's is read:
// every call is given a config file in a temporary folder.
//
// Run: SCRIPTORIUM_TEST_RCLONE=/path/to/rclone node --test plugins-tests/rclone-real.test.js
//   or SCRIPTORIUM_TEST_RCLONE=download (downloads the pinned rclone with the plugin's own code, checks it against
//      the pinned SHA-256, and uses it; this is what CI does on Linux, Windows and macOS).
// Without the variable the tests are skipped.
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
const https = require('node:https');
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

const WANT = process.env.SCRIPTORIUM_TEST_RCLONE || '';
const TMP = process.env.SCRIPTORIUM_TEST_TMP || os.tmpdir();
const WIN = process.platform === 'win32';
let EXE = WANT && WANT !== 'download' ? WANT : '';
const skip = WANT ? false : 'set SCRIPTORIUM_TEST_RCLONE to the path of rclone (or to "download")';
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(TMP, `scriptorium-rclone-${name || ''}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(dir, rel, data, mtime) {
  const file = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  if (mtime) fs.utimesSync(file, mtime, mtime);
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
const has = (dir, rel) => fs.existsSync(path.join(dir, ...rel.split('/')));
function tree(dir) {
  const out = {};
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child); else out[child] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, child))).digest('hex').slice(0, 12);
    }
  };
  walk('');
  return out;
}
const ago = s => new Date(Date.now() - s * 1000);

/* A "Drive" (a folder), and computers that sync with it. Each computer has its own Scriptorium folder (config,
   record of the sync, replaced files) and its own vault. */
function drive(t) {
  const root = tmp(t, 'drive');
  fs.mkdirSync(path.join(root, 'Vaults', 'Mine'), { recursive: true });
  return { root, folder: path.join(root, 'Vaults', 'Mine'), link: { root: 'my', driveId: '', driveName: '', path: 'Vaults/Mine' } };
}
function computer(t, d, name, settings) {
  const user = tmp(t, `${name}-user`), dir = tmp(t, `${name}-vault`);
  const paths = S.syncPaths(path, user, process.platform);
  fs.writeFileSync(paths.conf, `[${S.RCLONE.remote}]\ntype = alias\nremote = ${d.root}\n`, { mode: 0o600 });
  const runs = [];
  const c = {
    name, dir, user, paths, runs, settings: S.syncSettings({ sync: settings || {} }), link: d.link,
    id: S.syncVaultId(crypto, path, dir, process.platform), spawn,
  };
  c.api = S.rcloneApi({ spawn: (...a) => c.spawn(...a), fs, path, exe: EXE, paths, env: process.env, log: r => runs.push(r) });
  const base = more => Object.assign({ api: c.api, fs, path, crypto, paths, id: c.id, dir, link: Object.assign({}, c.link, { first: 'yes' }), settings: c.settings,
    now: () => Date.now(), pid: process.pid, alive }, more);
  c.preview = () => S.syncPreview(base({ link: c.link }));
  c.first = (more) => S.syncFirst(base(Object.assign({ link: c.link }, more)));
  c.sync = (more) => S.syncOnce(base(more));
  return c;
}

test('the pinned rclone is downloaded, checked against its SHA-256 and unpacked (only when asked to download)', { skip: WANT !== 'download' && 'not asked to download' }, async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'scriptorium-rclone-bin-'));   // kept for the tests below; removed when the process ends
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* the system clears it */ } });
  const asset = S.rcloneAsset(process.platform, process.arch);
  assert.ok(asset, `there is a build for ${process.platform} ${process.arch}`);
  const exe = path.join(dir, 'rclone', `v${S.RCLONE.version}`, asset.exe);
  let last = 0;
  await S.rcloneInstall({ fs, path, crypto, zlib, https, asset, exe, onProgress: n => { last = n; } });
  assert.equal(last, asset.bytes);
  assert.ok(fs.statSync(exe).size > 30e6);
  assert.deepEqual(fs.readdirSync(path.dirname(exe)), [asset.exe], 'the zip file is not kept');
  EXE = exe;
});

test('rclone is the right version and never reads another configuration', { skip }, async t => {
  const d = drive(t), a = computer(t, d, 'a');
  const v = await a.api.version();
  assert.ok(S.rcloneOldEnough(v), v.join('.'));
  assert.equal(a.api.connection().connected, true);
  assert.equal(a.api.connection().type, 'alias');
  // with an RCLONE_CONFIG in the environment that points elsewhere, the calls still use Scriptorium's own file
  const other = path.join(tmp(t, 'other'), 'other.conf');
  fs.writeFileSync(other, '[elsewhere]\ntype = alias\nremote = /nowhere\n');
  const api = S.rcloneApi({ spawn, fs, path, exe: EXE, paths: a.paths, env: Object.assign({}, process.env, { RCLONE_CONFIG: other, RCLONE_DRY_RUN: 'true' }) });
  assert.deepEqual((await api.dirs({ root: 'my', path: '' })).map(x => x.name), ['Vaults']);
  assert.equal(fs.readFileSync(other, 'utf8'), '[elsewhere]\ntype = alias\nremote = /nowhere\n');
});

test('browsing the Drive: folders level by level, a new folder, names with spaces and accents', { skip }, async t => {
  const d = drive(t), a = computer(t, d, 'a');
  fs.mkdirSync(path.join(d.root, 'Écrits d’été', 'Sub folder'), { recursive: true });
  fs.writeFileSync(path.join(d.root, 'a file.txt'), 'x');
  const b = new S.SyncBrowser(a.api);
  assert.deepEqual((await b.list()).map(x => x.name), ['Écrits d’été', 'Vaults']);
  assert.equal(b.canChoose(), false, 'the top of the Drive cannot be the vault’s folder');
  b.enter('Écrits d’été');
  assert.deepEqual((await b.list()).map(x => x.name), ['Sub folder']);
  await b.create('New vault');
  assert.equal(b.where(), 'My Drive › Écrits d’été › New vault');
  assert.ok(fs.statSync(path.join(d.root, 'Écrits d’été', 'New vault')).isDirectory());
  assert.deepEqual(await b.list(), []);
  b.up();
  assert.deepEqual((await b.list()).map(x => x.name), ['New vault', 'Sub folder']);
  await assert.rejects(b.create('new VAULT'), e => e.kind === 'name' && /already/.test(e.message));
  await assert.rejects(b.create('a/b'), e => e.kind === 'name');
  assert.deepEqual(b.link(), { root: 'my', driveId: '', driveName: '', path: 'Écrits d’été' });
  // a folder that is not there is said in plain words
  await assert.rejects(a.api.dirs({ root: 'my', path: 'No such folder' }), e => e.kind === 'folder' && !/directory not found/.test(e.message) && e.tail.length > 0);
});

test('the first sync: what it will do is shown first, both sides end up with everything, differing files are kept twice', { skip }, async t => {
  const d = drive(t), a = computer(t, d, 'a');
  write(a.dir, 'Notes/only here.md', 'local');
  write(a.dir, 'Notes/same.md', 'same on both');
  write(a.dir, 'Notes/differs.md', 'the local words', ago(50));
  write(a.dir, '.obsidian/app.json', '{"a":1}');
  write(a.dir, '.obsidian/workspace.json', '{"layout":1}');
  write(a.dir, '.obsidian/plugins/lagrange/data.json', '{"apiKey":"sk-secret"}');
  write(a.dir, '.trash/gone.md', 'in the bin');
  write(d.folder, 'Notes/same.md', 'same on both');
  write(d.folder, 'Notes/differs.md', 'the words in Drive, longer', ago(500));
  write(d.folder, 'only in drive.md', 'remote');
  write(d.folder, 'scriptorium-manifest.json', '{}');
  write(d.folder, '_trash/2026-01-01/old.md', 'old route');
  const pv = await a.preview();
  assert.deepEqual({ local: pv.local.count, drive: pv.drive.count, same: pv.same, onlyLocal: pv.onlyLocal, onlyDrive: pv.onlyDrive, differ: pv.differ },
    { local: 4, drive: 3, same: 1, onlyLocal: 2, onlyDrive: 1, differ: ['Notes/differs.md'] });
  assert.ok(!has(a.dir, S.SYNC_SENTINEL) && !has(d.folder, 'Notes/only here.md'), 'looking changes nothing');
  const r = await a.first({ differ: pv.differ, keep: 'both' });
  assert.deepEqual(r.renamed, [['Notes/differs.md', 'Notes/differs.conflict1.md']]);
  assert.equal(read(a.dir, 'Notes/differs.md'), 'the words in Drive, longer');
  assert.equal(read(a.dir, 'Notes/differs.conflict1.md'), 'the local words');
  assert.equal(read(d.folder, 'Notes/differs.conflict1.md'), 'the local words');
  assert.equal(read(a.dir, 'only in drive.md'), 'remote');
  assert.equal(read(d.folder, 'Notes/only here.md'), 'local');
  assert.equal(read(d.folder, '.obsidian/app.json'), '{"a":1}');
  for (const rel of ['.obsidian/workspace.json', '.obsidian/plugins/lagrange/data.json', '.trash/gone.md']) assert.ok(!has(d.folder, rel), `${rel} is not sent`);
  for (const rel of ['scriptorium-manifest.json', '_trash/2026-01-01/old.md']) assert.ok(!has(a.dir, rel), `${rel} is not brought in`);
  assert.ok(has(a.dir, S.SYNC_SENTINEL) && has(d.folder, S.SYNC_SENTINEL));
  assert.ok(r.summary.ok);
  // and then nothing is left to do
  const again = await a.sync();
  assert.deepEqual([again.summary.copied, again.summary.replaced, again.summary.deleted], [0, 0, 0]);
  assert.equal(S.syncSummaryText(again.summary), 'nothing had changed');
});

test('the first sync, keeping one side: this computer’s version, or Drive’s (the replaced file is kept aside)', { skip }, async t => {
  for (const keep of ['local', 'drive']) {
    const d = drive(t), a = computer(t, d, 'a');
    write(a.dir, 'n.md', 'local words', ago(900));   // older, and still wins when "local" is chosen
    write(d.folder, 'n.md', 'drive words!', ago(100));
    write(a.dir, 'l.md', 'L'); write(d.folder, 'r.md', 'R');
    const pv = await a.preview();
    await a.first({ differ: pv.differ, keep });
    assert.equal(read(a.dir, 'n.md'), keep === 'local' ? 'local words' : 'drive words!');
    assert.equal(read(d.folder, 'n.md'), keep === 'local' ? 'local words' : 'drive words!');
    assert.ok(has(a.dir, 'r.md') && has(d.folder, 'l.md'), 'what is on one side only is always copied');
    const kept = path.join(a.paths.kept, a.id);
    if (keep === 'drive') assert.equal(read(path.join(kept, fs.readdirSync(kept)[0]), 'n.md'), 'local words', 'the replaced local file is kept in Scriptorium’s folder');
  }
});

test('steady syncing: edits, new files, renames and deletions travel both ways', { skip }, async t => {
  const d = drive(t), a = computer(t, d, 'a');
  write(a.dir, 'a.md', 'one'); write(a.dir, 'b.md', 'two'); write(a.dir, 'c.md', 'three'); write(a.dir, 'd/e.md', 'four');
  await a.first({});
  write(a.dir, 'a.md', 'one, edited here');
  write(d.folder, 'b.md', 'two, edited in Drive');
  write(d.folder, 'new in drive.md', 'N');
  fs.renameSync(path.join(a.dir, 'c.md'), path.join(a.dir, 'c renamed.md'));
  fs.unlinkSync(path.join(d.folder, 'd', 'e.md'));
  fs.mkdirSync(path.join(a.dir, 'Empty folder'));
  const r = await a.sync();
  assert.ok(r.summary.ok);
  assert.equal(read(d.folder, 'a.md'), 'one, edited here');
  assert.equal(read(a.dir, 'b.md'), 'two, edited in Drive');
  assert.equal(read(a.dir, 'new in drive.md'), 'N');
  assert.ok(has(d.folder, 'c renamed.md') && !has(d.folder, 'c.md'));
  assert.ok(!has(a.dir, 'd/e.md'), 'a file deleted in Drive is removed here');
  assert.ok(has(d.folder, 'Empty folder'), 'a new, empty folder is made on the other side');
  assert.deepEqual(tree(a.dir), tree(d.folder));
  // what the sync removed or replaced on this computer is kept in Scriptorium's own folder
  const kept = path.join(a.paths.kept, a.id, S.syncStamp(new Date()));
  assert.equal(read(kept, 'd/e.md'), 'four');
  assert.equal(read(kept, 'b.md'), 'two');
  assert.ok(r.summary.copied >= 2 && r.summary.deleted >= 1 && r.summary.replaced >= 1, JSON.stringify(r.summary));
});

test('a file changed on both sides keeps both: the newer under its name, the older as name.conflict1.md', { skip }, async t => {
  const d = drive(t), a = computer(t, d, 'a');
  write(a.dir, 'Chapter.md', 'first words'); write(a.dir, 'other.md', 'x');
  await a.first({});
  write(a.dir, 'Chapter.md', 'written on this computer', ago(60));
  write(d.folder, 'Chapter.md', 'written on the other computer, later', ago(5));
  const r = await a.sync();
  assert.deepEqual(r.summary.conflicts, ['Chapter.md']);
  assert.match(S.syncSummaryText(r.summary), /1 file changed on both sides \(both versions kept\)/);
  for (const side of [a.dir, d.folder]) {
    assert.equal(read(side, 'Chapter.md'), 'written on the other computer, later');
    assert.equal(read(side, 'Chapter.conflict1.md'), 'written on this computer');
  }
  assert.ok(S.SYNC_CONFLICT.test('Chapter.conflict1.md'));
  // a second conflict on the same file takes the next number
  write(a.dir, 'Chapter.md', 'here again, later', ago(1));
  write(d.folder, 'Chapter.md', 'there again', ago(30));
  await a.sync();
  assert.equal(read(d.folder, 'Chapter.md'), 'here again, later');
  assert.equal(read(a.dir, 'Chapter.conflict2.md'), 'there again');
  assert.deepEqual(tree(a.dir), tree(d.folder));
});

test('the limit on deletions stops a run that would delete too much, and “Sync anyway” goes on', { skip }, async t => {
  const d = drive(t), a = computer(t, d, 'a');
  for (let i = 0; i < 10; i++) write(a.dir, `n${i}.md`, `note ${i}`);
  await a.first({});
  for (let i = 0; i < 7; i++) fs.unlinkSync(path.join(a.dir, `n${i}.md`));
  const before = tree(d.folder);
  await assert.rejects(a.sync(), e => {
    assert.equal(e.kind, 'deletes');
    assert.match(e.message, /^7 of the 11 files and folders that are synced disappeared on this computer since the last sync, which is more than the safety limit \(50%\), so nothing was changed\.$/);
    assert.ok(e.cause2 && e.next && /Sync anyway/.test(e.next));
    assert.ok(S.SyncEngine.needsWriter(e));
    return true;
  });
  assert.deepEqual(tree(d.folder), before, 'nothing was deleted in Drive');
  const r = await a.sync({ force: true });
  assert.equal(r.summary.deleted, 7);
  assert.deepEqual(Object.keys(tree(d.folder)).sort(), [S.SYNC_SENTINEL, 'n7.md', 'n8.md', 'n9.md']);
  // deletions in Drive beyond the limit stop too, and nothing is removed here
  for (const n of ['n7.md', 'n8.md', 'n9.md']) fs.unlinkSync(path.join(d.folder, n));
  await assert.rejects(a.sync(), e => e.kind === 'deletes' && /in the Drive folder/.test(e.message));
  assert.ok(has(a.dir, 'n7.md'));
  // with a lower limit in the settings, fewer deletions are enough
  const strict = computer(t, d, 'strict', { maxDelete: 10 });
  assert.ok(S.syncBisyncArgs({ path, local: strict.dir, link: d.link, paths: strict.paths, id: strict.id, settings: strict.settings, stamp: 'x' }).join(' ').includes('--max-delete 10'));
});

test('an emptied, missing or swapped side stops the run and deletes nothing', { skip }, async t => {
  const d = drive(t), a = computer(t, d, 'a');
  for (let i = 0; i < 6; i++) write(a.dir, `n${i}.md`, `note ${i}`);
  await a.first({});
  const local = tree(a.dir), away = `${d.folder}.away`;
  // the Drive folder is emptied
  fs.renameSync(d.folder, away); fs.mkdirSync(d.folder);
  await assert.rejects(a.sync(), e => (e.kind === 'empty' || e.kind === 'check') && /nothing was changed/.test(e.message) && Boolean(e.next));
  assert.deepEqual(tree(a.dir), local);
  // the Drive folder is gone
  fs.rmdirSync(d.folder);
  await assert.rejects(a.sync(), e => ['empty', 'check', 'folder'].includes(e.kind));
  assert.deepEqual(tree(a.dir), local);
  // the Drive folder holds other files, without the check file (a different folder under the same name)
  fs.mkdirSync(d.folder); write(d.folder, 'someone else.md', 'x'); write(d.folder, 'another.md', 'y');
  await assert.rejects(a.sync(), e => e.kind === 'check' && /in the Drive folder/.test(e.message));
  assert.deepEqual(tree(a.dir), local);
  assert.deepEqual(Object.keys(tree(d.folder)).sort(), ['another.md', 'someone else.md']);
  fs.rmSync(d.folder, { recursive: true }); fs.renameSync(away, d.folder);
  // back as it was: the sync carries on without a new first sync
  assert.ok((await a.sync()).summary.ok);
  // the vault's check file is gone (the folder was swapped): rclone is not even run
  const calls = a.runs.length;
  fs.unlinkSync(path.join(a.dir, S.SYNC_SENTINEL));
  await assert.rejects(a.sync(), e => e.kind === 'check' && /in this vault/.test(e.message));
  assert.equal(a.runs.length, calls);
  // the vault's folder is gone (a disk that is not connected)
  const gone = Object.assign({}, a, {});
  await assert.rejects(S.syncOnce({ api: a.api, fs, path, crypto, paths: a.paths, id: a.id, dir: path.join(a.dir, 'not mounted'), link: Object.assign({}, d.link, { first: 'yes' }), settings: a.settings, now: Date.now, pid: process.pid, alive }),
    e => e.kind === 'empty' && /cannot be found/.test(e.message));
  assert.ok(gone);
  assert.equal(Object.keys(tree(d.folder)).length, 7, 'Drive still has everything');
  // an emptied vault (every note deleted, the check file too) is stopped the same way
  write(a.dir, S.SYNC_SENTINEL, 'x');
  for (let i = 0; i < 6; i++) fs.unlinkSync(path.join(a.dir, `n${i}.md`));
  await assert.rejects(a.sync(), e => e.kind === 'deletes');
  assert.equal(Object.keys(tree(d.folder)).length, 7);
});

test('a run that is cut off is picked up by the next one', { skip }, async t => {
  const d = drive(t), a = computer(t, d, 'a');
  write(a.dir, 'start.md', 'x');
  await a.first({});
  for (let i = 0; i < 300; i++) write(a.dir, `many/f${i}.bin`, crypto.randomBytes(40000));
  // rclone is killed outright when the first file has gone up
  let child = null, killed = false;
  a.spawn = (...args) => { child = spawn(...args); return child; };
  await assert.rejects(a.sync({ onLine: l => { if (!killed && /^Copied/.test(l.msg)) { killed = true; child.kill('SIGKILL'); } } }), e => {
    assert.ok(['unknown', 'stopped'].includes(e.kind), e.kind);
    assert.ok(e.message && e.next);
    return true;
  });
  assert.ok(killed);
  a.spawn = spawn;
  const sent = fs.existsSync(path.join(d.folder, 'many')) ? fs.readdirSync(path.join(d.folder, 'many')).length : 0;
  assert.ok(sent < 300, `only part was sent (${sent})`);
  assert.ok(!fs.existsSync(path.join(a.paths.locks, `${a.id}.lock`)), 'Scriptorium’s lock is released');
  assert.ok(fs.readdirSync(path.join(a.paths.work, a.id)).some(n => n.endsWith('.lck')), 'rclone left its own lock behind');
  const r = await a.sync();
  assert.ok(r.summary.ok);
  assert.deepEqual(tree(a.dir), tree(d.folder));
  assert.equal(fs.readdirSync(path.join(d.folder, 'many')).length, 300);
});

test('a stop (the window closed, Obsidian quitting) cuts rclone off, and the next run carries on', { skip }, async t => {
  const d = drive(t), a = computer(t, d, 'a');
  write(a.dir, 'start.md', 'x');
  await a.first({});
  for (let i = 0; i < 200; i++) write(a.dir, `many/f${i}.bin`, crypto.randomBytes(40000));
  const ctl = new AbortController();
  let n = 0;
  await assert.rejects(a.sync({ signal: ctl.signal, onLine: l => { if (/^Copied/.test(l.msg) && ++n === 3) ctl.abort(); } }), e => e.kind === 'stopped' && /carries on/.test(e.next));
  assert.ok((await a.sync()).summary.ok);
  assert.deepEqual(tree(a.dir), tree(d.folder));
});

test('never two runs at once: a second run finds the lock and does nothing', { skip }, async t => {
  const d = drive(t), a = computer(t, d, 'a');
  write(a.dir, 'a.md', 'x');
  await a.first({});
  for (let i = 0; i < 60; i++) write(a.dir, `f${i}.bin`, crypto.randomBytes(20000));
  const [one, two] = await Promise.all([a.sync(), a.sync()]);
  assert.deepEqual([Boolean(one.summary), two.skipped], [true, 'busy']);
  // a lock left by a program that is gone is taken over
  fs.mkdirSync(a.paths.locks, { recursive: true });
  fs.writeFileSync(path.join(a.paths.locks, `${a.id}.lock`), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
  assert.ok((await S.syncOnce({ api: a.api, fs, path, crypto, paths: a.paths, id: a.id, dir: a.dir, link: Object.assign({}, d.link, { first: 'y' }), settings: a.settings, now: Date.now, pid: process.pid, alive: () => false })).summary.ok);
});

test('what is and is not synced; turning Obsidian’s settings off re-matches both sides without undoing a deletion', { skip }, async t => {
  const d = drive(t), a = computer(t, d, 'a');
  const files = {
    'Note.md': 1, 'Folder/Deep/note.md': 1, 'image.png': 1, '.obsidian/app.json': 1, '.obsidian/appearance.json': 1, '.obsidian/community-plugins.json': 1,
    '.obsidian/plugins/scriptorium/main.js': 1, '.obsidian/plugins/scriptorium/data.json': 1, '.obsidian/plugins/other/data.json': 1, '.obsidian/snippets/manuscript.css': 1,
    '.obsidian/themes/Scriptorium/theme.css': 1, '.obsidian/workspace.json': 0, '.obsidian/workspace-mobile.json': 0, '.obsidian/workspaces.json': 0, '.obsidian/cache/x': 0,
    '.obsidian/plugins/lagrange/data.json': 0, '.obsidian/plugins/lagrange/main.js': 1, '.obsidian/plugins/x/node_modules/y/index.js': 0, '.obsidian/plugins/scriptorium/drive-sync.json': 0,
    '.trash/old.md': 0, '.git/config': 0, 'Folder/.hidden/x.md': 0, '.DS_Store': 0, 'Folder/.DS_Store': 0, 'Folder/Thumbs.db': 0, 'x.scriptorium-tmp': 0,
    '.obsidian/scriptorium-backup-20261112-101010/app.json': 0, 'scriptorium-manifest.json': 0, '_trash/2026-11-01/x.md': 0, 'Folder/_trash/kept.md': 1, 'node_modules/p/i.js': 0,
  };
  for (const rel of Object.keys(files)) write(a.dir, rel, rel);
  await a.first({});
  for (const [rel, sent] of Object.entries(files)) assert.equal(has(d.folder, rel), Boolean(sent), rel);
  // Obsidian's settings are turned off on this computer: a note deleted meanwhile stays deleted, .obsidian stops travelling
  fs.unlinkSync(path.join(a.dir, 'Note.md'));
  a.settings = S.syncSettings({ sync: { obsidian: false } });
  const r = await a.sync();
  assert.ok(r.summary.ok);
  assert.ok(!has(d.folder, 'Note.md') && !has(a.dir, 'Note.md'), 'the deletion was synced before the rules changed');
  write(a.dir, '.obsidian/app.json', 'changed after');
  write(a.dir, 'Later.md', 'x');
  assert.ok((await a.sync()).summary.ok);
  assert.ok(has(d.folder, 'Later.md'));
  assert.equal(read(d.folder, '.obsidian/app.json'), '.obsidian/app.json', 'Obsidian’s settings are no longer sent');
  assert.equal(read(a.dir, '.obsidian/app.json'), 'changed after');
});

test('a large file, names in many scripts, and a path longer than Windows’ old limit', { skip }, async t => {
  const d = drive(t), a = computer(t, d, 'a');
  const big = crypto.randomBytes(48 * 1024 * 1024);
  write(a.dir, 'Recording.wav', big);
  const names = ['Ünïcödé — “quotes” & ampersand.md', '日本語のノート.md', 'emoji 🪶 note.md', 'Ελληνικά/κείμενο.md', 'name with  two spaces.md', 'trailing space folder /x.md'.replace(' /', WIN ? '/' : ' /'), "it's (1) [draft] {a} #tag +plus =eq ;semi ,comma !bang.md", '100% done.md'];
  for (const n of names) write(a.dir, n, n);
  const deep = `${Array.from({ length: 12 }, (_, i) => `a rather long folder name number ${i}`).join('/')}/the note at the bottom.md`;
  assert.ok(path.join(a.dir, deep).length > 300);
  write(a.dir, deep, 'deep');
  await a.first({});
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(d.folder, 'Recording.wav'))).digest('hex'), crypto.createHash('sha256').update(big).digest('hex'));
  assert.deepEqual(tree(a.dir), tree(d.folder));
  assert.equal(read(d.folder, deep), 'deep');
  // and back down to a second computer
  const b = computer(t, d, 'b');
  await b.first({});
  assert.deepEqual(tree(b.dir), tree(a.dir));
});

test('names that Windows keeps for itself or forbids come down under a safe spelling and go back up unchanged', { skip: skip || (WIN && 'such files cannot be made on Windows to stand in for Drive') }, async t => {
  const d = drive(t), a = computer(t, d, 'a');
  const odd = ['con.md', 'aux', 'a:b.md', 'what?.md', 'star*.md', 'quote".md', 'pipe|.md', 'less<more>.md', 'ends with dot.', 'back\\slash.md', 'COM1.txt'];
  for (const n of odd) write(d.folder, n, n);
  write(a.dir, 'mine.md', 'x');
  await a.first({});
  for (const n of odd) assert.equal(read(a.dir, n), n);
  // what Scriptorium tells a writer on Windows about such names is rclone's doing: rclone itself replaces the
  // characters Windows forbids with look-alikes on the way down and puts them back on the way up (its "encoding").
  assert.ok((await a.sync()).summary.ok);
  assert.deepEqual(tree(a.dir), tree(d.folder));
});

test('two computers on one Drive folder: each sees the other’s work, deletions and conflicts', { skip }, async t => {
  const d = drive(t), a = computer(t, d, 'a'), b = computer(t, d, 'b');
  write(a.dir, 'Book/ch1.md', 'chapter one'); write(a.dir, 'Book/ch2.md', 'chapter two'); write(a.dir, 'Book/ch3.md', 'chapter three'); write(a.dir, '.obsidian/app.json', '{}');
  await a.first({});
  // the second computer starts with an empty vault: its first sync brings everything down and deletes nothing
  const pv = await b.preview();
  assert.deepEqual([pv.local.count, pv.drive.count, pv.onlyDrive], [0, 4, 4]);
  await b.first({ differ: pv.differ });
  assert.deepEqual(tree(b.dir), tree(a.dir));
  // work on both, on different files
  write(a.dir, 'Book/ch1.md', 'chapter one, revised on A');
  write(b.dir, 'Book/ch4.md', 'chapter four, new on B');
  fs.unlinkSync(path.join(b.dir, 'Book', 'ch3.md'));
  await a.sync(); await b.sync(); await a.sync();
  assert.deepEqual(tree(a.dir), tree(b.dir));
  assert.equal(read(b.dir, 'Book/ch1.md'), 'chapter one, revised on A');
  assert.ok(!has(a.dir, 'Book/ch3.md') && has(a.dir, 'Book/ch4.md'));
  // the same file on both, between syncs: both versions survive on both computers
  write(a.dir, 'Book/ch2.md', 'two, as A has it', ago(40));
  write(b.dir, 'Book/ch2.md', 'two, as B has it (later)', ago(10));
  await a.sync();
  const rb = await b.sync();
  assert.deepEqual(rb.summary.conflicts, ['Book/ch2.md']);
  await a.sync();
  assert.deepEqual(tree(a.dir), tree(b.dir));
  assert.equal(read(a.dir, 'Book/ch2.md'), 'two, as B has it (later)');
  assert.equal(read(a.dir, 'Book/ch2.conflict1.md'), 'two, as A has it');
  // A's deleted chapter went to A's folder of replaced files, not into thin air
  assert.equal(read(path.join(a.paths.kept, a.id, S.syncStamp(new Date())), 'Book/ch3.md'), 'chapter three');
});

test('retrieving: a Drive folder is copied into a new folder, then linked without a second look', { skip }, async t => {
  const d = drive(t), a = computer(t, d, 'a');
  write(a.dir, 'Notes/a.md', 'A'); write(a.dir, 'pic.png', crypto.randomBytes(200000)); write(a.dir, '.obsidian/app.json', '{"x":1}');
  await a.first({});
  write(d.folder, 'scriptorium-manifest.json', '{}');
  const b = computer(t, d, 'b');
  const target = path.join(b.dir, 'Retrieved vault');
  const filters = path.join(b.paths.dir, 'retrieve.txt');
  fs.writeFileSync(filters, S.syncFilters(S.SYNC_DEFAULTS));
  const size = await b.api.size(d.link, filters);
  assert.equal(size.count, 4);
  assert.equal(S.driveTargetProblem(fs, path, target, size.bytes), '');
  assert.match(S.driveTargetProblem(fs, path, a.dir, size.bytes), /not empty/);
  fs.mkdirSync(target);
  const seen = [];
  await b.api.copy(d.link, target, filters, s => seen.push(s));
  assert.deepEqual(tree(target), tree(a.dir));
  const id = S.syncVaultId(crypto, path, target, process.platform);
  await S.syncFirst({ api: b.api, fs, path, paths: b.paths, id, dir: target, link: d.link, settings: b.settings, differ: [], now: Date.now, pid: process.pid, alive });
  S.syncSaveLink(fs, path, b.paths.vaults, id, Object.assign({}, d.link, { first: 'now' }));
  assert.equal(S.syncLink(fs, b.paths.vaults, id).path, 'Vaults/Mine');
  write(target, 'Notes/b.md', 'B');
  await S.syncOnce({ api: b.api, fs, path, crypto, paths: b.paths, id, dir: target, link: S.syncLink(fs, b.paths.vaults, id), settings: b.settings, now: Date.now, pid: process.pid, alive });
  await a.sync();
  assert.equal(read(a.dir, 'Notes/b.md'), 'B');
});

test('the sign-in, as far as it can go without Google: rclone waits on 127.0.0.1:53682 with the right request', { skip: skip || (process.platform !== 'linux' && 'only on Linux, where no browser is opened by it') }, async t => {
  const user = tmp(t, 'signin'), paths = S.syncPaths(path, user, process.platform);
  const env = Object.assign({}, process.env, { BROWSER: 'true' });
  delete env.DISPLAY; delete env.WAYLAND_DISPLAY;
  const api = S.rcloneApi({ spawn, fs, path, exe: EXE, paths, env });
  assert.equal(api.connection().connected, false);
  for (const client of [null, { id: '1234567890-abcdefghijklmnop.apps.googleusercontent.com', secret: 'GOCSPX-not-a-real-secret' }]) {
    const ctl = new AbortController();
    let url = '', where = '';
    const p = api.connect(client, async u => {
      url = u;
      // where rclone's page sends the browser: Google's sign-in, with the client, the scope and the loopback address
      try { const res = await fetch(u, { redirect: 'manual' }); where = res.headers.get('location') || ''; } catch (e) { where = `failed: ${e.message}`; }
      ctl.abort();
    }, ctl.signal);
    await assert.rejects(p, e => e.kind === 'stopped' && /sign-in was stopped/.test(e.message));
    assert.match(url, /^http:\/\/127\.0\.0\.1:53682\/auth\?state=/);
    const g = new URL(where);
    assert.equal(g.origin + g.pathname, 'https://accounts.google.com/o/oauth2/auth');
    assert.equal(g.searchParams.get('redirect_uri'), 'http://127.0.0.1:53682/');
    assert.equal(g.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive');
    assert.equal(g.searchParams.get('access_type'), 'offline');
    if (client) assert.equal(g.searchParams.get('client_id'), client.id); else assert.match(g.searchParams.get('client_id'), /\.apps\.googleusercontent\.com$/);
    assert.equal(api.connection().connected, false, 'no token: not connected');
    assert.equal((fs.statSync(paths.conf).mode & 0o777), 0o600);
    const conf = fs.readFileSync(paths.conf, 'utf8');
    assert.ok(conf.includes('[scriptorium-drive]') && conf.includes('scope = drive') && !/token\s*=\s*\S/.test(conf));
    await new Promise(done => setTimeout(done, 300));   // the port is free again for the next round
  }
  // and what the writer is told when the sign-in is missing
  await assert.rejects(api.dirs({ root: 'my', path: '' }), e => e.kind === 'connect' && /not signed in/.test(e.message));
});
