// The first launch of a vault that has just been set up, in a real Obsidian: nothing may complain.
//
// Why this exists. Scriptorium 1.4.0 and 1.4.1 opened a new vault with its plugins on by sending Obsidian's command
// line interface "plugins:restrict off", which starts every plugin and reloads the vault ten milliseconds later. The
// Excalidraw plugin writes its settings while it starts, without waiting for the write; cut off by the reload, it
// left an empty data.json, and when the vault came back it said: "Excalidraw data.json was empty or unreadable. The
// last known good settings were restored automatically." The installers now mark the vault as trusted and reload it
// before any plugin has started (see TRUST_QUIETLY in each installer). This makes a vault by each route that can run
// here, opens it the way that route's user does, and fails if
//   - any notice mentions Excalidraw, or says that something is unreadable, corrupt or failed to load;
//   - any window opens other than Obsidian's own question about trusting the author (so: no "Welcome to Excalidraw",
//     no "Excalidraw settings file is corrupted");
//   - Excalidraw is not on at the end with its settings loaded, its welcome window still held back (previousRelease
//     is its own version) and its data.json a whole JSON object;
//   - a community plugin was started in a page that was then reloaded (the cause above; this is checked on every
//     run, whereas the notice itself needs the reload to fall inside a write, about one run in twenty here);
//   - a second launch shows any notice or window at all, or changes Excalidraw's data.json.
// Routes: the set-up script (Setup-Scriptorium-Vault.py) on an empty folder, opened with "Trust author and enable
// plugins", then run again on the open-and-closed vault (an update: nothing to change) and launched again; the
// plugin's "Set up another vault"; a vault whose writer already had Excalidraw with settings of their own and TikZJax
// turned off (the settings are kept byte for byte by the set-up and are in force afterwards; TikZJax stays off);
// Install-Scriptorium-Linux.sh run whole, which opens the vault itself through Obsidian's command line interface;
// and, with --exe, Scriptorium Setup under Mono (--install-only, then its own --auto-open-only).
//
//   node plugins-tests/first-launch.harness.mjs --obsidian /path/to/Obsidian/obsidian [--plugins-from <folder>]
//        [--exe dist/Scriptorium-Setup.exe] [--zip dist/Scriptorium.zip] [--work <folder>] [--only <text>] [--secs 30]
//
// It needs an X display (Xvfb will do), Node 22 or later, python3, bash and curl; MONO=<prefix> or mono on PATH for
// --exe. --obsidian is the program itself (with obsidian-cli next to it, as Obsidian 1.12 and later ship it), not an
// AppImage. --plugins-from holds <plugin id>/<main.js, manifest.json, styles.css> of the two pinned releases; without
// it they are downloaded from their GitHub releases into the work folder and checked against the pins. They are never
// copied into this repository (Excalidraw is AGPL-3.0). Nothing outside the work folder is written: Obsidian runs
// with its own profile there, and the Linux installer with that folder as its home. OBSIDIAN_FLAGS (default
// "--no-sandbox --disable-gpu") are passed to Obsidian. Exit code 0 if every check passed.
//
// Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const opt = {};
for (let a = process.argv.slice(2), i = 0; i < a.length; i++) if (a[i].startsWith('--')) opt[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
if (!opt.obsidian || !process.env.DISPLAY) { console.error('usage: DISPLAY=:n node plugins-tests/first-launch.harness.mjs --obsidian <program> [--plugins-from <folder>] [--exe <Scriptorium-Setup.exe>] [--zip <Scriptorium.zip>] [--work <folder>] [--only <text>] [--secs 30]'); process.exit(2); }
const OBSIDIAN = path.resolve(opt.obsidian), CLI = path.join(path.dirname(OBSIDIAN), 'obsidian-cli');
const WORK = path.resolve(opt.work || fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-first-launch-')));
const SECS = Number(opt.secs || 30), FLAGS = (process.env.OBSIDIAN_FLAGS ?? '--no-sandbox --disable-gpu').split(/\s+/).filter(Boolean);
const PINS = JSON.parse(fs.readFileSync(path.join(ROOT, 'installers', 'diagram-plugins.json'), 'utf8')).plugins;
const EXCALIDRAW = PINS.find(p => p.id === 'obsidian-excalidraw-plugin'), TIKZJAX = PINS.find(p => p.id === 'obsidian-tikzjax');
const BAD = /excalidraw|unreadable|corrupt|failed to (load|read)|could not be (read|loaded)|data\.json/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const results = [];
const check = (route, ok, what, why) => { results.push({ route, ok: !!ok, what, why }); console.log(`${ok ? 'ok    ' : 'FAILED'} ${route}: ${what}${!ok && why ? ` (${String(why).slice(0, 600)})` : ''}`); };
const run = (cmd, args, o = {}) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 600000, ...o }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
// (the same without stopping this program meanwhile: what it runs is served by this program's own web server)
const runServed = (cmd, args, o = {}) => new Promise(res => { const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...o }); let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
  c.on('error', e => res({ code: -1, out: String(e) })); c.on('close', code => res({ code, out })); });
const dataFile = vault => path.join(vault, '.obsidian', 'plugins', EXCALIDRAW.id, 'data.json');
const readData = vault => { try { return fs.readFileSync(dataFile(vault)); } catch (e) { return null; } };

// ---- the two pinned plugins, checked against the pins ----
async function pinnedPlugins() {
  const dir = opt['plugins-from'] ? path.resolve(opt['plugins-from']) : path.join(WORK, 'pinned-plugins');
  for (const p of PINS) for (const [name, digest] of Object.entries(p.files)) {
    const file = path.join(dir, p.id, name);
    if (!fs.existsSync(file)) {
      if (opt['plugins-from']) throw new Error(`${file} is missing`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const r = await fetch(`https://github.com/${p.repository}/releases/download/${p.version}/${name}`);
      if (!r.ok) throw new Error(`${p.name} ${name} could not be downloaded (${r.status})`);
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    }
    if (sha256(fs.readFileSync(file)) !== digest) throw new Error(`${file} is not the pinned ${p.name} ${p.version}`);
  }
  return dir;
}

// ---- one Obsidian, watched ----
// In every page, before anything else runs: each notice and each window is reported as it appears, and so is each
// community plugin as Obsidian starts it (app.plugins.enablePlugin, which both a start and "plugins:restrict off" call).
const IN_PAGE = `(()=>{ if (window.__firstLaunch) return; window.__firstLaunch = 1; const seen = new WeakSet();
  const look = () => {
    document.querySelectorAll('.notice').forEach(n => { if (seen.has(n)) return; seen.add(n); console.log('__NOTICE__ ' + n.textContent); });
    document.querySelectorAll('.modal-container').forEach(n => { if (seen.has(n)) return; seen.add(n); setTimeout(() => console.log('__MODAL__ ' + n.textContent.slice(0, 1200)), 300); }); };
  new MutationObserver(look).observe(document, { childList: true, subtree: true }); look();
  const timer = setInterval(() => { const p = window.app && window.app.plugins; if (!p || typeof p.enablePlugin !== 'function') return; clearInterval(timer);
    const start = p.enablePlugin; p.enablePlugin = function (id) { console.log('__START__ ' + id); return start.apply(this, arguments); }; }, 2); })()`;

class Session {
  // Starts Obsidian with its own profile (profile given) or waits for one that something else starts on this port.
  constructor({ vault, port, profile, env }) {
    Object.assign(this, { vault, port, pages: new Map(), events: [], page: 0, t0: Date.now(), child: null, stopped: false });
    if (profile) {
      for (const f of fs.readdirSync(profile)) if (/^obsidian-.*\.asar$/.test(f)) fs.rmSync(path.join(profile, f));   // an update Obsidian fetched: the test stays on one version
      this.child = spawn(OBSIDIAN, [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, '--window-size=1440,1000', ...FLAGS],
        { stdio: 'ignore', detached: true, env: { ...process.env, ...(env || {}) } });
    }
    this.loop = this.watch();
  }
  add(kind, text) { this.events.push({ t: (Date.now() - this.t0) / 1000, page: this.page, kind, text }); }
  async attach(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl), pending = new Map(); let seq = 0;
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
    const main = target.url.includes('index.html');
    ws.onmessage = e => { const m = JSON.parse(e.data), p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); return; }
      if (m.method === 'Runtime.consoleAPICalled') { const text = m.params.args.map(x => x.value !== undefined ? String(x.value) : x.description).join(' ');
        for (const kind of ['NOTICE', 'MODAL', 'START']) if (text.startsWith(`__${kind}__ `)) return this.add(kind.toLowerCase(), text.slice(kind.length + 5));
        if (m.params.type === 'error') this.add('error', text.slice(0, 300)); }
      else if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId && main) { this.page++; this.add('reload', ''); } };
    ws.onclose = () => this.pages.delete(target.id);
    await call('Runtime.enable'); await call('Page.enable');
    await call('Page.addScriptToEvaluateOnNewDocument', { source: IN_PAGE });
    await call('Runtime.evaluate', { expression: IN_PAGE });
    return { call, main, ws };
  }
  async watch() {
    while (!this.stopped) {
      try {
        for (const t of await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json())
          if (t.type === 'page' && !this.pages.has(t.id)) { this.pages.set(t.id, null); try { this.pages.set(t.id, await this.attach(t)); } catch (e) { this.pages.delete(t.id); } }
      } catch (e) { /* not up yet */ }
      await sleep(100);
    }
  }
  async eval(expression) {
    for (const p of this.pages.values()) if (p && p.main) { try { const r = await p.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.result ? r.result.value : undefined; } catch (e) { return undefined; } }
    return undefined;
  }
  async until(expression, seconds) { for (const end = Date.now() + seconds * 1000; Date.now() < end; await sleep(200)) if (await this.eval(expression)) return true; return false; }
  // Clicks "Trust author and enable plugins" as soon as Obsidian asks (in any of its windows).
  async trust(seconds) {
    const click = `(()=>{const b=[...document.querySelectorAll('.modal-container button')].find(b=>/Trust author/.test(b.textContent)); if(b){b.click(); return 1} return 0})()`;
    for (const end = Date.now() + seconds * 1000; Date.now() < end; await sleep(200))
      for (const p of this.pages.values()) if (p) { try { const r = await p.call('Runtime.evaluate', { expression: click, returnByValue: true }); if (r.result && r.result.value === 1) return true; } catch (e) { /* that page went away */ } }
    return false;
  }
  state() {
    return this.eval(`(()=>{ try { const P = app.plugins, x = P.plugins[${JSON.stringify(EXCALIDRAW.id)}]; return JSON.stringify({ trusted: P.isEnabled(), on: [...P.enabledPlugins], loaded: Object.keys(P.plugins),
      excalidraw: x ? { version: x.manifest.version, settings: x.settings ? Object.keys(x.settings).length : 0, previousRelease: x.settings && x.settings.previousRelease, folder: x.settings && x.settings.folder,
        showReleaseNotes: x.settings && x.settings.showReleaseNotes, blocked: !!(x.settingsManager && x.settingsManager.persistenceBlockedByInvalidData) } : null }); } catch (e) { return JSON.stringify({ error: String(e) }); } })()`)
      .then(s => { try { return JSON.parse(s); } catch (e) { return { error: 'Obsidian did not answer' }; } });
  }
  async stop() {
    await Promise.race([this.eval(`require('@electron/remote').app.quit()`), sleep(3000)]);
    this.stopped = true; await this.loop;
    for (const p of this.pages.values()) if (p) try { p.ws.close(); } catch (e) { /* closed */ }
    await sleep(3000);
    if (this.child) try { process.kill(-this.child.pid, 'SIGTERM'); } catch (e) { /* gone */ }
    else run('pkill', ['-u', String(process.getuid()), '-f', `remote-debugging-port=${this.port}`]);
    await sleep(1500);
  }
  of(kind) { return this.events.filter(e => e.kind === kind); }
}

// What every first launch must look like. viaCli: the vault was opened by an installer through Obsidian's command
// line interface (no question is asked, and no plugin may have been started before the reload).
async function verdict(route, s, { viaCli, expect = {} }) {
  const state = await s.state(), notices = s.of('notice').map(e => e.text), modals = s.of('modal').map(e => e.text);
  const others = modals.filter(m => !/Trust author/.test(m));
  check(route, !notices.some(n => BAD.test(n)), 'no notice mentions Excalidraw, or says that something is unreadable, corrupt or failed to load', JSON.stringify(notices));
  check(route, !others.length && (!viaCli || modals.length <= 1), viaCli ? 'no window opens, but for Obsidian\'s question before it is answered for the writer' : 'no window opens but Obsidian\'s question about trusting the author', JSON.stringify(modals));
  check(route, !s.of('error').some(e => /failed to read JSON/.test(e.text)), 'Obsidian reads every settings file', JSON.stringify(s.of('error').filter(e => /failed to read JSON/.test(e.text))));
  const x = state.excalidraw || {};
  check(route, state.trusted === true && (state.loaded || []).includes(EXCALIDRAW.id) && x.version === EXCALIDRAW.version && x.settings > 50 && !x.blocked, `the vault is trusted and Excalidraw ${EXCALIDRAW.version} is on, with its settings loaded`, JSON.stringify(state));
  check(route, x.previousRelease === (expect.previousRelease || EXCALIDRAW.version) || expect.showReleaseNotes === false, 'Excalidraw\'s welcome window stays held back (previousRelease is its own version)', JSON.stringify(x));
  let onDisk = null; try { onDisk = JSON.parse(readData(s.vault).toString('utf8')); } catch (e) { /* not JSON */ }
  check(route, onDisk && typeof onDisk === 'object' && Object.keys(onDisk).length > 50, 'Excalidraw\'s data.json is a whole JSON object at the end', readData(s.vault) ? `${readData(s.vault).length} bytes` : 'missing');
  if (viaCli) {
    const early = s.of('start').filter(e => e.page < s.page);
    check(route, s.page >= 1 && !early.length, 'the vault is reloaded before any plugin has started: none is cut off in the middle of writing its settings', `${s.page} reload(s); started before the last: ${early.map(e => e.text).join(', ')}`);
  }
  return state;
}

async function secondLaunch(route, vault, profile) {
  const before = readData(vault), s = new Session({ vault, port: await freePort(), profile });
  const up = await s.until(`typeof app !== 'undefined' && !!app.plugins.plugins[${JSON.stringify(EXCALIDRAW.id)}]`, 60);
  await sleep(Math.max(8, SECS / 2) * 1000);
  const state = await s.state();
  check(route, up && state.excalidraw && state.excalidraw.settings > 50, 'a second launch: Excalidraw is on', JSON.stringify(state));
  check(route, !s.of('notice').length && !s.of('modal').length, 'a second launch: no notice and no window at all', JSON.stringify(s.of('notice').concat(s.of('modal')).map(e => e.text)));
  await s.stop();
  check(route, before && readData(vault) && before.equals(readData(vault)), 'a second launch: Excalidraw\'s data.json is not written again');
}

const newProfile = (dir, vault) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'obsidian.json'), JSON.stringify({ vaults: { [crypto.randomBytes(8).toString('hex')]: { path: vault, ts: Date.now(), open: true } } })); return dir; };

// Opens the vault as its writer does after a set-up that does not open it: Obsidian asks, the writer trusts.
async function openWithTrust(route, vault, profile, expect) {
  const s = new Session({ vault, port: await freePort(), profile: newProfile(profile, vault) });
  check(route, await s.trust(90), 'Obsidian asks whether to trust the author, and is told yes');
  await s.until(`typeof app !== 'undefined' && !!app.plugins.plugins[${JSON.stringify(EXCALIDRAW.id)}]`, 60);
  await sleep(SECS * 1000);
  const state = await verdict(route, s, { viaCli: false, expect });
  await s.stop();
  return state;
}

// ---- the routes ----
const setupScript = (vault, plugins) => run('python3', [path.join(ROOT, 'installers', 'Setup-Scriptorium-Vault.py'), vault, '--yes', '--package', path.join(ROOT, 'vault'), '--plugins-from', plugins]);

async function routeScript(plugins) {
  const route = 'Setup-Scriptorium-Vault.py', dir = path.join(WORK, 'script'), vault = path.join(dir, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const r = setupScript(vault, plugins);
  check(route, r.code === 0 && readData(vault), 'an empty folder is set up, with Excalidraw and its first settings', r.out.slice(-300));
  await openWithTrust(route, vault, path.join(dir, 'profile'));
  const before = readData(vault), again = setupScript(vault, plugins);
  check(route, again.code === 0 && before.equals(readData(vault)), 'run again on the vault (an update): Excalidraw\'s settings are not touched', again.out.slice(-300));
  await secondLaunch(route, vault, path.join(dir, 'profile'));
}

async function routePlugin(plugins) {
  const route = 'the plugin\'s "Set up another vault"', dir = path.join(WORK, 'plugin'), vault = path.join(dir, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  const r = run(process.execPath, [path.join(ROOT, 'plugins-tests', 'setup-vault-cli.js'), '--yes', vault]);
  // (the command's second half, as the plugin runs it after the files are in place, with the releases read from disk)
  const require = createRequire(import.meta.url), Module = require('node:module'), load = Module._load;
  Module._load = function (request, ...rest) { if (request === 'obsidian') { class Stub {} return { Plugin: Stub, PluginSettingTab: Stub, Setting: Stub, MarkdownView: Stub, MarkdownRenderer: Stub, Component: Stub, Scope: Stub, Modal: Stub, Notice: Stub, Platform: {} }; } return load.call(this, request, ...rest); };
  const S = require(path.join(ROOT, 'vault', '.obsidian', 'plugins', 'scriptorium', 'main.js'));
  Module._load = load;
  const done = await S.installDiagramPlugins(fs, path, crypto, vault, async url => { const p = S.DIAGRAM_PLUGINS.find(q => url.startsWith(q.base)); return fs.readFileSync(path.join(plugins, p.id, url.slice(p.base.length))); });
  check(route, r.code === 0 && done[EXCALIDRAW.id] === 'installed' && readData(vault), 'an empty folder is set up, with Excalidraw and its first settings', r.out.slice(-300) + JSON.stringify(done));
  await openWithTrust(route, vault, path.join(dir, 'profile'));
}

async function routeExisting(plugins) {
  const route = 'a vault that already had Excalidraw', dir = path.join(WORK, 'existing'), vault = path.join(dir, 'vault'), folder = path.join(vault, '.obsidian', 'plugins');
  for (const p of PINS) fs.cpSync(path.join(plugins, p.id), path.join(folder, p.id), { recursive: true });
  const theirs = Buffer.from('{\n\t"folder": "My drawings",\n\t"showReleaseNotes": false,\n\t"previousRelease": "2.20.0"\n}');   // (their own formatting, too)
  fs.writeFileSync(dataFile(vault), theirs);
  fs.writeFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify([EXCALIDRAW.id]));   // TikZJax is there, and off
  const r = setupScript(vault, plugins);
  let on = []; try { on = JSON.parse(fs.readFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), 'utf8')); } catch (e) { /* reported below */ }
  check(route, r.code === 0 && theirs.equals(readData(vault)), 'the set-up leaves the writer\'s Excalidraw settings byte for byte', r.out.slice(-300));
  check(route, on.includes(EXCALIDRAW.id) && !on.includes(TIKZJAX.id) && on.includes('scriptorium'), 'the set-up leaves TikZJax, which the writer had turned off, off', JSON.stringify(on));
  const state = await openWithTrust(route, vault, path.join(dir, 'profile'), { showReleaseNotes: false });
  const x = state.excalidraw || {};
  let kept = {}; try { kept = JSON.parse(readData(vault).toString('utf8')); } catch (e) { /* reported above */ }
  check(route, x.folder === 'My drawings' && x.showReleaseNotes === false && kept.folder === 'My drawings' && kept.showReleaseNotes === false, 'the writer\'s settings are in force after the first launch, and still in the file', JSON.stringify(x));
  check(route, !(state.loaded || []).includes(TIKZJAX.id), 'TikZJax is still off after the first launch', JSON.stringify(state.loaded));
}

// A folder with "obsidian" (this Obsidian, with a debugging port) and its "obsidian-cli": what an installer finds.
function programs(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'obsidian'), `#!/bin/bash\nexec ${JSON.stringify(OBSIDIAN)} ${FLAGS.join(' ')} --remote-debugging-address=127.0.0.1 --remote-debugging-port="$OBSIDIAN_DEBUG_PORT" --window-size=1440,1000 "$@"\n`, { mode: 0o755 });
  fs.rmSync(path.join(dir, 'obsidian-cli'), { force: true });
  fs.symlinkSync(CLI, path.join(dir, 'obsidian-cli'));
  return dir;
}

async function opened(route, vault, port, command, args, env, input) {
  const s = new Session({ vault, port });
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  child.stdin.end(input || '');
  const code = await Promise.race([new Promise(res => child.on('exit', res)), sleep(600000).then(() => { child.kill(); return 'it did not end in ten minutes'; })]);   // (not 'close': the Obsidian it starts may keep its output open)
  await sleep(500);
  await sleep(SECS * 1000);
  return { s, code, out };
}

async function routeLinux(plugins, served) {
  const route = 'Install-Scriptorium-Linux.sh', dir = path.join(WORK, 'linux'), home = path.join(dir, 'home'), vault = path.join(home, 'Documents', 'Scriptorium');
  fs.mkdirSync(home, { recursive: true });
  let zip = opt.zip ? path.resolve(opt.zip) : path.join(dir, 'Scriptorium.zip');
  if (!opt.zip) { const b = run('python3', [path.join(ROOT, 'tools', 'build_zip.py'), zip]); if (b.code !== 0) return check(route, false, 'Scriptorium.zip is built from vault/', b.out.slice(-300)); }
  fs.copyFileSync(zip, path.join(served.dir, 'Scriptorium.zip'));
  // The script as it stands, except that it must take this build's zip: if its pin is another zip's (the released
  // one, between releases), the pin is replaced, and the run says so.
  let text = fs.readFileSync(path.join(ROOT, 'installers', 'Install-Scriptorium-Linux.sh'), 'utf8');
  const digest = sha256(fs.readFileSync(zip)), pin = /verify_hash "\$work_dir\/Writing\.zip" '([0-9a-f]{64})'/.exec(text);
  if (pin && pin[1] !== digest) { text = text.replace(pin[1], digest); console.log(`      ${route}: its zip pin (${pin[1].slice(0, 8)}…) is not this build's (${digest.slice(0, 8)}…): replaced for this run`); }
  fs.writeFileSync(path.join(dir, 'install.sh'), text);
  // curl, standing in for the network: the zip and the two pinned releases come from this computer; nothing else does
  // (the fonts are then reported as not installed, which is not what is looked at here).
  const bin = programs(path.join(dir, 'bin')), real = run('bash', ['-c', 'command -v curl']).out.trim();
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash\nargs=()\nwhile [ $# -gt 0 ]; do\n  a="$1"; shift\n  case "$a" in\n    --proto) shift; continue ;;\n    --tlsv1.2) continue ;;\n    https://williamliaw.com/assets/downloads/Scriptorium.zip*) a="${served.base}/Scriptorium.zip" ;;\n` +
    PINS.map(p => `    https://github.com/${p.repository}/releases/download/${p.version}/*) a="${served.base}/${p.id}/\${a##*/}" ;;\n`).join('') + `    https://*) exit 22 ;;\n  esac\n  args+=("$a")\ndone\nexec ${JSON.stringify(real)} "\${args[@]}"\n`, { mode: 0o755 });
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-')), port = await freePort();
  const env = { ...process.env, HOME: home, XDG_RUNTIME_DIR: runtime, PATH: `${bin}:${process.env.PATH}`, OBSIDIAN_DEBUG_PORT: String(port) };
  delete env.XDG_CONFIG_HOME; delete env.XDG_DATA_HOME;
  const { s, code, out } = await opened(route, vault, port, 'bash', [path.join(dir, 'install.sh')], env, `${vault}\n\n`);
  check(route, code === 0 && /Opened it in Obsidian with its community plugins on/.test(out), 'the installer makes the vault and opens it in Obsidian with its plugins on', out.slice(-500));
  await verdict(route, s, { viaCli: true });
  let conf = {}; try { conf = JSON.parse(fs.readFileSync(path.join(home, '.config', 'obsidian', 'obsidian.json'), 'utf8')); } catch (e) { /* reported */ }
  check(route, !conf.cli, 'Obsidian\'s command line interface is off again', JSON.stringify(conf).slice(0, 200));
  await s.stop();
  fs.rmSync(runtime, { recursive: true, force: true });
  await secondLaunch(route, vault, path.join(home, '.config', 'obsidian'));
}

async function routeExe(plugins, served) {
  const route = 'Scriptorium-Setup.exe (Mono)', dir = path.join(WORK, 'exe'), vault = path.join(dir, 'vault'), exe = path.resolve(opt.exe);
  const mono = process.env.MONO ? path.join(process.env.MONO, 'bin', 'mono') : 'mono';
  fs.mkdirSync(dir, { recursive: true });
  const pins = path.join(dir, 'pins.txt');
  fs.writeFileSync(pins, PINS.flatMap(p => Object.entries(p.files).map(([n, d]) => `${p.id}|${p.name}|${p.version}|${n}|${d}|${served.base}/${p.id}/${n}`)).join('\n') + '\n');
  const made = await runServed(mono, [exe, '--plugin-pins', pins, '--install-only', vault], { env: { ...process.env, SCRIPTORIUM_NO_FONTS: '1' } });
  check(route, made.code === 0 && readData(vault), 'Setup makes a new vault, with Excalidraw and its first settings', made.out.slice(-300));
  const bin = programs(path.join(dir, 'bin')), runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-')), port = await freePort();
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_RUNTIME_DIR: runtime, OBSIDIAN_DEBUG_PORT: String(port) };
  const { s, code, out } = await opened(route, vault, port, mono, [exe, '--auto-open-only', vault, path.join(bin, 'obsidian')], env);
  check(route, code === 0 && /^Trusted/m.test(out), 'Setup opens the vault in Obsidian with its plugins on', out.slice(-700));
  await verdict(route, s, { viaCli: true });
  await s.stop();
  fs.rmSync(runtime, { recursive: true, force: true });
  await secondLaunch(route, vault, path.join(dir, 'config', 'obsidian'));
}

// ---- run ----
const plugins = await pinnedPlugins();
const servedDir = path.join(WORK, 'served');
fs.mkdirSync(servedDir, { recursive: true });
for (const p of PINS) fs.cpSync(path.join(plugins, p.id), path.join(servedDir, p.id), { recursive: true });
const server = http.createServer((req, res) => { const f = path.join(servedDir, path.normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200, { 'Content-Length': b.length }); res.end(b); } }); });
await new Promise(res => server.listen(0, '127.0.0.1', res));
const served = { dir: servedDir, base: `http://127.0.0.1:${server.address().port}` };
const routes = [['script', routeScript], ['plugin', routePlugin], ['existing', routeExisting], ['linux', routeLinux]];
if (opt.exe) routes.push(['exe', routeExe]); else console.log('      Scriptorium-Setup.exe was not given (--exe): that route is not run');
for (const [name, route] of routes) {
  if (typeof opt.only === 'string' && !name.includes(opt.only)) continue;
  try { await route(plugins, served); } catch (e) { check(name, false, 'the route runs to its end', e && e.stack || e); }
}
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed${failed.length ? `; FAILED:\n${failed.map(f => `  ${f.route}: ${f.what}`).join('\n')}` : '.'}`);
console.log(`(work folder: ${WORK})`);
process.exit(failed.length ? 1 : 0);
