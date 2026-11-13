// Tests for the pure helpers of the Scriptorium plugin (vault/.obsidian/plugins/scriptorium/main.js): settings,
// sidenote geometry and stacking, footnote definitions, and image captions.
// Run: node --test plugins-tests/scriptorium.test.js
//
// Copyright (C) 2026 William Liaw. Licensed under the GNU General Public License, version 3 or later (see LICENSE).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

// main.js requires 'obsidian', which exists only inside Obsidian: give it a stub with the names it destructures.
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

test('the plugin module exports the plugin class and its helpers', () => {
  assert.equal(typeof S, 'function');
  for (const name of ['normalizeSettings', 'marginGeometry', 'stackNotes', 'footnoteDefinitions', 'parseImageEmbed']) {
    assert.equal(typeof S[name], 'function', name);
  }
});

test('settings: defaults, checked values, unknown keys kept', () => {
  assert.deepEqual(S.normalizeSettings(undefined), { fancyMode: false, initials: 'yinit', marginalia: true, imageFocus: true });
  assert.deepEqual(S.normalizeSettings({ fancyMode: true }), { fancyMode: true, initials: 'yinit', marginalia: true, imageFocus: true });
  const s = S.normalizeSettings({ initials: 'goudy', marginalia: false, imageFocus: 'no', future: 3 });
  assert.equal(s.initials, 'goudy');
  assert.equal(s.marginalia, false);
  assert.equal(s.imageFocus, true);   // not a boolean: the default
  assert.equal(s.future, 3);
  assert.equal(S.normalizeSettings({ initials: 'comic-sans' }).initials, 'yinit');
  assert.equal(S.normalizeSettings({ initials: 'set:Dropcat' }).initials, 'set:Dropcat', 'a set of drop caps, by name');
  assert.equal(S.normalizeSettings({ initials: 'set:' }).initials, 'yinit');
  for (const v of ['yinit', 'goudy', 'plain', 'none']) assert.equal(S.normalizeSettings({ initials: v }).initials, v);
});

test('geometry: a wide pane keeps the text centred and puts the notes in the right margin', () => {
  const em = 22, columnWidth = 792, paneWidth = 2000, columnLeft = (paneWidth - columnWidth) / 2;
  const g = S.marginGeometry({ paneWidth, columnLeft, columnWidth, padLeft: 32, em });
  assert.equal(g.mode, 'margin');
  assert.equal(g.shift, 0);
  assert.equal(g.width, 17 * em);                       // the widest column
  assert.equal(g.left, columnLeft + columnWidth + 1.6 * em);
  assert.ok(g.left + g.width <= paneWidth - em);       // clear of the right edge
});

test('geometry: a middling pane moves the text left so that text and notes are centred together', () => {
  const em = 22, columnWidth = 792, paneWidth = 1343, columnLeft = (paneWidth - columnWidth) / 2;
  const g = S.marginGeometry({ paneWidth, columnLeft, columnWidth, padLeft: 32, em });
  assert.equal(g.mode, 'margin');
  assert.ok(g.shift > 0 && g.shift <= columnLeft - 32);
  assert.equal(g.width, 14 * em);
  const textLeft = columnLeft - g.shift, right = paneWidth - (g.left + g.width);
  assert.ok(Math.abs(textLeft - right) < 1e-9, `${textLeft} vs ${right}`);   // centred as one block
});

test('geometry: a narrow pane, no notes, or no readable line width leaves the notes at the foot', () => {
  const em = 22, columnWidth = 792;
  assert.equal(S.marginGeometry({ paneWidth: 1000, columnLeft: 104, columnWidth, padLeft: 32, em }).mode, 'bottom');
  assert.equal(S.marginGeometry({ paneWidth: 2000, columnLeft: 604, columnWidth, padLeft: 32, em, hasNotes: false }).mode, 'bottom');
  // readable line width off: the column fills the pane, inside its padding
  assert.equal(S.marginGeometry({ paneWidth: 1600, columnLeft: 32, columnWidth: 1536, padLeft: 32, em }).mode, 'bottom');
  assert.equal(S.marginGeometry({ paneWidth: 0, columnLeft: 0, columnWidth, em }).mode, 'bottom');
});

test('geometry: just enough room for the narrowest column', () => {
  const em = 20, columnWidth = 700, padLeft = 30;
  const need = columnWidth + padLeft + (1.6 + 10 + 1) * em;   // text + left padding + gap + narrowest notes + edge
  assert.equal(S.marginGeometry({ paneWidth: need, columnLeft: (need - columnWidth) / 2, columnWidth, padLeft, em }).mode, 'margin');
  assert.equal(S.marginGeometry({ paneWidth: need - 2, columnLeft: (need - 2 - columnWidth) / 2, columnWidth, padLeft, em }).mode, 'bottom');
});

const overlaps = (items, tops, gap) => {
  const order = items.map((_, i) => i).sort((a, b) => tops[a] - tops[b]);
  for (let k = 1; k < order.length; k++) {
    const a = order[k - 1], b = order[k];
    if (tops[a] + items[a].height + gap > tops[b] + 1e-9) return true;
  }
  return false;
};

test('stacking: notes far apart stay where they want to be', () => {
  const items = [{ want: 0, height: 50 }, { want: 200, height: 50 }, { want: 400, height: 80 }];
  assert.deepEqual(S.stackNotes(items, { gap: 10 }), [0, 200, 400]);
});

test('stacking: notes close together are pushed down, in order, without overlapping', () => {
  const items = [{ want: 100, height: 60 }, { want: 120, height: 40 }, { want: 120, height: 40 }, { want: 400, height: 10 }];
  const tops = S.stackNotes(items, { gap: 8 });
  assert.deepEqual(tops, [100, 168, 216, 400]);
  assert.ok(!overlaps(items, tops, 8));
});

test('stacking: two references on one line keep their order', () => {
  const items = [{ want: 300, height: 30 }, { want: 300, height: 30 }];
  const tops = S.stackNotes(items, { gap: 5 });
  assert.ok(tops[0] < tops[1]);
});

test('stacking: input order does not matter, results come back in input order', () => {
  const items = [{ want: 500, height: 20 }, { want: 0, height: 100 }, { want: 50, height: 20 }];
  const tops = S.stackNotes(items, { gap: 0 });
  assert.deepEqual(tops, [500, 0, 100]);
});

test('stacking: notes that would run past the bottom are pushed back up, but never above the top', () => {
  const items = [{ want: 0, height: 100 }, { want: 850, height: 100 }, { want: 900, height: 100 }];
  const tops = S.stackNotes(items, { gap: 10, top: 0, bottom: 1000 });
  assert.deepEqual(tops, [0, 790, 900]);
  assert.ok(!overlaps(items, tops, 10));
  const crowded = Array.from({ length: 12 }, (_, i) => ({ want: 10 * i, height: 100 }));
  const t2 = S.stackNotes(crowded, { gap: 0, top: 0, bottom: 500 });   // more than fits: they overflow downwards
  assert.equal(t2[0], 0);
  assert.ok(!overlaps(crowded, t2, 0));
});

test('stacking: a long random case never overlaps', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const items = Array.from({ length: 200 }, () => ({ want: rand() * 5000, height: 20 + rand() * 200 }));
  const tops = S.stackNotes(items, { gap: 12, top: 0, bottom: 6000 });
  assert.ok(!overlaps(items, tops, 12));
  assert.ok(tops.every(t => t >= 0));
});

const NOTE = [
  'Text.[^1] More.[^long] Inline.^[An *inline* note.]',
  '',
  '```',
  '[^1]: not a footnote, inside code',
  '```',
  '',
  '[^1]: The first note.',
  '[^long]: A long note,',
  '    with a second line.',
  '',
  '    And a second paragraph.',
  'Not part of it.'
].join('\n');

test('footnotes: definitions from the metadata positions, inline ones too', () => {
  const at = (s) => NOTE.indexOf(s);
  const def1 = '[^1]: The first note.', defLong = '[^long]: A long note,\n    with a second line.\n\n    And a second paragraph.';
  const inline = '^[An *inline* note.]';
  const footnotes = [
    { id: '[inline0', position: { start: { offset: at(inline) }, end: { offset: at(inline) + inline.length } } },
    { id: '1', position: { start: { offset: at(def1) }, end: { offset: at(def1) + def1.length } } },
    { id: 'long', position: { start: { offset: at(defLong) }, end: { offset: at(defLong) + defLong.length } } }
  ];
  const defs = S.footnoteDefinitions(NOTE, footnotes);
  assert.equal(defs.get('1'), 'The first note.');
  assert.equal(defs.get('long'), 'A long note,\nwith a second line.\n\nAnd a second paragraph.');
  assert.equal(defs.get('[inline0'), 'An *inline* note.');
});

test('footnotes: an inline footnote whose position covers only its text (as Obsidian 1.15 gives it)', () => {
  const start = NOTE.indexOf('An *inline*'), end = start + 'An *inline* note.'.length;
  const defs = S.footnoteDefinitions(NOTE, [{ id: '[inline0', position: { start: { offset: start }, end: { offset: end } } }]);
  assert.equal(defs.get('[inline0'), 'An *inline* note.');
});

test('footnotes: positions from another version of the text are ignored', () => {
  const footnotes = [{ id: '2', position: { start: { offset: NOTE.indexOf('[^1]: The') }, end: { offset: NOTE.length } } }];
  assert.equal(S.footnoteDefinitions(NOTE, footnotes).size, 0);
});

test('footnotes: without metadata, definitions are read from the text, skipping code', () => {
  const defs = S.footnoteDefinitions(NOTE, undefined);
  assert.equal(defs.get('1'), 'The first note.');
  assert.equal(defs.get('long'), 'A long note,\nwith a second line.\n\nAnd a second paragraph.');
  assert.equal(defs.size, 2);
});

test('footnote labels: Obsidian numbers references [n], and a second reference to n [n-1]', () => {
  assert.equal(S.refLabel('[4]'), '4');
  assert.equal(S.refLabel('[2-1]'), '2');
  assert.equal(S.refLabel(' [12] '), '12');
});

test('image captions: wikilink embeds', () => {
  assert.deepEqual(S.parseImageEmbed('![[fig.png|A press, in oxblood]]'), { link: 'fig.png', caption: 'A press, in oxblood', title: '' });
  assert.deepEqual(S.parseImageEmbed('![[fig.png|right|200]]'), { link: 'fig.png', caption: '', title: '' });
  assert.deepEqual(S.parseImageEmbed('![[fig.png|left|A caption|300x200]]'), { link: 'fig.png', caption: 'A caption', title: '' });
  assert.deepEqual(S.parseImageEmbed('![[sub/fig one.png]]'), { link: 'sub/fig one.png', caption: '', title: '' });
});

test('image captions: Markdown images, with sizes, placement words and titles', () => {
  assert.deepEqual(S.parseImageEmbed('![A second figure|300](fig.png "The fleuron")'),
    { link: 'fig.png', caption: 'A second figure', title: 'The fleuron' });
  assert.deepEqual(S.parseImageEmbed('![center](<my fig.png>)'), { link: 'my fig.png', caption: '', title: '' });
  assert.deepEqual(S.parseImageEmbed("![Brackets \\] inside](https://example.org/a.png 'Single')"),
    { link: 'https://example.org/a.png', caption: 'Brackets ] inside', title: 'Single' });
  assert.equal(S.parseImageEmbed('not an image'), null);
});

test('web images are found outside code', () => {
  const text = 'A ![one](https://example.org/1.png) and `x`\n```\n![no](https://example.org/2.png)\n```\n![three|200](http://example.org/3.jpg "T")';
  const fence = [text.indexOf('```'), text.lastIndexOf('```') + 3];
  const found = S.externalImages(text, [fence]);
  assert.deepEqual(found.map(f => [f.link, f.caption, f.title]),
    [['https://example.org/1.png', 'one', ''], ['http://example.org/3.jpg', 'three', 'T']]);
});

test('image addresses match without the timestamp Obsidian adds', () => {
  assert.equal(S.sourceKey('app://abc/vault/fig%20a.png?1794437986486'), 'app://abc/vault/fig a.png');
  assert.equal(S.sourceKey('https://example.org/a.png?x=1'), 'https://example.org/a.png?x=1');
});


// ---------------------------------------------------------------- setting up a vault
const fs = require('node:fs');
const os = require('node:os');
const VAULT = path.join(__dirname, '..', 'vault');

function tempVault(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-setup-'));
  for (const [rel, text] of Object.entries(files || {})) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  }
  return dir;
}

test('set up a vault: which files are Scriptorium’s, which are merged, and which are never brought along', () => {
  for (const rel of ['.obsidian/snippets/manuscript.css', '.obsidian/themes/Typewriter/theme.css', '.obsidian/plugins/scriptorium/main.js',
    '.obsidian/plugins/lagrange/styles.css', '.obsidian/plugins/lagrange/LagrangeHand-OFL.txt', '.obsidian/plugins/manuscriptum/LICENSE',
    '.obsidian/plugins/typewriter-mode/manifest.json', '.obsidian/plugins/longform/main.js']) assert.equal(S.setupRule(rel), 'replace', rel);
  for (const rel of ['.obsidian/core-plugins.json', '.obsidian/plugins/scriptorium/data.json', '.obsidian/plugins/lagrange/data.json']) assert.equal(S.setupRule(rel), 'missing', rel);
  assert.equal(S.setupRule('.obsidian/community-plugins.json'), 'plugins');
  assert.equal(S.setupRule('.obsidian/appearance.json'), 'appearance');
  assert.equal(S.setupRule('.obsidian/app.json'), 'app');
  for (const rel of ['Lorem Ipsum.md', 'README.md', 'Notes/My note.md', '.obsidian/workspace.json', '.obsidian/graph.json', '.obsidian/hotkeys.json',
    '.obsidian/plugins/calendar/main.js', '.obsidian/plugins/longform/data.json', '.obsidian/snippets/mine.css', '.obsidian/themes/Minimal/theme.css',
    '.obsidian/plugins/scriptorium/sub/main.js']) assert.equal(S.setupRule(rel), null, rel);
});

test('set up a vault: every file of the package that the rules name is in the plan for an empty folder, and no other', () => {
  const pkg = S.setupPackage(fs, path, VAULT);
  const dir = tempVault({ 'Essay.md': 'An essay.\n' });
  try {
    const plan = S.planVaultSetup(fs, path, pkg, dir);
    const all = [];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else all.push(path.relative(VAULT, f).split(path.sep).join('/')); } };
    walk(VAULT);
    assert.deepEqual(plan.changes.map(c => c.rel).sort(), all.filter(rel => S.setupRule(rel)).sort());
    assert.ok(plan.changes.every(c => !c.replaces && c.rel.startsWith('.obsidian/')));
    for (const c of plan.changes) {
      if (c.rel === '.obsidian/community-plugins.json') assert.deepEqual(JSON.parse(c.content), ['manuscriptum', 'typewriter-mode', 'scriptorium', 'lagrange']);
      else assert.ok(c.content.equals(fs.readFileSync(path.join(VAULT, c.rel))), `${c.rel} is the package's, byte for byte`);
    }
    assert.equal(S.describeVaultSetup(plan).length, plan.changes.length);
    assert.equal(S.applyVaultSetup(fs, path, dir, plan), null, 'no .obsidian to back up');
    assert.equal(fs.readFileSync(path.join(dir, 'Essay.md'), 'utf8'), 'An essay.\n');
    assert.deepEqual(S.planVaultSetup(fs, path, pkg, dir).changes, [], 'a second run has nothing to do');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('set up a vault: what is personal in the vault it copies from stays behind (API keys, other settings, other plugins)', () => {
  const source = tempVault({
    '.obsidian/plugins/lagrange/data.json': { provider: 'anthropic', anthropicApiKey: 'sk-ant-SECRET', openaiApiKey: 'sk-SECRET', openaiPlatformKey: 'sk-ALSO', penSpeed: 2 },
    '.obsidian/plugins/lagrange/main.js': '/* lagrange */',
    '.obsidian/plugins/scriptorium/main.js': '/* scriptorium */',
    '.obsidian/plugins/scriptorium/manifest.json': { id: 'scriptorium', version: '9.9.9' },
    '.obsidian/plugins/calendar/main.js': '/* calendar */',
    '.obsidian/plugins/longform/main.js': '/* longform */',
    '.obsidian/snippets/manuscript.css': '/* manuscript */',
    '.obsidian/snippets/private.css': '/* private */',
    '.obsidian/app.json': { baseFontSize: 20, attachmentFolderPath: 'Private/Attachments', userIgnoreFilters: ['Diary/'] },
    '.obsidian/appearance.json': { theme: 'moonstone', cssTheme: 'Minimal', enabledCssSnippets: ['private'], accentColor: '#ff0000', baseFontSize: 24 },
    '.obsidian/community-plugins.json': ['calendar', 'longform', 'scriptorium', 'secret-plugin'],
    '.obsidian/hotkeys.json': { x: 1 },
    '.obsidian/workspace.json': { lastOpenFiles: ['Diary/today.md'] },
    '.obsidian/scriptorium-backup-20260101-000000/.obsidian/plugins/scriptorium/main.js': '/* old */',
    'Diary/today.md': 'Dear diary.',
  });
  try {
    const pkg = S.setupPackage(fs, path, source);
    const text = Object.values(pkg).map(b => b.toString('utf8')).join('\n');
    assert.doesNotMatch(text, /SECRET|sk-ALSO|Diary|Private|private|secret-plugin|calendar|#ff0000|Minimal|old/);
    assert.deepEqual(JSON.parse(pkg['.obsidian/plugins/lagrange/data.json']), { provider: 'anthropic', anthropicApiKey: '', openaiApiKey: '', openaiPlatformKey: '', penSpeed: 2 });
    assert.deepEqual(JSON.parse(pkg['.obsidian/app.json']), { baseFontSize: 24 }, 'the text size Obsidian keeps in appearance.json');
    assert.deepEqual(JSON.parse(pkg['.obsidian/appearance.json']), { theme: 'moonstone', cssTheme: 'Typewriter', enabledCssSnippets: ['manuscript'] });
    assert.deepEqual(JSON.parse(pkg['.obsidian/community-plugins.json']), ['longform', 'scriptorium', 'manuscriptum', 'typewriter-mode', 'lagrange']);
    assert.deepEqual(Object.keys(pkg).sort(), ['.obsidian/app.json', '.obsidian/appearance.json', '.obsidian/community-plugins.json',
      '.obsidian/plugins/lagrange/data.json', '.obsidian/plugins/lagrange/main.js', '.obsidian/plugins/longform/main.js',
      '.obsidian/plugins/scriptorium/main.js', '.obsidian/plugins/scriptorium/manifest.json', '.obsidian/snippets/manuscript.css']);
    // Longform goes along when this vault has it, and is then turned on.
    const target = tempVault({ 'a.md': 'x' });
    const plan = S.planVaultSetup(fs, path, pkg, target);
    assert.deepEqual(JSON.parse(plan.changes.find(c => c.rel.endsWith('community-plugins.json')).content), ['longform', 'scriptorium', 'manuscriptum', 'typewriter-mode', 'lagrange']);
    fs.rmSync(target, { recursive: true, force: true });
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('set up a vault: the folder typed or chosen', () => {
  const posix = path.posix, win = path.win32;
  assert.equal(S.setupFolder(posix, '  /home/me/Notes/  '), '/home/me/Notes');
  assert.equal(S.setupFolder(posix, '"/home/me/My Notes"'), '/home/me/My Notes');
  assert.equal(S.setupFolder(posix, '/'), '/');
  assert.equal(S.setupFolder(posix, 'Notes'), '', 'a relative path is refused');
  assert.equal(S.setupFolder(posix, ''), '');
  assert.equal(S.setupFolder(win, 'C:\\Users\\me\\Notes\\'), 'C:\\Users\\me\\Notes');
  assert.equal(S.setupFolder(win, 'C:\\'), 'C:\\');
  assert.equal(S.setupFolder(win, 'Notes\\Mine'), '');
});


// ---------------------------------------------------------------- a drop cap for one note
test('a note’s drop cap: read from its properties, forgiving about spelling; anything else is the vault’s', () => {
  for (const [fm, want] of [
    [{ dropcap: 'goudy' }, 'goudy'], [{ dropcap: 'Goudy Initialen' }, 'goudy'], [{ dropcap: ' YINIT ' }, 'yinit'],
    [{ dropcap: 'plain' }, 'plain'], [{ dropcap: 'Cormorant' }, 'plain'], [{ dropcap: 'none' }, 'none'],
    [{ dropcap: 'off' }, 'none'], [{ dropcap: false }, 'none'], [{ 'drop-cap': 'goudy' }, 'goudy'], [{ dropCap: 'none' }, 'none'],
    [{ dropcap: 'comic-sans' }, 'set:comic-sans'], [{ dropcap: ' My Initials ' }, 'set:My Initials'], [{ dropcap: 'Dropcat' }, 'set:Dropcat'], [{ dropcap: '' }, null], [{ dropcap: '  ' }, null], [{ dropcap: true }, null], [{ dropcap: 3 }, null], [{ dropcap: null }, null],
    [{ title: 'x' }, null], [{}, null], [null, null], [undefined, null], ['goudy', null],
  ]) assert.equal(S.noteDropcap(fm), want, JSON.stringify(fm));
});

test('a note’s drop cap: the command offers the vault’s and each drop cap; a block is marked and unmarked', () => {
  const choices = S.dropcapChoices('goudy');
  assert.deepEqual(choices.map(c => c.value), [null, 'yinit', 'goudy', 'plain', 'none']);
  assert.match(choices[0].label, /vault’s drop cap \(Goudy Initialen/);
  assert.match(S.dropcapChoices('nonsense')[0].label, /Yinit/);
  const classes = new Set(['el-p', 'scriptorium-dropcap', 'scriptorium-dropcap-none']);
  const el = { classList: { add: (...c) => c.forEach(x => classes.add(x)), remove: c => classes.delete(c), [Symbol.iterator]: () => classes[Symbol.iterator]() } };
  S.markDropcap(el, 'goudy');
  assert.deepEqual([...classes].sort(), ['el-p', 'scriptorium-dropcap', 'scriptorium-dropcap-goudy']);
  S.markDropcap(el, null);
  assert.deepEqual([...classes], ['el-p']);
});

test('a note’s drop cap: the snippet has a rule for each, and the vault’s "None" gives way to a note’s own', () => {
  const css = fs.readFileSync(path.join(VAULT, '.obsidian', 'snippets', 'manuscript.css'), 'utf8');
  for (const which of ['yinit', 'goudy', 'plain']) assert.match(css, new RegExp(`\\.el-p\\.scriptorium-dropcap-${which}[\\s,{]`), which);
  assert.match(css, /\.scriptorium-dropcap\.scriptorium-dropcap-none > p::first-letter/);
  const none = css.split('\n').filter(l => l.startsWith('body.scriptorium-initials-none '));
  assert.ok(none.length >= 6);
  for (const l of none) assert.match(l, /\.el-p:not\(\.scriptorium-dropcap\) > p/, l);
});


// ---------------------------------------------------------------- Export to PDF
// A very small DOM: enough for dressPrint, which only reads tag names and classes and moves a few elements.
function fakeDoc() {
  const make = (tag, cls) => {
    const el = {
      tagName: tag.toUpperCase(), children: [], parentElement: null, textContent: '', ownerDocument: doc,
      classList: {
        list: new Set((cls || '').split(' ').filter(Boolean)),
        contains(c) { return this.list.has(c); },
        add(...c) { c.forEach(x => this.list.add(x)); },
        remove(c) { this.list.delete(c); },
        [Symbol.iterator]() { return this.list[Symbol.iterator](); },
      },
      get className() { return [...this.classList.list].join(' '); },
      set className(v) { this.classList.list = new Set(String(v).split(' ').filter(Boolean)); },
      get firstElementChild() { return this.children[0] || null; },
      appendChild(c) { c.parentElement = this; this.children.push(c); return c; },
      replaceChild(n, o) { n.parentElement = this; this.children[this.children.indexOf(o)] = n; return o; },
    };
    return el;
  };
  const doc = { createElement: tag => make(tag) };
  return { doc, make };
}

test('Export to PDF: the printed page gets Reading view’s marks, the title its header block, and the note’s own drop cap', () => {
  const { make } = fakeDoc();
  const print = make('div', 'print');
  const page = print.appendChild(make('div', 'markdown-preview-view markdown-rendered'));
  const title = page.appendChild(make('h1'));
  title.textContent = 'Of Gardens';
  const wrap = tag => { const d = page.appendChild(make('div')); d.appendChild(make(tag)); return d; };
  const blocks = ['h6', 'p', 'h2', 'blockquote', 'p', 'pre', 'ul'].map(wrap);
  const hr = page.appendChild(make('hr'));
  const empty = page.appendChild(make('div'));
  assert.equal(S.isPrintPage(page), true);
  assert.equal(S.isPrintPage(blocks[0]), false);
  assert.equal(S.isPrintPage(make('div', 'markdown-preview-view')), false, 'a Reading view is not a page being printed');

  const made = S.dressPrint(page, 'goudy');
  assert.equal(page.children[0].className, 'mod-header mod-ui');
  assert.equal(page.children[0].children[0], made);
  assert.equal(made.className, 'inline-title');
  assert.equal(made.textContent, 'Of Gardens');
  assert.deepEqual(blocks.map(b => b.className), ['h6', 'p', 'h2', 'blockquote', 'p', 'pre', 'ul'].map(t => `el-${t} scriptorium-dropcap scriptorium-dropcap-goudy`));
  assert.equal(hr.className, '', 'a rule is left as it is');
  assert.equal(empty.className, 'scriptorium-dropcap scriptorium-dropcap-goudy');
  assert.equal(page.children.length, 10);

  // without the title option there is no header block, and without a drop cap of its own a note is only marked up
  const bare = fakeDoc();
  const page2 = bare.make('div', 'print').appendChild(bare.make('div', 'markdown-preview-view'));
  const h1 = page2.appendChild(bare.make('div'));
  h1.appendChild(bare.make('h1'));
  const p = page2.appendChild(bare.make('div'));
  p.appendChild(bare.make('p'));
  assert.equal(S.dressPrint(page2, null), null);
  assert.deepEqual(page2.children.map(c => c.className), ['el-h1', 'el-p'], 'the note’s own first heading stays a heading');
  S.dressPrint(page2, null);
  assert.deepEqual(page2.children.map(c => c.className), ['el-h1', 'el-p'], 'doing it twice changes nothing');
});


// ---------------------------------------------------------------- sets of drop caps
test('sets of drop caps: the five that come with Scriptorium are there, whole, and say where they are from', () => {
  const dir = path.join(VAULT, '.obsidian', 'plugins', 'scriptorium', 'dropcaps');
  assert.deepEqual(S.BUNDLED_SETS.map(b => b.dir), ['kanzlei', 'de-zs', 'dropcat', 'gene-wolfe', 'ninit']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['de-zs', 'dropcat', 'gene-wolfe', 'gwern.json', 'kanzlei', 'ninit']);
  const letters = { dropcat: 'BCGIQT', 'gene-wolfe': 'FTV', ninit: 'ABC' };
  const ALL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let bytes = 0;
  for (const b of S.BUNDLED_SETS) {
    const files = fs.readdirSync(path.join(dir, b.dir));
    const set = S.describeSet(b.name, files, b.meta);
    for (const f of files) {
      const data = fs.readFileSync(path.join(dir, b.dir, f));
      assert.equal(S.checkDropcapFile(f, new Uint8Array(data)).ok, true, f);
      bytes += data.length;
    }
    if (letters[b.dir]) {
      assert.equal(set.kind, 'images');
      assert.equal(Object.keys(set.letters).sort().join(''), letters[b.dir], b.dir);
      for (const slot of Object.values(set.letters)) assert.ok(slot.light.length === 1 && slot.dark.length === 1, 'a light and a dark image for each letter');
      assert.equal(b.more, true, 'gwern.net has more of it');
      assert.match(S.setLabel(set, b.about), new RegExp(`^${b.name} \\(.*gwern\\.net; ${letters[b.dir].split('').join(' ')}\\)$`));
    } else {
      // gwern.net's fonts: one small font for each letter, as gwern.net serves them
      assert.equal(set.kind, 'font');
      assert.equal(Object.keys(set.fonts).sort().join(''), ALL, b.dir);
      assert.equal(files.length, 26);
      assert.ok(set.size > 3 && set.margin, 'set to stand three lines deep');
      const css = S.fontFaces(set, f => `app://x/${f}`);
      assert.equal(css.split('\n').length, 26);
      assert.match(css, new RegExp(`@font-face \\{ font-family: "${set.family}"; src: url\\("app://x/[A-Za-z-]+-Q\\.ttf"\\); font-display: block; unicode-range: U\\+51, U\\+71; \\}`));
    }
  }
  assert.ok(bytes < 1500 * 1024, `the bundled drop caps stay small (${bytes} bytes)`);
  // what is not Scriptorium's to pass on is named, with where to get it
  assert.deepEqual(S.YOUR_OWN_SETS.map(y => y.name), ['Cheshire Initials']);
  assert.match(S.YOUR_OWN_SETS[0].where, /^https:\/\/www\.1001fonts\.com\//);
  assert.equal(fs.existsSync(path.join(dir, 'cheshire')), false);
  const third = fs.readFileSync(path.join(__dirname, '..', 'THIRD_PARTY.md'), 'utf8');
  for (const name of ['Dropcat', 'Gene Wolfe', 'Ninit', 'Kanzlei Initialen', 'Deutsche Zierschrift', 'Cheshire Initials', 'Dieter Steffmann', 'House of Lime']) assert.match(third, new RegExp(name), name);
  assert.match(third, /CC0|CC-0/);
  assert.match(third, /licenses\/CC0-1\.0\.txt/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'licenses', 'CC0-1.0.txt')));
  assert.match(third, /at the repository owner’s direction/);
});

test('sets of drop caps: what gwern.net has more of, and fetching it only when asked', async () => {
  const list = JSON.parse(fs.readFileSync(path.join(VAULT, '.obsidian', 'plugins', 'scriptorium', 'dropcaps', 'gwern.json'), 'utf8'));
  assert.equal(list.from, 'https://gwern.net/static/font/dropcap/');
  const cat = S.downloadPlan(list, 'dropcat', false);
  assert.equal(cat.files.length, 74);
  assert.ok(cat.bytes > 2e6 && cat.bytes < 4e6);
  assert.deepEqual(S.downloadPlan(list, 'dropcat', true), cat, 'gwern.net shows every Dropcat image');
  assert.equal(cat.files[0].url, 'https://gwern.net/static/font/dropcap/dropcat/dark/B-dark-1-small-2x.png');
  assert.equal(cat.files[0].file, 'B-dark-1-small-2x.png');
  for (const f of cat.files) assert.ok(S.dropcapFile(f.file).letter, f.file);
  const wolfe = S.downloadPlan(list, 'gene-wolfe', false), wolfeAll = S.downloadPlan(list, 'gene-wolfe', true);
  assert.equal(wolfe.files.length, 30);
  assert.equal(wolfeAll.files.length, 165);
  assert.ok(wolfeAll.bytes > 30e6, 'and the size is said before anything is fetched');
  assert.equal(S.downloadPlan(list, 'ninit', false).files.length, 0);
  assert.equal(S.downloadPlan(list, 'ninit', true).files.length, 58);
  assert.equal(new Set(S.downloadPlan(list, 'ninit', true).files.map(f => f.file)).size, 58, 'no two files share a name');
  assert.deepEqual(S.downloadPlan(list, 'yinit', true), { files: [], bytes: 0 });
  assert.deepEqual(S.downloadPlan({ from: 'https://evil.example/', sets: list.sets }, 'dropcat', true).files, [], 'only from gwern.net');
  assert.deepEqual(S.downloadPlan({ from: list.from, sets: { x: { web: [['light/../../a.png', 1], ['light/a.svg', 1], ['other/A-1.png', 1]] } } }, 'x', true).files, []);
  assert.equal(S.sizeText(2747735), '2.6 MB');
  assert.equal(S.sizeText(36397640), '35 MB');
  assert.equal(S.sizeText(910925), '890 kB');

  const png = n => { const b = new Uint8Array(n); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b; };
  const plan = { files: ['A-light-1.png', 'B-light-1.png', 'C-dark-1.png', 'Q-light-2.png'].map(file => ({ url: `https://gwern.net/x/${file}`, file, bytes: 100 })), bytes: 400 };
  const vault = { 'B-light-1.png': png(9) }, asked = [], seen = [];
  const io = {
    get: async url => {
      asked.push(url);
      if (url.endsWith('C-dark-1.png')) return new TextEncoder().encode('<html>not found</html>');
      if (url.endsWith('Q-light-2.png')) throw new Error('gwern.net answered 503');
      return png(64).buffer;
    },
    has: async file => file in vault,
    put: async (file, bytes) => { vault[file] = bytes; },
    progress: (done, total, file) => seen.push([done, total, file]),
  };
  const r = await S.fetchDropcapSet(plan, io);
  assert.deepEqual([r.saved, r.kept, r.bytes, r.offline, r.stopped], [1, 1, 64, false, false]);
  assert.deepEqual(r.failed, [{ file: 'C-dark-1.png', problem: 'it is not a PNG image' }, { file: 'Q-light-2.png', problem: 'gwern.net answered 503' }]);
  assert.deepEqual(Object.keys(vault).sort(), ['A-light-1.png', 'B-light-1.png']);
  assert.equal(asked.length, 3, 'an image already in the vault is not fetched again');
  assert.deepEqual(seen[0], [0, 4, 'A-light-1.png']);
  assert.deepEqual(seen[seen.length - 1], [4, 4, '']);
  assert.match(S.describeDownload('Dropcat', r), /^Dropcat: 1 image added \(1 kB\), 1 already there, 2 could not be fetched \(it is not a PNG image\); ask again to try those\.$/);

  // no connection: three failures in a row and nothing more is asked for; nothing is written
  let tries = 0, wrote = 0;
  const off = await S.fetchDropcapSet(S.downloadPlan(list, 'dropcat', false), {
    get: async () => { tries++; throw new Error('net::ERR_INTERNET_DISCONNECTED'); }, has: async () => false, put: async () => { wrote++; },
  });
  assert.deepEqual([tries, wrote, off.offline, off.saved], [3, 0, true, 0]);
  assert.match(S.describeDownload('Dropcat', off), /gwern\.net could not be reached \(net::ERR_INTERNET_DISCONNECTED\)\. Nothing was changed/);
  // the writer closes the dialogue: it stops after the image it is on
  let n = 0;
  const halted = await S.fetchDropcapSet(plan, { get: async () => png(20), has: async () => false, put: async () => { n++; }, stopped: () => n >= 2 });
  assert.deepEqual([halted.saved, halted.stopped], [2, true]);
  // too large an answer is refused
  const big = await S.fetchDropcapSet({ files: [plan.files[0]] }, { get: async () => png(3 * 1024 * 1024), has: async () => false, put: async () => { throw new Error('written'); } });
  assert.match(big.failed[0].problem, /larger than 2 MB/);
});

test('sets of drop caps: an image of one colour becomes ink on a clear ground', () => {
  const image = (w, h, paint) => {
    const px = new Uint8ClampedArray(4 * w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(paint(x, y), 4 * (y * w + x));
    return px;
  };
  const alpha = (m, w, x, y) => m[4 * (y * w + x) + 3];
  // black ink on white paper, with a ruled frame at the very edge and a grey wash
  const w = 20, h = 20;
  const ink = (x, y) => x === 0 || y === 0 || x === 19 || y === 19 || (x >= 8 && x < 12);
  const paper = image(w, h, (x, y) => (ink(x, y) ? [8, 8, 8, 255] : (x === 4 ? [128, 128, 128, 255] : [250, 248, 240, 255])));
  const m = S.monoMask(paper, w, h);
  assert.equal(m.length, paper.length);
  assert.equal(alpha(m, w, 0, 0), 255, 'the frame is ink');
  assert.equal(alpha(m, w, 10, 10), 255, 'the letter is ink');
  assert.equal(alpha(m, w, 2, 2), 0, 'the paper is clear');
  assert.ok(alpha(m, w, 4, 10) > 100 && alpha(m, w, 4, 10) < 255, 'a grey wash is thin ink');
  assert.deepEqual([m[0], m[1], m[2]], [0, 0, 0], 'black: the snippet gives it the page’s colour');
  // a white letter on a black plate
  const plate = image(w, h, (x, y) => (x >= 8 && x < 12 && y > 3 && y < 16 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  const p = S.monoMask(plate, w, h);
  assert.deepEqual([alpha(p, w, 10, 10), alpha(p, w, 1, 1)], [255, 0]);
  // an image that has a clear ground already is left as it is
  assert.equal(S.monoMask(image(w, h, (x, y) => (ink(x, y) ? [0, 0, 0, 255] : [0, 0, 0, 0])), w, h), null);
  assert.equal(S.monoMask(new Uint8ClampedArray(8), 20, 20), null);
  assert.equal(S.monoMask(null, 0, 0), null);
});

test('sets of drop caps: a file’s letter and theme come from its name', () => {
  for (const [name, want] of [
    ['A.svg', { letter: 'A', theme: 'light' }], ['b.png', { letter: 'B', theme: 'light' }], ['initial-C.svg', { letter: 'C', theme: 'light' }],
    ['Goudy_D-dark.png', { letter: 'D', theme: 'dark' }], ['Q-light-1-small-2x.png', { letter: 'Q', theme: 'light' }], ['dropcap e.SVG', { letter: 'E', theme: 'light' }],
    ['T-dark.png', { letter: 'T', theme: 'dark' }], ['Kanzlei-Initialen.ttf', { font: true }], ['initials.WOFF2', { font: true }],
    ['Kanzlei-Initialen-A.ttf', { font: true, letter: 'A' }], ['DeutscheZierschrift-q.ttf', { font: true, letter: 'Q' }], ['C-artdeco-dark-2.png', { letter: 'C', theme: 'dark' }],
    ['cover.png', null], ['notes.md', null], ['AB.svg', null], ['set.json', null], ['noextension', null],
  ]) assert.deepEqual(S.dropcapFile(name), want, name);
  for (const [text, want] of [['Before the cat', 'B'], ['“Quietly,” she said', 'Q'], ['  (An aside)', 'A'], ['Élan vital', 'E'], ['1687 was the year', ''], ['', ''], ['¿Qué?', 'Q'], ['数学', '']]) {
    assert.equal(S.openingLetter(text), want, text);
  }
  assert.equal(S.setName('  My  Initials!! '), 'My Initials');
  assert.equal(S.setName('../../etc'), 'etc');
  assert.equal(S.setName('***'), '');
  assert.equal(S.setName('x'.repeat(60)).length, 40);
});

test('sets of drop caps: a folder of images, a font of initials, and what a set.json adds', () => {
  const images = S.describeSet('Roundels', ['T.svg', 'M.svg', 'M-dark.svg', 'M-light-10.png', 'M-light-2.png', 'set.json', 'README.txt'], { mono: true });
  assert.deepEqual(images, { name: 'Roundels', label: 'Roundels', kind: 'images', mono: true, letters: { M: { dark: ['M-dark.svg'], light: ['M-light-2.png', 'M-light-10.png', 'M.svg'] }, T: { light: ['T.svg'] } } });
  assert.equal(S.setLabel(images, ''), 'Roundels (M T)');
  const font = S.describeSet('Kanzlei', ['initials.ttf', 'set.json'], { size: 4.6, margin: '0.1em 0.1em 0 0', mono: true });
  assert.equal(font.kind, 'font');
  assert.equal(font.font, 'initials.ttf');
  assert.equal(font.family, 'Scriptorium Set Kanzlei');
  assert.equal(S.setLabel(font, 'blackletter'), 'Kanzlei (blackletter)');
  assert.equal(S.fontFaces(font, f => `app://x/${f}`), '@font-face { font-family: "Scriptorium Set Kanzlei"; src: url("app://x/initials.ttf"); font-display: block; }');
  assert.equal(font.size, 4.6);
  assert.equal(font.margin, '0.1em 0.1em 0 0');
  assert.equal(S.describeSet('Bad', ['initials.ttf'], { size: 99, margin: 'url(x)' }).size, undefined, 'a wild size is not taken');
  assert.equal(S.describeSet('Bad', ['initials.ttf'], { margin: 'expression(1);' }).margin, undefined);
  assert.equal(S.describeSet('Empty', ['set.json', 'readme.md'], null), null);
  assert.equal(S.describeSet('Both', ['A.png', 'initials.otf'], null).kind, 'images', 'images come first');
  // the choices of the command, and marking a block for a set
  const choices = S.dropcapChoices('set:Roundels', [images, font]);
  assert.deepEqual(choices.map(c => c.value), [null, 'yinit', 'goudy', 'plain', 'none', 'set:Roundels', 'set:Kanzlei']);
  const withMissing = S.dropcapChoices('yinit', [images], S.YOUR_OWN_SETS);
  assert.deepEqual(withMissing[withMissing.length - 1], { value: 'add:Cheshire Initials', label: 'Cheshire Initials (not included: add the font yourself)' });
  assert.match(choices[0].label, /vault’s drop cap \(Roundels\)/);
  const block = text => {
    const classes = new Set(['el-p']), vars = {};
    return {
      classes, vars,
      classList: { add: (...c) => c.forEach(x => classes.add(x)), remove: c => classes.delete(c), [Symbol.iterator]: () => classes[Symbol.iterator]() },
      style: { setProperty: (k, v) => { vars[k] = v; }, removeProperty: k => { delete vars[k]; } },
      querySelector: () => (text === null ? null : { textContent: text }),
    };
  };
  const withUrls = { name: 'Roundels', kind: 'images', mono: true, letters: { M: { light: ['app://x/M.svg?1'], dark: ['app://x/M-dark.svg?1'] } } };
  const m = block('Men fear death');
  assert.deepEqual(S.markDropcap(m, 'set:Roundels', withUrls, 'Of Death.md'), { light: 'app://x/M.svg?1', dark: 'app://x/M-dark.svg?1' });
  assert.deepEqual([...m.classes].sort(), ['el-p', 'scriptorium-dropcap', 'scriptorium-dropcap-image', 'scriptorium-dropcap-mono']);
  assert.equal(m.vars['--scriptorium-dropcap-light'], 'url("app://x/M.svg?1")');
  assert.equal(m.vars['--scriptorium-dropcap-dark'], 'url("app://x/M-dark.svg?1")');
  // several images of a letter: a paragraph has one of them, the same one each time, and not every paragraph the same
  const many = { name: 'Cats', kind: 'images', mono: false, letters: { M: { light: ['a', 'b', 'c', 'd', 'e'] } } };
  const pick = (text, key) => S.markDropcap(block(text), 'set:Cats', many, key);
  assert.deepEqual(pick('Men fear death', 'Of Death.md'), pick('Men fear death', 'Of Death.md'));
  assert.equal(pick('Men fear death', 'Of Death.md').dark, pick('Men fear death', 'Of Death.md').light, 'no dark image: the light one');
  const picked = new Set(['Men fear death', 'Many a clerk', 'More than once', 'Midway', 'My lord', 'Mark this', 'Music', 'Morning came'].map(t => pick(t, 'x.md').light));
  assert.ok(picked.size >= 3, 'the images are spread among the paragraphs');
  assert.equal(S.seedOf('abc'), S.seedOf('abc'));
  assert.notEqual(S.seedOf('abc'), S.seedOf('abd'));
  const inked = block('Men fear death');
  inked.classes.add('scriptorium-dropcap-inked');
  S.markDropcap(inked, 'goudy', null);
  assert.ok(inked.classes.has('scriptorium-dropcap-inked') && inked.classes.has('scriptorium-dropcap-goudy'), 'marking again leaves the inking to finish');
  const w = block('What is truth?');
  S.markDropcap(w, 'set:Roundels', withUrls);
  assert.deepEqual([...w.classes], ['el-p'], 'no image for W: the block keeps the vault’s drop cap');
  S.markDropcap(m, null, null);
  assert.deepEqual([[...m.classes], m.vars], [['el-p'], {}], 'unmarked again');
  const f = block('Anything');
  S.markDropcap(f, 'set:Kanzlei', font);
  assert.ok(f.classes.has('scriptorium-dropcap-font'));
  assert.equal(f.vars['--scriptorium-initial-font'], '"Scriptorium Set Kanzlei", var(--manuscript-display)');
  assert.equal(f.vars['--scriptorium-initial-size'], '4.6em');
});

test('sets of drop caps: an SVG is made safe, and a file that is not what its name says is refused', () => {
  const bad = '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">' +
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="steal()">' +
    '<script>alert(1)</script><script src="https://evil.example/x.js"/><style>@import url("https://evil.example/a.css"); path{fill:url(#g)}</style>' +
    '<foreignObject><iframe src="https://evil.example"></iframe></foreignObject>' +
    '<a href="javascript:alert(1)"><path d="M0 0h10v10z" onclick="x()" fill="url(https://evil.example/p.svg#a)"/></a>' +
    '<image href="https://evil.example/track.png"/><use xlink:href="#shape"/><image href="data:image/png;base64,AAAA"/>' +
    '<linearGradient id="g"/></svg>';
  const clean = S.sanitizeSvg(bad);
  assert.ok(clean.svg && clean.removed >= 8);
  assert.doesNotMatch(clean.svg, /script|onload|onclick|foreignObject|iframe|evil\.example|@import|javascript|DOCTYPE/i);
  assert.match(clean.svg, /<path d="M0 0h10v10z"/);
  assert.match(clean.svg, /xlink:href="#shape"/, 'a reference inside the file stays');
  assert.match(clean.svg, /href="data:image\/png;base64,AAAA"/, 'an embedded picture stays');
  assert.match(clean.svg, /fill:url\(#g\)/);
  const plain = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M1 1h6v6z"/></svg>';
  assert.deepEqual(S.sanitizeSvg(plain), { svg: plain, removed: 0 });
  assert.match(S.sanitizeSvg('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>').problem, /entities/);
  assert.match(S.sanitizeSvg('<html><body>hello</body></html>').problem, /not an SVG/);

  const enc = t => new TextEncoder().encode(t);
  const ok = S.checkDropcapFile('initial-T.svg', enc(bad));
  assert.deepEqual([ok.ok, ok.kind, ok.letter, ok.theme], [true, 'svg', 'T', 'light']);
  assert.doesNotMatch(new TextDecoder().decode(ok.bytes), /script/);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  assert.deepEqual([S.checkDropcapFile('B-dark.png', png).ok, S.checkDropcapFile('B-dark.png', png).theme], [true, 'dark']);
  assert.match(S.checkDropcapFile('B.png', enc('<svg/>')).problem, /not a PNG/);
  assert.match(S.checkDropcapFile('B.svg', png).problem, /not text|not an SVG/);
  assert.match(S.checkDropcapFile('cover.png', png).problem, /no single letter/);
  assert.match(S.checkDropcapFile('B.png', new Uint8Array(700 * 1024)).problem, /600 kB/);
  assert.equal(S.checkDropcapFile('Kanzlei.ttf', new Uint8Array([0, 1, 0, 0, 9, 9])).kind, 'font');
  assert.equal(S.checkDropcapFile('Kanzlei-Initialen-K.ttf', new Uint8Array([0, 1, 0, 0, 9, 9])).letter, 'K');
  assert.match(S.checkDropcapFile('B.svg', enc('<!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>')).problem, /entities/);
  assert.equal(S.checkDropcapFile('B.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(700 * 1024).fill(0)]), 2 * 1024 * 1024).ok, true, 'a larger limit for what is fetched or drawn');
  assert.equal(S.checkDropcapFile('x.woff2', enc('wOF2....')).ok, true);
  assert.equal(S.checkDropcapFile('x.otf', enc('OTTO....')).ok, true);
  assert.match(S.checkDropcapFile('x.ttf', enc('MZ this is not a font')).problem, /not a TrueType/);
  assert.match(S.checkDropcapFile('x.ttf', new Uint8Array(4 * 1024 * 1024)).problem, /3 MB/);
});

test('sets of drop caps: the snippet draws an image where the initial would be, in one colour through a mask, and inks a new one in', () => {
  const css = fs.readFileSync(path.join(VAULT, '.obsidian', 'snippets', 'manuscript.css'), 'utf8');
  assert.match(css, /\.el-p\.scriptorium-dropcap-image > p::before/);
  assert.match(css, /background: var\(--scriptorium-dropcap-light\)/);
  assert.match(css, /background-image: var\(--scriptorium-dropcap-dark\)/);
  assert.match(css, /\.scriptorium-dropcap-mono > p::before[\s\S]{0,400}mask: var\(--scriptorium-dropcap-light\)/);
  assert.match(css, /\.scriptorium-dropcap-image > p::first-letter[\s\S]{0,200}font-size: 0/);
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*scriptorium-dropcap-inked/);
  assert.match(css, /--scriptorium-dropcap-ratio-dark/);
  assert.match(css, /scriptorium-dropcap-inked\.scriptorium-dropcap-image\.scriptorium-dropcap-mono > p::before \{[\s\S]{0,900}mask-composite: intersect/, 'the pen’s edge and the image’s own mask both hold');
  assert.doesNotMatch(css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}\n/g, ''), /animation: scriptorium-(ink|uncover)/, 'no animation outside that media query');
});

/* ---------- a family whose upright face is missing ---------- */

/* A letter I as ink in an RGBA image: a stem 14 px wide from row 30 to row 170, leaning by `lean` (run over rise). */
function stem(lean) {
  const width = 240, height = 200, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 30; y < 170; y++) {
    const x0 = Math.round(100 + (170 - y) * lean);
    for (let x = x0; x < x0 + 14; x++) data[(y * width + x) * 4 + 3] = 255;
  }
  return { data, width, height };
}

test('the lean of a drawn letter tells an upright face from an italic one', () => {
  const up = stem(0), italic = stem(0.21), back = stem(-0.2);
  assert.ok(Math.abs(S.inkSlant(up.data, up.width, up.height)) < 0.01);
  assert.ok(Math.abs(S.inkSlant(italic.data, italic.width, italic.height) - 0.21) < 0.03);
  assert.ok(S.inkSlant(back.data, back.width, back.height) < -0.15);
  assert.equal(S.inkSlant(new Uint8ClampedArray(240 * 200 * 4), 240, 200), null, 'no ink, no answer');
});

test('a family that is there but draws upright text leaning is reported; a family that is not there is not', () => {
  // A pretend canvas: `installed` families measure differently from the fallback, and `leaning` ones draw the I leaning.
  const doc = (installed, leaning) => ({ createElement: () => ({ getContext: () => {
    const g = { font: '', measureText: () => ({ width: installed.some(f => g.font.includes(`"${f}"`)) ? 500 : 700 }), clearRect() {}, fillText() {},
      getImageData: () => stem(leaning.some(f => g.font.includes(`"${f}"`)) ? 0.2 : 0) };
    return g;
  } }) });
  assert.equal(S.uprightMissing(doc(['Cormorant Garamond'], ['Cormorant Garamond']), 'Cormorant Garamond'), true);
  assert.equal(S.uprightMissing(doc(['Cormorant Garamond'], []), 'Cormorant Garamond'), false);
  assert.equal(S.uprightMissing(doc([], []), 'Cormorant Garamond'), null, 'not installed at all: nothing to say');
  assert.equal(S.uprightMissing({ createElement: () => { throw new Error('no canvas'); } }, 'EB Garamond'), null);
});

/* ---------- centred and right-aligned text ---------- */

const VERSE = ['Tyger Tyger, burning bright,', 'In the forests of the night;'];
const PROSE = 'The chapter begins here, in prose.';
const plan = text => S.alignPlan(text.split('\n'));
const marks = (text, from, to) => S.sectionMarks(plan(text), from, to === undefined ? from : to);

test('aligned text: the marker lines are read, in Pandoc’s forms too, and nothing else is one', () => {
  for (const [line, want] of [
    ['::: center', { align: 'center', dropcap: false }], [':::center', { align: 'center', dropcap: false }], ['::: centre', { align: 'center', dropcap: false }],
    ['::: Centered', { align: 'center', dropcap: false }], [':::: right', { align: 'right', dropcap: false }], ['  ::: right  ', { align: 'right', dropcap: false }],
    ['::: center dropcap', { align: 'center', dropcap: true }], ['::: right drop-cap', { align: 'right', dropcap: true }],
    ['::: {.center}', { align: 'center', dropcap: false }], ['::: {.center .dropcap}', { align: 'center', dropcap: true }], ['::: center :::', { align: 'center', dropcap: false }],
    [':::', { close: true }], ['::::: ', { close: true }],
    ['::: note', null], ['::: rightly so', null], ['::: right-hand', null], [':: center', null], ['text ::: center', null], ['    ::: center', null], ['', null],
  ]) assert.deepEqual(S.alignMarker(line), want, JSON.stringify(line));
  assert.equal(S.alignKind(' Centre '), 'center');
  assert.equal(S.alignKind('left'), null);
  assert.deepEqual(S.noteAlign({ align: 'Right', 'dropcap-aligned': true }), { align: 'right', dropcap: true });
  assert.deepEqual(S.noteAlign({ align: 'justify', 'dropcap-aligned': 'no' }), { align: null, dropcap: false });
  assert.deepEqual(S.noteAlign(null), { align: null, dropcap: false });
});

test('aligned text: a block runs from its opening marker to its closing one; a block that is not closed aligns nothing', () => {
  const p = plan(['## Verse', '', '::: center', ...VERSE, ':::', '', '::: right', '— Blake', ':::', '', PROSE].join('\n'));
  assert.deepEqual(p.ranges.map(r => [r.align, r.open, r.close]), [['center', 2, 5], ['right', 7, 9]]);
  assert.equal(plan(['::: center', ...VERSE, '', PROSE].join('\n')).ranges.length, 0, 'never closed');
  assert.equal(plan(['Some text', '::: center', ...VERSE, ':::'].join('\n')).ranges.length, 0, 'the opening marker is a line of the paragraph above it');
  assert.equal(plan(['::: center', ...VERSE, ':::', 'more text'].join('\n')).ranges.length, 0, 'the closing marker has text against it');
  assert.equal(plan(['# Title', '::: center', ...VERSE, ':::', '## Next'].join('\n')).ranges.length, 1, 'a heading may stand against either marker');
  assert.deepEqual(plan(['::: center', 'one', '', '::: right', 'two', ':::'].join('\n')).ranges.map(r => [r.align, r.open, r.close]), [['right', 3, 5]], 'a second opening marker starts afresh');
  assert.equal(plan(['```', '::: center', 'code', ':::', '```'].join('\n')).ranges.length, 0, 'markers in a code block are code');
  assert.deepEqual(plan(['::: center', '```', ':::', '```', 'verse', ':::'].join('\n')).ranges.map(r => [r.open, r.close]), [[0, 5]], 'and a code block inside an aligned block is skipped');
  assert.equal(plan(['::: note', 'text', ':::'].join('\n')).ranges.length, 0, 'another kind of container is not ours');
  // the properties: where the note begins, and what they say
  const fm = plan(['---', 'align: centre', 'dropcap-aligned: true', 'dropcap: goudy', '---', '::: right', '— Blake', ':::'].join('\n'));
  assert.equal(fm.body, 5);
  assert.deepEqual(fm.note, { align: 'center', dropcap: true });
  assert.deepEqual(fm.ranges.map(r => [r.align, r.dropcap, r.own, r.open]), [['right', true, false, 5]], 'the first line after the properties starts a block; the note’s drop caps are the block’s');
  assert.deepEqual(plan('---\nalign: "right"  # set to the right\n---\ntext').note, { align: 'right', dropcap: false });
  assert.deepEqual(plan('align: center\n\ntext').note, { align: null, dropcap: false }, 'not in the properties: only a line of text');
});

test('aligned text: each block of the note gets its marks; the marker lines are not shown', () => {
  const text = ['## Verse', '', '::: center', ...VERSE, '', ...VERSE, ':::', '', '::: right', '', '— Blake', '', ':::', '', PROSE].join('\n');
  assert.equal(marks(text, 0), null, 'the heading');
  assert.deepEqual(marks(text, 2, 4), { align: 'center', dropcap: false, first: true, last: false, fence: false, opens: false }, 'the first stanza, with the opening marker on it');
  assert.deepEqual(marks(text, 6, 8), { align: 'center', dropcap: false, first: false, last: true, fence: false, opens: true }, 'the last stanza, with the closing marker on it');
  assert.deepEqual(marks(text, 10), { align: 'right', dropcap: false, first: true, last: false, fence: true, opens: false }, 'a marker that is a paragraph of its own');
  assert.deepEqual(marks(text, 12), { align: 'right', dropcap: false, first: false, last: false, fence: false, opens: false });
  assert.deepEqual(marks(text, 14), { align: 'right', dropcap: false, first: false, last: true, fence: true, opens: true });
  assert.equal(marks(text, 16), null, 'the prose after it');
  assert.deepEqual(S.alignClasses(marks(text, 6, 8)), ['scriptorium-align', 'scriptorium-align-center', 'scriptorium-opens']);
  assert.deepEqual(S.alignClasses(marks(text, 14)), ['scriptorium-align', 'scriptorium-align-right', 'scriptorium-align-fence', 'scriptorium-opens']);
  assert.deepEqual(S.alignClasses(null), []);
  // a note aligned as a whole: every block after the properties, and a block of its own alignment inside it
  const whole = ['---', 'align: center', '---', 'One.', '', '::: right', 'Two.', ':::'].join('\n');
  assert.equal(marks(whole, 0, 2), null);
  assert.deepEqual(S.alignClasses(marks(whole, 3)), ['scriptorium-align', 'scriptorium-align-center']);
  assert.deepEqual(S.alignClasses(marks(whole, 5, 7)), ['scriptorium-align', 'scriptorium-align-right']);
});

test('aligned text and drop caps: aligned blocks under a heading are passed over, and the first paragraph after them opens the chapter', () => {
  const lead = text => plan(text).ranges.map(r => r.lead);
  const block = (kind, ...lines) => [`::: ${kind}`, ...lines, ':::', ''];
  assert.deepEqual(lead(['## Verse', '', ...block('center', ...VERSE), ...block('right', '— Blake'), PROSE].join('\n')), [true, true], 'a poem and the name under it');
  assert.deepEqual(lead([...block('center', ...VERSE), PROSE].join('\n')), [true], 'at the top of a note');
  assert.deepEqual(lead(['---', 'dropcap: goudy', '---', ...block('center', ...VERSE), PROSE].join('\n')), [false], 'not under properties, where the snippet opens no chapter either');
  assert.deepEqual(lead(['###### Subtitle', ...block('center', ...VERSE)].join('\n')), [true]);
  assert.deepEqual(lead(['### A smaller heading', '', ...block('center', ...VERSE)].join('\n')), [false], 'only where a chapter opens: headings 1, 2 and 6');
  assert.deepEqual(lead(['Title', '=====', '', ...block('center', ...VERSE)].join('\n')), [true], 'a heading underlined');
  assert.deepEqual(lead(['## Verse', '', PROSE, '', ...block('center', ...VERSE)].join('\n')), [false], 'after the opening paragraph');
  assert.deepEqual(lead(['## Verse', '', '> An epigraph,', '> in prose.', '', ...block('right', '— Its author'), PROSE].join('\n')), [true], 'the name under an epigraph');
  assert.deepEqual(lead(['## Verse', '', '> [!note]', '> A callout.', '', ...block('right', '— Its author')].join('\n')), [false], 'a callout is no epigraph');
  assert.deepEqual(lead(['## Verse', '', '> One.', '', '> Two.', '', ...block('right', '— Its author')].join('\n')), [false], 'one quotation, not two');
  assert.deepEqual(lead(['## Verse', '', '---', '', ...block('center', ...VERSE)].join('\n')), [false], 'a rule is not a heading');
  // which block carries the mark: the last one of the run, whichever of its blocks holds the closing marker
  const text = ['## Verse', '', ...block('center', ...VERSE), ...block('right', '— Blake'), PROSE].join('\n');
  assert.equal(marks(text, 2, 5).opens, true);
  assert.equal(marks(text, 7, 9).opens, true);
  // suppression is by class: an aligned block has no .scriptorium-align-dropcap unless asked
  assert.ok(!S.alignClasses(marks(text, 2, 5)).includes('scriptorium-align-dropcap'));
});

test('aligned text and drop caps: “dropcap” on a block, or “dropcap-aligned” on the note, asks for the drop cap; the paragraph after it then has none', () => {
  const block = (open, ...lines) => [open, ...lines, ':::', ''];
  const own = ['## Verse', '', ...block('::: center dropcap', ...VERSE), PROSE].join('\n');
  assert.deepEqual(plan(own).ranges.map(r => [r.dropcap, r.own, r.lead]), [[true, true, true]]);
  assert.deepEqual(S.alignClasses(marks(own, 2, 5)), ['scriptorium-align', 'scriptorium-align-center', 'scriptorium-align-dropcap'], 'it is the opening paragraph itself: nothing opens after it');
  // its marker on a paragraph of its own: that (unseen) block is what the opening paragraph follows
  const apart = ['## Verse', '', '::: center dropcap', '', ...VERSE, '', ':::', '', PROSE].join('\n');
  assert.deepEqual(S.alignClasses(marks(apart, 2)), ['scriptorium-align', 'scriptorium-align-center', 'scriptorium-align-dropcap', 'scriptorium-align-fence', 'scriptorium-opens']);
  assert.equal(marks(apart, 4, 5).opens, false);
  assert.equal(marks(apart, 7).opens, false, 'the prose after it is not the opening');
  // after a block that keeps its drop cap, the next aligned block is not at the opening either
  const two = ['## Verse', '', ...block('::: center dropcap', ...VERSE), ...block('::: right', '— Blake'), PROSE].join('\n');
  assert.deepEqual(plan(two).ranges.map(r => r.lead), [true, false]);
  // a block without a drop cap first, then one with: the second is the opening
  const then = ['## Verse', '', ...block('::: right', '— A dedication'), ...block('::: center dropcap', ...VERSE), PROSE].join('\n');
  assert.deepEqual(plan(then).ranges.map(r => [r.lead, r.dropcap]), [[true, false], [true, true]]);
  assert.equal(marks(then, 2, 4).opens, true);
  assert.equal(marks(then, 6, 9).opens, false);
  // the whole note
  const note = ['---', 'dropcap-aligned: true', '---', '## Verse', '', ...block('::: center', ...VERSE), PROSE].join('\n');
  assert.deepEqual(plan(note).ranges.map(r => [r.dropcap, r.own]), [[true, false]]);
  assert.ok(S.alignClasses(marks(note, 5, 8)).includes('scriptorium-align-dropcap'));
  assert.ok(!S.alignClasses(marks(note, 5, 8)).includes('scriptorium-opens'));
});

test('aligned text: a page rendered all at once (Export to PDF) is read from its blocks', () => {
  assert.deepEqual(S.blockLines('H2', 'The Tyger'), ['## The Tyger']);
  assert.deepEqual(S.blockLines('DIV', 'Of Gardens', true), ['# Of Gardens']);
  assert.deepEqual(S.blockLines('P', '::: center\nTyger Tyger\n:::\n'), ['::: center', 'Tyger Tyger', ':::']);
  assert.deepEqual(S.blockLines('BLOCKQUOTE', 'An epigraph,\nin prose.'), ['> An epigraph,', '> in prose.']);
  assert.deepEqual(S.blockLines('PRE', '::: center\ncode\n:::'), ['<pre>'], 'code is never read for markers');
  assert.deepEqual(S.blockLines('HR', ''), ['<hr>']);
  const p = text => ({ tag: 'P', text });
  const page = [{ tag: 'DIV', text: 'Of Tygers', title: true }, p('::: center\nTyger Tyger, burning bright,\nIn the forests of the night;'), p('What immortal hand or eye,\nCould frame thy fearful symmetry?\n:::'),
    p('::: right\n— Blake\n:::'), p(PROSE), p('::: center dropcap'), p('Verse again.'), p(':::'), { tag: 'PRE', text: ':::' }];
  const got = S.blockMarks(page).map(m => S.alignClasses(m).join(' ').replace(/scriptorium-/g, ''));
  assert.deepEqual(got, ['', 'align align-center', 'align align-center opens', 'align align-right opens', '',
    'align align-center align-dropcap align-fence', 'align align-center align-dropcap', 'align align-center align-dropcap align-fence', '']);
  const m = S.blockMarks(page);
  assert.deepEqual([m[1].first, m[1].last, m[2].first, m[2].last, m[3].first, m[3].last], [true, false, false, true, true, true]);
  // the note's own alignment comes with the page (its properties are not on it)
  assert.deepEqual(S.blockMarks([p('One.'), { tag: 'H2', text: 'Two' }], { align: 'right', dropcap: false }).map(x => x.align), ['right', 'right']);
  assert.deepEqual(S.blockMarks([p('One.')]), [null]);
});

test('aligned text: marks are classes on the block, set and taken away again', () => {
  const classes = new Set(['el-p']);
  const el = { tagName: 'DIV', firstElementChild: null, textContent: '', classList: { contains: c => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
  assert.equal(S.markAligned(el, { align: 'center', dropcap: false, first: false, last: true, fence: false, opens: true }), true);
  assert.deepEqual([...classes].sort(), ['el-p', 'scriptorium-align', 'scriptorium-align-center', 'scriptorium-opens']);
  assert.equal(S.markAligned(el, { align: 'center', dropcap: false, first: false, last: true, fence: false, opens: true }), false, 'nothing changed');
  assert.equal(S.markAligned(el, { align: 'right', dropcap: true, first: false, last: false, fence: false, opens: false }), true);
  assert.deepEqual([...classes].sort(), ['el-p', 'scriptorium-align', 'scriptorium-align-dropcap', 'scriptorium-align-right']);
  assert.equal(S.markAligned(el, null), true);
  assert.deepEqual([...classes], ['el-p']);
});

test('aligned text: the commands put the selection’s paragraphs between markers, change them, and take them out again exactly', () => {
  const note = ['---', 'dropcap: goudy', '---', '## Verse', 'Tyger Tyger, burning bright,', 'In the forests of the night;', '', 'What immortal hand or eye,', 'Could frame thy fearful symmetry?', '', PROSE, ''];
  const run = (lines, from, to, kind) => S.applyLineEdits(lines, S.alignEdits(lines, from, to, kind));
  // the cursor in a paragraph: the whole paragraph, and no further than the heading above it
  const one = run(note, 5, 5, 'center');
  assert.deepEqual(one.slice(3, 9), ['## Verse', '::: center', 'Tyger Tyger, burning bright,', 'In the forests of the night;', ':::', '']);
  assert.deepEqual(plan(one.join('\n')).ranges.map(r => [r.align, r.open, r.close]), [['center', 4, 7]], 'what the command writes is a block');
  assert.deepEqual(run(one, 6, 6, null), note, 'and “Remove alignment” gives the note back exactly');
  // a selection over two paragraphs (and the blank lines at its ends do not count)
  const two = run(note, 4, 9, 'right');
  assert.deepEqual(two.slice(4, 12), ['::: right', 'Tyger Tyger, burning bright,', 'In the forests of the night;', '', 'What immortal hand or eye,', 'Could frame thy fearful symmetry?', ':::', '']);
  assert.deepEqual(run(two, 4, 4, null), note, 'from a marker line too');
  // every round trip: any one line, either alignment
  for (let i = 3; i < note.length; i++) for (const kind of ['center', 'right']) {
    const there = run(note, i, i, kind);
    if (/\S/.test(note[i])) {
      assert.equal(there.length, note.length + 2, `line ${i}`);
      assert.equal(plan(there.join('\n')).ranges.length, 1, `line ${i}`);
      assert.deepEqual(run(there, S.lineAfterEdits(S.alignEdits(note, i, i, kind), i), S.lineAfterEdits(S.alignEdits(note, i, i, kind), i), null), note, `line ${i}`);
    } else assert.deepEqual(there, note, 'a blank line: nothing to align');
  }
  // the last line of a note without a line break at its end
  const bare = ['One.', '', 'Two.'];
  assert.deepEqual(run(bare, 2, 2, 'center'), ['One.', '', '::: center', 'Two.', ':::']);
  assert.deepEqual(run(run(bare, 2, 2, 'center'), 3, 3, null), bare);
  // text that is aligned already: the other alignment changes the marker and keeps what else it says; the same one changes nothing
  assert.deepEqual(S.alignEdits(one, 5, 5, 'right'), [{ line: 4, text: '::: right' }]);
  assert.deepEqual(S.alignEdits(['::: {.centre .dropcap}', 'verse', ':::'], 1, 1, 'right'), [{ line: 0, text: '::: {.right .dropcap}' }]);
  assert.deepEqual(S.alignEdits(one, 5, 5, 'center'), []);
  assert.deepEqual(S.alignEdits(note, 5, 5, null), [], 'nothing to remove');
  assert.deepEqual(S.alignEdits(note, 0, 1, 'center'), [], 'the properties are not text');
  // a heading that stands against the paragraph above it: the opening marker needs a blank line, which is made
  const tight = ['Some prose.', '## Verse', 'A line.'];
  assert.deepEqual(run(tight, 1, 1, 'center'), ['Some prose.', '', '::: center', '## Verse', 'A line.', ':::']);
  assert.equal(plan(run(tight, 1, 1, 'center').join('\n')).ranges.length, 1);
  // where the selection's lines are afterwards
  const edits = S.alignEdits(note, 5, 5, 'center');
  assert.deepEqual([S.lineAfterEdits(edits, 3), S.lineAfterEdits(edits, 4), S.lineAfterEdits(edits, 5), S.lineAfterEdits(edits, 6)], [3, 5, 6, 8]);
  const out = S.alignEdits(one, 5, 5, null);
  assert.deepEqual([S.lineAfterEdits(out, 4), S.lineAfterEdits(out, 5), S.lineAfterEdits(out, 7), S.lineAfterEdits(out, 8)], [4, 4, 6, 6]);
});

test('aligned text: the commands for a drop cap write “dropcap” on the block’s marker and take it off again', () => {
  const lines = ['## Verse', '', '::: center', ...VERSE, ':::', '', PROSE];
  const on = S.alignDropcapEdits(lines, 3, true);
  assert.deepEqual(on, [{ line: 2, text: '::: center dropcap' }]);
  const with_ = S.applyLineEdits(lines, on);
  assert.deepEqual(S.alignDropcapEdits(with_, 4, true), [], 'it has one already');
  assert.deepEqual(S.applyLineEdits(with_, S.alignDropcapEdits(with_, 5, false)), lines, 'on and off again: the note as it was');
  assert.deepEqual(S.alignDropcapEdits(lines, 3, false), []);
  assert.equal(S.alignDropcapEdits(lines, 7, true), null, 'not in an aligned block');
  assert.deepEqual(S.alignDropcapEdits(['::: {.right}', 'x', ':::'], 1, true), [{ line: 0, text: '::: {.right .dropcap}' }]);
  assert.deepEqual(S.alignDropcapEdits(['::: {.right .dropcap}', 'x', ':::'], 1, false), [{ line: 0, text: '::: {.right}' }]);
  assert.deepEqual(S.alignDropcapEdits(['::: center :::', 'x', ':::'], 1, true), [{ line: 0, text: '::: center dropcap' }]);
});

test('aligned text: the snippet sets it, shows no marker, gives it no drop cap unless asked, and opens the chapter after it', () => {
  const css = fs.readFileSync(path.join(VAULT, '.obsidian', 'snippets', 'manuscript.css'), 'utf8');
  assert.match(css, /\.scriptorium-align-center[^{]*\{\s*text-align: center !important;/);
  assert.match(css, /\.scriptorium-align-right[^{]*\{\s*text-align: right !important;/);
  assert.match(css, /\.is-live-preview \.cm-line\.scriptorium-align-center,[^{]*\{\s*text-align: center;/);
  assert.match(css, /\.is-live-preview \.cm-line\.scriptorium-align-right,[^{]*\{\s*text-align: right;/);
  assert.match(css, /\.scriptorium-align-fence,\s*\.markdown-rendered span\.scriptorium-fence \{\s*display: none;/);
  assert.match(css, /\.el-p\.scriptorium-align:not\(\.scriptorium-align-dropcap\) > p::first-letter \{[^}]*float: none !important;[^}]*font: inherit !important;/);
  assert.match(css, /\.el-p\.scriptorium-align:not\(\.scriptorium-align-dropcap\) > p::first-line \{[^}]*font-variant-caps: normal !important;/);
  assert.match(css, /\.el-p\.scriptorium-align:not\(\.scriptorium-align-dropcap\) > p::before \{\s*content: none !important;/, 'nor a drop cap that is an image');
  assert.match(css, /\.el-p\.scriptorium-align-dropcap:not\(\.scriptorium-dropcap-none\) > p::first-letter,[^{]*\{\s*float: none;/, 'a drop cap that was asked for stands on its line');
  assert.match(css, /\.scriptorium-align-dropcap\.scriptorium-dropcap-image > p::before,[^{]*\{\s*float: none;\s*position: absolute;/, 'and so does one that is an image');
  // every rule for a chapter opening takes .scriptorium-opens as it takes a heading
  assert.doesNotMatch(css, /:is\(\.mod-header, \.el-h1, \.el-h2, \.el-h6\)/);
  const single = css.split('\n').filter(l => /\.markdown-rendered \.el-h6 \+ \.el-p > p/.test(l));
  assert.ok(single.length >= 5);
  for (const l of single) assert.ok(css.includes(l.replace('.el-h6 + .el-p', '.scriptorium-opens + .el-p')), l);
});

test('aligned text: the plugin registers its commands by id, and everything that must travel is in the plugin and the snippet', () => {
  const src = fs.readFileSync(path.join(VAULT, '.obsidian', 'plugins', 'scriptorium', 'main.js'), 'utf8');
  for (const id of ['align-center', 'align-right', 'align-remove', 'aligned-dropcap-on', 'aligned-dropcap-off']) assert.ok(src.includes(`'${id}'`), id);
  for (const name of ['Centre selection', 'Right-align selection', 'Remove alignment', 'Use a drop cap on this aligned paragraph', 'Remove the drop cap from this aligned paragraph']) assert.ok(src.includes(name), name);
  assert.match(src, /Also on centred and right-aligned text/);
});

// ---- Drop caps in Live Preview: which lines of the note open a chapter, and what they are given ----

const openings = text => S.openingPlan(text.split('\n'));
const openLines = text => openings(text).map(o => o.line);

test('drop caps in Live Preview: the note is read into the blocks Reading view draws', () => {
  const blocks = text => S.noteBlocks(text.split('\n'), 0).map(b => `${b.type}${b.level || ''}:${b.from}-${b.to}`);
  assert.deepEqual(blocks('# One\nText under it\nand its second line\n\n> a quote\nlazily continued\n\n> [!note] A callout\n> text'),
    ['heading1:0-0', 'p:1-2', 'quote:4-5', 'other:7-8']);
  assert.deepEqual(blocks('Title\n=====\n\nA paragraph\n-----\n\n---\n\n***'), ['heading1:0-1', 'heading2:3-4', 'other:6-6', 'other:8-8'], 'headings underlined, and rules');
  assert.deepEqual(blocks('```js\n\n# not a heading\n```\nAfter\n\n~~~\nopen to the end'), ['other:0-3', 'p:4-4', 'other:6-7'], 'code, closed or not');
  assert.deepEqual(blocks('- one\n- two\n\n- three\n\n  set in\n\nAfter the list'), ['other:0-5', 'p:7-7'], 'a list keeps its items and what is set in under them');
  assert.deepEqual(blocks('Text\n- a list right under it\n\nText\n2. no list: only 1. begins one there'), ['p:0-0', 'other:1-1', 'p:3-4']);
  assert.deepEqual(blocks('$$\nx\n\ny\n$$\n\n$$x$$\n\n%%\na comment\n\nstill\n%%\n\n%% in a line %% text'), ['other:0-4', 'other:6-6', 'other:8-12', 'p:14-14'], 'mathematics and comments run over blank lines');
  assert.deepEqual(blocks('| a | b |\n| - | - |\n| 1 | 2 |\n\n<div>\nhtml\n</div>\n\n[^1]: a note\n    set in\n\nAfter it\n\n    code set in'), ['other:0-2', 'other:4-6', 'other:8-9', 'p:11-11', 'other:13-13']);
  assert.deepEqual(blocks('a | b\nno table without its rule'), ['p:0-1']);
  assert.deepEqual(S.noteBlocks(['---', 'a: 1', '---', 'Text'], 3).map(b => b.from), [3], 'the properties are no block of the text');
});

test('drop caps in Live Preview: the paragraphs that open a chapter are the ones Reading view gives a drop cap', () => {
  assert.deepEqual(openLines('First paragraph.\n\nSecond.'), [0], 'the top of a note without properties');
  assert.deepEqual(openLines('\n\nFirst paragraph.'), [2]);
  assert.deepEqual(openLines('---\ntags: [a]\n---\nFirst paragraph.\n\n# One\n\nUnder it.'), [7], 'not under properties: the snippet opens no chapter there either');
  assert.deepEqual(openLines('# One\nRight under it.\n\n## Two\n\nUnder two.\n\n###### Six\n\nUnder six.\n\nNot this one.'), [1, 5, 9]);
  assert.deepEqual(openLines('### Three\n\nNo.\n\n#### Four\n\nNo.\n\n##### Five\n\nNo.'), [], 'only headings 1, 2 and 6');
  assert.deepEqual(openLines('Title\n=====\n\nUnder it.\n\nSub\n---\n\nUnder that.'), [3, 8], 'headings underlined');
  assert.deepEqual(openLines('## Two\n\n> An epigraph,\n> in two lines.\n\nAfter the epigraph.\n\nNo.'), [5], 'one quotation may stand between');
  assert.deepEqual(openLines('## Two\n\n> One.\n\n> Two.\n\nNo.'), [], 'one, not two');
  assert.deepEqual(openLines('## Two\n\n> [!note] A callout\n> text\n\nNo.'), [], 'a callout is no epigraph');
  for (const between of ['- a list', '1. a list', '```\ncode\n```', '---', '| a | b |\n| - | - |', '$$\nx\n$$', '<div>html</div>', '[^1]: a footnote', '%%\na comment\n%%', '    code set in', '### A smaller heading']) {
    assert.deepEqual(openLines(`## Two\n\n${between}\n\nNo.`), [], between);
  }
  assert.deepEqual(openLines('## Two\n\nA paragraph of\nthree lines\nin the note.\n\nNo.'), [2], 'the paragraph’s first line');
  assert.deepEqual(openLines('## Two\n- a list right under the heading\n\nNo.'), []);
  assert.deepEqual(openLines('## Two\n\n```\n## not a heading\n\nNot a paragraph.\n```'), []);
  // the paragraph is there, and opens the chapter, but has no letter to set
  for (const lead of ['![[picture.png]]', '![alt](picture.png) text', '$x$ is a number.', '%% a comment %%', '<span>marked up</span> text']) {
    assert.deepEqual(openLines(`## Two\n\n${lead}\n\nNo.`), [], lead);
  }
  const led = text => openings(`## Two\n\n${text}`).map(o => o.led);
  assert.deepEqual(led('Plain words.'), [false]);
  assert.deepEqual(led('“Quoted,” she said.'), [false], 'a quotation mark is part of the initial in both views');
  for (const text of ['**Bold** words.', '*Emphasis* first.', '_Emphasis_ first.', '[[A link]] first.', '[A link](https://example.com) first.', '==Marked== first.', '~~Struck~~ first.', '`code` first.']) assert.deepEqual(led(text), [true], text);
});

test('drop caps in Live Preview: aligned text has none unless it asks, a standing initial if it does, and the chapter opens after it', () => {
  const VERSE2 = ['Tyger Tyger, burning bright,', 'In the forests of the night;'];
  const block = (kind, ...lines) => [`::: ${kind}`, ...lines, ':::', ''];
  const text = ['## Verse', '', ...block('center', ...VERSE2), ...block('right', '— Blake'), 'The prose after it.', '', 'No.'].join('\n');
  assert.deepEqual(openings(text).map(o => [o.line, o.standing]), [[11, false]], 'the first paragraph that is not aligned');
  const asked = ['## Verse', '', ...block('center dropcap', ...VERSE2), 'The prose after it.'].join('\n');
  assert.deepEqual(openings(asked).map(o => [o.line, o.standing, o.text]), [[3, true, VERSE2.join('\n')]], 'the line after the marker, and not the paragraph after the block');
  // an initial that is a word by itself: the space after it is marked (Reading view sets none at the head of the line)
  const gap = line => openings(`## Two\n\n${line}`).map(o => o.gap);
  assert.deepEqual(gap('A body at rest stays at rest.'), [[1, 2]]);
  assert.deepEqual(gap('“I” is a word by itself.'), [[3, 4]]);
  assert.deepEqual(gap('**A** body, in bold.'), [[5, 6]]);
  assert.deepEqual(gap('At rest a body stays.'), [null]);
  assert.deepEqual(gap('A'), [null]);
  assert.deepEqual(gap('::: center dropcap\nA body at rest\n:::'), [null], 'beside a standing initial the space is a space');
  const note = ['---', 'align: center', '---', '## Verse', '', ...VERSE2, '', 'More.'].join('\n');
  assert.deepEqual(openLines(note), [], 'a note that is centred as a whole');
  assert.deepEqual(openings(note.replace('align: center', 'align: center\ndropcap-aligned: true')).map(o => [o.line, o.standing]), [[6, true]]);
  assert.deepEqual(openLines(['## Verse', '', '::: center dropcap', '', ...VERSE2, '', ':::', '', 'Prose.'].join('\n')), [4], 'markers that stand apart from the stanza');
  assert.deepEqual(openLines(['## Verse', '', '::: center', ':::', '', 'Prose.'].join('\n')), [5], 'a block of nothing but its markers');
});

test('drop caps in Live Preview: the note’s own choice is read from its lines, as its properties will say it', () => {
  const said = (...props) => { const lines = ['---', ...props, '---', 'Text']; return S.linesDropcap(lines, props.length + 2); };
  assert.equal(said('dropcap: goudy'), 'goudy');
  assert.equal(said('tags: [a]', 'dropcap: "Goudy Initialen"'), 'goudy');
  assert.equal(said('dropcap: none'), 'none');
  assert.equal(said('dropcap: false'), 'none');
  assert.equal(said('dropcap: Dropcat   # the cats'), 'set:Dropcat');
  assert.equal(said("drop-cap: 'plain'"), 'plain');
  assert.equal(said('dropcap:'), null);
  assert.equal(said('title: dropcap: goudy'), null);
  assert.equal(said('dropcap: yinit', 'drop-cap: goudy'), 'yinit', 'the same key first as noteDropcap');
  assert.equal(S.linesDropcap(['dropcap: goudy', 'Text'], 0), null, 'only in the properties');
  for (const v of ['goudy', 'Plain capital', 'none', 'My initials', 'no']) assert.equal(said(`dropcap: ${v}`), S.noteDropcap({ dropcap: v }), v);
});

test('drop caps in Live Preview: a line is read as it is shown (its opening words choose a drop cap’s image)', () => {
  assert.equal(S.shownLine('**Bold** and *emphasis* and _this_ and ==marked== and ~~struck~~ and `code`.'), 'Bold and emphasis and this and marked and struck and code.');
  assert.equal(S.shownLine('[[A note]] and [[A note|its name]] and [a link](https://example.com/a_b).'), 'A note and its name and a link.');
  assert.equal(S.shownLine('snake_case stays, 2 * 3 loses its star only'), 'snake_case stays, 2  3 loses its star only');
  assert.equal(S.shownLine('A note[^1] with %%a comment%% and ![[a picture.png]] and <b>html</b>.'), 'A note with  and  and html.');
  assert.equal(S.shownLine('\\*not emphasis\\* and \\[no link\\]'), '*not emphasis* and [no link]', 'an escaped mark is a character');
  assert.equal(openings('## Two\n\n**Tyger** Tyger,\nburning bright.   \n\nNo.')[0].text, 'Tyger Tyger,\nburning bright.');
});

test('drop caps in Live Preview: an opening line is given the classes and properties a block of Reading view is given', () => {
  const o = { line: 2, text: 'Tyger Tyger, burning bright', standing: false, led: false };
  const line = (...args) => S.openingLine(o, ...args);
  assert.deepEqual(line(null, null, 'yinit', 'a.md'), { classes: 'scriptorium-opening', style: '' }, 'the vault’s: the classes on body do the rest');
  assert.deepEqual(line('goudy', null, 'yinit', 'a.md'), { classes: 'scriptorium-opening scriptorium-dropcap scriptorium-dropcap-goudy', style: '' });
  assert.equal(line('none', null, 'yinit', 'a.md'), null, 'the note says none');
  assert.equal(line(null, null, 'none', 'a.md'), null, 'the vault says none');
  assert.ok(line('plain', null, 'none', 'a.md'), 'the note’s choice outranks the vault’s None');
  assert.equal(S.openingLine(Object.assign({}, o, { standing: true }), null, null, 'yinit', 'a.md').classes, 'scriptorium-opening scriptorium-align-dropcap');
  assert.equal(line(null, null, 'yinit', 'a.md', null, true).classes, 'scriptorium-opening scriptorium-dropcap-inked');
  const font = { kind: 'font', family: 'Scriptorium Set Kanzlei', size: 3.95, margin: '0.2em 0.12em -0.1em 0' };
  const f = line('set:Kanzlei', font, 'yinit', 'a.md');
  assert.equal(f.classes, 'scriptorium-opening scriptorium-dropcap scriptorium-dropcap-font');
  assert.match(f.style, /--scriptorium-initial-font: "Scriptorium Set Kanzlei", var\(--manuscript-display\); --scriptorium-initial-size: 3\.95em; --scriptorium-initial-margin: 0\.2em 0\.12em -0\.1em 0/);
  const images = { kind: 'images', mono: true, letters: { T: { light: ['app://x/T-1.png', 'app://x/T-2.png'], dark: ['app://x/T-dark.png'] } } };
  const i = line('set:Cats', images, 'yinit', 'a.md', url => (url.includes('dark') ? 0 : 1.25));
  assert.equal(i.classes, 'scriptorium-opening scriptorium-dropcap scriptorium-dropcap-image scriptorium-dropcap-mono');
  assert.match(i.style, /--scriptorium-dropcap-light: url\("app:\/\/x\/T-[12]\.png"\); --scriptorium-dropcap-dark: url\("app:\/\/x\/T-dark\.png"\); --scriptorium-dropcap-ratio: 1\.25$/);
  // the same image as Reading view chooses for the same paragraph of the same note
  const el = { classList: { list: [], add(...c) { this.list.push(...c); }, remove() {}, [Symbol.iterator]: function* () {} }, style: { set: {}, setProperty(k, v) { this.set[k] = v; }, removeProperty() {} },
    querySelector: () => ({ childNodes: null, textContent: o.text }) };
  S.markDropcap(el, 'set:Cats', images, 'a.md');
  assert.ok(i.style.includes(`--scriptorium-dropcap-light: ${el.style.set['--scriptorium-dropcap-light']}`));
  // a set without the paragraph's letter: the vault's drop cap, or none if the vault has none
  const noT = { kind: 'images', letters: { B: { light: ['app://x/B.png'] } } };
  assert.deepEqual(line('set:Cats', noT, 'goudy', 'a.md'), { classes: 'scriptorium-opening', style: '' });
  assert.equal(line('set:Cats', noT, 'none', 'a.md'), null);
});

test('drop caps in Live Preview: the snippet sets the editor’s opening line with the rules it has for Reading view, in Live Preview only', () => {
  const css = fs.readFileSync(path.join(VAULT, '.obsidian', 'snippets', 'manuscript.css'), 'utf8').replace(/url\("data:[^"]*"\)/g, 'url()');
  const LP = '.markdown-source-view.mod-cm6.is-live-preview .cm-line.scriptorium-opening';
  // every rule for the paragraph after an epigraph has the editor's line in its list of selectors (so: the same declarations)
  const rules = css.split('}').map(r => r.slice(0, r.indexOf('{') < 0 ? r.length : r.indexOf('{'))).filter(sel => /\.el-blockquote \+ \.el-p[^,]*$/.test(sel.trim()) && !/scriptorium-initials-none|@media print|hyphens/.test(sel));
  assert.ok(rules.length >= 15, String(rules.length));
  for (const sel of rules) {
    if (/^\s*(?:@media[^{]*\{\s*)?\.markdown-rendered :is\(/.test(sel) && /-none/.test(sel)) continue;   // "None" is said in the plugin: such a line is not an opening line at all
    assert.ok(sel.includes(LP), sel.trim().slice(-160));
  }
  for (const mode of [':where(body:not(.scriptorium-fancy))', ':where(body.scriptorium-fancy)']) {
    assert.ok(css.includes(`${mode} ${LP}::first-letter,`), mode);
    assert.ok(css.includes(`${mode} ${LP}::first-line,`), mode);
  }
  assert.ok(css.includes(`:where(body:not(.scriptorium-fancy)) ${LP}:not(.scriptorium-align-dropcap),`), 'the opening paragraph is not justified in normal mode');
  for (const which of ['goudy', 'plain', 'yinit', 'font', 'image']) assert.ok(css.includes(`.cm-line.scriptorium-dropcap-${which}`), which);
  // Source mode stays plain: no rule reaches an opening line outside Live Preview
  for (const line of css.split('\n')) if (line.includes('.cm-line.scriptorium-opening')) assert.ok(line.includes('.is-live-preview '), line.slice(0, 160));
  assert.match(css, /\.cm-line\.scriptorium-opening \.sc-keep,\s*\.markdown-rendered \.sc-keep \{\s*white-space: nowrap;/);
});

test('drop caps in Live Preview: the plugin registers the extension, never changes the note for it, and previews in the editor too', () => {
  const src = fs.readFileSync(path.join(VAULT, '.obsidian', 'plugins', 'scriptorium', 'main.js'), 'utf8');
  assert.match(src, /this\.dropcapLive = dropcapExtension\(this\); this\.registerEditorExtension\(this\.dropcapLive\.extension\)/);
  const ext = src.slice(src.indexOf('function dropcapExtension('), src.indexOf('Export to PDF: the page as Reading view sets it'));
  assert.doesNotMatch(ext, /changes\s*:/, 'decorations only: no change to the text');
  assert.doesNotMatch(ext, /Decoration\.(?:replace|widget)/, 'the letter stays the note’s own text');
  assert.match(ext, /Decoration\.line\(/);
  assert.match(src, /previewDropcap\(view, which, quiet\) \{\s*this\.previewLive\(view, which, quiet\);/);
  assert.equal(typeof S.dropcapExtension, 'function');
});
