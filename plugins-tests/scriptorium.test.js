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
    [{ dropcap: 'comic-sans' }, null], [{ dropcap: '' }, null], [{ dropcap: true }, null], [{ dropcap: 3 }, null], [{ dropcap: null }, null],
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
