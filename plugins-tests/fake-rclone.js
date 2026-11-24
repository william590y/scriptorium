#!/usr/bin/env node
// A pretend rclone for plugins-tests/rclone-sync.test.js: it answers the few commands Scriptorium gives rclone, in
// rclone's own formats (the JSON log on stderr, JSON on stdout), from what the test put in the environment. It never
// touches the network. The sign-in's four notices, "empty token found", "didn't find section", "address already in
// use" and "directory not found" were copied from runs of the real rclone 1.76.0; the lines for a sign-in that Google
// refuses (access_denied, deleted_client) are written from rclone's and Google's documentation, not observed.
//
// FAKE_RCLONE_ECHO=1          print the arguments and the RCLONE_* environment as JSON, and stop
// FAKE_RCLONE_VERSION=1.60.2  the version to claim (default 1.76.0); "none" prints something that is not a version
// FAKE_RCLONE_TREE=file.json  {"": ["A", "B"], "A": ["Sub"]}: the folders of the pretend Drive
// FAKE_RCLONE_AUTH=ok|denied|deleted|busy|hang   how `config update … scope=drive` (the sign-in) ends
// FAKE_RCLONE_FAIL=file.json  {"code": 1, "lines": [{"level": "error", "msg": "…"}]}: fail any other command so
// FAKE_RCLONE_RECORD=file     append each call's arguments, one JSON array per line
// FAKE_RCLONE_QUERY=file.json what `backend query` prints (default: null, as rclone prints no match)
// FAKE_RCLONE_FILES=dir       a folder standing for the files of the pretend Drive ("scriptorium-drive:A/B" is dir/A/B):
//                             `lsjson … --files-from-raw list` lists those of the names that are files there, as rclone
//                             does (a name that is missing or a folder is left out), `copy … --files-from-raw list`
//                             copies them out with their times, and `copyto` puts a file in
// FAKE_RCLONE_CHECK=file      what `check --combined -` prints (it ends with 1 when a line is not "= …", as rclone does)
// FAKE_RCLONE_BISYNC=file.json [[{level, msg, object}, …], …]: the log of each `bisync`, in turn, taken off the file as it
//                             is used; without it (or once it is used up) a bisync says "Bisync successful" and nothing else
//
// Copyright (C) 2026 William Liaw. Licensed under the GNU General Public License, version 3 or later (see LICENSE).
'use strict';
const fs = require('fs');
const env = process.env, args = process.argv.slice(2);
const log = (level, msg, more) => process.stderr.write(JSON.stringify(Object.assign({ time: new Date().toISOString(), level, msg }, more)) + '\n');
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const conf = flag('--config');
// what is left when the global flags are taken away
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (['--config', '--color'].includes(args[i])) { i++; continue; }
  if (args[i] === '--use-json-log') continue;
  rest.push(args[i]);
}
if (env.FAKE_RCLONE_RECORD) fs.appendFileSync(env.FAKE_RCLONE_RECORD, JSON.stringify(rest) + '\n');
if (env.FAKE_RCLONE_ECHO) {
  process.stdout.write(JSON.stringify({ args, env: Object.keys(env).filter(k => /^RCLONE_/i.test(k)) }));
  process.exit(0);
}
const section = () => {
  const text = fs.existsSync(conf) ? fs.readFileSync(conf, 'utf8') : '';
  const m = /\[scriptorium-drive\]([^[]*)/.exec(text);
  return m ? m[1] : null;
};

if (rest[0] === 'version') {
  const v = env.FAKE_RCLONE_VERSION || '1.76.0';
  process.stdout.write(v === 'none' ? 'hello, I am another program\n' : `rclone v${v}\n- os/version: test\n- os/arch: amd64\n- go/version: go1.27.3\n`);
  process.exit(0);
}

if (rest[0] === 'config' && rest[1] === 'update') {
  const how = env.FAKE_RCLONE_AUTH || 'ok';
  if (section() === null) { log('critical', 'Failed to update remote: couldn\'t find type field in config'); process.exit(1); }
  if (how === 'busy') {
    log('notice', 'Fatal error: config failed to refresh token: failed to start auth webserver: listen tcp 127.0.0.1:53682: bind: address already in use');
    process.exit(1);
  }
  log('notice', 'Make sure your Redirect URL is set to "http://127.0.0.1:53682/" in your custom config.\n');
  log('notice', 'If your browser doesn\'t open automatically go to the following link: http://127.0.0.1:53682/auth?state=fAkEsTaTe0123456789abc\n');
  log('notice', 'Log in and authorize rclone for access\n');
  log('notice', 'Waiting for code...\n');
  const end = () => {
    if (how === 'ok') {
      log('notice', 'Got code\n');
      fs.appendFileSync(conf, 'token = {"access_token":"ya29.a0FAKEACCESSTOKENFAKEACCESSTOKEN","token_type":"Bearer","refresh_token":"1//0fFAKEREFRESHTOKENFAKEREFRESH","expiry":"2026-11-12T22:00:00Z"}\nteam_drive = \n');
      process.exit(0);
    }
    if (how === 'denied') { log('notice', 'Fatal error: config failed to refresh token: failed to get token: Error: Auth Error\nDescription: No code returned by remote server\nCode: access_denied'); process.exit(1); }
    if (how === 'deleted') { log('notice', 'Fatal error: config failed to refresh token: failed to get token: oauth2: "deleted_client" "The OAuth client was deleted."'); process.exit(1); }
  };
  if (how === 'hang') { process.on('SIGINT', () => process.exit(130)); setInterval(() => {}, 1000); } else setTimeout(end, 120);
} else if (rest[0] === 'config' && rest[1] === 'disconnect') {
  log('critical', 'Failed to disconnect: backend doesn\'t support Disconnect');
  process.exit(1);
} else if (rest[0] === 'config' && rest[1] === 'delete') {
  const text = fs.existsSync(conf) ? fs.readFileSync(conf, 'utf8') : '';
  fs.writeFileSync(conf, text.replace(/\[scriptorium-drive\][^[]*/, ''));
  process.exit(0);
} else {
  const sec = section();
  if (sec === null) { log('critical', 'Failed to create file system for "scriptorium-drive:": didn\'t find section in config file ("scriptorium-drive")'); process.exit(1); }
  if (/type = drive/.test(sec) && !/token = \{/.test(sec)) {
    log('critical', 'Failed to create file system for "scriptorium-drive:": drive: failed when making oauth client: failed to create oauth client: empty token found - please run "rclone config reconnect scriptorium-drive:"');
    process.exit(1);
  }
  if (env.FAKE_RCLONE_FAIL) {
    const f = JSON.parse(fs.readFileSync(env.FAKE_RCLONE_FAIL, 'utf8'));
    for (const l of f.lines || []) log(l.level || 'error', l.msg, l.object ? { object: l.object } : {});
    if (f.out) process.stdout.write(f.out);
    process.exit(f.code === undefined ? 1 : f.code);
  }
  const tree = env.FAKE_RCLONE_TREE ? JSON.parse(fs.readFileSync(env.FAKE_RCLONE_TREE, 'utf8')) : { '': [] };
  const where = a => String(a || '').replace(/^scriptorium-drive:/, '');
  const root = rest.includes('--drive-shared-with-me') ? 'shared:' : rest.includes('--drive-team-drive') ? `drive:${rest[rest.indexOf('--drive-team-drive') + 1]}:` : '';
  const files = env.FAKE_RCLONE_FILES, path = require('path');
  const named = () => fs.readFileSync(flag('--files-from-raw'), 'utf8').split('\n').filter(Boolean);
  const inDrive = a => path.join(files, ...where(a).split('/').filter(Boolean));
  if (rest[0] === 'lsjson' && rest.includes('--files-from-raw')) {
    const out = [];
    for (const rel of named()) {
      let st = null;
      try { st = fs.statSync(path.join(inDrive(rest[1]), ...rel.split('/'))); } catch (e) { /* not there: left out */ }
      if (st && st.isFile()) out.push({ Path: rel, Name: rel.split('/').pop(), Size: st.size, ModTime: new Date(st.mtimeMs).toISOString(), IsDir: false });
    }
    process.stdout.write('[\n' + out.map(x => JSON.stringify(x)).join(',\n') + '\n]\n');
    process.exit(0);
  }
  if (rest[0] === 'copy' && rest.includes('--files-from-raw')) {
    for (const rel of named()) {
      const from = path.join(inDrive(rest[1]), ...rel.split('/')), to = path.join(rest[2], ...rel.split('/'));
      if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      const st = fs.statSync(from);
      fs.utimesSync(to, st.atime, st.mtime);
      log('info', 'Copied (new)', { object: rel });
    }
    process.exit(0);
  }
  if (rest[0] === 'copyto') {
    if (files) { const to = inDrive(rest[2]); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(rest[1], to); }
    process.exit(0);
  }
  if (rest[0] === 'check') {
    const text = env.FAKE_RCLONE_CHECK ? fs.readFileSync(env.FAKE_RCLONE_CHECK, 'utf8') : '';
    process.stdout.write(text);
    process.exit(text.split('\n').some(l => l && !l.startsWith('= ')) ? 1 : 0);
  }
  if (rest[0] === 'bisync') {
    let runs = [];
    if (env.FAKE_RCLONE_BISYNC) runs = JSON.parse(fs.readFileSync(env.FAKE_RCLONE_BISYNC, 'utf8'));
    const lines = runs.length ? runs.shift() : [{ level: 'info', msg: 'Bisync successful' }];
    if (env.FAKE_RCLONE_BISYNC) fs.writeFileSync(env.FAKE_RCLONE_BISYNC, JSON.stringify(runs));
    for (const l of lines) log(l.level || 'info', l.msg, l.object ? { object: l.object } : {});
    process.exit(0);
  }
  if (rest[0] === 'lsjson') {
    const dirs = tree[root + where(rest[1])];
    if (!dirs) { log('error', 'error listing: directory not found'); log('notice', 'Failed to lsjson with 2 errors: last error was: error in ListJSON: directory not found'); process.exit(3); }
    process.stdout.write('[\n' + dirs.map(n => JSON.stringify({ Path: n, Name: n, Size: -1, MimeType: '', ModTime: '', IsDir: true, ID: `id-${n}` })).join(',\n') + '\n]\n');
    process.exit(0);
  }
  if (rest[0] === 'mkdir') {
    const p = root + where(rest[1]), up = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : root, name = p.slice(p.lastIndexOf('/') + 1).replace(root, '');
    tree[up] = (tree[up] || []).concat([name]); tree[p] = [];
    fs.writeFileSync(env.FAKE_RCLONE_TREE, JSON.stringify(tree));
    process.exit(0);
  }
  if (rest[0] === 'backend' && rest[1] === 'drives') { process.stdout.write(JSON.stringify(tree.drives || [])); process.exit(0); }
  // FAKE_RCLONE_QUERY=file.json: what `backend query` answers (Drive's files, or null for none, as rclone prints it)
  if (rest[0] === 'backend' && rest[1] === 'query') { process.stdout.write(env.FAKE_RCLONE_QUERY ? fs.readFileSync(env.FAKE_RCLONE_QUERY, 'utf8') : 'null\n'); process.exit(0); }
  if (rest[0] === 'size') { process.stdout.write('{"count":3,"bytes":1234,"sizeless":0}\n'); process.exit(0); }
  log('critical', `Fatal error: unknown command "${rest[0]}" for "rclone"`);
  process.exit(2);
}
