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
  if (rest[0] === 'size') { process.stdout.write('{"count":3,"bytes":1234,"sizeless":0}\n'); process.exit(0); }
  log('critical', `Fatal error: unknown command "${rest[0]}" for "rclone"`);
  process.exit(2);
}
