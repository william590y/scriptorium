// Tests for the Scriptorium plugin's Google Drive backup (vault/.obsidian/plugins/scriptorium/main.js, "Backing up to
// Google Drive"): which files are backed up, the three-way plan, conflict names, batches, reading Claude Code's event
// stream, and whole backups, syncs and retrievals against a pretend Google Drive (no network, no Claude Code).
// Run: node --test plugins-tests/drive-sync.test.js
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
const FOLDER = 'application/vnd.google-apps.folder';

/* ---------- a pretend Google Drive, answering the calls the backup makes ---------- */

function pretendDrive() {
  const d = { files: new Map(), calls: [], runs: 0, n: 0, clock: Date.UTC(2026, 10, 12), before: null, corrupt: new Set(), blobs: false };
  const add = f => { f.id = `id${++d.n}`; f.createdTime = new Date(d.clock += 1000).toISOString(); f.trashed = false; d.files.set(f.id, f); return f; };
  const meta = f => ({ id: f.id, title: f.title, parentId: f.parentId, mimeType: f.mimeType, createdTime: f.createdTime, trashed: f.trashed, fileSize: f.bytes ? String(f.bytes.length) : undefined });
  const one = call => {
    const a = call.input;
    if (d.before) { const refuse = d.before(call); if (refuse) return { ok: false, error: refuse }; }
    if (call.tool === 'search_files') {
      const want = {};
      for (const m of a.query.matchAll(/(title|parentId|mimeType) = '((?:[^'\\]|\\.)*)'/g)) want[m[1]] = m[2].replace(/\\(.)/g, '$1');
      return { ok: true, data: { files: [...d.files.values()].filter(f => !f.trashed && Object.keys(want).every(k => f[k] === want[k])).map(meta) } };
    }
    if (call.tool === 'create_file') {
      if (a.contentMimeType === FOLDER) return { ok: true, data: meta(add({ title: a.title, parentId: a.parentId, mimeType: FOLDER })) };
      const m = /^sha256:([0-9a-f]{64}):(.+)$/.exec(a.base64Content || '');
      if (!m) return { ok: false, error: 'the pretend Drive takes file references only' };
      let bytes;
      try { bytes = fs.readFileSync(m[2]); } catch (e) { return { ok: false, error: `Nothing was uploaded: ${m[2]} does not exist` }; }
      if (sha(bytes) !== m[1]) return { ok: false, error: 'does not match the SHA-256 in the reference, so nothing was uploaded' };
      if (!bytes.length) return { ok: false, error: 'is empty, so nothing was uploaded' };
      assert.equal(a.disableConversionToGoogleType, true);
      return { ok: true, data: meta(add({ title: a.title, parentId: a.parentId, mimeType: a.contentMimeType, bytes })) };
    }
    const f = d.files.get(a.fileId);
    if (!f) return { ok: false, error: 'File not found (404)' };
    if (call.tool === 'get_file_metadata') return { ok: true, data: meta(f) };
    if (call.tool === 'trash_file') { f.trashed = true; return { ok: true, data: {} }; }
    if (call.tool === 'update_file') { if (a.parentId) f.parentId = a.parentId; return { ok: true, data: meta(f) }; }
    if (call.tool === 'download_file_content') {
      const bytes = d.corrupt.has(f.id) ? Buffer.concat([f.bytes, Buffer.from('!')]) : f.bytes;
      // The real connector answers in two shapes; d.blobs chooses the one with the bytes apart.
      return { ok: true, data: d.blobs ? { id: f.id, title: f.title, mimeType: f.mimeType, content: '(file sent separately)', bytes } : { id: f.id, title: f.title, mimeType: f.mimeType, content: bytes.toString('base64') } };
    }
    return { ok: false, error: `unknown tool ${call.tool}` };
  };
  d.run = async (calls, hooks) => {
    d.runs++;
    if (hooks && hooks.signal && hooks.signal.aborted) { const e = new Error('Stopped.'); e.name = 'AbortError'; throw e; }
    if (d.crash && d.crash(d.runs, calls)) throw new Error('Claude Code stopped with an error: pretend crash');
    const results = calls.map(c => { d.calls.push(c); return one(c); });
    return { results, extra: [], cost: 0.004 };
  };
  // The path of a file in the pretend Drive, e.g. "Scriptorium/My Vault/Notes/a.md".
  d.pathOf = f => { const parts = []; for (let x = f; x; x = d.files.get(x.parentId)) parts.unshift(x.title); return parts.join('/'); };
  d.tree = () => Object.fromEntries([...d.files.values()].filter(f => !f.trashed && f.mimeType !== FOLDER).map(f => [d.pathOf(f), f]));
  d.count = tool => d.calls.filter(c => c.tool === tool && (tool !== 'create_file' || c.input.contentMimeType !== FOLDER)).length;
  return d;
}

function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `scriptorium-drive-test-${name || ''}`));
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

function device(t, drive, dir, name, more) {
  const work = tmp(t, 'work-');
  return () => new S.DriveSync(Object.assign({ fs, path, crypto, dir, work, vault: 'My Vault', folder: 'Scriptorium', device: name, run: drive.run, now: () => new Date(2026, 10, 12, 15, 0, 0) }, more));
}

function sampleVault(dir) {
  write(dir, 'Welcome.md', '# Welcome\n');
  write(dir, 'Notes/One.md', 'one\n');
  write(dir, 'Notes/Deep/Two.md', 'two\n');
  write(dir, 'Notes/It’s “quoted”.md', 'quoted\n');
  write(dir, 'Attachments/picture.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]));
  write(dir, 'Empty.md', '');
  write(dir, '.obsidian/app.json', '{"baseFontSize":22}\n');
  write(dir, '.obsidian/snippets/mine.css', 'body {}\n');
  write(dir, '.obsidian/plugins/scriptorium/data.json', '{"fancyMode":true}\n');
  // None of these may leave the computer.
  write(dir, '.obsidian/workspace.json', '{}');
  write(dir, '.obsidian/plugins/lagrange/data.json', '{"anthropicKey":"sk-secret"}');
  write(dir, '.obsidian/plugins/other-plugin/data.json', '{"token":"secret"}');
  write(dir, '.obsidian/plugins/scriptorium/main.js', '// code');
  write(dir, '.obsidian/snippets/manuscript.css', '/* Scriptorium */');
  write(dir, '.obsidian/scriptorium-backup-20261112-150000/.obsidian/app.json', '{}');
  write(dir, '.trash/old.md', 'old');
  write(dir, '.git/config', 'x');
}
const SAMPLE = ['.obsidian/app.json', '.obsidian/plugins/scriptorium/data.json', '.obsidian/snippets/mine.css', 'Attachments/picture.png', 'Empty.md',
  'Notes/Deep/Two.md', 'Notes/It’s “quoted”.md', 'Notes/One.md', 'Welcome.md'];

/* ---------- pure helpers ---------- */

test('drive: which files are backed up', () => {
  for (const rel of ['Note.md', 'Folder/Sub/Note.md', 'Attachments/a.png', 'Scriptorium/Drop caps/mine/A.svg', 'Board.canvas', '.obsidian/app.json',
    '.obsidian/appearance.json', '.obsidian/community-plugins.json', '.obsidian/hotkeys.json', '.obsidian/snippets/mine.css', '.obsidian/themes/Other/theme.css',
    '.obsidian/plugins/scriptorium/data.json', '.obsidian/plugins/manuscriptum/data.json', '.obsidian/plugins/longform/data.json']) assert.equal(S.driveRule(rel), true, rel);
  for (const rel of ['.obsidian/workspace.json', '.obsidian/workspace-mobile.json', '.obsidian/workspaces.json', '.obsidian/cache', '.obsidian/plugins/lagrange/data.json',
    '.obsidian/plugins/other/data.json', '.obsidian/plugins/other/main.js', '.obsidian/plugins/scriptorium/main.js', '.obsidian/plugins/scriptorium/drive-sync.json',
    '.obsidian/snippets/manuscript.css', '.obsidian/themes/Typewriter/theme.css', '.obsidian/scriptorium-backup-20261112-150000/.obsidian/app.json',
    '.trash/a.md', '.git/config', 'Folder/.hidden/a.md', '.DS_Store', 'Folder/Thumbs.db', 'node_modules/x/index.js', 'a.md.scriptorium-tmp', '../outside.md',
    'Folder/../../outside.md', '/etc/passwd', 'Folder\\a.md', 'a\nb.md', '']) assert.equal(S.driveRule(rel), false, JSON.stringify(rel));
  assert.equal(S.DRIVE_STATE, '.obsidian/plugins/scriptorium/drive-sync.json');
});

test('drive: the type a file is uploaded under never lets Google Drive call it an image', () => {
  assert.equal(S.driveMime('a.md'), 'text/markdown');
  assert.equal(S.driveMime('A.PDF'), 'application/pdf');
  for (const name of ['a.png', 'a.jpg', 'a.svg', 'a.webp', 'a.heic', 'a.bin', 'noextension', '.hidden', 'a.constructor']) assert.equal(S.driveMime(name), 'application/x-scriptorium-file', name);
});

test('drive: the plan, from here, there, and what both had last time', () => {
  const f = h => ({ sha256: h });
  const plan = S.drivePlan(
    { same: f('a'), mine: f('b2'), theirs: f('c'), both: f('d2'), bothSame: f('e2'), newHere: f('f'), goneThere: f('g'), keptHere: f('h2'), clash: f('k1') },
    { same: f('a'), mine: f('b'), theirs: f('c2'), both: f('d3'), bothSame: f('e2'), newThere: f('i'), goneHere: f('j'), keptThere: f('l2'), clash: f('k2') },
    { same: 'a', mine: 'b', theirs: 'c', both: 'd', bothSame: 'e', goneThere: 'g', goneHere: 'j', keptHere: 'h', keptThere: 'l', goneBoth: 'm' });
  assert.deepEqual(plan.upload, ['keptHere', 'mine', 'newHere']);          // changed here and deleted there: the change is kept
  assert.deepEqual(plan.download, ['keptThere', 'newThere', 'theirs']);    // deleted here and changed there: the change is kept
  assert.deepEqual(plan.conflicts, ['both', 'clash']);                     // changed on both sides, or new on both sides, differently
  assert.deepEqual(plan.deleteLocal, ['goneThere']);
  assert.deepEqual(plan.deleteRemote, ['goneHere']);
  assert.equal(plan.same, 2);                                              // same, and bothSame (the same change made twice)
  assert.deepEqual(S.drivePlan({}, {}, { gone: 'x' }), { upload: [], download: [], conflicts: [], deleteLocal: [], deleteRemote: [], same: 0 });
});

test('drive: the name of a file kept after a conflict', () => {
  const day = new Date(2026, 10, 2);
  assert.equal(S.driveConflictName('Notes/a.md', 'laptop', day), 'Notes/a (conflict laptop 2026-11-02).md');
  assert.equal(S.driveConflictName('a', 'laptop', day), 'a (conflict laptop 2026-11-02)');
  assert.equal(S.driveConflictName('.hidden', 'laptop', day), '.hidden (conflict laptop 2026-11-02)');
  assert.equal(S.driveConflictName('x/a.tar.gz', 'my/lap:top (2)', day), 'x/a.tar (conflict my lap top 2 2026-11-02).gz');
  const taken = new Set(['a (conflict laptop 2026-11-02).md', 'a (conflict laptop 2026-11-02 2).md']);
  assert.equal(S.driveConflictName('a.md', 'laptop', day, r => taken.has(r)), 'a (conflict laptop 2026-11-02 3).md');
  assert.equal(S.driveConflictName('a.md', '', day), 'a (conflict this device 2026-11-02).md');
});

test('drive: batches by count and by size', () => {
  const limits = { batchFiles: 3, batchBytes: 100 };
  assert.deepEqual(S.driveBatches([1, 2, 3, 4, 5, 6, 7], null, limits), [[1, 2, 3], [4, 5, 6], [7]]);
  assert.deepEqual(S.driveBatches([60, 50, 10, 200, 5], n => n, limits), [[60], [50, 10], [200], [5]]);   // one too large for a batch goes alone
  assert.deepEqual(S.driveBatches([], null, limits), []);
  assert.ok(Math.ceil(S.DRIVE_LIMITS.fileBytes / 3) * 4 < 9.9e6, 'as base64, the largest file must fit in the connector’s 10,000,000-byte request');
});

test('drive: settings', () => {
  assert.deepEqual(S.driveSettings(undefined, 'my-laptop'), { folder: 'Scriptorium', model: 'haiku', device: 'my-laptop' });
  assert.deepEqual(S.driveSettings({ drive: { folder: ' Backups/Mine ', model: 'sonnet; rm', device: 'a"b' } }, 'x'), { folder: 'Backups Mine', model: 'sonnetrm', device: 'a b' });
  assert.equal(S.driveSettings({ drive: 3 }, '').device, 'this device');
  // The plugin's other settings keep the backup's (normalizeSettings keeps keys it does not know).
  assert.deepEqual(S.normalizeSettings({ drive: { folder: 'X' } }).drive, { folder: 'X' });
});

/* ---------- Claude Code's event stream ---------- */

test('drive: the prompt loads the tools, then lists the calls as JSON', () => {
  const prompt = S.drivePrompt([{ tool: 'create_file', input: { title: 'It’s "a".md', parentId: 'p' } }, { tool: 'trash_file', input: { fileId: 'x' } }]);
  assert.match(prompt, /ToolSearch once with \{"query":"select:mcp__claude_ai_Google_Drive__create_file,mcp__claude_ai_Google_Drive__trash_file","max_results":2\}/);
  assert.ok(prompt.includes('1. mcp__claude_ai_Google_Drive__create_file {"title":"It’s \\"a\\".md","parentId":"p"}\n2. mcp__claude_ai_Google_Drive__trash_file {"fileId":"x"}\n'));
});

test('drive: results are read from the stream and from the files Claude Code saves, never from what the model says', t => {
  const dir = tmp(t), results = path.join(dir, 'proj', 'session', 'tool-results');
  fs.mkdirSync(results, { recursive: true });
  const saved = (name, text) => { fs.writeFileSync(path.join(results, name), text); return path.join(results, name); };
  const T = S.DRIVE_TOOL;
  const use = (id, tool, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: T + tool, input }] } });
  const res = (id, content, bad) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: bad }] } });
  const over = file => `Error: result (99 characters) exceeds maximum allowed tokens. Output has been saved to ${file}.\nFormat: JSON with schema: {id: string}\nUse jq`;
  const blob = saved('mcp-claude_ai_Google_Drive-blob-1-abc.json', Buffer.from([0, 1, 2, 255]));
  const st = { uses: [], results: {}, cost: 0 };
  const lines = [
    'not json', '',
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't0', name: 'ToolSearch', input: { query: 'select:x' } }] } }),
    use('u1', 'create_file', { title: 'a.md', parentId: 'p', disableConversionToGoogleType: 'true' }),   // the model wrote true as a string
    res('u1', over(saved('mcp-create_file-1.txt', '{"id":"F1","fileSize":"3"}'))),
    use('u2', 'download_file_content', { fileId: 'F1' }),
    res('u2', [{ type: 'text', text: '{"id":"F1","content":"YWJj"}' }]),
    use('u3', 'download_file_content', { fileId: 'F2' }),
    res('u3', over(saved('mcp-download-2.txt', JSON.stringify([{ type: 'text', text: `[Resource from claude.ai Google Drive at googledrive://file/F2] Binary content (application/json, 4B) saved to ${blob}` },
      { type: 'text', text: '{"id":"F2","content":"(file sent separately)"}' }])))),
    use('u4', 'trash_file', { fileId: 'F3' }),
    res('u4', ''),
    use('u5', 'create_file', { title: 'b.md', parentId: 'p' }),
    res('u5', 'Nothing was uploaded: /x/b.md either does not exist or can\'t be sent by reference from here'),
    use('u6', 'download_file_content', { fileId: 'F9' }),
    res('u6', '<tool_use_error>Error: No such tool available</tool_use_error>', true),
    use('u6b', 'download_file_content', { fileId: 'F9' }),           // made twice: the one that worked counts
    res('u6b', '{"id":"F9","content":""}'),
    use('u7', 'trash_file', { fileId: 'SOMETHING-ELSE' }),            // not asked for
    res('u7', ''),
    use('u8', 'get_file_metadata', { fileId: 'F1' }),                 // no result came (the run was cut short)
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.005, result: 'done. Everything worked and the id is F777.' }),
  ];
  for (const line of lines) S.applyDriveLine(st, line);
  assert.equal(st.done, true);
  assert.equal(st.cost, 0.005);
  const calls = [
    { tool: 'create_file', input: { title: 'a.md', parentId: 'p', disableConversionToGoogleType: true } },
    { tool: 'download_file_content', input: { fileId: 'F1' } },
    { tool: 'download_file_content', input: { fileId: 'F2' } },
    { tool: 'trash_file', input: { fileId: 'F3' } },
    { tool: 'create_file', input: { title: 'b.md', parentId: 'p' } },
    { tool: 'download_file_content', input: { fileId: 'F9' } },
    { tool: 'get_file_metadata', input: { fileId: 'F1' } },
    { tool: 'create_file', input: { title: 'never-made.md', parentId: 'p' } },
  ];
  const { results: r, extra } = S.driveResults(fs, path, st, calls);
  assert.deepEqual(r[0], { ok: true, data: { id: 'F1', fileSize: '3' } });
  assert.deepEqual(r[1], { ok: true, data: { id: 'F1', content: 'YWJj' } });
  assert.equal(r[2].ok, true);
  assert.deepEqual([...r[2].data.bytes], [0, 1, 2, 255]);
  assert.deepEqual(r[3], { ok: true, data: {} });
  assert.equal(r[4].ok, false);
  assert.match(r[4].error, /Nothing was uploaded/);
  assert.deepEqual(r[5], { ok: true, data: { id: 'F9', content: '' } });
  assert.equal(r[6].ok, false);
  assert.equal(r[7].ok, false);
  assert.equal(r[7].missed, true);
  assert.deepEqual(extra.map(x => [x.tool, x.input.fileId]), [['download_file_content', 'F9'], ['trash_file', 'SOMETHING-ELSE']]);
  // The saved results are deleted once read, and the folders Claude Code made for them with them.
  assert.equal(fs.existsSync(path.join(dir, 'proj')), false);
  // An error at the end of the run is kept for the message.
  const bad = { uses: [], results: {}, cost: 0 };
  S.applyDriveLine(bad, JSON.stringify({ type: 'result', is_error: true, result: 'Invalid API key · Please run /login' }));
  assert.match(bad.error, /login/);
});

test('drive: the runner gives Claude Code only the Drive tools, a hook that refuses the rest, and a limit that keeps contents from the model', async t => {
  const work = tmp(t);
  let seen = null;
  const cli = {
    cliErrorMessage: (which, text) => `Claude Code stopped with an error: ${text}`,
    runCli: async (which, exe, args, input, onLine, hooks) => {
      seen = { which, exe, args, input, hooks };
      onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: `${S.DRIVE_TOOL}trash_file`, input: { fileId: 'F' } }] } }));
      onLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: '' }] } }));
      onLine(JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.01 }));
      return { code: 0, stderr: '' };
    },
  };
  const run = S.driveRunner({ cli, fs, path, exe: '/bin/claude', model: 'haiku', dirs: ['/my/vault'], work });
  const out = await run([{ tool: 'trash_file', input: { fileId: 'F' } }]);
  assert.deepEqual(out.results, [{ ok: true, data: {} }]);
  assert.equal(out.cost, 0.01);
  assert.equal(seen.hooks.cwd, work);
  assert.deepEqual(seen.hooks.env, { MAX_MCP_OUTPUT_TOKENS: '1' });
  const arg = name => seen.args[seen.args.indexOf(name) + 1];
  assert.equal(arg('--allowedTools'), `${S.DRIVE_TOOL}trash_file`);      // only the tools this batch uses
  assert.equal(arg('--add-dir'), '/my/vault');
  assert.equal(arg('--setting-sources'), '');
  assert.equal(arg('--model'), 'haiku');
  assert.ok(seen.args.includes('--no-session-persistence'));
  const hook = JSON.parse(fs.readFileSync(arg('--settings'), 'utf8')).hooks.PreToolUse[0];
  const refused = new RegExp(hook.matcher);
  for (const tool of ['Read', 'Bash', 'Write', 'Edit', 'Grep', 'WebFetch', 'mcp__claude_ai_Gmail__send_message']) assert.ok(refused.test(tool), tool);
  for (const tool of ['ToolSearch', `${S.DRIVE_TOOL}create_file`]) assert.ok(!refused.test(tool), tool);
  assert.equal(hook.hooks[0].command, 'exit 2');
  // An error from Claude Code itself (not signed in, usage limit) stops the run with its message.
  cli.runCli = async (w, e, a, i, onLine) => { onLine(JSON.stringify({ type: 'result', is_error: true, result: 'Please run /login' })); return { code: 1, stderr: '' }; };
  await assert.rejects(run([{ tool: 'trash_file', input: { fileId: 'F' } }]), /login/);
});

test('drive: finding Claude Code and the Google Drive connector', async () => {
  const cli = (found, auth, list) => ({
    findCli: () => (found ? '/bin/claude' : null),
    runCli: async (which, exe, args, input, onLine) => { for (const l of (args[0] === 'auth' ? auth : list).split('\n')) onLine(l); return { code: 0, stderr: '' }; },
  });
  const ok = '{"loggedIn": true, "authMethod": "claude.ai"}';
  assert.deepEqual(await S.driveCheck(cli(true, ok, 'claude.ai Box: https://mcp.box.com - ! Needs authentication\nclaude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected'), ''), { ok: true, exe: '/bin/claude' });
  let r = await S.driveCheck(cli(false, ok, ''), '/custom/claude');
  assert.equal(r.ok, false);
  assert.match(r.problem, /not found at \/custom\/claude/);
  assert.equal(r.steps.length, 4);
  r = await S.driveCheck(cli(true, '{"loggedIn": false}', ''), '');
  assert.match(r.problem, /not signed in/);
  r = await S.driveCheck(cli(true, '{"loggedIn": true, "authMethod": "apiKey"}', ''), '');
  assert.match(r.problem, /API key/);
  r = await S.driveCheck(cli(true, ok, 'claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ! Needs authentication'), '');
  assert.match(r.problem, /not signed in to Google/);
  r = await S.driveCheck(cli(true, 'an old Claude Code: unknown command', 'claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected'), '');
  assert.match(r.problem, /no Google Drive connector/);
  assert.ok(r.steps.some(s => /Connectors/.test(s)));
});

test('drive: the check says what it saw, for the diagnostic report, and stops a Claude Code that does not answer', async () => {
  const seen = {};
  const cli = {
    findCli: () => 'C:\\Users\\Ada\\.local\\bin\\claude.exe',
    runCli: async (which, exe, args, input, onLine) => {
      for (const l of (args[0] === 'auth' ? '{"loggedIn": true, "authMethod": "claude.ai"}' : 'claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ! Needs authentication').split('\n')) onLine(l);
      return { code: 0, stderr: '' };
    },
  };
  const r = await S.driveCheck(cli, '', seen);
  assert.equal(r.ok, false);
  assert.deepEqual(seen, { exe: 'C:\\Users\\Ada\\.local\\bin\\claude.exe', auth: 'claude.ai', connector: 'claude.ai Google Drive: - ! Needs authentication' });
  // Not found, with no path set: where it was looked for, and where to say where it is.
  const none = await S.driveCheck({ findCli: () => null }, '');
  assert.match(none.problem, /not found on this computer.*Lagrange’s settings/);
  // A Claude Code that hangs is stopped, and the command to try by hand is named.
  const limit = S.DRIVE_LIMITS.checkMs;
  S.DRIVE_LIMITS.checkMs = 30;
  try {
    const hung = {
      findCli: () => '/bin/claude',
      runCli: (which, exe, args, input, onLine, hooks) => new Promise((resolve, reject) => hooks.signal.addEventListener('abort', () => { const e = new Error('Stopped.'); e.name = 'AbortError'; reject(e); })),
    };
    const h = await S.driveCheck(hung, '');
    assert.equal(h.ok, false);
    assert.match(h.problem, /did not answer within 0 seconds \(“claude auth status”\)/);
  } finally {
    S.DRIVE_LIMITS.checkMs = limit;
  }
});

/* ---------- whole backups against the pretend Drive ---------- */

test('drive: a first backup sends the notes and Scriptorium\'s settings, and nothing private', async t => {
  const drive = pretendDrive(), dir = tmp(t);
  sampleVault(dir);
  write(dir, 'Attachments/huge.mov', Buffer.alloc(300));
  const said = [];
  const sync = device(t, drive, dir, 'laptop', { limits: Object.assign({}, S.DRIVE_LIMITS, { fileBytes: 200, batchFiles: 3 }), say: p => said.push(p.stage) })();
  const info = await sync.prepare();
  assert.equal(info.first, true);
  assert.equal(info.nothing, false);
  assert.deepEqual(info.plan.upload, SAMPLE);
  assert.deepEqual(info.skipped, [{ path: 'Attachments/huge.mov', why: '300 B: larger than 200 B' }]);
  assert.equal(drive.count('create_file') + drive.count('update_file') + drive.count('trash_file'), 0, 'looking changes nothing');
  assert.equal([...drive.files.values()].length, 0);
  const s = await sync.sync();
  assert.equal(s.uploaded, 9);
  assert.deepEqual(s.failed, []);
  assert.equal(s.files, 9);
  const tree = drive.tree();
  assert.deepEqual(Object.keys(tree).sort(), SAMPLE.filter(r => r !== 'Empty.md').map(r => `Scriptorium/My Vault/${r}`).concat('Scriptorium/My Vault/scriptorium-manifest.json').sort());
  for (const [p, f] of Object.entries(tree)) {
    if (!p.endsWith('scriptorium-manifest.json')) assert.equal(sha(f.bytes), sha(fs.readFileSync(path.join(dir, p.slice('Scriptorium/My Vault/'.length)))), p);
  }
  assert.equal(tree['Scriptorium/My Vault/Attachments/picture.png'].mimeType, 'application/x-scriptorium-file');
  assert.equal(tree['Scriptorium/My Vault/Welcome.md'].mimeType, 'text/markdown');
  assert.ok(![...drive.files.values()].some(f => f.bytes && /sk-secret|"token"/.test(f.bytes.toString('latin1'))), 'no API key was uploaded');
  const m = JSON.parse(tree['Scriptorium/My Vault/scriptorium-manifest.json'].bytes.toString('utf8'));
  assert.equal(m.schema, 1);
  assert.equal(m.app, 'scriptorium');
  assert.equal(m.vault, 'My Vault');
  assert.equal(m.seq, 1);
  assert.equal(m.device, 'laptop');
  assert.deepEqual(Object.keys(m.files).sort(), SAMPLE);
  const one = m.files['Notes/One.md'];
  assert.deepEqual(Object.keys(one).sort(), ['device', 'id', 'mtime', 'sha256', 'size']);
  assert.equal(one.sha256, sha('one\n'));
  assert.equal(one.size, 4);
  assert.equal(one.mtime, Math.round(fs.statSync(path.join(dir, 'Notes/One.md')).mtimeMs));
  assert.equal(drive.files.get(one.id).title, 'One.md');
  assert.equal(m.files['Empty.md'].id, null, 'Drive takes no empty file: the manifest alone records it');
  assert.ok(said.includes('Uploading') && said.includes('Making folders') && said.includes('Done'));
  // The state this device keeps is not in the backup, and is valid JSON written whole.
  const state = JSON.parse(fs.readFileSync(path.join(dir, S.DRIVE_STATE), 'utf8'));
  assert.equal(state.seq, 1);
  assert.equal(state.journal, null);
  assert.deepEqual(Object.keys(state.base).sort(), SAMPLE);
  assert.equal(fs.existsSync(path.join(dir, `${S.DRIVE_STATE}.scriptorium-tmp`)), false);
  // Run again: nothing to do, and nothing is sent.
  const before = drive.count('create_file');
  const again = device(t, drive, dir, 'laptop', { limits: Object.assign({}, S.DRIVE_LIMITS, { fileBytes: 200 }) })();
  const info2 = await again.prepare();
  assert.equal(info2.nothing, true);
  assert.equal(info2.plan.same, 9);
  assert.equal(drive.count('create_file'), before);
});

test('drive: a second backup sends only what changed; a deleted file goes to _trash in Drive, never away', async t => {
  const drive = pretendDrive(), dir = tmp(t);
  sampleVault(dir);
  const make = device(t, drive, dir, 'laptop');
  await make().sync();
  const firstManifest = [...drive.files.values()].find(f => f.title === S.DRIVE_MANIFEST);
  const oldOne = [...drive.files.values()].find(f => f.title === 'One.md');
  const two = [...drive.files.values()].find(f => f.title === 'Two.md');
  const uploads = drive.count('create_file');
  write(dir, 'Notes/One.md', 'one, changed\n');
  write(dir, 'New/Fresh.md', 'fresh\n');
  fs.unlinkSync(path.join(dir, 'Notes/Deep/Two.md'));
  fs.unlinkSync(path.join(dir, 'Empty.md'));
  const sync = make();
  const info = await sync.prepare();
  assert.deepEqual(info.plan.upload, ['New/Fresh.md', 'Notes/One.md']);
  assert.deepEqual(info.plan.deleteRemote, ['Empty.md', 'Notes/Deep/Two.md']);
  assert.equal(info.plan.same, 6);
  const s = await sync.sync();
  assert.equal(s.uploaded, 2);
  assert.equal(s.deletedThere, 2);
  assert.deepEqual(s.failed, []);
  assert.equal(drive.count('create_file') - uploads, 3, 'two files and the manifest');
  const tree = drive.tree();
  assert.equal(tree['Scriptorium/My Vault/Notes/One.md'].bytes.toString(), 'one, changed\n');
  assert.equal(tree['Scriptorium/My Vault/_trash/2026-11-12/Two.md'].id, two.id, 'the deleted file was moved, not deleted');
  assert.equal(two.trashed, false);
  assert.equal(oldOne.trashed, true, 'the old copy of a changed file goes to Drive’s trash');
  assert.equal(firstManifest.trashed, true);
  const m = JSON.parse(tree['Scriptorium/My Vault/scriptorium-manifest.json'].bytes.toString('utf8'));
  assert.equal(m.seq, 2);
  assert.ok(!m.files['Notes/Deep/Two.md'] && !m.files['Empty.md']);
  assert.deepEqual(m.deleted.map(d => [d.path, d.id, d.folder, d.device]), [['Empty.md', null, null, 'laptop'], ['Notes/Deep/Two.md', two.id, '_trash/2026-11-12', 'laptop']]);
  assert.equal(m.deleted[1].sha256, sha('two\n'));
  assert.deepEqual(m.stale, []);
  assert.equal((await make().prepare()).nothing, true);
});

test('drive: a stopped backup carries on where it stopped, uploading nothing twice', async t => {
  const drive = pretendDrive(), dir = tmp(t);
  sampleVault(dir);
  for (let i = 0; i < 12; i++) write(dir, `Many/Note ${i}.md`, `note ${i}\n`);
  const limits = Object.assign({}, S.DRIVE_LIMITS, { batchFiles: 4, parallel: 1 });
  const make = device(t, drive, dir, 'laptop', { limits });
  // Claude Code dies in the third batch of uploads.
  let uploadsRuns = 0;
  drive.crash = (n, calls) => calls.some(c => c.tool === 'create_file' && c.input.base64Content) && ++uploadsRuns === 3;
  await assert.rejects(make().sync(), /pretend crash/);
  const sent = drive.count('create_file');
  assert.equal(sent, 8);
  assert.ok(!Object.keys(drive.tree()).some(p => p.endsWith(S.DRIVE_MANIFEST)), 'no manifest yet');
  const state = JSON.parse(fs.readFileSync(path.join(dir, S.DRIVE_STATE), 'utf8'));
  assert.equal(Object.keys(state.journal.manifest.files).length, 9, 'eight uploads and the empty file are recorded');
  drive.crash = null;
  const sync = make();
  const info = await sync.prepare();
  assert.equal(info.resumed, true);
  assert.equal(info.plan.upload.length, 20 - 8);   // 21 files, one of them empty and already recorded
  const s = await sync.sync();
  assert.deepEqual(s.failed, []);
  assert.equal(drive.count('create_file'), 20 + 1, 'every file once, and the manifest');
  const titles = Object.keys(drive.tree());
  assert.equal(titles.length, 21);
  assert.equal(new Set(titles).size, 21);
  assert.equal((await make().prepare()).nothing, true);
  // A run stopped half-way through a batch hands over what it had done, and that is recorded too.
  for (let i = 0; i < 4; i++) write(dir, `Half/Note ${i}.md`, `half ${i}\n`);
  const real = drive.run;
  drive.run = async (calls, hooks) => {
    if (!calls.some(c => c.input.base64Content && /Half\/Note/.test(c.input.base64Content))) return real(calls, hooks);
    const out = await real(calls.slice(0, 2), hooks);
    const e = new Error('Stopped.');
    e.name = 'AbortError';
    e.partial = out.results.concat(calls.slice(2).map(() => ({ ok: false, error: 'Claude Code did not make this call as it was written.', missed: true })));
    throw e;
  };
  const half = device(t, drive, dir, 'laptop', { limits, run: (c, h) => drive.run(c, h) });
  const made = drive.count('create_file');
  await assert.rejects(half().sync(), e => e.name === 'AbortError');
  assert.equal(drive.count('create_file') - made, 2);
  drive.run = real;
  assert.equal((await make().sync()).uploaded, 2, 'only the two that had not gone up');
  assert.equal(drive.count('create_file') - made, 2 + 2 + 1);
  // A stop asked for by the writer is the same: what is done is kept.
  write(dir, 'Later.md', 'later\n');
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(device(t, drive, dir, 'laptop', { signal: stop.signal })().sync(), e => e.name === 'AbortError');
  assert.equal((await make().sync()).uploaded, 1);
});

test('drive: a call that fails is tried again, and what still fails is reported, not lost', async t => {
  const drive = pretendDrive(), dir = tmp(t);
  sampleVault(dir);
  const make = device(t, drive, dir, 'laptop');
  let refused = 0;
  drive.before = call => (call.tool === 'create_file' && call.input.title === 'One.md' && refused++ < 1 ? 'Rate limit exceeded' : (call.input.title === 'Welcome.md' ? 'Drive says no' : null));
  const s = await make().sync();
  assert.equal(s.uploaded, 8);
  assert.deepEqual(s.failed.map(f => f.path), ['Welcome.md']);
  assert.match(s.failed[0].why, /Uploading: Drive says no/);
  const m = JSON.parse(Object.values(drive.tree()).find(f => f.title === S.DRIVE_MANIFEST).bytes.toString());
  assert.ok(m.files['Notes/One.md'] && !m.files['Welcome.md']);
  drive.before = null;
  const next = await make().sync();
  assert.equal(next.uploaded, 1);
  assert.deepEqual(next.failed, []);
  // A file that is not what was sent (a wrong size comes back) is not recorded either.
  write(dir, 'Odd.md', 'odd\n');
  const real = drive.run;
  drive.run = async (calls, hooks) => {
    const out = await real(calls, hooks);
    calls.forEach((c, i) => { if (c.input.title === 'Odd.md') out.results[i].data.fileSize = '999'; });
    return out;
  };
  const odd = await device(t, drive, dir, 'laptop', { run: (c, h) => drive.run(c, h) })().sync();
  assert.deepEqual(odd.failed.map(f => f.path), ['Odd.md']);
  assert.match(odd.failed[0].why, /not the file that was sent/);
});

test('drive: retrieving a vault checks every file against the manifest\'s SHA-256', async t => {
  for (const blobs of [false, true]) {
    const drive = pretendDrive(), dir = tmp(t), dest = tmp(t, 'dest-');
    drive.blobs = blobs;
    sampleVault(dir);
    await device(t, drive, dir, 'laptop')().sync();
    const lister = device(t, drive, tmp(t), 'desktop', { vault: '' })();
    const vaults = await lister.vaults();
    assert.deepEqual(vaults.map(v => [v.name, v.files, v.device, v.manifest.seq]), [['My Vault', 9, 'laptop', 1]]);
    assert.equal(vaults[0].bytes, SAMPLE.reduce((n, r) => n + fs.statSync(path.join(dir, r)).size, 0));
    assert.equal(typeof vaults[0].updated, 'string');
    // One file is damaged on its way down.
    drive.corrupt.add([...drive.files.values()].find(f => f.title === 'One.md').id);
    const before = drive.count('create_file') + drive.count('trash_file') + drive.count('update_file');
    const s = await device(t, drive, dest, 'desktop')().retrieve(vaults[0]);
    assert.equal(drive.count('create_file') + drive.count('trash_file') + drive.count('update_file'), before, 'retrieving sends nothing');
    assert.equal(s.downloaded, 8);
    assert.deepEqual(s.failed.map(f => f.path), ['Notes/One.md']);
    assert.match(s.failed[0].why, /does not match the backup’s SHA-256/);
    assert.equal(fs.existsSync(path.join(dest, 'Notes/One.md')), false, 'a file that fails the check is not written');
    const got = vaultFiles(dest), had = vaultFiles(dir);
    for (const rel of SAMPLE.filter(r => r !== 'Notes/One.md')) assert.equal(got[rel], had[rel], rel);
    assert.equal(Math.round(fs.statSync(path.join(dest, 'Welcome.md')).mtimeMs), Math.round(fs.statSync(path.join(dir, 'Welcome.md')).mtimeMs));
    assert.deepEqual(Object.keys(got).filter(r => r !== S.DRIVE_STATE).sort(), SAMPLE.filter(r => r !== 'Notes/One.md'));
    // The retrieved folder is tied to the backup it came from, whatever the folder itself is called.
    assert.equal(S.driveLinked(fs, path, dest, 'Scriptorium'), 'My Vault');
    assert.equal(S.driveLinked(fs, path, dest, 'Another folder'), null);
    assert.equal(S.driveLinked(fs, path, tmp(t), 'Scriptorium'), null);
    // A sync in the retrieved vault fetches the file that failed, and sends nothing.
    drive.corrupt.clear();
    const fix = await device(t, drive, dest, 'desktop')().sync();
    assert.equal(fix.downloaded, 1);
    assert.equal(fix.uploaded, 0);
    assert.equal(vaultFiles(dest)['Notes/One.md'], had['Notes/One.md']);
    // Setting it up as a Scriptorium vault, as the command does, leaves the notes alone.
    const plan = S.planVaultSetup(fs, path, S.setupPackage(fs, path, path.join(__dirname, '..', 'vault')), dest);
    S.applyVaultSetup(fs, path, dest, plan);
    assert.ok(fs.existsSync(path.join(dest, '.obsidian/plugins/scriptorium/main.js')));
    assert.equal(vaultFiles(dest)['Welcome.md'], had['Welcome.md']);
    assert.equal(fs.readFileSync(path.join(dest, '.obsidian/plugins/scriptorium/data.json'), 'utf8'), '{"fancyMode":true}\n', 'the vault’s own settings came back');
  }
});

test('drive: a manifest cannot make a retrieval write outside the vault or into a plugin\'s code', () => {
  const entry = { sha256: 'a'.repeat(64), size: 1, mtime: 1, id: 'x' };
  const pack = m => ({ content: Buffer.from(JSON.stringify(m)).toString('base64') });
  const m = S.driveManifest(pack({ schema: 1, app: 'scriptorium', seq: 3, files: {
    'ok.md': entry, '../evil.md': entry, '/abs.md': entry, '.obsidian/plugins/scriptorium/main.js': entry, '.obsidian/plugins/evil/main.js': entry,
    'bad-hash.md': Object.assign({}, entry, { sha256: 'zz' }), 'bad-id.md': Object.assign({}, entry, { id: 7 }),
  } }));
  assert.deepEqual(Object.keys(m.files), ['ok.md']);
  assert.equal(m.seq, 3);
  assert.deepEqual([m.deleted, m.stale, m.folders], [[], [], {}]);
  assert.match(S.driveManifest(pack({ schema: 2, app: 'scriptorium', files: {} })).message, /newer Scriptorium/);
  assert.match(S.driveManifest(pack({ schema: 1, app: 'other', files: {} })).message, /could not be read/);
  assert.match(S.driveManifest({ content: 'not base64 json' }).message, /could not be read/);
  assert.equal(S.driveManifest({ content: '(file sent separately)', bytes: Buffer.from(JSON.stringify({ schema: 1, app: 'scriptorium', files: {} })) }).seq, 0);
});

test('drive: two devices. What another device sent is brought in first; a file changed on both sides keeps both', async t => {
  const drive = pretendDrive(), a = tmp(t, 'a-'), b = tmp(t, 'b-');
  sampleVault(a);
  const A = device(t, drive, a, 'laptop'), B = device(t, drive, b, 'desktop');
  await A().sync();
  const [entry] = await device(t, drive, tmp(t), 'desktop', { vault: '' })().vaults();
  await B().retrieve(entry);
  // On the desktop: one note edited, one added, one deleted.
  write(b, 'Notes/One.md', 'one, from the desktop\n');
  write(b, 'From desktop.md', 'hello\n');
  fs.unlinkSync(path.join(b, 'Welcome.md'));
  const sb = await B().sync();
  assert.equal(sb.uploaded, 2);
  assert.equal(sb.deletedThere, 1);
  // Meanwhile on the laptop: the same note edited differently, another edited, and one deleted that the desktop did not touch.
  write(a, 'Notes/One.md', 'one, from the laptop\n');
  write(a, 'Notes/Deep/Two.md', 'two, from the laptop\n');
  fs.unlinkSync(path.join(a, 'Attachments/picture.png'));
  const sync = A();
  const info = await sync.prepare();
  assert.deepEqual(info.plan.conflicts, ['Notes/One.md']);
  assert.deepEqual(info.plan.download, ['From desktop.md']);
  assert.deepEqual(info.plan.deleteLocal, ['Welcome.md']);
  assert.deepEqual(info.plan.upload, ['Notes/Deep/Two.md']);
  assert.deepEqual(info.plan.deleteRemote, ['Attachments/picture.png']);
  const order = [];
  const real = drive.run;
  drive.run = async (calls, hooks) => { for (const c of calls) if (c.tool === 'download_file_content' || (c.tool === 'create_file' && c.input.base64Content)) order.push(c.tool); return real(calls, hooks); };
  const sa = await device(t, drive, a, 'laptop', { run: (c, h) => drive.run(c, h) })().sync();
  drive.run = real;
  assert.ok(order.lastIndexOf('download_file_content') < order.indexOf('create_file'), 'everything is brought in before anything is sent');
  assert.deepEqual(sa.conflicts, [{ path: 'Notes/One.md', kept: 'Notes/One (conflict laptop 2026-11-12).md' }]);
  assert.equal(sa.downloaded, 2);
  assert.equal(sa.deletedHere, 1);
  assert.equal(sa.uploaded, 2, 'the other edit, and the copy kept after the conflict');
  assert.equal(sa.deletedThere, 1);
  assert.deepEqual(sa.failed, []);
  assert.equal(fs.readFileSync(path.join(a, 'Notes/One.md'), 'utf8'), 'one, from the desktop\n');
  assert.equal(fs.readFileSync(path.join(a, 'Notes/One (conflict laptop 2026-11-12).md'), 'utf8'), 'one, from the laptop\n');
  assert.equal(fs.readFileSync(path.join(a, '.trash/Welcome.md'), 'utf8'), '# Welcome\n', 'a file deleted elsewhere goes to the vault’s .trash, not away');
  // The desktop syncs again and both vaults are the same.
  const sb2 = await B().sync();
  assert.equal(sb2.downloaded, 2);
  assert.equal(sb2.deletedHere, 1);
  assert.equal(sb2.uploaded, 0);
  const strip = files => Object.fromEntries(Object.entries(files).filter(([rel]) => S.driveRule(rel)));
  assert.deepEqual(strip(vaultFiles(a)), strip(vaultFiles(b)));
  assert.equal((await A().prepare()).nothing, true);
  assert.equal((await B().prepare()).nothing, true);
  // A file changed while the sync was running is not overwritten either.
  write(b, 'Notes/Deep/Two.md', 'two, from the desktop\n');
  await B().sync();
  const late = A();
  await late.prepare();
  write(a, 'Notes/Deep/Two.md', 'typed while it ran\n');
  const sl = await late.sync();
  assert.deepEqual(sl.conflicts.map(c => c.kept), ['Notes/Deep/Two (conflict laptop 2026-11-12).md']);
  assert.equal(fs.readFileSync(path.join(a, 'Notes/Deep/Two (conflict laptop 2026-11-12).md'), 'utf8'), 'typed while it ran\n');
  assert.equal(fs.readFileSync(path.join(a, 'Notes/Deep/Two.md'), 'utf8'), 'two, from the desktop\n');
});

test('drive: a backup whose Drive folder was removed is made again, not written into the trash', async t => {
  const drive = pretendDrive(), dir = tmp(t);
  write(dir, 'a.md', 'a\n');
  const make = device(t, drive, dir, 'laptop');
  await make().sync();
  for (const f of drive.files.values()) f.trashed = true;
  const s = await make().sync();
  assert.equal(s.uploaded, 1);
  assert.deepEqual(Object.keys(drive.tree()).sort(), ['Scriptorium/My Vault/a.md', 'Scriptorium/My Vault/scriptorium-manifest.json']);
});
