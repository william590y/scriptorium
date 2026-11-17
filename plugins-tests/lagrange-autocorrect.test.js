// Unit tests for Lagrange's autocorrect (1.5.0): which words are looked at (finished, in prose, not set apart on
// purpose), what is never touched (code, mathematics, front matter, links and the like), what counts as a slip of
// typing, the dictionary's suggestion taken, and what a model's reply is allowed to change. The pen correcting as
// the writer types is checked in a real Obsidian by plugins-tests/autocorrect.harness.js.
//
// Run from the repository root:   node --test plugins-tests/lagrange-autocorrect.test.js
//
// Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
function stubModule() {
  return new Proxy({}, { get(target, key) { if (!(key in target)) target[key] = class { static define() { return {}; } }; return target[key]; } });
}
const stubs = { obsidian: stubModule(), '@codemirror/state': stubModule(), '@codemirror/view': stubModule() };
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};
const plugin = require(path.join(ROOT, 'vault', '.obsidian', 'plugins', 'lagrange', 'main.js'));
Module._load = realLoad;
const L = plugin.internals;

const words = (text, from, to, cursor) => L.wordsToCheck(text, from == null ? 0 : from, to == null ? text.length : to, cursor == null ? text.length : cursor).map(w => w.word);

test('Autocorrect is off unless the writer turns it on, and its setting is one of three', () => {
  // (the settings are sanitised on loading: an unknown value falls back to off)
  assert.deepEqual(L.AUTOCORRECT_MODES, ['off', 'dictionary', 'model']);
  const src = require('node:fs').readFileSync(path.join(ROOT, 'vault', '.obsidian', 'plugins', 'lagrange', 'main.js'), 'utf8');
  assert.match(src, /autocorrect: 'off',/);
  assert.match(src, /if \(!\['off', 'dictionary', 'model'\]\.includes\(s\.autocorrect\)\) s\.autocorrect = DEFAULT_SETTINGS\.autocorrect;/);
  const shipped = JSON.parse(require('node:fs').readFileSync(path.join(ROOT, 'vault', '.obsidian', 'plugins', 'lagrange', 'data.json'), 'utf8'));
  assert.ok(shipped.autocorrect === undefined || shipped.autocorrect === 'off', 'the vault ships with autocorrect off');
});

test('wordsToCheck: the words the writer has finished in the typed range; never the word at the cursor or at the end', () => {
  assert.deepEqual(words('I recieve teh letter '), ['I', 'recieve', 'teh', 'letter'].filter(w => w.length >= 2));
  assert.deepEqual(words('I recieve teh lett'), ['recieve', 'teh'], 'the last word runs to the end of the note: still being typed');
  const t = 'Some teh text here.';
  assert.deepEqual(words(t, 0, t.length, t.indexOf('teh') + 3), ['Some', 'text', 'here'], 'the word at the cursor is left alone');
  assert.deepEqual(words('one two three four ', 4, 7), ['two'], 'only what the typing touched');
  assert.deepEqual(words('alpha beta ', 2, 3), ['alpha'], 'a word the range only touches is read whole');
  assert.deepEqual(words("don't wouldn’t well-known ", 0, 26), ["don't", 'wouldn’t', 'well-known']);
});

test('wordsToCheck: words set apart on purpose are left alone', () => {
  assert.deepEqual(words('NASA and JWST were here '), ['and', 'were', 'here'], 'capitals: abbreviations');
  assert.deepEqual(words('call getValue and iPhone now '), ['call', 'and', 'now'], 'capitals inside: identifiers and names');
  assert.deepEqual(words('h2o x_1 file.md me@ex.com C3PO ok '), ['ok'], 'digits, underscores, file names, addresses');
  assert.deepEqual(words('a b cd '), ['cd'], 'one letter is never a slip');
});

test('proseSkips: nothing in front matter, code, mathematics, links, tags and the like is ever looked at', () => {
  const note = [
    '---', 'title: Teh notte', 'tags: [recieve]', '---', '',
    'Prose wiht a slip.', '',
    '```python', 'def teh(): return recieve', '```', '',
    'Inline `teh code` and $teh + recieve$ and $$\\text{teh}$$ and \\(teh\\).', '',
    'A [[Teh link]] and ![[teh.png]] and [the tetx](https://teh.example/recieve) and https://www.teh.com/x and teh@mail.com.', '',
    '#tehtag and a footnote[^teh] and %%teh comment%% and <span class="teh">x</span>.', '',
    '> [!teh] A callout', '', '::: center', 'Centred tetx', ':::', '',
    '| teh | cell |', '|---|---|', '',
    'Last ^tehid', '',
    '```', 'unclosed code wiht teh', ''].join('\n');
  const got = words(note);
  for (const w of ['wiht', 'tetx', 'Prose', 'slip', 'Centred', 'Last', 'callout']) assert.ok(got.includes(w), `${w} is prose`);
  for (const w of ['teh', 'recieve', 'notte', 'tehtag', 'tehid', 'center', 'cell']) assert.ok(!got.includes(w), `${w} is not prose`);
  assert.equal(got.filter(w => w === 'wiht').length, 1, 'the slip in the unclosed code block is left alone');
  // a $ that is not closed yet: the formula still being typed is not prose either
  assert.deepEqual(words('Money: and $x + teh is open '), ['Money', 'and']);
});

test('typoDistance and typoLimit: letters added, left out, changed or swapped count one each', () => {
  assert.equal(L.typoDistance('teh', 'the'), 1);
  assert.equal(L.typoDistance('recieve', 'receive'), 1);
  assert.equal(L.typoDistance('acomodate', 'accommodate'), 2);
  assert.equal(L.typoDistance('kitten', 'sitting'), 3);
  assert.equal(L.typoDistance('', 'ab'), 2);
  assert.equal(L.typoDistance('same', 'same'), 0);
  assert.equal(L.typoLimit('teh'), 1);
  assert.equal(L.typoLimit('wiht'), 1);
  assert.equal(L.typoLimit('recieve'), 2);
});

test('typoFix: the dictionary’s first suggestion that is a slip of typing away, in the word’s capitals', () => {
  assert.equal(L.typoFix('teh', ['the', 'eh', 'tech']), 'the');
  assert.equal(L.typoFix('Teh', ['the', 'eh']), 'The', 'a capital stays a capital');
  assert.equal(L.typoFix('recieve', ['receive', 'relieve']), 'receive');
  assert.equal(L.typoFix('alot', ['a lot', 'allot']), 'a lot', 'two words run together');
  assert.equal(L.typoFix('dont', ["don't", 'font']), "don't");
  assert.equal(L.typoFix('xqzt', ['quartz', 'text']), null, 'nothing near enough: left alone');
  assert.equal(L.typoFix('london', ['London']), null, 'only the capital differs');
  assert.equal(L.typoFix('lodnon', ['London']), null, 'a name typed in small letters is the writer’s to capitalise');
  assert.equal(L.typoFix('teh', []), null);
  assert.equal(L.typoFix('teh', ['the1', 'th-']), null, 'not made of letters');
  assert.equal(L.typoFix('Thier', ['Shier', 'Thieu', 'Their']), 'Their', 'the first letter kept, and letters swapped before a letter changed');
  assert.equal(L.typoFix('Thier', ['Thieu', 'their']), 'Their', 'a word in small letters before a name');
  assert.equal(L.typoFix('hte', ['hate', 'the']), 'the', 'its first two letters swapped count as kept');
  assert.equal(L.typoFix('wiht', ['whit', 'with']), 'with', 'between two as near, the common word');
  assert.equal(L.typoFix('tehx', ['the']), null, 'two slips in a word of four letters: too far');
  assert.equal(L.typoFix('aple', ['maple', 'apple']), 'apple', 'the first letter kept wins over the list’s order');
  assert.equal(L.typoFix('', ['the']), null);
});

test('meantWord: a capitalised word inside a sentence (a name), or a word the note uses three times, is meant', () => {
  const t = 'We met Keziah at noon. Keziah left. Then I wrote teh note, teh other, teh last.';
  assert.equal(L.meantWord(t, { word: 'Keziah', from: t.indexOf('Keziah') }), true);
  assert.equal(L.meantWord('Teh start', { word: 'Teh', from: 0 }), false, 'the first word of the note');
  assert.equal(L.meantWord('One. Teh next', { word: 'Teh', from: 5 }), false, 'after a full stop');
  assert.equal(L.meantWord('- Teh item', { word: 'Teh', from: 2 }), false, 'a list item');
  assert.equal(L.meantWord('# Teh heading', { word: 'Teh', from: 2 }), false);
  assert.equal(L.meantWord(t, { word: 'teh', from: t.indexOf('teh') }), true, 'used three times');
  assert.equal(L.meantWord('I wrote teh note.', { word: 'teh', from: 8 }), false);
});

test('modelTypoFixes: only slips of typing in the words asked about; a rewording or another word is left out', () => {
  const asked = [{ word: 'teh' }, { word: 'form' }, { word: 'recieve' }, { word: 'quick' }];
  const reply = 'Here:\n[{"find": "teh", "replace": "the"}, {"find": "form", "replace": "from"}, {"find": "recieve", "replace": "obtain"},' +
    ' {"find": "quick", "replace": "fast"}, {"find": "brown", "replace": "brwn"}, {"find": "teh", "replace": "the"}, {"find": "form", "replace": "f0rm"}]';
  assert.deepEqual(L.modelTypoFixes(reply, asked), [{ find: 'teh', replace: 'the' }, { find: 'form', replace: 'from' }]);
  assert.deepEqual(L.modelTypoFixes('[]', asked), []);
  assert.deepEqual(L.modelTypoFixes('not json', asked), []);
  assert.deepEqual(L.modelTypoFixes('{"edits": [{"find": "teh", "replace": "The"}]}', asked), [{ find: 'teh', replace: 'The' }]);
});

test('The model is told to correct only slips of typing in the words just typed, and to answer with JSON', () => {
  assert.match(L.AUTOCORRECT_SYSTEM, /Correct only slips of typing and misspellings among those words/);
  assert.match(L.AUTOCORRECT_SYSTEM, /Change nothing else/);
  assert.match(L.AUTOCORRECT_SYSTEM, /\[\{"find": "the word as typed", "replace": "the corrected word"\}\]/);
  for (const [k, v] of Object.entries(L.DEMO_TYPOS)) assert.ok(L.typoDistance(k, v) <= L.typoLimit(k), `the demo’s ${k} -> ${v} is a slip of typing`);
});
