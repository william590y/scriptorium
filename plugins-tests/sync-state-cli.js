// A vault whose Google Drive sync is set up, for the tests of updating and setting up a vault: tools/test_update.py
// and tools/test_setup_vault.py make one with this, update the vault by each route (Scriptorium Setup, the script,
// the plugin's command), and then ask the plugin's own code whether the sync is still set up. Everything here is
// pretend: the sign-in is made-up text, no rclone is run and nothing leaves the computer. Not packaged, and not for
// users.
//
//   node plugins-tests/sync-state-cli.js make <vault> <user folder>    writes the sync's files, as the plugin does
//   node plugins-tests/sync-state-cli.js check <vault> <user folder>   exits 0 if the plugin finds the sync set up
//                                                                      as `make` left it, and would sync without
//                                                                      asking anything or matching both sides anew
//
// <user folder> stands for Scriptorium's own folder (per user, outside every vault). The layout is that of 1.2.3,
// which is also that of every version since.
//
// Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

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

/* The vault's own sync settings: none of them is the default, so that a file written anew would show. */
const SYNC = { auto: true, minutes: 17, obsidian: false, maxDelete: 35, keepDays: 90 };
const LINK = { root: 'my', path: 'Writing/My vault', linked: '2026-06-01T09:00:00.000Z', first: '2026-06-01T09:01:00.000Z' };
const DEVICE = { rclone: path.join(path.sep, 'opt', 'rclone', 'rclone') };
const RECORD = ['path1.lst', 'path2.lst'];   // stand-ins for rclone's record of the last sync

function kit(vault, user) {
  vault = path.resolve(vault); user = path.resolve(user);
  const paths = S.syncPaths(path, user, process.platform);
  return { vault, paths, id: S.syncVaultId(crypto, path, vault, process.platform), data: path.join(vault, '.obsidian', 'plugins', 'scriptorium', 'data.json') };
}

function make(vault, user) {
  const k = kit(vault, user), { paths, id } = k;
  // In the vault: the check file, the plugin's settings, and what the older backup (1.2.0 to 1.2.2) left behind.
  fs.mkdirSync(path.dirname(k.data), { recursive: true });
  fs.writeFileSync(path.join(k.vault, S.SYNC_SENTINEL), 'Scriptorium keeps this file on both sides of a sync.\n');
  const saved = S.syncReadJson(fs, k.data);
  fs.writeFileSync(k.data, JSON.stringify(Object.assign(saved, { fancyMode: true, sync: SYNC, syncMoveTold: true, drive: { folder: 'an older backup' } }), null, 2));
  fs.writeFileSync(path.join(path.dirname(k.data), 'drive-sync.json'), '{"files":{}}\n');
  // Outside it: the sign-in (made up), the Drive folder of this vault, the path to rclone, and the sync's records.
  S.syncConfPrepare(fs, path, paths.conf, { id: 'pretend.apps.googleusercontent.com', secret: 'pretend-secret' });
  fs.appendFileSync(paths.conf, 'token = {"access_token":"pretend-access","refresh_token":"pretend-refresh"}\n');
  S.syncSaveLink(fs, path, paths.vaults, id, LINK);
  S.syncSaveLink(fs, path, paths.vaults, '0123456789abcdef', { root: 'my', path: 'Another vault', linked: LINK.linked, first: LINK.first });
  S.syncWriteJson(fs, path, paths.device, DEVICE);
  for (const dir of [path.join(paths.work, id), paths.filters, paths.locks, path.join(paths.kept, id, S.syncStamp(new Date()))]) fs.mkdirSync(dir, { recursive: true });
  for (const name of RECORD) fs.writeFileSync(path.join(paths.work, id, name), `# pretend record of the last sync (${name})\n`);
  fs.writeFileSync(path.join(paths.filters, `${id}.txt`), S.syncFilters(SYNC));
  fs.writeFileSync(path.join(paths.kept, id, S.syncStamp(new Date()), 'An older draft.md'), 'What a sync replaced.\n');
}

async function check(vault, user) {
  const k = kit(vault, user), { paths, id } = k, wrong = [];
  const want = (ok, what) => { if (!ok) wrong.push(what); };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  want(fs.existsSync(path.join(k.vault, S.SYNC_SENTINEL)), 'the check file is in the vault');
  const link = S.syncLink(fs, paths.vaults, id);
  want(link && same(link, LINK), 'the vault is linked to its Drive folder, with its first sync done');
  const conn = S.syncConnection(fs, paths.conf);
  want(conn.connected && conn.own && conn.client === 'pretend.apps.googleusercontent.com', 'this computer is signed in, with the client ID that was given');
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(k.data, 'utf8')); } catch (e) { /* said below */ }
  const settings = S.syncSettings(S.normalizeSettings(saved));
  want(saved && same(settings, SYNC), 'the vault’s sync settings are its own');
  want(saved && saved.syncMoveTold === true && same(saved.drive, { folder: 'an older backup' }) && saved.fancyMode === true, 'the plugin’s other settings are the vault’s own');
  want(same(S.syncReadJson(fs, paths.device), DEVICE), 'the path to rclone is kept');
  want(RECORD.every(name => fs.existsSync(path.join(paths.work, id, name))), 'rclone’s record of the last sync is there');
  let rules = null;
  try { rules = fs.readFileSync(path.join(paths.filters, `${id}.txt`), 'utf8'); } catch (e) { /* said below */ }
  want(rules === S.syncFilters(settings), 'the list of what is synced is the one the last sync used');
  // One sync, with a pretend rclone that only notes what it is asked: a plain run, not a new first sync.
  const runs = [];
  try {
    await S.syncOnce({ api: { bisync: async args => { runs.push(args); return { summary: {} }; } }, fs, path, paths, id, dir: k.vault, link, settings,
      now: () => Date.now(), pid: process.pid, alive: () => false });
    want(runs.length === 1 && !runs[0].includes('--resync') && runs[0].includes(path.join(paths.work, id)), 'the next sync is a plain one: nothing is asked, and the two sides are not matched up anew');
  } catch (e) {
    want(false, `the next sync runs (it said: ${e && e.message})`);
  }
  if (wrong.length) { for (const w of wrong) console.error(`NOT SO: ${w}`); process.exit(1); }
  console.log('The sync is set up as it was: signed in, linked to its Drive folder, and the next sync is a plain one.');
}

const [mode, vault, user] = process.argv.slice(2);
if (!['make', 'check'].includes(mode) || !vault || !user) {
  console.error('usage: sync-state-cli.js make|check <vault> <user folder>');
  process.exit(2);
}
if (mode === 'make') make(vault, user); else check(vault, user).catch(e => { console.error(`FAILED: ${e && e.message}`); process.exit(1); });
