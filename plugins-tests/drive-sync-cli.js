// Runs the Scriptorium plugin's Google Drive backup from the command line, against the real Google Drive connector
// of the Claude account that Claude Code is signed in to. For testing the backup without Obsidian; not packaged, and
// not for users (they have the commands in Obsidian). It runs Claude Code, so it uses a little of that account's usage.
//
//   node plugins-tests/drive-sync-cli.js check
//   node plugins-tests/drive-sync-cli.js plan <vault>      [--folder <Drive folder>] [--device <name>] [--name <vault name>] [--log <file for Claude Code's event stream>]
//   node plugins-tests/drive-sync-cli.js sync <vault>      [same options]
//   node plugins-tests/drive-sync-cli.js list              [--folder <Drive folder>]
//   node plugins-tests/drive-sync-cli.js retrieve <vault name> <new folder> [--folder <Drive folder>] [--device <name>]
//
// The Drive folder defaults to "Scriptorium"; tests use one whose name starts with "Scriptorium-sync-TEST-".
//
// Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

function stub() {
  return new Proxy({}, { get(t, k) { if (!(k in t)) t[k] = class { static define() { return {}; } }; return t[k]; } });
}
const stubs = { obsidian: Object.assign(stub(), { Platform: {} }), '@codemirror/state': stub(), '@codemirror/view': stub() };
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  return Object.prototype.hasOwnProperty.call(stubs, request) ? stubs[request] : realLoad.call(this, request, ...rest);
};
const plugins = path.join(__dirname, '..', 'vault', '.obsidian', 'plugins');
const S = require(path.join(plugins, 'scriptorium', 'main.js'));
const cli = require(path.join(plugins, 'lagrange', 'main.js')).internals;
Module._load = realLoad;

const argv = process.argv.slice(2), opt = {}, words = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i]; else words.push(argv[i]);
}
const [command, a, b] = words;

async function main() {
  const check = await S.driveCheck(cli, opt.claude);
  if (command === 'check' || !check.ok) {
    console.log(check.ok ? `OK: ${check.exe} has the Google Drive connector.` : `${check.problem}\n${check.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`);
    process.exit(check.ok ? 0 : 1);
  }
  const settings = S.driveSettings({ drive: { folder: opt.folder, device: opt.device, model: opt.model } }, os.hostname());
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-drive-'));
  let said = '';
  const make = (dir, vault) => new S.DriveSync({
    fs, path, crypto, dir, work, vault, folder: settings.folder, device: settings.device,
    say: p => { const t = p.total ? `${p.stage}: ${p.done} of ${p.total}` : p.stage; if (t !== said) { said = t; console.log(`  [${new Date().toISOString().slice(11, 19)}] ${t}`); } },
    run: S.driveRunner({ cli, fs, path, exe: check.exe, model: settings.model, dirs: [dir], work, onLine: opt.log ? line => fs.appendFileSync(opt.log, `${line}\n`) : null }),
  });
  const report = s => {
    console.log(JSON.stringify(Object.assign({}, s, { skipped: s.skipped.length, cost: Math.round(s.cost * 1000) / 1000 }), null, 1));
    for (const f of s.failed) console.log(`FAILED ${f.path}: ${f.why}`);
    for (const f of s.skipped) console.log(`SKIPPED ${f.path}: ${f.why}`);
  };
  try {
    if (command === 'plan' || command === 'sync') {
      const dir = path.resolve(a), sync = make(dir, opt.name || S.driveLinked(fs, path, dir, settings.folder) || path.basename(dir));
      const info = await sync.prepare();
      const p = info.plan;
      console.log(`${settings.folder}/${sync.vault}: ${info.first ? 'no backup yet' : `seq ${info.remote.seq}, ${Object.keys(info.remote.files).length} files, from ${info.remote.device}`}${info.resumed ? ' (carrying on a stopped run)' : ''}`);
      console.log(`upload ${p.upload.length} (${info.upBytes} B), download ${p.download.length}, conflicts ${p.conflicts.length}, delete here ${p.deleteLocal.length}, delete in Drive ${p.deleteRemote.length}, same ${p.same}, skipped ${info.skipped.length}${info.nothing ? ': nothing to do' : ''}`);
      if (command === 'sync' && !info.nothing) report(await sync.sync());
      else console.log(`runs ${sync.runs}, cost ${sync.cost.toFixed(3)}`);
    } else if (command === 'list') {
      const lister = make(work, '');
      for (const v of await lister.vaults()) console.log(`${v.name}\t${v.files} files\t${v.bytes} B\t${v.updated}\t${v.device}\tseq ${v.manifest.seq}`);
      console.log(`runs ${lister.runs}, cost ${lister.cost.toFixed(3)}`);
    } else if (command === 'retrieve') {
      const dest = path.resolve(b);
      if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error(`${dest} is not empty`);
      const lister = make(work, '');
      const entry = (await lister.vaults()).find(v => v.name === a);
      if (!entry) throw new Error(`No vault named ${a} in ${settings.folder}`);
      fs.mkdirSync(dest, { recursive: true });
      report(await make(dest, entry.name).retrieve(entry));
      const plan = S.planVaultSetup(fs, path, S.setupPackage(fs, path, path.join(__dirname, '..', 'vault')), dest);
      S.applyVaultSetup(fs, path, dest, plan);
      console.log(`Set up as a Scriptorium vault: ${plan.changes.length} files.`);
    } else {
      throw new Error('usage: drive-sync-cli.js check | plan <vault> | sync <vault> | list | retrieve <name> <folder>');
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(`FAILED: ${e.message}`); process.exit(1); });
