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
    return { Plugin: Stub, PluginSettingTab: Stub, Setting: Stub, MarkdownView: Stub, MarkdownRenderer: Stub, Component: Stub, Scope: Stub };
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
