const { Plugin, PluginSettingTab, Setting, MarkdownView, MarkdownRenderer, Component, Scope, Modal, Notice, Platform, requestUrl } = require('obsidian');

/* ==========================================================
   Settings
   ========================================================== */

const INITIALS = [
  ['yinit', 'Yinit (ornamental)'],
  ['goudy', 'Goudy Initialen (floriated)'],
  ['plain', 'Plain capital (Cormorant Garamond)'],
  ['none', 'None']
];
const DEFAULT_SETTINGS = { fancyMode: false, initials: 'yinit', marginalia: true, imageFocus: true };

/* Saved settings with every known key checked and defaulted; keys this version does not know are kept. */
function normalizeSettings(saved) {
  const settings = Object.assign({}, saved && typeof saved === 'object' ? saved : {}, DEFAULT_SETTINGS);
  if (saved && typeof saved === 'object') {
    for (const key of ['fancyMode', 'marginalia', 'imageFocus']) {
      if (typeof saved[key] === 'boolean') settings[key] = saved[key];
    }
    // one of the four built in, or a set of drop caps by name ("set:Dropcat", "set:My initials"; see "Sets of drop caps")
    if (INITIALS.some(([value]) => value === saved.initials) || (typeof saved.initials === 'string' && /^set:.+/.test(saved.initials))) settings.initials = saved.initials;
  }
  return settings;
}

/* ==========================================================
   A drop cap for one note
   ==========================================================
   A note can ask for a drop cap of its own with the property "dropcap" (yinit, goudy, plain, none, or the name of a
   set of drop caps); without it the note has the vault's (Settings → Scriptorium → Drop cap). "Scriptorium: Choose the drop cap for this note" sets
   it, showing each choice in the note as you move through the list. In Reading view (and wherever a note is
   rendered: embeds, hover previews, PDF export) the plugin marks each block of such a note with .scriptorium-dropcap
   and .scriptorium-dropcap-<which>; the snippet does the rest. */

const DROPCAP_KEYS = ['dropcap', 'drop-cap', 'dropCap', 'drop cap'];

/* The drop cap a note's properties ask for: 'yinit' | 'goudy' | 'plain' | 'none', 'set:<name>' for anything else
   that is written there (the name of a set of drop caps), or null (the vault's). Forgiving about case, about the
   labels in the settings ("Goudy Initialen") and about no/off/false for none. */
function noteDropcap(frontmatter) {
  if (!frontmatter || typeof frontmatter !== 'object') return null;
  let v;
  for (const k of DROPCAP_KEYS) if (k in frontmatter) { v = frontmatter[k]; break; }
  if (v === false) return 'none';
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  if (['none', 'no', 'off', 'false'].includes(t)) return 'none';
  if (t.startsWith('yinit')) return 'yinit';
  if (t.startsWith('goudy')) return 'goudy';
  if (t.startsWith('plain') || t.startsWith('cormorant')) return 'plain';
  return t ? `set:${v.trim()}` : null;
}

const DROPCAP_VARS = ['--scriptorium-dropcap-light', '--scriptorium-dropcap-dark', '--scriptorium-dropcap-ratio', '--scriptorium-dropcap-ratio-dark',
  '--scriptorium-initial-font', '--scriptorium-initial-size', '--scriptorium-initial-margin', '--scriptorium-initial-weight'];

/* A number from a text, the same each time (FNV-1a): which of a letter's several images a paragraph has. */
function seedOf(text) {
  let h = 2166136261;
  const t = String(text || '');
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
  return h >>> 0;
}

/* Marks (or unmarks) one rendered block with a drop cap: which is one of the four built in, or `set` is a set of
   drop caps (see "Sets of drop caps"). A set of images marks the block only if it has an image for the letter the
   block's paragraph begins with; otherwise the block keeps the vault's drop cap. Where a set has several images of a
   letter, `key` (the note's path) and the paragraph's opening words choose one, the same one each time the note is
   drawn. Returns the image chosen ({light, dark}), or null. */
function markDropcap(el, which, set, key) {
  for (const c of Array.from(el.classList)) if (c.startsWith('scriptorium-dropcap') && c !== 'scriptorium-dropcap-inked') el.classList.remove(c);
  if (el.style && el.style.removeProperty) for (const v of DROPCAP_VARS) el.style.removeProperty(v);
  if (set) {
    if (set.kind === 'font') {
      el.classList.add('scriptorium-dropcap', 'scriptorium-dropcap-font');
      el.style.setProperty('--scriptorium-initial-font', `"${set.family}", var(--manuscript-display)`);
      el.style.setProperty('--scriptorium-initial-size', `${set.size || 4.2}em`);
      el.style.setProperty('--scriptorium-initial-margin', set.margin || '0.1em 0.1em -0.12em 0');
      el.style.setProperty('--scriptorium-initial-weight', 'normal');
      return null;
    }
    const p = el.querySelector ? el.querySelector(':scope > p') : null;
    const text = p ? String(p.textContent || '') : '';
    const slot = p && set.letters[openingLetter(text)];
    if (!slot) return null;
    const seed = seedOf(`${key || ''}\n${text.slice(0, 48)}`);
    const one = v => (Array.isArray(v) ? v[seed % v.length] : v) || '';
    const image = { light: one(slot.light) || one(slot.dark), dark: one(slot.dark) || one(slot.light) };
    if (!image.light) return null;
    el.classList.add('scriptorium-dropcap', 'scriptorium-dropcap-image');
    if (set.mono) el.classList.add('scriptorium-dropcap-mono');
    const url = u => `url("${String(u).replace(/["\\\n]/g, encodeURIComponent)}")`;
    el.style.setProperty('--scriptorium-dropcap-light', url(image.light));
    el.style.setProperty('--scriptorium-dropcap-dark', url(image.dark));
    return image;
  }
  if (which && !which.startsWith('set:')) el.classList.add('scriptorium-dropcap', `scriptorium-dropcap-${which}`);
  return null;
}

/* The choices of the command: the vault's, then each drop cap built in, then each set, then the sets Scriptorium
   knows of but may not pass on (`missing`: the writer adds the font; the value is 'add:<name>'). */
function dropcapChoices(vaultInitials, sets, missing) {
  const all = INITIALS.map(([value, label]) => ({ value, label }))
    .concat((sets || []).map(set => ({ value: `set:${set.name}`, label: set.label })));
  const name = (all.find(c => c.value === vaultInitials) || all[0]).label;
  return [{ value: null, label: `The vault’s drop cap (${name})` }].concat(all,
    (missing || []).map(m => ({ value: `add:${m.name}`, label: `${m.name} (not included: add the font yourself)` })));
}

/* ==========================================================
   Sets of drop caps
   ==========================================================
   Beside the four built in, a drop cap can come from a set: a folder of images, one or several per letter, or a
   font of initials (one file, or one file per letter).
     - gwern.net shows eight kinds of initial (https://gwern.net/dropcap). Yinit and Goudy Initialen are built in.
       Five more come with Scriptorium as sets, in the plugin's dropcaps folder, as gwern.net publishes them: the
       fonts Kanzlei Initialen and Deutsche Zierschrift (one small font per letter), and a selection of the images
       Dropcat, Gene Wolfe and Ninit (CC0). The image sets have a few letters each (B C G I Q T; F T V; A B C): a
       paragraph that begins with another letter keeps the vault's drop cap. "Scriptorium: Download more drop caps
       from gwern.net" fetches every image of one of them into the vault, when the writer asks (dropcaps/gwern.json
       lists what there is). The eighth, Cheshire Initials, has terms that forbid passing it on, so it is named
       in the list but not included: a writer who has the font adds it as a set of their own.
     - The writer's own sets live in the vault, in "Scriptorium/Drop caps/<name>/": images named for their letter
       (A.svg, b.png, initial-C.svg, D-dark.png for the dark theme), or a font (.ttf, .otf, .woff, .woff2). An
       optional set.json gives {"mono": true} (the images are one colour and take the page's accent colour, drawn
       through a CSS mask, so they follow the light and dark themes), and for a font {"size": 4.2, "margin": "…"}.
       "Scriptorium: Add a set of drop caps" makes such a folder from files the writer picks, checking each one.
       A folder with the name of a set that comes with Scriptorium adds to that set (its letters come first).
   A set is named in a note's "dropcap" property by its name, and can be the vault's drop cap (Settings). An image
   takes the place of the paragraph's first letter: the snippet floats it where the initial would be and hides the
   letter itself, which stays in the text. */

const DROPCAP_FOLDER = 'Scriptorium/Drop caps';
const BUNDLED_SETS = [
  { name: 'Kanzlei Initialen', dir: 'kanzlei', about: 'blackletter', also: ['kanzlei'], meta: { size: 3.95, margin: '0.2em 0.12em -0.1em 0' } },
  { name: 'Deutsche Zierschrift', dir: 'de-zs', about: 'Rudolf Koch’s blackletter', also: ['de-zs', 'zierschrift'], meta: { size: 4.3, margin: '0.07em 0.1em -0.2em 0' } },
  { name: 'Dropcat', dir: 'dropcat', about: 'cats, from gwern.net', more: true },
  { name: 'Gene Wolfe', dir: 'gene-wolfe', about: 'wolves and suns, from gwern.net', more: true },
  { name: 'Ninit', dir: 'ninit', about: 'machines and flowers, from gwern.net', more: true },
];
/* Known, but not Scriptorium's to pass on: the writer fetches the font and adds it as a set of this name. */
const YOUR_OWN_SETS = [
  {
    name: 'Cheshire Initials', also: ['cheshire'], by: 'House of Lime (2001)',
    where: 'https://www.1001fonts.com/cheshire-initials-font.html',
    why: 'Its licence (the 1001Fonts Free For Commercial Use License) lets you download and use it, but not publish it, so Scriptorium cannot include it.',
    meta: { size: 4.1, margin: '0.12em 0.1em -0.12em 0' },
  },
];
const DROPCAP_IMAGE_MAX = 600 * 1024, DROPCAP_FONT_MAX = 3 * 1024 * 1024, DROPCAP_FETCH_MAX = 2 * 1024 * 1024;

/* The letter a paragraph opens with, as a capital A-Z ('' if it opens with anything else): the letter a drop cap
   image must show. Opening quotation marks and brackets are passed over. */
function openingLetter(text) {
  const m = String(text || '').match(/^[\s"'“”‘’«»(\[¿¡—–-]*(\p{L})/u);
  if (!m) return '';
  const c = m[1].normalize('NFD')[0].toUpperCase();
  return /^[A-Z]$/.test(c) ? c : '';
}

/* What a file of a set is, from its name: {letter, theme} for an image ('light' unless the name says dark), {font:
   true} for a font ({font: true, letter} for a font of one letter), or null. The letter is the first part of the
   name that is a single letter: "A.svg", "b.png", "initial-C.svg", "Goudy_D-dark.png", "Q-light-1-small-2x.png",
   "Kanzlei-Initialen-A.ttf". */
function dropcapFile(name) {
  const m = String(name || '').match(/^(.*)\.([A-Za-z0-9]+)$/);
  if (!m) return null;
  const ext = m[2].toLowerCase();
  const parts = m[1].split(/[-_ .]+/).filter(Boolean);
  const letter = parts.find(t => /^[A-Za-z]$/.test(t));
  if (['ttf', 'otf', 'woff', 'woff2'].includes(ext)) return letter ? { font: true, letter: letter.toUpperCase() } : { font: true };
  if (!['svg', 'png'].includes(ext)) return null;
  if (!letter) return null;
  return { letter: letter.toUpperCase(), theme: parts.some(t => /^dark$/i.test(t)) ? 'dark' : 'light' };
}

/* A set from its folder's file names and its set.json (if any): {name, label, kind: 'images' | 'font', mono, letters:
   {A: {light: [files], dark: [files]}}, font: file, fonts: {A: file}, size, margin}; null if the folder has nothing
   a set can use. */
function describeSet(name, files, meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const set = { name, label: typeof m.label === 'string' && m.label ? m.label : name, kind: 'images', mono: Boolean(m.mono), letters: {} };
  const fonts = {};
  for (const file of files.slice().sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
    const what = dropcapFile(file);
    if (!what) continue;
    if (what.font) {
      if (what.letter) { if (!fonts[what.letter]) fonts[what.letter] = file; } else if (!set.font) set.font = file;
      continue;
    }
    const slot = set.letters[what.letter] || (set.letters[what.letter] = {});
    (slot[what.theme] || (slot[what.theme] = [])).push(file);
  }
  if (Object.keys(set.letters).length) { delete set.font; return set; }
  if (!set.font && !Object.keys(fonts).length) return null;
  set.kind = 'font';
  if (Object.keys(fonts).length) set.fonts = fonts;
  set.family = `Scriptorium Set ${name.replace(/[^A-Za-z0-9 _-]/g, '')}`;
  if (typeof m.size === 'number' && m.size > 0.5 && m.size < 12) set.size = m.size;
  if (typeof m.margin === 'string' && /^[-0-9.a-z %]+$/i.test(m.margin)) set.margin = m.margin;
  return set;
}

/* The @font-face rules of a set that is a font: url gives a file's address. A font of one letter is asked for only
   where that letter is set, so one small file is read, not twenty-six. */
function fontFaces(set, url) {
  const face = (file, range) => `@font-face { font-family: "${set.family}"; src: url("${url(file)}"); font-display: block;${range ? ` unicode-range: ${range};` : ''} }`;
  const out = set.font ? [face(set.font, '')] : [];
  for (const [letter, file] of Object.entries(set.fonts || {})) {
    const hex = n => `U+${n.toString(16).toUpperCase()}`;
    out.push(face(file, `${hex(letter.charCodeAt(0))}, ${hex(letter.toLowerCase().charCodeAt(0))}`));
  }
  return out.join('\n');
}

/* A set's line in the lists: its name, what it is, and (a set of images) the letters it has. */
function setLabel(set, about) {
  const letters = set.kind === 'images' ? Object.keys(set.letters).sort() : [];
  const bits = [about, letters.length && letters.length < 26 ? letters.join(' ') : ''].filter(Boolean);
  return bits.length ? `${set.name} (${bits.join('; ')})` : set.name;
}

/* A name a set's folder can have: letters, digits, spaces, hyphens and underscores, 40 at most; '' if nothing is left. */
function setName(text) {
  return String(text || '').normalize('NFKC').replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
}

/* An SVG made safe to keep in the vault: scripts, foreign content, event handlers, and every reference outside the
   file are taken out. Returns {svg, removed} or {problem}. (A drop cap is only ever shown as an image, where none of
   these would run or load; this is so that the file is harmless wherever else it is opened.) */
function sanitizeSvg(text) {
  let t = String(text || '').replace(/^﻿/, '');
  if (/<!ENTITY/i.test(t)) return { problem: 'it declares XML entities' };
  if (!/<svg[\s>]/i.test(t)) return { problem: 'it is not an SVG image' };
  let removed = 0;
  const cut = re => { t = t.replace(re, () => { removed++; return ''; }); };
  cut(/<!DOCTYPE[^>]*>/gi);
  cut(/<\?xml-stylesheet[^>]*\?>/gi);
  for (const tag of ['script', 'foreignObject', 'iframe', 'object', 'embed', 'audio', 'video', 'animate', 'set', 'a']) {
    if (tag === 'a') { cut(/<a(\s[^>]*)?>/gi); cut(/<\/a\s*>/gi); continue; }   // a link's content stays, the link goes
    cut(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'));
    cut(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'));
  }
  cut(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi);
  cut(/\s+(?:xlink:)?href\s*=\s*(?:"(?!#|data:image\/(?:png|jpeg|gif);)[^"]*"|'(?!#|data:image\/(?:png|jpeg|gif);)[^']*')/gi);
  cut(/@import[^;]*;?/gi);
  cut(/url\(\s*(['"]?)(?!#|data:image\/(?:png|jpeg|gif);)[^)]*\1\s*\)/gi);
  cut(/(?:java|vb)script\s*:/gi);
  if (/<script|<foreignObject|\son[a-z]+\s*=|javascript\s*:/i.test(t)) return { problem: 'it holds script that could not be taken out' };
  return { svg: t, removed };
}

/* Checks one file picked for a set: {ok: true, name, kind: 'svg' | 'png' | 'font', letter, theme, bytes} with the
   bytes to store (an SVG's are the sanitised ones), or {ok: false, name, problem}. bytes is a Uint8Array. max is the
   largest image taken (600 kB unless given). */
function checkDropcapFile(name, bytes, max) {
  const what = dropcapFile(name);
  const no = problem => ({ ok: false, name, problem });
  if (!what) return no('its name has no single letter in it (name each image for its letter: A.svg, b.png), and it is not a font');
  const head = Array.from(bytes.slice(0, 4));
  const tag = String.fromCharCode(...head);
  if (what.font) {
    if (bytes.length > DROPCAP_FONT_MAX) return no('the font is larger than 3 MB');
    const ok = ['wOFF', 'wOF2', 'OTTO', 'true'].includes(tag) || (head[0] === 0 && head[1] === 1 && head[2] === 0 && head[3] === 0);
    if (!ok) return no('it is not a TrueType, OpenType or WOFF font');
    return what.letter ? { ok: true, name, kind: 'font', letter: what.letter, bytes } : { ok: true, name, kind: 'font', bytes };
  }
  const limit = max || DROPCAP_IMAGE_MAX;
  if (bytes.length > limit) return no(`the image is larger than ${limit >= 1048576 ? `${Math.round(limit / 1048576)} MB` : `${Math.round(limit / 1024)} kB`}`);
  if (/\.png$/i.test(name)) {
    const png = head[0] === 0x89 && tag.slice(1) === 'PNG';
    return png ? { ok: true, name, kind: 'png', letter: what.letter, theme: what.theme, bytes } : no('it is not a PNG image');
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { return no('it is not text'); }
  const clean = sanitizeSvg(text);
  if (clean.problem) return no(clean.problem);
  return { ok: true, name, kind: 'svg', letter: what.letter, theme: what.theme, bytes: new TextEncoder().encode(clean.svg), removed: clean.removed };
}

/* An image of one colour as a mask: the ink keeps its place and the ground becomes clear, so the snippet can draw
   the letter in the page's accent colour (see .scriptorium-dropcap-mono). rgba is the image's pixels (four bytes
   each). An image that already has a clear ground needs nothing: null. Otherwise the ground is the paper's
   shade (or, for a white letter on a black plate, the plate's), and each pixel is as opaque as it is far from the ground; the result
   is black ink, the same size. */
function monoMask(rgba, width, height) {
  const n = width * height;
  if (!n || !rgba || rgba.length < 4 * n) return null;
  let clear = 0;
  for (let i = 0; i < n; i++) if (rgba[4 * i + 3] < 32) clear++;
  if (clear > n * 0.02) return null;
  const lum = i => 0.2126 * rgba[4 * i] + 0.7152 * rgba[4 * i + 1] + 0.0722 * rgba[4 * i + 2];
  const all = new Uint32Array(256), rim = new Uint32Array(256);
  const edge = Math.max(1, Math.round(Math.min(width, height) * 0.02));
  let rims = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const l = Math.round(lum(y * width + x));
      all[l]++;
      if (x < edge || x >= width - edge || y < edge || y >= height - edge) { rim[l]++; rims++; }
    }
  }
  const at = (hist, total, part) => { let seen = 0; for (let l = 0; l < 256; l++) { seen += hist[l]; if (seen >= total * part) return l; } return 255; };
  // paper, unless the image is dark at its edge and three quarters dark in all (a white letter on a black plate)
  const dark = at(rim, rims, 0.5) < 96 && at(all, n, 0.75) < 96;
  const ground = dark ? at(all, n, 0.1) : at(all, n, 0.9), span = Math.max(ground, 255 - ground) || 1;
  const out = new Uint8ClampedArray(4 * n);
  for (let i = 0; i < n; i++) {
    const d = Math.abs(lum(i) - ground) / span;
    const a = Math.min(1, Math.max(0, (d - 0.12) / 0.45));
    out[4 * i + 3] = Math.round(a * rgba[4 * i + 3]);
  }
  return out;
}

/* What "Download more drop caps from gwern.net" would fetch for one set: list is the plugin's dropcaps/gwern.json,
   id the set's folder there. Each image at the size gwern.net shows on its pages where it has one; with `all`, also
   the images it keeps only at full size. Returns {files: [{url, file, bytes}], bytes}. */
function downloadPlan(list, id, all) {
  const set = list && list.sets && list.sets[id];
  const base = list && typeof list.from === 'string' && /^https:\/\/gwern\.net\//.test(list.from) ? list.from : null;
  const files = [];
  if (set && base) {
    for (const [path, bytes] of (set.web || []).concat(all ? set.rest || [] : [])) {
      if (!/^(?:light|dark)\/[A-Za-z0-9._-]+\.png$/.test(path)) continue;
      files.push({ url: `${base}${id}/${path}`, file: path.slice(path.indexOf('/') + 1), bytes: Number(bytes) || 0 });
    }
  }
  return { files, bytes: files.reduce((sum, f) => sum + f.bytes, 0) };
}

/* "12 MB", "900 kB". */
function sizeText(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

/* Fetches a plan's images one at a time. io: get(url) → the bytes (rejects when it cannot), has(file) → whether the
   vault has it already, put(file, bytes), progress(done, total, file), stopped() → the writer has had enough.
   An image already there is kept, one that fails is passed over, and if the first three all fail nothing more is
   asked for (there is no connection, or gwern.net is away). Returns {saved, kept, failed: [{file, problem}], bytes,
   offline, stopped}. */
async function fetchDropcapSet(plan, io) {
  const out = { saved: 0, kept: 0, failed: [], bytes: 0, offline: false, stopped: false };
  let done = 0;
  for (const f of plan.files) {
    if (io.stopped && io.stopped()) { out.stopped = true; break; }
    if (io.progress) io.progress(done, plan.files.length, f.file);
    done++;
    try {
      if (await io.has(f.file)) { out.kept++; continue; }
      const got = await io.get(f.url);
      const bytes = got instanceof Uint8Array ? got : new Uint8Array(got);
      const checked = checkDropcapFile(f.file, bytes, DROPCAP_FETCH_MAX);
      if (!checked.ok || checked.kind !== 'png') throw new Error(checked.problem || 'it is not a PNG image');
      await io.put(f.file, bytes);
      out.saved++;
      out.bytes += bytes.length;
    } catch (e) {
      out.failed.push({ file: f.file, problem: String((e && e.message) || e) });
      if (!out.saved && !out.kept && out.failed.length >= 3) { out.offline = true; break; }
    }
  }
  if (io.progress) io.progress(done, plan.files.length, '');
  return out;
}

/* "Scriptorium: Add a set of drop caps": a name, the files, and whether the images are of one colour. `preset` is
   one of YOUR_OWN_SETS: a font Scriptorium names but may not include. */
class DropcapSetModal extends Modal {
  constructor(plugin, preset) {
    super(plugin.app);
    this.plugin = plugin;
    this.preset = preset || null;
    this.files = [];
  }

  onOpen() {
    this.modalEl.addClass('scriptorium-setup');
    const preset = this.preset;
    this.titleEl.setText(preset ? `Add ${preset.name}` : 'Add a set of drop caps');
    const el = this.contentEl;
    if (preset) {
      const p = el.createEl('p');
      p.appendText(`${preset.name}, by ${preset.by}, is one of the initials gwern.net uses. ${preset.why} Download it from `);
      p.createEl('a', { text: preset.where.replace(/^https:\/\/(www\.)?/, ''), href: preset.where });
      p.appendText(', unzip it, and pick the font file below.');
    }
    el.createEl('p', {
      text: (preset ? 'In general: pick' : 'Pick') + ' one image for each letter you have (SVG or PNG, named for its letter: A.svg, b.png, initial-C.svg; ' +
        'add “-dark” for a dark-theme version), or a font of initials (.ttf, .otf, .woff, .woff2). The set is kept in ' +
        `the vault, in “${DROPCAP_FOLDER}”, and then appears in “Choose the drop cap for this note” and in the settings.`,
    });
    const name = el.createEl('input', { type: 'text', cls: 'scriptorium-setup-path', attr: { placeholder: 'A name for the set', 'aria-label': 'A name for the set' } });
    if (preset) name.value = preset.name;
    const pick = el.createEl('input', { type: 'file', attr: { multiple: 'true', accept: '.svg,.png,.ttf,.otf,.woff,.woff2', 'aria-label': 'The images, or the font' } });
    pick.style.display = 'block';
    pick.style.margin = '10px 0';
    const monoRow = el.createEl('label', { cls: 'scriptorium-setup-mono' });
    const mono = monoRow.createEl('input', { type: 'checkbox' });
    monoRow.appendText(' The images are of one colour: draw them in the page’s accent colour, in the light and the dark theme (ink on white paper is made into ink alone)');
    const list = el.createEl('pre', { cls: 'scriptorium-setup-plan', attr: { tabindex: '0' } });
    list.style.display = 'none';
    const said = el.createEl('p', { cls: 'scriptorium-setup-problem' });
    const buttons = el.createDiv({ cls: 'modal-button-container' });
    const save = buttons.createEl('button', { cls: 'mod-cta', text: 'Add the set' });
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    this.take = async files => {     // the files picked
      this.files = [];
      for (const f of files) {
        try { this.files.push(checkDropcapFile(f.name, new Uint8Array(await f.arrayBuffer()))); }
        catch (e) { this.files.push({ ok: false, name: f.name, problem: 'it could not be read' }); }
      }
      list.style.display = this.files.length ? '' : 'none';
      list.setText(this.files.map(f => (f.ok
        ? `${f.name}: ${f.kind === 'font' ? (f.letter ? `a font of the letter ${f.letter}` : 'a font of initials') : `the letter ${f.letter}${f.theme === 'dark' ? ' (dark theme)' : ''}`}${f.removed ? `; ${f.removed} unsafe part${f.removed === 1 ? '' : 's'} taken out` : ''}`
        : `${f.name}: left out, ${f.problem}`)).join('\n'));
    };
    pick.addEventListener('change', () => this.take(Array.from(pick.files || [])));
    save.addEventListener('click', async () => {
      const n = setName(name.value);
      const good = this.files.filter(f => f.ok);
      if (!n) { said.setText('Give the set a name (letters, digits and spaces).'); name.focus(); return; }
      if (INITIALS.some(([v, label]) => v === n.toLowerCase() || label.toLowerCase() === n.toLowerCase()) || BUNDLED_SETS.some(b => b.name.toLowerCase() === n.toLowerCase())) {
        said.setText('That is the name of a drop cap Scriptorium already has: choose another.'); name.focus(); return;
      }
      if (!good.length) { said.setText('Pick at least one image named for its letter, or a font.'); return; }
      save.disabled = true;
      try {
        const own = YOUR_OWN_SETS.find(y => y.name.toLowerCase() === n.toLowerCase());
        await this.plugin.saveDropcapSet(n, good, mono.checked, own && own.meta);
        new Notice(`The set “${n}” was added. Choose it with “Scriptorium: Choose the drop cap for this note”, or in the settings.`, 8000);
        this.close();
      } catch (e) {
        save.disabled = false;
        said.setText(`The set could not be saved: ${e.message}`);
      }
    });
    window.setTimeout(() => (preset ? pick : name).focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* "Scriptorium: Download more drop caps from gwern.net": every image of Dropcat, Gene Wolfe or Ninit, fetched into
   the vault. Nothing is asked of gwern.net until a button here is pressed. */
class DropcapDownloadModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.busy = false;
    this.halt = false;
  }

  async onOpen() {
    this.modalEl.addClass('scriptorium-setup');
    this.titleEl.setText('More drop caps from gwern.net');
    const el = this.contentEl;
    el.createEl('p', {
      text: 'Scriptorium comes with a few images of each of these sets. gwern.net has many more of the same letters, ' +
        'released into the public domain (CC0). A button below fetches them from gwern.net, now, into this vault ' +
        `(“${DROPCAP_FOLDER}”); a paragraph then has one of its letter’s images, the same one each time. Nothing is fetched until you ask.`,
    });
    let list;
    try { list = await this.plugin.gwernList(); } catch (e) { list = null; }
    const said = el.createEl('p', { cls: 'scriptorium-setup-note', attr: { 'aria-live': 'polite' } });
    if (!list) { said.setText('The list of gwern.net’s images is missing from the plugin’s folder.'); return; }
    const rows = el.createDiv({ cls: 'scriptorium-dropcap-downloads' });
    const all = [];
    for (const b of BUNDLED_SETS.filter(s => s.more)) {
      const web = downloadPlan(list, b.dir, false), whole = downloadPlan(list, b.dir, true);
      const row = rows.createDiv({ cls: 'scriptorium-dropcap-download' });
      row.createEl('strong', { text: b.name });
      const offer = (plan, text) => {
        if (!plan.files.length) return;
        const button = row.createEl('button', { text: `${text}: ${plan.files.length} images, ${sizeText(plan.bytes)}` });
        all.push(button);
        button.addEventListener('click', async () => {
          if (this.busy) return;
          this.busy = true;
          this.halt = false;
          all.forEach(x => { x.disabled = true; });
          let result;
          try {
            result = await this.plugin.downloadDropcapSet(b, plan, {
              progress: (done, total, file) => said.setText(file ? `${b.name}: ${done + 1} of ${total} (${file})` : `${b.name}: finishing`),
              stopped: () => this.halt,
            });
          } catch (e) {
            result = { saved: 0, kept: 0, failed: [{ file: '', problem: e.message }], bytes: 0, offline: false };
          }
          this.busy = false;
          all.forEach(x => { x.disabled = false; });
          if (this.halt) return;
          said.setText(describeDownload(b.name, result));
        });
      };
      if (web.files.length) offer(web, whole.files.length > web.files.length ? 'The images gwern.net shows' : 'Every image');
      if (whole.files.length > web.files.length) offer(whole, web.files.length ? 'Every image, the rest at full size' : 'Every image, at full size');
    }
    const buttons = el.createDiv({ cls: 'modal-button-container' });
    buttons.createEl('button', { text: 'Close' }).addEventListener('click', () => this.close());
  }

  onClose() {
    this.halt = true;     // a download under way stops after the image it is on
    this.contentEl.empty();
  }
}

/* What a download came to, in a sentence. */
function describeDownload(name, r) {
  if (r.offline) return `${name}: gwern.net could not be reached (${r.failed[0] ? r.failed[0].problem : 'no connection'}). Nothing was changed; try again when you are online.`;
  const bits = [];
  if (r.saved) bits.push(`${r.saved} image${r.saved === 1 ? '' : 's'} added (${sizeText(r.bytes)})`);
  if (r.kept) bits.push(`${r.kept} already there`);
  if (r.failed.length) bits.push(`${r.failed.length} could not be fetched (${r.failed[0].problem}); ask again to try those`);
  if (r.stopped) bits.push('stopped before the end');
  return `${name}: ${bits.join(', ') || 'nothing to fetch'}.`;
}

/* ==========================================================
   Export to PDF: the page as Reading view sets it
   ==========================================================
   Obsidian builds the page it prints in a window of its own, and not as Reading view builds a note: each block is in
   a plain <div> (Reading view's are marked el-p, el-h1 and so on), there is no header block, and the note's title,
   if "Include file name as title" is ticked, is a bare <h1>. The snippet's rules for chapter openings look for those
   marks, so an exported PDF had no drop caps and no small-capped first lines, and its title was set as a chapter
   heading. dressPrint gives the printed page the same marks: each block gets its el-<tag> class (and the note's own
   drop cap, if it has one), and the bare <h1> becomes the header block with the title in it, as in Reading view.
   The body of the print window gets the vault's mode and drop cap classes, and the drop cap's font is loaded before
   the page is printed. The title is included by default (the plugin ticks Obsidian's option once; untick it in the
   export dialogue and it stays unticked). */

/* Whether el is the page Obsidian is about to print. */
function isPrintPage(el) {
  return Boolean(el && el.classList && el.classList.contains('markdown-preview-view') && el.parentElement &&
    el.parentElement.classList.contains('print'));
}

/* Marks the blocks of a page about to be printed as Reading view marks them; which is the note's own drop cap or
   null. Returns the title element it made, or null. */
function dressPrint(page, which) {
  const doc = page.ownerDocument;
  let title = null;
  for (const child of Array.from(page.children)) {
    if (child.tagName === 'H1' && child === page.firstElementChild) {
      // the file name, added by "Include file name as title": Reading view's header block
      const header = doc.createElement('div');
      header.className = 'mod-header mod-ui';
      title = doc.createElement('div');
      title.className = 'inline-title';
      title.textContent = child.textContent;
      header.appendChild(title);
      page.replaceChild(header, child);
      continue;
    }
    if (child.tagName !== 'DIV' || child.classList.contains('mod-header')) continue;
    const first = child.firstElementChild;
    if (first && !Array.from(child.classList).some(c => c.startsWith('el-'))) child.classList.add(`el-${first.tagName.toLowerCase()}`);
    markDropcap(child, which);
  }
  return title;
}

class DropcapModal extends Modal {
  constructor(plugin, view) {
    super(plugin.app);
    this.plugin = plugin;
    this.view = view;
    this.chosen = false;
  }

  onOpen() {
    const file = this.view.file;
    this.modalEl.addClass('scriptorium-dropcap-modal');
    this.titleEl.setText('Drop cap for this note');
    const cache = this.app.metadataCache.getFileCache(file);
    const asked = noteDropcap(cache && cache.frontmatter);
    const known = asked && asked.startsWith('set:') ? this.plugin.findSet(asked) : null;
    const current = known ? `set:${known.name}` : (asked && asked.startsWith('set:') ? null : asked);
    this.contentEl.createEl('p', { cls: 'scriptorium-dropcap-file', text: file.basename });
    const list = this.contentEl.createDiv({ cls: 'scriptorium-dropcap-list', attr: { role: 'listbox', 'aria-label': 'Drop cap' } });
    const items = [];
    const missing = YOUR_OWN_SETS.filter(y => !this.plugin.findSet(y.name));
    for (const choice of dropcapChoices(this.plugin.settings.initials, this.plugin.dropcapSets, missing)) {
      const add = choice.value && choice.value.startsWith('add:') ? missing.find(m => `add:${m.name}` === choice.value) : null;
      const item = list.createEl('button', {
        cls: 'scriptorium-dropcap-choice', text: choice.label,
        attr: { role: 'option', 'aria-selected': String(choice.value === current) },
      });
      if (choice.value === current) item.addClass('is-current');
      // Moving through the list shows each drop cap in the note; nothing is saved until one is chosen.
      const show = () => this.plugin.previewDropcap(this.view, add ? undefined : choice.value);
      item.addEventListener('focus', show);
      item.addEventListener('mouseenter', () => item.focus());
      item.addEventListener('click', () => {
        if (add) { this.close(); new DropcapSetModal(this.plugin, add).open(); return; }   // a font the writer adds
        this.chosen = true;
        this.close();
        void this.plugin.setNoteDropcap(file, choice.value);
      });
      if (add) item.addClass('is-missing');
      item.addEventListener('keydown', ev => {
        const i = items.indexOf(item);
        if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(i + items.length - 1) % items.length].focus(); }
      });
      items.push(item);
    }
    this.contentEl.createEl('p', {
      cls: 'scriptorium-dropcap-hint',
      text: 'Saved in the note’s properties as “dropcap”. It shows in Reading view, where drop caps are drawn. A set ' +
        'of images shows where it has the paragraph’s first letter.',
    });
    const more = this.contentEl.createDiv({ cls: 'scriptorium-dropcap-more' });
    more.createEl('button', { text: 'Add a set of your own…' })
      .addEventListener('click', () => { this.close(); new DropcapSetModal(this.plugin).open(); });
    more.createEl('button', { text: 'More from gwern.net…' })
      .addEventListener('click', () => { this.close(); new DropcapDownloadModal(this.plugin).open(); });
    window.setTimeout(() => (items.find(i => i.hasClass('is-current')) || items[0]).focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
    if (!this.chosen) this.plugin.previewDropcap(this.view, undefined);   // back to what the note says
  }
}

class ScriptoriumSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const el = this.containerEl, settings = this.plugin.settings;
    el.empty();
    new Setting(el)
      .setName('Fancy mode')
      .setDesc('Use quiet italic quotations and justified openings. Turn off for bordered quotations and centered section headings. Both modes use the same line spacing.')
      .addToggle(toggle => toggle
        .setValue(settings.fancyMode)
        .onChange(value => this.plugin.setFancyMode(value)));
    new Setting(el)
      .setName('Drop cap')
      .setDesc('The initial that opens a chapter in Reading view: an ornamental Yinit letter, a floriated Goudy Initialen letter, a plain Cormorant Garamond capital in the accent colour, or none (an ordinary first letter, without the small-capped first line).')
      .addDropdown(dropdown => {
        for (const [value, label] of INITIALS) dropdown.addOption(value, label);
        for (const set of this.plugin.dropcapSets) dropdown.addOption(`set:${set.name}`, set.label);
        if (!INITIALS.some(([value]) => value === settings.initials) && !this.plugin.findSet(settings.initials)) {
          dropdown.addOption(settings.initials, `${settings.initials.replace(/^set:/, '')} (a set that is not in this vault)`);
        }
        dropdown.setValue(settings.initials).onChange(value => this.plugin.updateSettings({ initials: value }));
      });
    new Setting(el)
      .setName('Marginalia')
      .setDesc('In Reading view, set footnotes beside their references in the right margin, as sidenotes, when the pane is wide enough; otherwise they stay at the foot of the note. A callout of type margin (> [!margin]) becomes an unnumbered note in the margin.')
      .addToggle(toggle => toggle
        .setValue(settings.marginalia)
        .onChange(value => this.plugin.updateSettings({ marginalia: value })));
    new Setting(el)
      .setName('Image focus')
      .setDesc('Click an image in a note to see it on its own, fitted to the window, with its caption. The arrow keys step through the note\'s images, the mouse wheel zooms and dragging pans; Esc, a click outside the image or the close button returns to the note.')
      .addToggle(toggle => toggle
        .setValue(settings.imageFocus)
        .onChange(value => this.plugin.updateSettings({ imageFocus: value })));

    // Google Drive backup (experimental): see "Backing up to Google Drive" below.
    new Setting(el).setName('Google Drive backup (experimental)').setHeading();
    const drive = driveSettings(settings, '');
    const setDrive = patch => this.plugin.updateSettings({ drive: Object.assign({}, this.plugin.settings.drive, patch) });
    new Setting(el)
      .setName('Back up, sync or retrieve')
      .setDesc('Keeps a copy of this vault in your own Google Drive, through Claude Code signed in to your Claude account with its Google Drive connector. Nothing runs by itself: a backup happens when you ask for one. ' + DRIVE_PRIVACY)
      .addButton(b => b.setButtonText('Back up now').setCta().onClick(() => new DriveModal(this.plugin, 'backup').open()))
      .addButton(b => b.setButtonText('Retrieve a vault…').onClick(() => new DriveModal(this.plugin, 'retrieve').open()));
    new Setting(el)
      .setName('Folder in Google Drive')
      .setDesc('The folder in My Drive that holds one folder per vault.')
      .addText(t => t.setPlaceholder(DRIVE_ROOT).setValue(drive.folder === DRIVE_ROOT ? '' : drive.folder).onChange(v => setDrive({ folder: v })));
    new Setting(el)
      .setName('This device’s name')
      .setDesc('Recorded with each backup, and used in the name of a file kept after a conflict. Empty: the computer’s name.')
      .addText(t => t.setValue((settings.drive && settings.drive.device) || '').onChange(v => setDrive({ device: v })));
    new Setting(el)
      .setName('Model that makes the Drive calls')
      .setDesc('A Claude Code model name. The smallest one is enough (it only copies a list of calls), and uses the least of your subscription.')
      .addText(t => t.setPlaceholder(DRIVE_MODEL).setValue(drive.model === DRIVE_MODEL ? '' : drive.model).onChange(v => setDrive({ model: v })));
  }
}

/* ==========================================================
   No word split across the small-capped opening line
   ========================================================== */

/* No word is split across the end of a small-capped first line (reading view).
   Opening paragraphs (the ones with a drop cap) hyphenate like any other. If the line break after the small-capped
   first line would fall inside a word (hyphenation, or the hyphen of a compound such as "self-play"), the word is
   wrapped in a no-break span (.sc-keep, see the snippet) and moves to the second line whole, so no word is half
   small caps and half lowercase. CSS can't set hyphenation per line, hence the script. The same logic runs on
   williamliaw.com (assets/scriptorium-keep-words.js). With the drop cap set to None there are no small caps, so
   nothing is wrapped. */
const KEEP_SEL = '.markdown-rendered :is(.mod-header, .el-h1, .el-h2, .el-h6) + .el-p > p,' +
                 ' .markdown-rendered :is(.mod-header, .el-h1, .el-h2, .el-h6) + .el-blockquote + .el-p > p';
const WORD = /[\p{L}\p{M}\p{N}'’\-‐­]/u;   // letters, digits, apostrophes, and the hyphens (and soft hyphens) inside words

function unwrapKept(p) {
  const spans = p.querySelectorAll('span.sc-keep');
  if (!spans.length) return;
  spans.forEach(s => { while (s.firstChild) s.parentNode.insertBefore(s.firstChild, s); s.remove(); });
  p.normalize();
}

function wrapWord(nodes, a, b) {
  let s = a.slice(), e = b.slice(), m, j;
  for (;;) {
    m = s[0]; j = s[1] - 1;
    while (j < 0 && m > 0) { m--; j = nodes[m].data.length - 1; }
    if (j < 0 || !WORD.test(nodes[m].data[j])) break;
    s = [m, j];
  }
  for (;;) {
    m = e[0]; j = e[1] + 1;
    while (j >= nodes[m].data.length && m < nodes.length - 1) { m++; j = 0; }
    if (j >= nodes[m].data.length || !WORD.test(nodes[m].data[j])) break;
    e = [m, j];
  }
  for (m = e[0]; m >= s[0]; m--) {
    const n = nodes[m], from = m === s[0] ? s[1] : 0, to = m === e[0] ? e[1] + 1 : n.data.length;
    if (to <= from) continue;
    const mid = n.splitText(from); mid.splitText(to - from);
    const span = document.createElement('span'); span.className = 'sc-keep';
    mid.parentNode.insertBefore(span, mid); span.appendChild(mid);
  }
}

function keepFirstLineWords(p) {
  unwrapKept(p);
  // No drop cap, no small caps: the note's own choice first, then the vault's.
  const block = p.parentElement;
  const none = block && block.classList.contains('scriptorium-dropcap')
    ? block.classList.contains('scriptorium-dropcap-none') : document.body.classList.contains('scriptorium-initials-none');
  if (!p.isConnected || !p.matches(KEEP_SEL) || none) return;
  const nodes = [], walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) if (!n.parentElement.closest('mjx-container, .math, code')) nodes.push(n);
  const fs = parseFloat(getComputedStyle(p).fontSize), r = document.createRange();
  let top0 = null, prev = null;
  for (let k = 0; k < nodes.length; k++) {
    n = nodes[k];
    for (let i = 0; i < n.data.length; i++) {
      r.setStart(n, i); r.setEnd(n, i + 1);
      const rc = r.getClientRects()[0];
      if (rc && rc.height && rc.height < 2 * fs) {   // skips the floated initial and collapsed white space
        if (top0 === null) top0 = rc.top;
        else if (rc.top > top0 + 0.6 * fs) {         // the first character of the second line
          if (prev && WORD.test(nodes[prev[0]].data[prev[1]]) && WORD.test(n.data[i])) wrapWord(nodes, prev, [k, i]);
          return;
        }
      }
      prev = [k, i];
    }
  }
}

/* ==========================================================
   Marginalia: footnotes as sidenotes, after gwern.net
   ========================================================== */

/* Reading view lays a note out lazily, a section at a time, so the footnotes at the end are often not in the page while
   their references are. The notes are therefore taken from the note's text (Obsidian's metadata gives each footnote's
   place in it) and rendered here, one sidenote per footnote whose reference is on the page, in a column beside the
   text. Sizes are in em of the note's text. */
const MARGIN = {
  gap: 1.6,      // between the text column and the notes
  min: 10,       // the narrowest note column worth having; below it, the notes stay at the foot of the note
  ideal: 14,     // the text column moves left, if it must, to give the notes this much
  max: 17,       // the widest note column
  edge: 1,       // kept free at the pane's right edge
  between: 0.9   // between stacked notes
};

/* Where the note column goes. paneWidth: the reading view's width; columnLeft, columnWidth: the text column where it
   is now (centred); padLeft: the pane's left padding, which the text never crosses; em: the text size in px.
   Returns mode 'margin' with the column's shift to the left, the notes' width and their left edge (all px, from the
   pane's left edge), or mode 'bottom' when there is no room. */
function marginGeometry({ paneWidth, columnLeft, columnWidth, padLeft = 0, em, hasNotes = true }) {
  const bottom = { mode: 'bottom', shift: 0, width: 0, left: 0 };
  if (!hasNotes || !(paneWidth > 0) || !(columnWidth > 0) || !(em > 0)) return bottom;
  const gap = MARGIN.gap * em, min = MARGIN.min * em, ideal = MARGIN.ideal * em, max = MARGIN.max * em;
  const edge = MARGIN.edge * em;
  if (!(columnLeft >= 0)) columnLeft = (paneWidth - columnWidth) / 2;
  const rightFree = paneWidth - columnLeft - columnWidth;
  const asIs = rightFree - gap - edge;                                   // notes beside the column where it is
  if (asIs >= ideal) {
    return { mode: 'margin', shift: 0, width: Math.min(max, asIs), left: columnLeft + columnWidth + gap };
  }
  const most = rightFree + Math.max(0, columnLeft - padLeft) - gap - edge;   // with the column moved hard left
  if (most < min) return bottom;
  const width = Math.min(ideal, most), block = columnWidth + gap + width;
  let textLeft = Math.min(columnLeft, Math.max(padLeft, (paneWidth - block) / 2));   // text and notes centred together
  if (textLeft + block > paneWidth - edge) textLeft = paneWidth - edge - block;
  return { mode: 'margin', shift: columnLeft - textLeft, width, left: textLeft + columnWidth + gap };
}

/* Stacks notes so that none overlaps another. items: [{ want, height }], want being where a note would like its top
   to be; gap: the space kept between notes; top, bottom: the notes stay below top and, where they can, above bottom.
   Each note sits as close to where it wants to be as the notes before it allow (pushed down, never up), unless the
   last ones would run past the bottom, in which case they are pushed back up (gwern.net does the same). Returns the
   tops, in the order of items. */
function stackNotes(items, { gap = 0, top = -Infinity, bottom = Infinity } = {}) {
  const order = items.map((_, i) => i).sort((a, b) => (items[a].want - items[b].want) || (a - b));
  const n = order.length, tops = new Array(items.length);
  let floor = top;
  for (const i of order) { tops[i] = Math.max(items[i].want, floor); floor = tops[i] + items[i].height + gap; }
  let ceiling = bottom;
  for (let k = n - 1; k >= 0; k--) {
    const i = order[k];
    if (tops[i] + items[i].height > ceiling) tops[i] = ceiling - items[i].height;
    ceiling = tops[i] - gap;
  }
  floor = top;
  for (const i of order) { if (tops[i] < floor) tops[i] = floor; floor = tops[i] + items[i].height + gap; }
  return tops;
}

/* The Markdown of one footnote, from its source: "[^id]: text" with indented continuation lines, or "^[text]" for an
   inline footnote (Obsidian gives those ids "[inline0", "[inline1", ...). */
function footnoteMarkdown(source, id) {
  if (id.startsWith('[inline')) {
    const m = /^\^\[([\s\S]*)\]$/.exec(source.trim());
    return m ? m[1].trim() : null;
  }
  const m = /^\[\^([^\]]+)\]:[ \t]?/.exec(source);
  if (!m || m[1] !== id) return null;   // the metadata is from another version of the text
  return source.slice(m[0].length).split('\n')
    .map((line, i) => (i === 0 ? line : line.replace(/^(?: {1,4}|\t)/, '')))
    .join('\n').trim();
}

/* All footnotes of a note, id -> Markdown, from Obsidian's metadata (footnotes: [{ id, position }]) or, without it,
   by reading the definitions from the text. */
function footnoteDefinitions(text, footnotes) {
  const defs = new Map();
  if (!Array.isArray(footnotes)) return parseFootnoteDefinitions(text);
  for (const fn of footnotes) {
    const start = fn && fn.position && fn.position.start && fn.position.start.offset;
    const end = fn && fn.position && fn.position.end && fn.position.end.offset;
    if (typeof fn.id !== 'string' || !(start >= 0) || !(end >= start) || defs.has(fn.id)) continue;
    // an inline footnote's position may cover only its text, inside the ^[ ]
    const inner = fn.id.startsWith('[inline') && text.slice(start - 2, start) === '^[' && text[end] === ']';
    const md = footnoteMarkdown(inner ? text.slice(start - 2, end + 1) : text.slice(start, end), fn.id);
    if (md !== null) defs.set(fn.id, md);
  }
  return defs;
}

function parseFootnoteDefinitions(text) {
  const defs = new Map(), lines = text.split('\n'), indented = /^(?: {4}|\t)/;
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const f = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; continue; }
    if (fence) continue;
    const m = /^\[\^([^\]\s]+)\]:[ \t]?(.*)$/.exec(lines[i]);
    if (!m) continue;
    const body = [m[2]];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (indented.test(lines[j])) body.push(lines[j].replace(indented, ''));
      else if (lines[j].trim() === '' && j + 1 < lines.length && indented.test(lines[j + 1])) body.push('');
      else break;
    }
    i = j - 1;
    if (!defs.has(m[1])) defs.set(m[1], body.join('\n').trim());
  }
  return defs;
}

/* "[4]" -> "4", "[2-1]" (a second reference to note 2) -> "2" */
function refLabel(text) {
  const t = String(text || '').trim().replace(/^\[|\]$/g, '');
  const m = /^(\d+)(?:-\d+)?$/.exec(t);
  return m ? m[1] : t;
}

class MarginNotes {
  constructor(owner, view) {
    this.owner = owner;
    this.app = owner.app;
    this.view = view;
    this.file = view.file;
    this.scroller = view.contentEl.querySelector('.markdown-reading-view > .markdown-preview-view');
    this.column = document.createElement('div');
    this.column.className = 'scriptorium-sidenote-column';
    this.notes = new Map();      // footnote id, or the callout element of a marginal note -> { el, body, md }
    this.defs = null;
    this.mode = 'bottom';
    this.frame = 0;
    this.lit = null;
    this.component = new Component();
    this.component.load();
    this.listeners = [];
    this.resizeObserver = new ResizeObserver(() => this.schedule());
    this.mutationObserver = new MutationObserver(() => this.schedule());
    if (!this.scroller) return;
    this.resizeObserver.observe(this.scroller);
    this.observeSizer();
    this.on(this.scroller, 'click', e => this.onClick(e), true);
    this.on(this.scroller, 'mouseover', e => this.onHover(e), true);
    this.on(this.scroller, 'mouseleave', () => this.light(null));
  }

  on(el, type, fn, capture) {
    el.addEventListener(type, fn, capture);
    this.listeners.push(() => el.removeEventListener(type, fn, capture));
  }

  observeSizer() {
    const sizer = this.scroller && this.scroller.querySelector(':scope > .markdown-preview-sizer');
    if (!sizer || sizer === this.sizer) return sizer;
    if (this.sizer) this.resizeObserver.unobserve(this.sizer);
    this.sizer = sizer;
    this.resizeObserver.observe(sizer);
    this.mutationObserver.disconnect();
    this.mutationObserver.observe(sizer, { childList: true });
    return sizer;
  }

  /* The note's footnotes, read again whenever the view's text or Obsidian's metadata for it has changed (both arrive
     a moment after the view opens, and the metadata a moment after each edit). */
  definitions() {
    const text = (typeof this.view.getViewData === 'function' ? this.view.getViewData() : this.view.data) || '';
    const cache = this.file ? this.app.metadataCache.getFileCache(this.file) : null;
    if (!this.defs || text !== this.defsText || cache !== this.defsCache) {
      this.defsText = text;
      this.defsCache = cache;
      this.defs = footnoteDefinitions(text, cache ? cache.footnotes : undefined);
      this.hasMarginCallouts = /^[ \t]*>[ \t]*\[!margin\]/im.test(text);
    }
    return this.defs;
  }

  schedule() {
    if (this.frame || this.destroyed) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; try { this.layout(); } catch (e) { console.error('Scriptorium marginalia:', e); } });
  }

  layout() {
    if (this.destroyed || !this.scroller || !this.scroller.isConnected) return;
    const sizer = this.observeSizer();
    if (!sizer) return;
    const defs = this.definitions();
    const style = getComputedStyle(this.scroller), em = parseFloat(style.fontSize) || 16;
    const shiftNow = this.mode === 'margin' ? this.shift || 0 : 0;
    const paneBox = this.scroller.getBoundingClientRect();
    const geometry = this.scroller.clientWidth ? marginGeometry({
      paneWidth: this.scroller.clientWidth,
      columnLeft: sizer.getBoundingClientRect().left - paneBox.left - this.scroller.clientLeft + shiftNow,
      columnWidth: sizer.offsetWidth,
      padLeft: parseFloat(style.paddingLeft) || 0,
      em,
      hasNotes: defs.size > 0 || this.hasMarginCallouts
    }) : { mode: 'bottom' };
    if (geometry.mode !== 'margin') { this.toBottom(); return; }

    this.mode = 'margin';
    this.shift = Math.round(geometry.shift);   // whole pixels, so that measuring again finds the same layout
    this.scroller.classList.add('scriptorium-margin');
    this.scroller.style.setProperty('--scriptorium-sidenote-shift', `${this.shift}px`);
    if (this.column.parentElement !== this.scroller) this.scroller.appendChild(this.column);
    this.column.style.left = `${Math.round(geometry.left + (geometry.shift - this.shift))}px`;
    this.column.style.width = `${Math.floor(geometry.width)}px`;

    // what belongs in the margin: each footnote whose (first) reference is on the page, and each marginal note
    const items = [], seen = new Set();
    for (const a of sizer.querySelectorAll('sup.footnote-ref > a.footnote-link[data-footref]')) {
      const id = a.dataset.footref;
      if (seen.has(id) || !defs.has(id) || a.closest('.markdown-embed, .callout.scriptorium-in-margin')) continue;
      seen.add(id);
      items.push({ key: id, ref: a.parentElement, label: refLabel(a.textContent), md: defs.get(id) });
    }
    for (const callout of sizer.querySelectorAll('.callout[data-callout="margin" i]')) {
      if (callout.parentElement.closest('.markdown-embed, .callout')) continue;
      callout.classList.add('scriptorium-in-margin');
      items.push({ key: callout, callout });
    }

    // anchors, in the pane's coordinates (the column scrolls with the text)
    const paneTop = this.scroller.getBoundingClientRect().top - this.scroller.scrollTop;
    const placed = [];
    for (const item of items) {
      const top = item.ref ? lineTop(item.ref) : item.callout.parentElement.getBoundingClientRect().top;
      if (top === null) continue;
      item.want = top - paneTop;
      placed.push(item);
    }

    const keep = new Set(placed.map(item => item.key));
    for (const [key, note] of this.notes) {
      if (keep.has(key)) continue;
      note.el.remove();
      if (typeof key !== 'string' && !key.isConnected) this.notes.delete(key);   // a marginal note's callout has gone
    }
    for (const item of placed) {
      const note = item.ref ? this.footnote(item) : this.marginNote(item);
      if (note.el.parentElement !== this.column) this.column.appendChild(note.el);
      item.note = note;
    }
    const heights = placed.map(item => item.note.el.offsetHeight);
    const sizerBottom = sizer.getBoundingClientRect().bottom - paneTop;
    const tops = stackNotes(placed.map((item, i) => ({ want: item.want, height: heights[i] })),
      { gap: MARGIN.between * em, top: 0, bottom: Math.max(sizerBottom, ...placed.map(item => item.want)) });
    placed.forEach((item, i) => { item.note.el.style.top = `${tops[i].toFixed(1)}px`; });
  }

  footnote(item) {
    let note = this.notes.get(item.key);
    if (!note) {
      const el = document.createElement('div');
      el.className = 'scriptorium-sidenote';
      el.dataset.footref = item.key;
      const number = el.appendChild(document.createElement('a'));
      number.className = 'scriptorium-sidenote-number';
      number.setAttribute('role', 'button');
      number.setAttribute('aria-label', 'Go to the reference');
      const body = el.appendChild(document.createElement('div'));
      body.className = 'scriptorium-sidenote-body';
      note = { el, number, body, md: null };
      this.notes.set(item.key, note);
    }
    note.number.textContent = item.label;
    if (note.md !== item.md) {
      note.md = item.md;
      const body = note.body;
      body.empty ? body.empty() : (body.textContent = '');
      const back = () => {
        const link = document.createElement('a');
        link.className = 'scriptorium-sidenote-back';
        link.textContent = '↙';
        link.setAttribute('role', 'button');
        link.setAttribute('aria-label', 'Back to the reference');
        const last = body.lastElementChild;
        (last && last.tagName === 'P' ? last : body).appendChild(link);
      };
      const done = MarkdownRenderer.render
        ? MarkdownRenderer.render(this.app, item.md, body, this.file ? this.file.path : '', this.component)
        : MarkdownRenderer.renderMarkdown(item.md, body, this.file ? this.file.path : '', this.component);
      Promise.resolve(done).then(() => { if (note.md === item.md) { back(); this.schedule(); } }, () => {});
    }
    return note;
  }

  marginNote(item) {
    let note = this.notes.get(item.key);
    if (!note) {
      const el = document.createElement('div');
      el.className = 'scriptorium-sidenote is-margin-note';
      const body = el.appendChild(document.createElement('div'));
      body.className = 'scriptorium-sidenote-body';
      const title = item.callout.querySelector(':scope > .callout-title .callout-title-inner');
      const titleText = title ? title.textContent.trim() : '';
      if (titleText && titleText.toLowerCase() !== 'margin') {
        const t = body.appendChild(document.createElement('div'));
        t.className = 'scriptorium-sidenote-title';
        t.textContent = titleText;
      }
      const content = item.callout.querySelector(':scope > .callout-content');
      if (content) for (const child of content.children) body.appendChild(child.cloneNode(true));
      note = { el, body, md: null };
      this.notes.set(item.key, note);
    }
    return note;
  }

  toBottom() {
    if (this.mode === 'bottom' && !this.column.parentElement) return;
    this.mode = 'bottom';
    this.shift = 0;
    this.light(null);
    if (this.scroller) {
      this.scroller.classList.remove('scriptorium-margin');
      this.scroller.style.removeProperty('--scriptorium-sidenote-shift');
      for (const c of this.scroller.querySelectorAll('.callout.scriptorium-in-margin')) c.classList.remove('scriptorium-in-margin');
    }
    this.column.remove();
  }

  /* Hovering a reference lights its note, and the other way round. While the note is in the margin, Obsidian's own
     footnote popover would only repeat it, so the hover does not reach Obsidian. */
  onHover(e) {
    if (this.mode !== 'margin') return;
    const t = e.target instanceof Element ? e.target : null;
    const ref = t && t.closest('sup.footnote-ref');
    const note = t && t.closest('.scriptorium-sidenote[data-footref]');
    let key = null;
    if (ref) { const a = ref.querySelector('a[data-footref]'); key = a ? a.dataset.footref : null; }
    else if (note) key = note.dataset.footref;
    const shown = key !== null && this.notes.has(key) && this.notes.get(key).el.isConnected;
    this.light(shown ? key : null);
    if (ref && shown) e.stopPropagation();
  }

  light(key) {
    if (key === this.lit) return;
    if (this.lit !== null) this.mark(this.lit, false);
    this.lit = key;
    if (key !== null) this.mark(key, true);
  }

  mark(key, on) {
    const note = this.notes.get(key);
    if (note) note.el.classList.toggle('is-highlighted', on);
    for (const sup of this.refsFor(key)) sup.classList.toggle('scriptorium-ref-highlighted', on);
  }

  refsFor(key) {
    if (!this.sizer) return [];
    return Array.from(this.sizer.querySelectorAll('sup.footnote-ref > a.footnote-link[data-footref]'))
      .filter(a => a.dataset.footref === key).map(a => a.parentElement);
  }

  /* In the margin, a reference points at its sidenote, and the sidenote's number and ↙ point back at the reference. */
  onClick(e) {
    if (this.mode !== 'margin' || e.button !== 0) return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const a = t.closest('sup.footnote-ref > a.footnote-link[data-footref]');
    const back = t.closest('.scriptorium-sidenote-number, .scriptorium-sidenote-back');
    if (a && this.notes.has(a.dataset.footref) && this.notes.get(a.dataset.footref).el.isConnected) {
      e.preventDefault(); e.stopPropagation();
      this.flash(this.notes.get(a.dataset.footref).el);
    } else if (back) {
      const el = back.closest('.scriptorium-sidenote[data-footref]');
      const sup = el && this.refsFor(el.dataset.footref)[0];
      e.preventDefault(); e.stopPropagation();
      if (sup) this.flash(sup, 'center');
    }
  }

  flash(el, block = 'nearest') {
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block, inline: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
    el.classList.remove('is-targeted');
    void el.offsetWidth;
    el.classList.add('is-targeted');
    window.setTimeout(() => el.classList.remove('is-targeted'), 1600);
  }

  destroy() {
    this.destroyed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.toBottom();
    this.resizeObserver.disconnect();
    this.mutationObserver.disconnect();
    this.listeners.forEach(off => off());
    this.component.unload();
    this.notes.clear();
  }
}

/* The top of the line a footnote reference sits on (its raised number would be too high), or null if it is hidden:
   the top of the last letter before it, skipping other references ([^4][^5] share a line). */
function lineTop(sup) {
  const box = sup.getBoundingClientRect();
  if (!box.width && !box.height) return null;
  const block = sup.parentElement.closest('p, li, td, th, h1, h2, h3, h4, h5, h6, dd, dt, div') || sup.parentElement;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let last = null, n;
  while ((n = walker.nextNode())) {
    if (sup.contains(n)) continue;
    if (sup.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) break;
    if (n.parentElement.closest('sup.footnote-ref') || !/\S/.test(n.data)) continue;
    last = n;
  }
  if (last) {
    let i = last.data.length - 1;
    while (i > 0 && /\s/.test(last.data[i])) i--;
    const range = document.createRange();
    range.setStart(last, i);
    range.setEnd(last, i + 1);
    const rects = range.getClientRects();
    const rc = rects[rects.length - 1];
    // on the reference's line, not the one before (a raised number reaches a little above its own line)
    if (rc && Math.min(rc.bottom, box.bottom) - Math.max(rc.top, box.top) > box.height / 2) return rc.top;
  }
  return box.top;
}

class Marginalia {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.states = new Map();   // MarkdownView -> MarginNotes
    this.frame = 0;
  }

  load() {
    const p = this.plugin, ws = this.app.workspace;
    for (const name of ['layout-change', 'active-leaf-change', 'file-open', 'resize', 'css-change']) {
      p.registerEvent(ws.on(name, () => this.refreshSoon()));
    }
    p.registerEvent(this.app.metadataCache.on('changed', file => {
      for (const state of this.states.values()) if (state.file === file) state.schedule();
    }));
    p.registerMarkdownPostProcessor(() => this.refreshSoon());   // a section of some note has just been rendered
    ws.onLayoutReady(() => this.refreshSoon());
  }

  refreshSoon() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.refresh(); });
  }

  refresh() {
    const on = this.plugin.settings.marginalia, views = new Set();
    this.app.workspace.iterateAllLeaves(leaf => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      views.add(view);
      const wanted = on && view.file && view.getMode() === 'preview';
      let state = this.states.get(view);
      if (state && (!wanted || state.file !== view.file || !state.scroller || !state.scroller.isConnected)) {
        state.destroy(); this.states.delete(view); state = null;
      }
      if (!wanted) return;
      if (!state) { state = new MarginNotes(this, view); this.states.set(view, state); }
      state.schedule();
    });
    for (const [view, state] of this.states) if (!views.has(view)) { state.destroy(); this.states.delete(view); }
  }

  unload() {
    if (this.frame) cancelAnimationFrame(this.frame);
    for (const state of this.states.values()) state.destroy();
    this.states.clear();
  }
}

/* ==========================================================
   Image focus, after gwern.net
   ========================================================== */

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif', 'tif', 'tiff', 'ico']);
const PLACEMENT = /^(?:left|right|center|centre)$/i;
const SIZE = /^\d+(?:\s*x\s*\d+)?$/i;

/* The caption in the parts of an image's alt text, without the size and placement words Scriptorium and Obsidian
   read there ("left|300", "right", "640x480"). */
function captionFromParts(parts) {
  return parts.map(p => p.trim()).filter(p => p && !SIZE.test(p) && !PLACEMENT.test(p)).join(' | ');
}

/* An image embed's link, caption and title: ![[link|caption|300]] or ![caption|300](link "title"). */
function parseImageEmbed(original) {
  const s = String(original || '').trim();
  let m = /^!\[\[([^\]|]*?)(\|[\s\S]*)?\]\]$/.exec(s);
  if (m) return { link: m[1].trim(), caption: captionFromParts((m[2] || '').split('|').slice(1)), title: '' };
  m = /^!\[((?:[^\]\\]|\\.)*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*\)$/.exec(s);
  if (m) {
    const link = m[2].startsWith('<') ? m[2].slice(1, -1) : m[2];
    const alt = m[1].replace(/\\(.)/g, '$1');
    return { link, caption: captionFromParts(alt.split('|')), title: (m[3] || m[4] || m[5] || '').trim() };
  }
  return null;
}

/* Markdown images with a web address (Obsidian's metadata lists only the vault's own files), outside code. */
function externalImages(text, codeRanges = []) {
  const re = /!\[(?:[^\]\\]|\\.)*\]\(\s*(?:<https?:\/\/[^>]*>|https?:\/\/[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  const out = [];
  for (const m of String(text || '').matchAll(re)) {
    if (codeRanges.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const parsed = parseImageEmbed(m[0]);
    if (parsed) out.push(Object.assign({ offset: m.index }, parsed));
  }
  return out;
}

/* Images are matched by address, without the ?timestamp Obsidian adds to the vault's files. */
function sourceKey(url) {
  let u = String(url || '');
  try { u = decodeURI(u); } catch (e) { /* keep it as it is */ }
  return /^app:\/\//i.test(u) ? u.replace(/[?#].*$/, '') : u;
}

function isFocusable(img) {
  if (!img || img.tagName !== 'IMG' || img.classList.contains('emoji')) return false;
  if (!img.closest('.markdown-reading-view .markdown-preview-view, .markdown-source-view.mod-cm6 .cm-content')) return false;
  if (img.closest('a[href], button, .callout-icon, .metadata-container, .scriptorium-focus')) return false;
  return img.offsetWidth >= 24 || img.offsetHeight >= 24;
}

/* An image found only in the page: its caption from a figure's caption, its alt text or its title. */
function domImage(img) {
  let name = (img.currentSrc || img.src || '').split(/[?#]/)[0].split('/').pop() || '';
  try { name = decodeURIComponent(name); } catch (e) { /* keep it encoded */ }
  const embed = img.closest('.internal-embed');
  const figure = img.closest('figure');
  const figcaption = figure && figure.querySelector('figcaption');
  let caption = figcaption ? figcaption.textContent.trim() : captionFromParts((img.getAttribute('alt') || '').split('|'));
  if (caption === name || (embed && caption === embed.getAttribute('src'))) caption = '';
  const title = (img.getAttribute('title') || '').trim();
  return { url: img.currentSrc || img.src, key: sourceKey(img.currentSrc || img.src), caption, title, name };
}

class ImageFocus {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.isOpen = false;
    this.token = 0;
    this.onResize = () => { if (this.isOpen) this.fit(); };
  }

  load() {
    const attach = doc => {
      this.plugin.registerDomEvent(doc, 'pointerdown', e => { this.down = { x: e.clientX, y: e.clientY }; }, true);
      this.plugin.registerDomEvent(doc, 'click', e => this.onClick(e), true);
    };
    attach(document);
    this.plugin.registerEvent(this.app.workspace.on('window-open', win => attach(win.doc)));
  }

  onClick(e) {
    if (!this.plugin.settings.imageFocus || this.isOpen || e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const img = e.target;
    if (!isFocusable(img)) return;
    if (this.down && Math.abs(e.clientX - this.down.x) + Math.abs(e.clientY - this.down.y) > 6) return;   // a drag
    e.preventDefault();
    e.stopPropagation();
    this.open(img);
  }

  /* The note's images, in order: its embeds of the vault's images and its web images, from the note's text, so that
     images Reading view or the editor has not laid out yet are counted too. */
  noteImages(view) {
    const file = view.file, cache = this.app.metadataCache.getFileCache(file) || {};
    const text = typeof view.getViewData === 'function' ? view.getViewData() : (view.data || '');
    const items = [];
    for (const e of cache.embeds || []) {
      const parsed = parseImageEmbed(e.original) || { caption: '', title: '' };
      const linkpath = String(e.link || '').replace(/[#^].*$/, '');
      const target = this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
      if (!target || !IMAGE_EXTENSIONS.has(String(target.extension).toLowerCase())) continue;
      const url = this.app.vault.getResourcePath(target);
      items.push({ offset: e.position.start.offset, url, key: sourceKey(url), caption: parsed.caption, title: parsed.title, name: target.name });
    }
    const code = (cache.sections || []).filter(s => s.type === 'code')
      .map(s => [s.position.start.offset, s.position.end.offset]);
    for (const x of externalImages(text, code)) {
      items.push({ offset: x.offset, url: x.link, key: sourceKey(x.link), caption: x.caption, title: x.title, name: x.link.split('/').pop() });
    }
    return items.sort((a, b) => a.offset - b.offset);
  }

  context(img) {
    let view = null;
    this.app.workspace.iterateAllLeaves(leaf => {
      if (!view && leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(img)) view = leaf.view;
    });
    const container = img.closest('.markdown-preview-view, .cm-content') || img.parentElement;
    const key = sourceKey(img.currentSrc || img.src);
    if (view && view.file && !img.closest('.markdown-embed')) {
      const items = this.noteImages(view);
      const matches = [];
      items.forEach((item, i) => { if (item.key === key) matches.push(i); });
      if (matches.length) {
        const same = Array.from(container.querySelectorAll('img')).filter(x => sourceKey(x.currentSrc || x.src) === key);
        const index = matches[Math.min(Math.max(0, same.indexOf(img)), matches.length - 1)];
        const here = domImage(img);
        if (!items[index].caption && !items[index].title) items[index] = Object.assign({}, items[index], { caption: here.caption, title: here.title });
        return { items, index };
      }
    }
    const imgs = Array.from(container.querySelectorAll('img')).filter(isFocusable);
    return { items: imgs.map(domImage), index: Math.max(0, imgs.indexOf(img)) };
  }

  build(doc) {
    if (this.el && this.el.ownerDocument === doc) return;
    const make = (tag, cls, parent) => { const el = doc.createElement(tag); if (cls) el.className = cls; if (parent) parent.appendChild(el); return el; };
    const el = make('div', 'scriptorium-focus');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    this.stage = make('div', 'scriptorium-focus-stage', el);
    this.image = make('img', 'scriptorium-focus-image', this.stage);
    this.image.id = `scriptorium-focus-image-${Date.now().toString(36)}`;
    el.setAttribute('aria-labelledby', this.image.id);   // named by the image's caption (its alt text); no tooltip
    this.image.draggable = false;
    this.counter = make('div', 'scriptorium-focus-counter', el);
    this.counter.setAttribute('aria-live', 'polite');
    const button = (cls, text, label, fn) => {
      const b = make('button', `scriptorium-focus-button ${cls}`, el);
      b.type = 'button';
      b.textContent = text;
      b.setAttribute('aria-label', label);   // Obsidian shows it as the tooltip
      b.addEventListener('click', e => { e.stopPropagation(); fn(); });
      return b;
    };
    this.prevButton = button('scriptorium-focus-prev', '‹', 'Previous image (←)', () => this.step(-1));
    this.nextButton = button('scriptorium-focus-next', '›', 'Next image (→)', () => this.step(1));
    this.closeButton = button('scriptorium-focus-close', '×', 'Close (Esc)', () => this.close());
    this.caption = make('figcaption', 'scriptorium-focus-caption', el);

    el.addEventListener('click', e => {
      if (this.dragged) { this.dragged = false; return; }
      if (e.target === el || e.target === this.stage) this.close();
    });
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      this.zoomTo(this.z * Math.exp(-dy * 0.002), e.clientX, e.clientY);
    }, { passive: false });
    this.image.addEventListener('dblclick', e => {
      e.preventDefault();
      if (this.z > 1.001) this.zoomTo(1); else this.zoomTo(2.5, e.clientX, e.clientY);
    });
    this.image.addEventListener('pointerdown', e => {
      if (e.button !== 0 || this.z <= 1.001) return;
      e.preventDefault();
      this.drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, moved: false };
      this.image.setPointerCapture(e.pointerId);
      el.classList.add('is-dragging');
    });
    this.image.addEventListener('pointermove', e => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
      this.tx = this.drag.tx + dx;
      this.ty = this.drag.ty + dy;
      this.clampPan();
      this.apply();
    });
    const endDrag = () => {
      if (!this.drag) return;
      this.dragged = this.drag.moved;
      this.drag = null;
      el.classList.remove('is-dragging');
    };
    this.image.addEventListener('pointerup', endDrag);
    this.image.addEventListener('pointercancel', endDrag);
    el.addEventListener('keydown', e => {   // keep Tab among the overlay's buttons
      if (e.key !== 'Tab') return;
      const buttons = [this.prevButton, this.nextButton, this.closeButton].filter(b => !b.disabled && b.offsetParent);
      if (!buttons.length) return;
      const i = buttons.indexOf(doc.activeElement);
      e.preventDefault();
      buttons[(i + (e.shiftKey ? buttons.length - 1 : 1) + buttons.length) % buttons.length].focus();
    });
    this.el = el;
  }

  open(img) {
    const { items, index } = this.context(img);
    if (!items.length) return;
    const doc = img.ownerDocument;
    this.items = items;
    this.doc = doc;
    this.win = doc.defaultView || window;
    this.returnFocus = doc.activeElement;
    this.build(doc);
    doc.body.appendChild(this.el);
    doc.body.classList.add('scriptorium-focus-open');
    this.isOpen = true;
    if (Scope && this.app.keymap) {
      this.scope = new Scope();
      this.scope.register([], 'Escape', () => { this.close(); return false; });
      this.scope.register([], 'ArrowLeft', () => { this.step(-1); return false; });
      this.scope.register([], 'ArrowRight', () => { this.step(1); return false; });
      for (const key of ['+', '=']) this.scope.register(null, key, () => { this.zoomTo(this.z * 1.25); return false; });
      this.scope.register(null, '-', () => { this.zoomTo(this.z / 1.25); return false; });
      this.scope.register(null, '0', () => { this.zoomTo(1); return false; });
      this.app.keymap.pushScope(this.scope);
    }
    this.win.addEventListener('resize', this.onResize);
    this.show(index);
    this.closeButton.focus({ preventScroll: true });
  }

  step(delta) {
    const i = this.index + delta;
    if (this.isOpen && i >= 0 && i < this.items.length) this.show(i);
  }

  show(i) {
    const item = this.items[i], n = this.items.length;
    this.index = i;
    this.el.classList.toggle('is-single', n < 2);
    this.counter.textContent = n > 1 ? `${i + 1} of ${n}` : '';
    this.prevButton.disabled = i === 0;
    this.nextButton.disabled = i === n - 1;
    this.caption.textContent = '';
    if (item.caption) this.caption.appendChild(this.doc.createElement('p')).textContent = item.caption;
    if (item.title && item.title !== item.caption) {
      const p = this.caption.appendChild(this.doc.createElement('p'));
      p.className = 'scriptorium-focus-title';
      p.textContent = item.title;
    }
    this.caption.classList.toggle('is-empty', !this.caption.childElementCount);
    this.z = 1; this.tx = 0; this.ty = 0;
    const img = this.image, token = ++this.token;
    img.alt = item.caption || item.title || item.name || '';
    img.classList.add('is-loading');
    const ready = () => { if (token === this.token) { img.classList.remove('is-loading'); this.fit(); } };
    img.onload = ready;
    img.onerror = ready;
    if (img.getAttribute('src') !== item.url) img.src = item.url;
    else if (img.complete) ready();
  }

  fit() {
    const img = this.image, win = this.win;
    const nw = img.naturalWidth || 800, nh = img.naturalHeight || 600;
    const vw = win.innerWidth, vh = win.innerHeight;
    const em = parseFloat(getComputedStyle(this.el).fontSize) || 16;
    const side = this.items.length > 1 ? 3.6 * em : 1.6 * em, top = 2.8 * em;
    const bottom = this.caption.classList.contains('is-empty') ? 1.6 * em : this.caption.offsetHeight + 1.8 * em;
    const aw = Math.max(40, vw - 2 * side), ah = Math.max(40, vh - top - bottom);
    this.scale = Math.min(aw / nw, ah / nh, 2);   // fitted to the window, but never more than twice its own size
    this.w = nw * this.scale;
    this.h = nh * this.scale;
    this.cx = vw / 2;
    this.cy = top + ah / 2;
    Object.assign(img.style, {
      width: `${this.w}px`, height: `${this.h}px`, left: `${this.cx - this.w / 2}px`, top: `${this.cy - this.h / 2}px`
    });
    this.clampPan();
    this.apply();
  }

  maxZoom() {
    return Math.min(16, Math.max(4, 3 / (this.scale || 1)));
  }

  /* Zooms to z, keeping the point (x, y) of the window where it is. */
  zoomTo(z, x = this.cx, y = this.cy) {
    if (!this.isOpen) return;
    z = Math.min(this.maxZoom(), Math.max(1, z));
    const k = z / this.z;
    this.tx = (x - this.cx) - (x - this.cx - this.tx) * k;
    this.ty = (y - this.cy) - (y - this.cy - this.ty) * k;
    this.z = z;
    if (z <= 1.001) { this.z = 1; this.tx = 0; this.ty = 0; }
    this.clampPan();
    this.apply();
  }

  clampPan() {
    const mx = (this.w * this.z) / 2, my = (this.h * this.z) / 2;
    this.tx = Math.min(mx, Math.max(-mx, this.tx || 0));
    this.ty = Math.min(my, Math.max(-my, this.ty || 0));
  }

  apply() {
    this.image.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.z})`;
    this.el.classList.toggle('is-zoomed', this.z > 1.001);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.token++;
    if (this.scope) { this.app.keymap.popScope(this.scope); this.scope = null; }
    this.win.removeEventListener('resize', this.onResize);
    this.drag = null;
    this.el.classList.remove('is-dragging', 'is-zoomed');
    this.el.remove();
    this.doc.body.classList.remove('scriptorium-focus-open');
    if (this.returnFocus && this.returnFocus.isConnected && this.returnFocus.focus) this.returnFocus.focus({ preventScroll: true });
    this.returnFocus = null;
  }

  unload() {
    this.close();
  }
}

/* ==========================================================
   Setting up a vault
   ==========================================================
   "Scriptorium: Set up another vault" makes any folder a Scriptorium vault from this one: a vault you already write in,
   a new vault, or a folder of notes. "Scriptorium: Set up this vault" does the same to this vault, which turns
   Scriptorium's theme, snippet and plugins back on if they were turned off. The rules are those of Scriptorium Setup
   (Vaults.SetUp in installer/ScriptoriumSetup.cs) and of installers/Setup-Scriptorium-Vault.py:
     - only the vault's .obsidian folder is written to; no note is touched and nothing is deleted;
     - Scriptorium's own files (the manuscript snippet, the Typewriter theme, the code of the Scriptorium, Lagrange,
       Manuscriptum and Typewriter Mode plugins, and Longform's if this vault has it) are added, or replaced if a file
       of that name differs;
     - the community plugin list, appearance.json (the manuscript snippet on, the Typewriter theme) and app.json (the
       text size, unless the vault has one of its own) are merged; a plugin's data.json and core-plugins.json are
       written only where the vault has none; hotkeys, the workspace and everything else are left alone;
     - Lagrange's API keys are never copied: its settings go across with every key emptied;
     - the whole .obsidian folder as it was is first copied to .obsidian/scriptorium-backup-<time>/.obsidian, and a
       failure half-way puts every file back; run again, it changes nothing.
   It reads and writes files with Node's fs, so it works in Obsidian on a computer only. The functions below take fs
   and path as arguments and are tested under Node (plugins-tests/, tools/test_setup_vault.py). */

const SETUP_BACKUP = 'scriptorium-backup-';
const SETUP_PLUGINS = ['scriptorium', 'manuscriptum', 'typewriter-mode', 'lagrange'];
const SETUP_CODE = ['main.js', 'manifest.json', 'styles.css', 'LICENSE'];

/* How a file of the package is treated: 'replace', 'missing' (written only if the vault has none), 'plugins',
   'appearance' or 'app' (merged), or null (not part of setting up a vault). rel uses forward slashes. */
function setupRule(rel) {
  if (rel === '.obsidian/community-plugins.json') return 'plugins';
  if (rel === '.obsidian/appearance.json') return 'appearance';
  if (rel === '.obsidian/app.json') return 'app';
  if (rel === '.obsidian/core-plugins.json') return 'missing';
  if (rel === '.obsidian/snippets/manuscript.css' || rel === '.obsidian/plugins/lagrange/LagrangeHand-OFL.txt') return 'replace';
  if (rel.startsWith('.obsidian/themes/Typewriter/')) return 'replace';
  const m = rel.match(/^\.obsidian\/plugins\/([^/]+)\/([^/]+)$/);
  if (!m) return null;
  if (SETUP_PLUGINS.includes(m[1])) return SETUP_CODE.includes(m[2]) ? 'replace' : (m[2] === 'data.json' ? 'missing' : null);
  if (m[1] === 'longform') return ['main.js', 'manifest.json', 'styles.css'].includes(m[2]) ? 'replace' : null;
  return null;
}

function setupJson(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/* The parsed JSON of a file if it is an object (kind 'object') or a list (kind 'array'), else null. */
function setupParse(data, kind) {
  try {
    const v = JSON.parse(data.toString('utf8').replace(/^﻿/, ''));
    if (kind === 'array') return Array.isArray(v) ? v : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (e) {
    return null;
  }
}

/* The Scriptorium files of the vault in dir, as a package: {rel: Buffer}. What is personal stays behind: Lagrange's
   API keys are emptied, app.json is cut down to the text size, and appearance.json to the theme and the snippet. */
function setupPackage(fs, path, dir) {
  const files = {};
  const walk = rel => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) { if (!entry.name.startsWith(SETUP_BACKUP)) walk(child); }
      else if (entry.isFile() && setupRule(child)) files[child] = fs.readFileSync(path.join(dir, child));
    }
  };
  if (fs.existsSync(path.join(dir, '.obsidian'))) walk('.obsidian');
  const reshape = (rel, kind, change) => {
    const before = files[rel] && setupParse(files[rel], kind);
    const after = change(before);
    if (!before || JSON.stringify(before) !== JSON.stringify(after)) files[rel] = setupJson(after);   // else the file's own bytes
  };
  // The text size: Obsidian keeps it in appearance.json once it has opened the vault; a new vault has it in app.json.
  const size = [files['.obsidian/appearance.json'], files['.obsidian/app.json']].map(f => f && setupParse(f, 'object'))
    .map(o => o && o.baseFontSize).find(v => typeof v === 'number');
  reshape('.obsidian/app.json', 'object', () => ({ baseFontSize: size || 22 }));
  reshape('.obsidian/appearance.json', 'object', a => ({ theme: (a && a.theme) || 'obsidian', cssTheme: 'Typewriter', enabledCssSnippets: ['manuscript'] }));
  reshape('.obsidian/community-plugins.json', 'array', a => {
    const mine = ['longform'].concat(SETUP_PLUGINS);
    const kept = (a || []).filter(id => mine.includes(id));
    return kept.concat(SETUP_PLUGINS.filter(id => !kept.includes(id)));
  });
  // The Scriptorium plugin's own note that it has ticked the PDF title option here: the other vault has not been.
  const own = '.obsidian/plugins/scriptorium/data.json';
  if (files[own]) reshape(own, 'object', a => { const out = Object.assign({}, a); delete out.pdfTitleSet; return out; });
  const lagrange = '.obsidian/plugins/lagrange/data.json';
  if (files[lagrange]) {
    reshape(lagrange, 'object', a => {
      const out = Object.assign({}, a);
      for (const k of Object.keys(out)) if (/key|token|secret|password/i.test(k) && typeof out[k] === 'string') out[k] = '';
      return out;
    });
  }
  return files;
}

/* What setting up the vault in dir from the package would change: {changes: [{rel, content, replaces, note}], notes}.
   notes are lines about files left as they were. Nothing is written. */
function planVaultSetup(fs, path, pkg, dir) {
  const changes = [], notes = [];
  const existing = rel => {
    try { return fs.statSync(path.join(dir, rel)).isFile() ? fs.readFileSync(path.join(dir, rel)) : null; } catch (e) { return null; }
  };
  // The plugins that will be in the vault afterwards: those in the package, and whatever is installed already.
  const present = new Set(SETUP_PLUGINS);
  for (const rel of Object.keys(pkg)) { const m = rel.match(/^\.obsidian\/plugins\/([^/]+)\/main\.js$/); if (m) present.add(m[1]); }
  try {
    for (const e of fs.readdirSync(path.join(dir, '.obsidian', 'plugins'), { withFileTypes: true })) if (e.isDirectory()) present.add(e.name);
  } catch (e) { /* no plugins folder yet */ }
  const mergeFile = (rel, now, ours) => {
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    if (rel.endsWith('community-plugins.json')) {
      const current = setupParse(now, 'array');
      if (!current) return [null, `Left ${name} as it was: it is not a valid JSON list.`];
      const added = (setupParse(ours, 'array') || []).filter(id => typeof id === 'string' && present.has(id) && !current.includes(id));
      if (!added.length) return [null, null];
      return [setupJson(current.concat(added)), `turn on the community plugin${added.length > 1 ? 's' : ''} ${added.join(', ')}`];
    }
    const a = setupParse(now, 'object');
    if (!a) return [null, `Left ${name} as it was: it is not a valid JSON object.`];
    if (rel.endsWith('appearance.json')) {
      const snippets = 'enabledCssSnippets' in a ? a.enabledCssSnippets : [];
      if (!Array.isArray(snippets)) return [null, `Left ${name} as it was: its enabledCssSnippets is not a list.`];
      const said = [];
      if (!snippets.includes('manuscript')) { a.enabledCssSnippets = snippets.concat('manuscript'); said.push('turn on the manuscript snippet'); }
      if (a.cssTheme !== 'Typewriter') {
        said.push(`change the theme from ${a.cssTheme || 'the default'} to Typewriter`);
        a.cssTheme = 'Typewriter';
      }
      return said.length ? [setupJson(a), said.join(' and ')] : [null, null];
    }
    const o = setupParse(ours, 'object') || {};
    const added = Object.keys(o).filter(k => !(k in a));
    const kept = Object.keys(o).filter(k => k in a && JSON.stringify(a[k]) !== JSON.stringify(o[k]))
      .map(k => `kept your ${k} (${JSON.stringify(a[k])}; Scriptorium's is ${JSON.stringify(o[k])})`).join('; ') || null;
    if (!added.length) return [null, kept];
    for (const k of added) a[k] = o[k];
    return [setupJson(a), `set ${added.map(k => `${k} to ${JSON.stringify(o[k])}`).join(', ')}${kept ? `; ${kept}` : ''}`];
  };
  for (const rel of Object.keys(pkg).sort()) {
    const rule = setupRule(rel);
    if (!rule) continue;
    let content = pkg[rel];
    const now = existing(rel);
    if (rule === 'app') {
      // Obsidian keeps some of app.json's settings (the text size) in appearance.json once it has opened the vault: a
      // setting the vault has there is the vault's own, and is not set again here.
      const appearance = setupParse(existing('.obsidian/appearance.json') || Buffer.alloc(0), 'object') || {};
      const ours = setupParse(content, 'object') || {};
      const theirs = Object.keys(ours).filter(k => k in appearance);
      if (theirs.length) {
        const own = (now && setupParse(now, 'object')) || {};
        for (const k of theirs) {
          if (JSON.stringify(appearance[k]) !== JSON.stringify(ours[k]) && !(k in own)) {
            notes.push(`kept your ${k} (${JSON.stringify(appearance[k])}; Scriptorium's is ${JSON.stringify(ours[k])})`);
          }
          delete ours[k];
        }
        if (!Object.keys(ours).length) continue;
        content = setupJson(ours);
      }
    }
    if (now === null) {
      if (rule === 'plugins') content = setupJson((setupParse(content, 'array') || []).filter(id => present.has(id)));
      changes.push({ rel, content, replaces: false, note: null });
    } else if (rule === 'missing') {
      continue;
    } else if (rule === 'replace') {
      if (!now.equals(content)) changes.push({ rel, content, replaces: true, note: null });
    } else {
      const [merged, note] = mergeFile(rel, now, content);
      if (merged) changes.push({ rel, content: merged, replaces: true, note });
      else if (note) notes.push(note);
    }
  }
  return { changes, notes };
}

/* The plan in words, one line each. */
function describeVaultSetup(plan) {
  return plan.changes.map(c => (c.note ? `  merge    ${c.rel}: ${c.note}` : `  ${c.replaces ? 'replace ' : 'add     '} ${c.rel}`))
    .concat(plan.notes.map(n => `  note     ${n}`));
}

/* Makes the plan's changes in the vault in dir: backs up .obsidian as it is, then writes; on a failure every file is
   put back and the error is thrown. Returns the backup folder, or null if there was nothing to back up or to change. */
function applyVaultSetup(fs, path, dir, plan, now) {
  const changes = plan.changes;
  if (!changes.length) return null;
  const config = path.join(dir, '.obsidian');
  let backup = null;
  if (fs.existsSync(config) && fs.readdirSync(config).length) {
    const d = now || new Date(), two = n => String(n).padStart(2, '0');
    const stamp = `${SETUP_BACKUP}${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
    backup = path.join(config, stamp);
    for (let n = 2; fs.existsSync(backup); n++) backup = path.join(config, `${stamp}-${n}`);
    const copy = (from, to) => {
      fs.mkdirSync(to, { recursive: true });
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (entry.isDirectory()) { if (!entry.name.startsWith(SETUP_BACKUP)) copy(path.join(from, entry.name), path.join(to, entry.name)); }
        else if (entry.isFile()) fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
      }
    };
    try {
      copy(config, path.join(backup, '.obsidian'));
    } catch (e) {
      try { fs.rmSync(backup, { recursive: true, force: true }); } catch (err) { /* leave it */ }
      throw new Error(`The vault's .obsidian folder could not be backed up, so nothing was changed: ${e.message}`);
    }
  }
  const written = [], made = [];
  try {
    for (const c of changes) {
      const target = path.join(dir, c.rel);
      const missing = [];
      for (let d = path.dirname(target); !fs.existsSync(d); d = path.dirname(d)) missing.unshift(d);
      for (const d of missing) { fs.mkdirSync(d); made.push(d); }
      written.push(c);
      fs.writeFileSync(`${target}.scriptorium-tmp`, c.content);
      fs.renameSync(`${target}.scriptorium-tmp`, target);
    }
  } catch (e) {
    let restored = true;
    for (const c of written.reverse()) {
      const target = path.join(dir, c.rel);
      try {
        if (fs.existsSync(`${target}.scriptorium-tmp`)) fs.unlinkSync(`${target}.scriptorium-tmp`);
        if (c.replaces) fs.copyFileSync(path.join(backup, c.rel), target);
        else if (fs.existsSync(target) && fs.statSync(target).isFile()) fs.unlinkSync(target);
      } catch (err) { restored = false; }
    }
    for (const d of made.reverse()) { try { fs.rmdirSync(d); } catch (err) { /* not empty: it was not ours alone */ } }
    if (restored && backup) { try { fs.rmSync(backup, { recursive: true, force: true }); } catch (err) { /* leave it */ } }
    throw new Error(restored ? `The setup failed and was undone: ${e.message}`
      : `The setup failed, and some files could not be put back; the originals are in ${backup}: ${e.message}`);
  }
  return backup;
}

/* The folder of a vault from what was typed or chosen: trimmed, quotes and a trailing separator removed; '' if it is
   not an absolute path. */
function setupFolder(path, text) {
  let t = String(text || '').trim().replace(/^["']|["']$/g, '').trim();
  if (!t || !path.isAbsolute(t)) return '';
  t = path.normalize(t);
  return t.length > path.parse(t).root.length ? t.replace(/[\\/]+$/, '') : t;
}

class SetupVaultModal extends Modal {
  /* target: null to ask for a folder ("another vault"), or this vault's folder. */
  constructor(plugin, target) {
    super(plugin.app);
    this.plugin = plugin;
    this.target = target;
    this.own = Boolean(target);
  }

  onOpen() {
    this.modalEl.addClass('scriptorium-setup');
    this.titleEl.setText(this.own ? 'Set up this vault' : 'Set up another vault');
    this.fs = require('fs');
    this.path = require('path');
    this.source = this.plugin.app.vault.adapter.basePath;
    if (this.own) this.showPlan(); else this.askFolder();
  }

  onClose() {
    this.contentEl.empty();
  }

  askFolder(problem) {
    const el = this.contentEl;
    el.empty();
    el.createEl('p', {
      text: 'Choose a vault, or any folder of notes. Scriptorium’s theme, snippet and plugins are added to its .obsidian ' +
        'folder from this vault, and its own settings are merged. Its notes are not touched. You are shown what will ' +
        'change before anything does.',
    });
    const row = el.createDiv({ cls: 'scriptorium-setup-row' });
    const input = row.createEl('input', { type: 'text', cls: 'scriptorium-setup-path', attr: { placeholder: 'The vault’s folder', 'aria-label': 'The vault’s folder', spellcheck: 'false' } });
    if (this.typed) input.value = this.typed;
    const dialog = setupDialog();
    if (dialog) {
      const browse = row.createEl('button', { text: 'Browse…' });
      browse.addEventListener('click', async () => {
        try {
          const r = await dialog.showOpenDialog({ title: 'Choose a vault to set up', properties: ['openDirectory', 'createDirectory'] });
          if (r && !r.canceled && r.filePaths && r.filePaths[0]) { input.value = r.filePaths[0]; input.focus(); }
        } catch (e) { new Notice('Could not open the folder chooser: type the folder’s path instead.'); }
      });
    }
    const said = el.createEl('p', { cls: 'scriptorium-setup-problem', text: problem || '' });
    const buttons = el.createDiv({ cls: 'modal-button-container' });
    const next = buttons.createEl('button', { cls: 'mod-cta', text: 'Show what will change' });
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    const go = () => {
      this.typed = input.value;
      const dir = setupFolder(this.path, input.value);
      let why = '';
      if (!dir) why = 'Give the folder’s full path.';
      else if (!this.fs.existsSync(dir) || !this.fs.statSync(dir).isDirectory()) why = 'There is no such folder. Make the vault in Obsidian first, or make the folder.';
      else if (this.path.basename(dir) === '.obsidian' || dir.split(/[\\/]/).includes('.obsidian')) why = 'That is a folder inside a vault’s settings, not a vault.';
      else if (this.path.resolve(dir) === this.path.resolve(this.source)) why = 'That is this vault. Use “Scriptorium: Set up this vault” for it.';
      if (why) { said.setText(why); input.focus(); return; }
      this.target = dir;
      this.showPlan();
    };
    next.addEventListener('click', go);
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); go(); } });
    window.setTimeout(() => input.focus(), 0);
  }

  showPlan() {
    const el = this.contentEl;
    el.empty();
    let plan;
    try {
      plan = planVaultSetup(this.fs, this.path, setupPackage(this.fs, this.path, this.source), this.target);
    } catch (e) {
      if (this.own) { el.createEl('p', { text: `Could not read the vault: ${e.message}` }); return; }
      this.askFolder(`Could not read that folder: ${e.message}`);
      return;
    }
    el.createEl('p', { cls: 'scriptorium-setup-where', text: this.target });
    const buttons = () => el.createDiv({ cls: 'modal-button-container' });
    if (!plan.changes.length) {
      el.createEl('p', { text: 'Scriptorium is already set up here: nothing to change.' });
      for (const n of plan.notes) el.createEl('p', { cls: 'scriptorium-setup-note', text: n });
      buttons().createEl('button', { cls: 'mod-cta', text: 'Close' }).addEventListener('click', () => this.close());
      return;
    }
    const replaced = plan.changes.filter(c => c.replaces).length, added = plan.changes.length - replaced;
    el.createEl('p', {
      text: `${added} file${added === 1 ? '' : 's'} to add and ${replaced} to replace or merge, all in the .obsidian folder. ` +
        'No note is touched and nothing is deleted. The .obsidian folder as it is now is first copied to ' +
        '.obsidian/scriptorium-backup-….',
    });
    el.createEl('pre', { cls: 'scriptorium-setup-plan', text: describeVaultSetup(plan).map(l => l.trimStart()).join('\n'), attr: { tabindex: '0' } });
    const row = buttons();
    const yes = row.createEl('button', { cls: 'mod-cta', text: 'Set up' });
    if (!this.own) row.createEl('button', { text: 'Back' }).addEventListener('click', () => this.askFolder());
    row.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    yes.addEventListener('click', () => {
      yes.disabled = true;
      let backup;
      try {
        backup = applyVaultSetup(this.fs, this.path, this.target, plan);
      } catch (e) {
        el.empty();
        el.createEl('p', { cls: 'scriptorium-setup-problem', text: e.message });
        buttons().createEl('button', { cls: 'mod-cta', text: 'Close' }).addEventListener('click', () => this.close());
        return;
      }
      el.empty();
      el.createEl('p', { text: `Done: ${added} file${added === 1 ? '' : 's'} added, ${replaced} replaced or merged.` });
      if (backup) el.createEl('p', { cls: 'scriptorium-setup-note', text: `The .obsidian folder as it was is in ${backup}` });
      el.createEl('p', {
        text: this.own ? 'Reload Obsidian to see it (Ctrl/Cmd+P, “Reload app without saving”).'
          : 'Open that vault from the vault switcher (“Open folder as vault” if it is new to Obsidian) and, when Obsidian asks, choose “Trust author and enable plugins”. If it was open, reload it.',
      });
      buttons().createEl('button', { cls: 'mod-cta', text: 'Close' }).addEventListener('click', () => this.close());
    });
  }
}

/* Electron's folder chooser, or null where there is none. */
function setupDialog() {
  try {
    const electron = require('electron');
    const remote = electron.remote || require('@electron/remote');
    return remote && remote.dialog && typeof remote.dialog.showOpenDialog === 'function' ? remote.dialog : null;
  } catch (e) {
    return null;
  }
}

/* ==========================================================
   Backing up to Google Drive (experimental)
   ==========================================================
   "Scriptorium: Back up this vault to Google Drive", "Sync now with Google Drive" and "Retrieve a vault from Google
   Drive" keep a copy of the vault in the writer's own Google Drive, in the folder Scriptorium/<vault name>/, without a
   Google API key: the calls are made by Claude Code, signed in to the writer's Claude account, through that account's
   Google Drive connector. How it works:
     - Scriptorium runs `claude -p` once per batch with a numbered list of exact Drive calls. The model (Haiku unless
       changed) makes them; it is given file names, folder names and Drive ids. It is never given what is in a file:
       an upload names the file by reference (sha256:<hash>:<path>) and Claude Code sends the bytes itself; every
       result, downloads included, is saved by Claude Code to a file that only Scriptorium reads
       (MAX_MCP_OUTPUT_TOKENS=1); and a hook refuses every tool but the Drive ones, so the model cannot read a file.
     - Nothing the model says is trusted: Scriptorium reads each call and each result from Claude Code's event stream,
       matches them against the list, and checks ids, sizes and (after a download) SHA-256.
     - The Drive folder holds the vault's files in the vault's own folders, and scriptorium-manifest.json: for each
       file its path, SHA-256, size, modified time and Drive id. The connector cannot replace a file's content, so a
       changed file is uploaded again and the old copy goes to Drive's trash; a deleted file is moved to
       _trash/<date>/ in the vault's Drive folder. Nothing is ever deleted for good.
     - This device remembers (drive-sync.json, next to this file) the hash of every file as of the last sync. Local,
       remote and remembered are compared file by file: changed on one side, that side wins; changed on both, both
       are kept (the local one is renamed "name (conflict <device> <date>).md"). Changes made on another device are
       always brought in before anything is sent.
     - What is done is recorded after every batch, so a stopped or failed run is continued by running it again.
   Not backed up: Obsidian's workspace and caches, .trash, hidden folders, the code of plugins and of Scriptorium's own
   theme and snippet (Setup or "Set up another vault" puts those back), other plugins' settings, and Lagrange's
   settings, which hold API keys. The functions below take fs, path and crypto as arguments and are tested under Node
   with a pretend Drive (plugins-tests/drive-sync.test.js). */

const DRIVE_TOOL = 'mcp__claude_ai_Google_Drive__';
const DRIVE_SCHEMA = 1;
const DRIVE_MANIFEST = 'scriptorium-manifest.json';
const DRIVE_STATE = '.obsidian/plugins/scriptorium/drive-sync.json';
const DRIVE_FOLDER_TYPE = 'application/vnd.google-apps.folder';
const DRIVE_ROOT = 'Scriptorium';
const DRIVE_MODEL = 'haiku';
// A batch is one run of Claude Code; up to `parallel` run at once. The connector takes a request of at most
// 10,000,000 bytes, and a file travels as base64 (4 bytes for every 3), so a file of more than about 7.4 MB cannot go
// up: one over 7 MB is listed as not backed up.
const DRIVE_LIMITS = { fileBytes: 7 * 1000 * 1000, batchFiles: 10, batchBytes: 20 * 1000 * 1000, parallel: 3, tries: 3, runMs: 10 * 60 * 1000 };
const DRIVE_SYSTEM = 'You make the Google Drive tool calls you are given, exactly as written, and nothing else. ' +
  'You never read, open or summarise a file, and you never repeat a call.';
/* The type a file is uploaded under. Only types that were seen to come back byte for byte are named. Everything else,
   images above all, goes up under a neutral type: Google Drive would call "a.png" an image whatever it is told except
   a type of its own, and Claude Code hands a downloaded image to the model as a picture, resized, instead of saving
   its bytes. (So Drive's web page may show no preview of an image in the backup; downloaded, it is the same file.) */
const DRIVE_MIME = { md: 'text/markdown', txt: 'text/plain', json: 'application/json', canvas: 'application/json', css: 'text/css', pdf: 'application/pdf', mp3: 'audio/mpeg' };
const DRIVE_MIME_OTHER = 'application/x-scriptorium-file';
function driveMime(name) {
  const dot = name.lastIndexOf('.');
  return (dot > 0 && Object.prototype.hasOwnProperty.call(DRIVE_MIME, name.slice(dot + 1).toLowerCase()) && DRIVE_MIME[name.slice(dot + 1).toLowerCase()]) || DRIVE_MIME_OTHER;
}

/* The settings of the backup, from the plugin's saved settings: {folder, model, device}. */
function driveSettings(saved, hostname) {
  const d = saved && saved.drive && typeof saved.drive === 'object' ? saved.drive : {};
  const clean = (v, max) => String(v || '').replace(/[\u0000-\u001f\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return {
    folder: clean(d.folder, 80) || DRIVE_ROOT,
    model: String(d.model || '').trim().replace(/[^\w.\-[\]]/g, '') || DRIVE_MODEL,
    device: clean(d.device, 40) || clean(hostname, 40) || 'this device',
  };
}

/* Whether the file at rel (forward slashes, relative to the vault) is backed up. */
function driveRule(rel) {
  const parts = String(rel || '').split('/');
  const name = parts[parts.length - 1];
  if (!name || parts.some(p => !p || p === '..' || p === '.') || /[\u0000-\u001f\\]/.test(rel)) return false;
  if (name.endsWith('.scriptorium-tmp') || /^(?:Thumbs\.db|desktop\.ini)$/i.test(name)) return false;
  if (parts[0] !== '.obsidian') return !parts.some(p => p.startsWith('.') || p === 'node_modules');
  if (parts.length === 2) return name.endsWith('.json') && !name.startsWith('workspace');
  if (setupRule(rel) === 'replace') return false;   // Scriptorium's own files: setting up a vault puts them back
  if (parts[1] === 'snippets') return parts.length === 3 && name.endsWith('.css');
  if (parts[1] === 'themes') return parts.length === 4 && (name === 'theme.css' || name === 'manifest.json');
  if (parts[1] === 'plugins') {
    return parts.length === 4 && name === 'data.json' && parts[2] !== 'lagrange' && (SETUP_PLUGINS.includes(parts[2]) || parts[2] === 'longform');
  }
  return false;
}

function driveBytes(n) {
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)} kB`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
}

/* The vault's files that are backed up: {files: {rel: {sha256, size, mtime}}, skipped: [{path, why}], hashes}.
   cache is the hashes of an earlier scan ({rel: [size, mtime, sha256]}): a file of the same size and time is not
   read again. */
function driveScan(fs, path, crypto, dir, cache, limits) {
  const max = (limits || DRIVE_LIMITS).fileBytes;
  const files = {}, skipped = [], hashes = {};
  // Only the folders that can hold a file that is backed up are walked.
  const walkable = (rel, name) => {
    const parts = rel ? rel.split('/') : [];
    if (!parts.length) return name === '.obsidian' || !(name.startsWith('.') || name === 'node_modules');
    if (parts[0] !== '.obsidian') return !(name.startsWith('.') || name === 'node_modules');
    if (parts.length === 1) return ['snippets', 'themes', 'plugins'].includes(name);
    return parts.length === 2 && parts[1] !== 'snippets';   // .obsidian/themes/<name> and .obsidian/plugins/<id>
  };
  const walk = rel => {
    let entries;
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch (e) { skipped.push({ path: rel || '.', why: `could not be read (${e.code || e.message})` }); return; }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (walkable(rel, entry.name)) walk(child); continue; }
      if (!entry.isFile()) continue;
      if (!driveRule(child)) {
        if (/[\u0000-\u001f\\]/.test(child)) skipped.push({ path: child, why: 'its name has a character that cannot be sent' });
        continue;
      }
      try {
        const stat = fs.statSync(path.join(dir, child));
        const size = stat.size, mtime = Math.round(stat.mtimeMs);
        if (size > max) { skipped.push({ path: child, why: `${driveBytes(size)}: larger than ${driveBytes(max)}` }); continue; }
        const known = cache && cache[child];
        const sha256 = known && known[0] === size && known[1] === mtime ? known[2]
          : crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, child))).digest('hex');
        files[child] = { sha256, size, mtime };
        hashes[child] = [size, mtime, sha256];
      } catch (e) {
        skipped.push({ path: child, why: `could not be read (${e.code || e.message})` });
      }
    }
  };
  walk('');
  return { files, skipped, hashes };
}

/* What a sync has to do, from the files here (local), the files in the Drive manifest (remote), each {rel: {sha256}},
   and the hashes both had at the last sync (base: {rel: sha256}). A file changed on one side goes to the other; a
   file changed on both sides, differently, is a conflict, except that a change always wins over a deletion. */
function drivePlan(local, remote, base) {
  const plan = { upload: [], download: [], conflicts: [], deleteLocal: [], deleteRemote: [], same: 0 };
  const all = new Set(Object.keys(local).concat(Object.keys(remote), Object.keys(base || {})));
  for (const rel of [...all].sort()) {
    const l = local[rel] ? local[rel].sha256 : null, r = remote[rel] ? remote[rel].sha256 : null;
    const b = base && typeof base[rel] === 'string' ? base[rel] : null;
    if (l === r) { if (l) plan.same++; continue; }
    if (l === b) (r ? plan.download : plan.deleteLocal).push(rel);          // only the remote changed
    else if (r === b) (l ? plan.upload : plan.deleteRemote).push(rel);      // only this vault changed
    else if (!l) plan.download.push(rel);                                   // deleted here, changed there: the change is kept
    else if (!r) plan.upload.push(rel);                                     // changed here, deleted there: the change is kept
    else plan.conflicts.push(rel);
  }
  return plan;
}

/* The name a file changed on both sides is kept under: "Notes/a.md" -> "Notes/a (conflict laptop 2026-11-12).md".
   taken(rel) says whether a name is in use. */
function driveConflictName(rel, device, date, taken) {
  const slash = rel.lastIndexOf('/'), folder = rel.slice(0, slash + 1), name = rel.slice(slash + 1);
  const dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  const who = String(device || '').replace(/[\u0000-\u001f\\/:*?"<>|()]/g, ' ').replace(/\s+/g, ' ').trim() || 'this device';
  const d = date instanceof Date ? date : new Date(date);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  for (let n = 1; ; n++) {
    const out = `${folder}${stem} (conflict ${who} ${day}${n > 1 ? ` ${n}` : ''})${ext}`;
    if (!taken || !taken(out)) return out;
  }
}

/* The operations in groups of at most limits.batchFiles and limits.batchBytes (size(op) in bytes): one run each. */
function driveBatches(ops, size, limits) {
  const l = limits || DRIVE_LIMITS, out = [];
  let group = [], bytes = 0;
  for (const op of ops) {
    const n = size ? size(op) : 0;
    if (group.length && (group.length >= l.batchFiles || bytes + n > l.batchBytes)) { out.push(group); group = []; bytes = 0; }
    group.push(op);
    bytes += n;
  }
  if (group.length) out.push(group);
  return out;
}

/* A call's arguments as one string, to compare a call that was made with the call that was asked for: keys in
   order, and true, 100 and "100" alike as text, since the model sometimes writes a number or a boolean as a string
   (Google Drive takes either). */
function driveStable(v) {
  if (Array.isArray(v)) return `[${v.map(driveStable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${driveStable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined || v === null ? '' : String(v));
}

/* What Claude Code is asked: to load the tools (Claude Code holds a connector's tools back until they are looked up,
   and a call to one that is not loaded fails), then the calls, numbered, as JSON. */
function drivePrompt(calls) {
  const tools = [...new Set(calls.map(c => DRIVE_TOOL + c.tool))];
  return `First call ToolSearch once with ${JSON.stringify({ query: `select:${tools.join(',')}`, max_results: tools.length })} to load the tools. ` +
    `Then make exactly these ${calls.length === 1 ? 'tool call' : `${calls.length} tool calls`}, each once, with exactly these arguments, ` +
    'copied character for character. You may make several at once. Make no other call. If a call fails, do not make ' +
    'it again and do not try another way. A result that says its output has been saved to a file is a success: do ' +
    'not read the file. When every call has been made, reply with the one word: done\n\n' +
    calls.map((c, i) => `${i + 1}. ${DRIVE_TOOL}${c.tool} ${JSON.stringify(c.input)}`).join('\n') + '\n';
}

/* Applies one line of `claude -p --output-format stream-json` to st = {uses: [], results: {}, cost: 0}. */
function applyDriveLine(st, line) {
  line = String(line || '').trim();
  if (!line) return;
  let e;
  try { e = JSON.parse(line); } catch (err) { return; }
  const blocks = e && e.message && Array.isArray(e.message.content) ? e.message.content : [];
  if (e.type === 'assistant') {
    for (const b of blocks) if (b && b.type === 'tool_use') st.uses.push({ id: b.id, name: String(b.name), input: b.input || {} });
  } else if (e.type === 'user') {
    for (const b of blocks) {
      if (!b || b.type !== 'tool_result') continue;
      const text = typeof b.content === 'string' ? b.content
        : (Array.isArray(b.content) ? b.content.filter(c => c && c.type === 'text').map(c => c.text).join('\n') : '');
      st.results[b.tool_use_id] = { error: Boolean(b.is_error), text };
    }
  } else if (e.type === 'result') {
    st.done = true;
    st.cost += Number(e.total_cost_usd) || 0;
    if (e.is_error) st.error = String(e.result || (e.errors && e.errors.join(' ')) || e.subtype || 'Claude Code reported an error.');
  }
}

/* One result of a call, from what Claude Code gave the model: {ok, data} or {ok: false, error}. A result too large
   for the model (every result is, by MAX_MCP_OUTPUT_TOKENS) was saved to a file, which is read here and deleted.
   A download comes in one of two shapes: {content: <base64>, id, ...}, or, for some types of file, the bytes in a
   file of their own ("Binary content (...) saved to <path>") next to {content: "(file sent separately)", id, ...};
   then data.bytes holds them. */
function driveResult(fs, path, r) {
  if (!r) return { ok: false, error: 'No answer came back from Google Drive.' };
  const take = file => {
    const data = fs.readFileSync(file);
    try {
      fs.unlinkSync(file);
      // The folders Claude Code made for it, if nothing else is in them.
      for (let d = path.dirname(file), n = 0; n < 3; n++, d = path.dirname(d)) fs.rmdirSync(d);
    } catch (e) { /* not empty, or not ours to remove */ }
    return data;
  };
  let text = r.text || '';
  try {
    const saved = text.match(/Output has been saved to (.+?[\\/]tool-results[\\/][^\\/\n]+?\.(?:txt|json))\.?\s*(?:\n|$)/);
    if (saved) text = take(saved[1]).toString('utf8');
    if (r.error) return { ok: false, error: text.replace(/<\/?tool_use_error>/g, '').slice(0, 400) || 'Google Drive refused the call.' };
    if (!text.trim()) return { ok: true, data: {} };
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* not JSON alone */ }
    if (Array.isArray(data)) {   // the result's blocks
      text = data.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
      data = null;
    }
    let bytes = null;
    const blob = text.match(/Binary content \([^)\n]*\) saved to (.+?[\\/]tool-results[\\/][^\\/\n]+?)\s*(?:\n|$)/);
    if (blob) {
      bytes = take(blob[1]);
      const rest = text.slice(blob.index + blob[0].length).trim();
      try { data = JSON.parse(rest); } catch (e) { data = null; }
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (bytes) data.bytes = bytes;
      return { ok: true, data };
    }
  } catch (e) {
    return { ok: false, error: `The saved result could not be read: ${e.message}` };
  }
  return { ok: false, error: text.slice(0, 400) };
}

/* The results of the calls that were asked for, in order, from a finished run; extra lists Drive calls the model
   made that were not asked for. */
function driveResults(fs, path, st, calls) {
  const used = new Set();
  const results = calls.map(call => {
    const key = driveStable(call.input);
    // If the model made the call twice (it should not), the one that worked is the one that counts.
    const made = st.uses.filter(u => !used.has(u.id) && u.name === DRIVE_TOOL + call.tool && driveStable(u.input) === key);
    const use = made.find(u => st.results[u.id] && !st.results[u.id].error) || made[0];
    if (!use) return { ok: false, error: 'Claude Code did not make this call as it was written.', missed: true };
    used.add(use.id);
    return driveResult(fs, path, st.results[use.id]);
  });
  const extra = st.uses.filter(u => !used.has(u.id) && u.name.startsWith(DRIVE_TOOL))
    .map(u => ({ tool: u.name.slice(DRIVE_TOOL.length), input: u.input, result: driveResult(fs, path, st.results[u.id]) }));
  return { results, extra };
}

/* Makes Drive calls by running Claude Code: returns run(calls, hooks) -> {results, extra, cost}. cli is Lagrange's
   {runCli, cliErrorMessage}; exe the path of `claude`; dirs the folders files are uploaded from; work a private
   folder Claude Code runs in. */
function driveRunner(o) {
  const { fs, path } = o;
  const settings = path.join(o.work, 'drive-settings.json');
  // Every tool but the Drive connector's (and the tool that looks tools up) is refused before it runs.
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '^(?!mcp__claude_ai_Google_Drive__|ToolSearch$).*', hooks: [{ type: 'command', command: 'exit 2' }] }] } }));
  return async (calls, hooks = {}) => {
    const cmd = process.platform === 'win32' && /\.cmd$/i.test(o.exe);
    const quote = a => (cmd ? `"${String(a).replace(/"/g, '""')}"` : a);
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--model', quote(o.model || DRIVE_MODEL),
      '--setting-sources', quote(''), '--settings', quote(settings), '--system-prompt', quote(DRIVE_SYSTEM)];
    for (const d of o.dirs || []) args.push('--add-dir', quote(d));
    args.push('--allowedTools', quote([...new Set(calls.map(c => DRIVE_TOOL + c.tool))].join(',')));
    const st = { uses: [], results: {}, cost: 0, done: false, error: null };
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    if (hooks.signal) { if (hooks.signal.aborted) stop.abort(); else hooks.signal.addEventListener('abort', onAbort, { once: true }); }
    let late = false;
    const timer = setTimeout(() => { late = true; stop.abort(); }, (o.limits || DRIVE_LIMITS).runMs);
    let ended;
    try {
      ended = await o.cli.runCli('claude', o.exe, args, drivePrompt(calls), line => {
        applyDriveLine(st, line);
        if (o.onLine) o.onLine(line);   // for plugins-tests/drive-sync-cli.js
        if (hooks.onStep) hooks.onStep(Object.keys(st.results).length);
      }, { signal: stop.signal, cwd: o.work, env: { MAX_MCP_OUTPUT_TOKENS: '1' } });
    } catch (e) {
      // Stopped part-way: the calls that were answered still count (and their saved results are read and deleted).
      try { e.partial = driveResults(fs, path, st, calls).results; } catch (err) { /* nothing to salvage */ }
      if (!late) throw e;
      throw new Error('Claude Code took too long over one batch and was stopped. Run it again to continue.');
    } finally {
      clearTimeout(timer);
      if (hooks.signal) hooks.signal.removeEventListener('abort', onAbort);
    }
    const out = driveResults(fs, path, st, calls);
    if (st.error || (!st.uses.length && (ended.code || !st.done))) {
      throw new Error(o.cli.cliErrorMessage('claude', st.error || ended.stderr || `exit code ${ended.code}`));
    }
    return Object.assign(out, { cost: st.cost });
  };
}

/* Whether Claude Code is here and has the Google Drive connector: {ok: true, exe} or {ok: false, problem, steps}.
   cli is Lagrange's {findCli, runCli}; custom a path to `claude` set in Lagrange's settings. */
async function driveCheck(cli, custom) {
  const steps = [
    'Install Claude Code (claude.com/code).',
    'Run “claude” once in a terminal and sign in with your Claude account (Pro or Max).',
    'Connect Google Drive to that account: on claude.ai, open Settings → Connectors, choose Google Drive and Connect.',
    'Run this command again.',
  ];
  let exe;
  try { exe = cli.findCli('claude', custom); } catch (e) { return { ok: false, problem: e.message, steps: [] }; }
  if (!exe) return { ok: false, problem: `Claude Code was not found${custom ? ` at ${custom}` : ''}.`, steps };
  let text = '', ended;
  try {
    // `claude auth status` prints JSON; an older Claude Code without it is asked for its connectors anyway.
    let auth = '';
    await cli.runCli('claude', exe, ['auth', 'status'], '', line => { auth += `${line}\n`; }, {});
    let who = null;
    try { who = JSON.parse(auth); } catch (e) { /* not JSON */ }
    if (who && who.loggedIn === false) return { ok: false, problem: 'Claude Code is not signed in.', steps: steps.slice(1) };
    if (who && who.loggedIn && who.authMethod && who.authMethod !== 'claude.ai') {
      return { ok: false, problem: 'Claude Code is signed in with an API key. Connectors such as Google Drive belong to a Claude account: sign in with one (run “claude”, then /login).', steps: steps.slice(2) };
    }
    ended = await cli.runCli('claude', exe, ['mcp', 'list'], '', line => { text += `${line}\n`; }, {});
  } catch (e) {
    return { ok: false, problem: e.message, steps };
  }
  const line = text.split('\n').find(l => /google drive/i.test(l));
  if (line && /connected/i.test(line) && !/not connected|needs auth|failed/i.test(line)) return { ok: true, exe };
  if (line) return { ok: false, problem: 'Your Claude account has the Google Drive connector, but it is not signed in to Google.', steps: steps.slice(2) };
  if (/log ?in|sign ?in|authenticat/i.test(`${text} ${ended.stderr}`) && !/claude\.ai/i.test(text)) {
    return { ok: false, problem: 'Claude Code is not signed in.', steps: steps.slice(1) };
  }
  return { ok: false, problem: 'Claude Code is here, but your Claude account has no Google Drive connector (or Claude Code is signed in with an API key, not a Claude account).', steps: steps.slice(1) };
}

/* The bytes of a download's result, or null if it has none. */
function driveBytesOf(data) {
  if (data && data.bytes) return data.bytes;
  return data && typeof data.content === 'string' && data.content !== '(file sent separately)' ? Buffer.from(data.content, 'base64') : null;
}

function driveQuote(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/* A manifest that was downloaded, checked: the object, or an Error to throw. */
function driveManifest(data) {
  let m;
  try { m = JSON.parse(driveBytesOf(data).toString('utf8')); } catch (e) { m = null; }
  if (!m || typeof m !== 'object' || m.app !== 'scriptorium' || !m.files || typeof m.files !== 'object' || Array.isArray(m.files)) {
    return new Error('The backup’s list of files (scriptorium-manifest.json) in Google Drive could not be read.');
  }
  if (!(Number(m.schema) <= DRIVE_SCHEMA)) return new Error('This backup was written by a newer Scriptorium. Update Scriptorium on this computer, then try again.');
  for (const [rel, f] of Object.entries(m.files)) {
    if (!driveRule(rel) || !f || !/^[0-9a-f]{64}$/.test(f.sha256) || !(f.size >= 0) || !(f.id === null || typeof f.id === 'string')) delete m.files[rel];
  }
  m.seq = Number(m.seq) || 0;
  m.folders = m.folders && typeof m.folders === 'object' ? m.folders : {};
  m.deleted = Array.isArray(m.deleted) ? m.deleted : [];
  m.stale = Array.isArray(m.stale) ? m.stale.filter(id => typeof id === 'string') : [];
  return m;
}

/* The name of the backup the vault in dir is tied to in the Drive folder `folder` (a retrieved vault keeps its
   backup's name even if its own folder is called something else), or null if it has not been synced there. */
function driveLinked(fs, path, dir, folder) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, DRIVE_STATE), 'utf8'));
    return s && s.schema === DRIVE_SCHEMA && s.rootName === folder && typeof s.vault === 'string' && s.vault && s.folderId ? s.vault : null;
  } catch (e) {
    return null;
  }
}

const DRIVE_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';   // the SHA-256 of no bytes

/* One vault and its copy in Drive. o: {fs, path, crypto, dir, work, run, folder, vault, device, say, signal, now,
   limits}. run(calls, hooks) makes Drive calls (driveRunner, or a pretend Drive in the tests); say({stage, done,
   total}) reports progress; work is a private folder for the manifest on its way up. */
class DriveSync {
  constructor(o) {
    Object.assign(this, { limits: DRIVE_LIMITS, now: () => new Date(), say: () => {}, folder: DRIVE_ROOT }, o);
    this.runs = 0;
    this.cost = 0;
    this.failed = [];
    this.done = { uploaded: 0, downloaded: 0, conflicts: [], deletedHere: 0, deletedThere: 0, bytesUp: 0, bytesDown: 0 };
    this.extraManifests = [];
    this.state = this.loadState();
  }

  loadState() {
    let s = null;
    try { s = JSON.parse(this.fs.readFileSync(this.path.join(this.dir, DRIVE_STATE), 'utf8')); } catch (e) { /* none yet */ }
    if (!s || typeof s !== 'object' || s.schema !== DRIVE_SCHEMA || s.rootName !== this.folder || s.vault !== this.vault) s = {};
    return {
      schema: DRIVE_SCHEMA, rootName: this.folder, vault: this.vault, rootId: s.rootId || null, folderId: s.folderId || null,
      seq: Number(s.seq) || 0, manifestId: s.manifestId || null, synced: s.synced || null,
      base: s.base && typeof s.base === 'object' ? s.base : {}, hashes: s.hashes && typeof s.hashes === 'object' ? s.hashes : {},
      journal: s.journal && typeof s.journal === 'object' ? s.journal : null,
      untidy: Array.isArray(s.untidy) ? s.untidy.filter(id => typeof id === 'string') : [],
    };
  }

  /* Written to a temporary file and renamed, so a crash leaves the old one or the new one, never half of one. */
  saveState() {
    const file = this.path.join(this.dir, DRIVE_STATE);
    this.fs.mkdirSync(this.path.dirname(file), { recursive: true });
    if (this.w && this.dirty) this.state.journal = { onSeq: this.remote ? this.remote.seq : 0, manifest: this.w };
    this.fs.writeFileSync(`${file}.scriptorium-tmp`, JSON.stringify(this.state));
    this.fs.renameSync(`${file}.scriptorium-tmp`, file);
  }

  check() {
    if (this.signal && this.signal.aborted) { const e = new Error('Stopped.'); e.name = 'AbortError'; throw e; }
  }

  async batch(calls, onStep) {
    this.check();
    this.runs++;
    const out = await this.run(calls, { signal: this.signal, onStep });
    this.cost += out.cost || 0;
    // A file or folder made by a call that was not asked for is ours to tidy away: it goes to Drive's trash later.
    for (const x of out.extra || []) {
      if (x.tool === 'create_file' && x.result.ok && typeof x.result.data.id === 'string' && this.w) { this.w.stale.push(x.result.data.id); this.dirty = true; }
    }
    return out.results;
  }

  /* One call that has to work: tried up to limits.tries times. */
  async must(call, what) {
    let why = '';
    for (let n = 0; n < this.limits.tries; n++) {
      const [r] = await this.batch([call]);
      if (r.ok) return r.data;
      why = r.error;
    }
    throw new Error(`${what}: ${why}`);
  }

  /* Runs call(op) for every op, in batches, trying again those that fail; done(op, data) takes each result and may
     throw to refuse it. Those that still fail are added to this.failed and returned. */
  async each(ops, o) {
    let left = ops.slice(), finished = 0;
    const total = ops.length, flying = new Map();
    const tell = () => this.say({ stage: o.stage, done: Math.min(total, finished + [...flying.values()].reduce((a, n) => a + n, 0)), total });
    for (let attempt = 1; left.length && attempt <= this.limits.tries; attempt++) {
      const again = [], groups = driveBatches(left, o.size, this.limits);
      let next = 0, halted = null;
      // Up to limits.parallel runs of Claude Code at once, each with its own batch.
      const worker = async () => {
        while (next < groups.length && !halted) {
          const group = groups[next++];
          let results;
          try {
            flying.set(group, 0);
            tell();
            results = await this.batch(group.map(o.call), n => { flying.set(group, Math.min(group.length, n)); tell(); });
          } catch (e) {
            halted = halted || e;
            results = Array.isArray(e.partial) ? e.partial : null;   // what a stopped run did before it stopped is kept
            if (!results) return;
          } finally {
            flying.delete(group);
          }
          for (let i = 0; i < group.length; i++) {
            const op = group[i], r = results[i];
            try {
              if (!r.ok) throw new Error(r.error);
              await o.done(op, r.data);
              finished++;
            } catch (e) {
              op.error = e.message;
              again.push(op);
            }
          }
          this.saveState();
          tell();
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(this.limits.parallel || 1, groups.length)) }, worker));
      if (halted) { this.saveState(); throw halted; }
      left = again;
    }
    for (const op of left) this.failed.push({ path: op.rel || op.title || '', why: `${o.stage}: ${op.error}` });
    return left;
  }

  async find(query) {
    const files = [];
    let token = null;
    for (let page = 0; page < 50; page++) {
      const input = { query, excludeContentSnippets: true, pageSize: 100 };
      if (token) input.pageToken = token;
      const data = await this.must({ tool: 'search_files', input }, 'Google Drive could not be searched');
      for (const f of Array.isArray(data.files) ? data.files : []) if (f && typeof f.id === 'string') files.push(f);
      token = data.nextPageToken || null;
      if (!token) break;
    }
    return files;
  }

  async mkdir(title, parentId) {
    const data = await this.must({ tool: 'create_file', input: { title, parentId, contentMimeType: DRIVE_FOLDER_TYPE } }, `The folder ${title} could not be made in Google Drive`);
    if (typeof data.id !== 'string' || data.mimeType !== DRIVE_FOLDER_TYPE) throw new Error(`The folder ${title} could not be made in Google Drive.`);
    return data.id;
  }

  async folderNamed(title, parentId) {
    const found = (await this.find(`title = '${driveQuote(title)}' and parentId = '${driveQuote(parentId)}' and mimeType = '${DRIVE_FOLDER_TYPE}'`))
      .filter(f => f.title === title && f.mimeType === DRIVE_FOLDER_TYPE && !f.trashed)
      .sort((a, b) => String(a.createdTime) < String(b.createdTime) ? -1 : 1);
    return found.length ? found[0].id : null;
  }

  manifestQuery(folderId) {
    return `title = '${DRIVE_MANIFEST}' and parentId = '${driveQuote(folderId)}'`;
  }

  /* Finds the vault's folder in Drive and its manifest: sets this.remote (the manifest, or null) and the ids in
     this.state. With create, the folders are made if they are not there. */
  async locate(create) {
    const st = this.state;
    let manifests = null, early = null;
    this.say({ stage: 'Looking in Google Drive' });
    if (st.folderId) {
      // Known from last time: one run checks that the folder is still there, looks for the manifest, and downloads
      // the manifest this device saw last, which is the current one unless another device has backed up since.
      const calls = [
        { tool: 'get_file_metadata', input: { fileId: st.folderId, excludeContentSnippets: true } },
        { tool: 'search_files', input: { query: this.manifestQuery(st.folderId), excludeContentSnippets: true, pageSize: 100 } },
      ];
      if (st.manifestId) calls.push({ tool: 'download_file_content', input: { fileId: st.manifestId } });
      const [meta, search, known] = await this.batch(calls);
      if (meta.ok && meta.data.id === st.folderId && !meta.data.trashed && search.ok) {
        manifests = Array.isArray(search.data.files) ? search.data.files : [];
        if (known && known.ok && known.data.id === st.manifestId) early = known.data;
      } else if ((meta.ok && search.ok) || (!meta.ok && /not found|404/i.test(meta.error))) { st.folderId = null; st.rootId = null; }
      else throw new Error(`Google Drive could not be read: ${(meta.ok ? search : meta).error}`);
    }
    if (!st.folderId) {
      st.rootId = await this.folderNamed(this.folder, 'root');
      if (!st.rootId && create) st.rootId = await this.mkdir(this.folder, 'root');
      if (st.rootId) {
        st.folderId = await this.folderNamed(this.vault, st.rootId);
        if (!st.folderId && create) { st.folderId = await this.mkdir(this.vault, st.rootId); manifests = []; }
      }
      if (st.folderId && !manifests) manifests = await this.find(this.manifestQuery(st.folderId));
    }
    this.remote = null;
    this.extraManifests = [];
    manifests = (manifests || []).filter(f => f && f.title === DRIVE_MANIFEST && !f.trashed && typeof f.id === 'string')
      .sort((a, b) => String(a.createdTime) > String(b.createdTime) ? -1 : 1);
    if (manifests.length) {
      const data = early && manifests[0].id === st.manifestId ? early
        : await this.must({ tool: 'download_file_content', input: { fileId: manifests[0].id } }, 'The backup’s list of files could not be downloaded');
      const m = driveManifest(data);
      if (m instanceof Error) throw m;
      this.remote = m;
      this.remoteId = manifests[0].id;
      this.extraManifests = manifests.slice(1).map(f => f.id);
    }
    return this.remote;
  }

  /* The manifest being worked on: the remote one (or an empty one), or the one a stopped run left, if the remote
     has not moved since. */
  working() {
    const j = this.state.journal, seq = this.remote ? this.remote.seq : 0;
    this.dirty = false;
    if (j && j.onSeq === seq && j.manifest && j.manifest.files && (this.remote || !this.state.folderId || j.manifest.folder === this.state.folderId)) {
      this.w = j.manifest;
      this.dirty = true;
    } else {
      this.state.journal = null;
      // No backup in Drive (none yet, or its folder was removed): what this device remembers of one no longer holds,
      // and must not be read as "deleted there".
      if (!this.remote) this.state.base = {};
      this.w = this.remote ? JSON.parse(JSON.stringify(this.remote))
        : { schema: DRIVE_SCHEMA, app: 'scriptorium', vault: this.vault, seq: 0, folders: {}, files: {}, deleted: [], stale: [] };
    }
    for (const k of ['folders', 'files']) if (!this.w[k] || typeof this.w[k] !== 'object') this.w[k] = {};
    for (const k of ['deleted', 'stale']) if (!Array.isArray(this.w[k])) this.w[k] = [];
  }

  scan() {
    const s = driveScan(this.fs, this.path, this.crypto, this.dir, this.state.hashes, this.limits);
    this.state.hashes = s.hashes;
    this.local = s.files;
    this.skipped = s.skipped;
    // A file here that is not backed up (too large, unreadable) is not "deleted here": it is left alone on both sides.
    const out = new Set(s.skipped.map(x => x.path));
    this.plan = drivePlan(this.local, this.w.files, this.state.base);
    this.plan.deleteRemote = this.plan.deleteRemote.filter(rel => !out.has(rel));
    return this.plan;
  }

  /* Looks at both sides and says what a sync would do. Nothing is changed, here or in Drive. */
  async prepare() {
    await this.locate(false);
    this.working();
    this.scan();
    const size = list => list.reduce((n, rel) => n + ((this.local[rel] || this.w.files[rel] || {}).size || 0), 0);
    const p = this.plan;
    return {
      plan: p, skipped: this.skipped, remote: this.remote, first: !this.remote, resumed: this.dirty,
      upBytes: size(p.upload), downBytes: p.download.concat(p.conflicts).reduce((n, rel) => n + (this.w.files[rel].size || 0), 0),
      nothing: Boolean(this.remote) && !this.dirty && !p.upload.length && !p.download.length && !p.conflicts.length && !p.deleteLocal.length && !p.deleteRemote.length
        && !this.extraManifests.length && !this.w.stale.length,
    };
  }

  hashNow(rel) {
    try { return this.crypto.createHash('sha256').update(this.fs.readFileSync(this.path.join(this.dir, rel))).digest('hex'); } catch (e) { return null; }
  }

  /* Puts downloaded bytes at rel. If the file here is not what the plan saw (it was changed on both sides, or while
     the sync ran), it is first renamed to a conflict name: nothing is overwritten that is not in Drive too. */
  place(rel, bytes, entry, expected) {
    const { fs, path } = this, target = path.join(this.dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const now = fs.existsSync(target) ? this.hashNow(rel) : null;
    if (now && now !== entry.sha256 && now !== expected) {
      const name = driveConflictName(rel, this.device, this.now(), r => fs.existsSync(path.join(this.dir, r)));
      fs.renameSync(target, path.join(this.dir, name));
      this.done.conflicts.push({ path: rel, kept: name });
    }
    fs.writeFileSync(`${target}.scriptorium-tmp`, bytes);
    fs.renameSync(`${target}.scriptorium-tmp`, target);
    if (entry.mtime > 0) { try { fs.utimesSync(target, new Date(entry.mtime), new Date(entry.mtime)); } catch (e) { /* the time is only a convenience */ } }
    this.state.base[rel] = entry.sha256;
  }

  /* Brings in what changed in Drive: downloads (checked against the manifest's SHA-256), conflicts, and deletions
     (the file here goes to the vault's .trash folder). */
  async pull() {
    const { fs, path } = this, p = this.plan, files = this.w.files;
    const conflicts = new Set(p.conflicts);
    const ops = p.download.concat(p.conflicts).map(rel => ({ rel, entry: files[rel], expected: conflicts.has(rel) ? null : (this.local[rel] ? this.local[rel].sha256 : null) }));
    const got = (op, bytes) => {
      const sha = this.crypto.createHash('sha256').update(bytes).digest('hex');
      if (sha !== op.entry.sha256 || bytes.length !== op.entry.size) throw new Error('what came from Google Drive does not match the backup’s SHA-256, so it was not written');
      this.place(op.rel, bytes, op.entry, op.expected);
      this.done.downloaded++;
      this.done.bytesDown += bytes.length;
    };
    const empty = ops.filter(op => op.entry.id === null);
    for (const op of empty) {
      try { if (op.entry.sha256 !== DRIVE_EMPTY) throw new Error('the backup has no copy of it'); got(op, Buffer.alloc(0)); }
      catch (e) { this.failed.push({ path: op.rel, why: `Downloading: ${e.message}` }); }
    }
    await this.each(ops.filter(op => op.entry.id !== null), {
      stage: 'Downloading', size: op => op.entry.size,
      call: op => ({ tool: 'download_file_content', input: { fileId: op.entry.id } }),
      done: (op, data) => {
        const bytes = driveBytesOf(data);
        if (data.id !== op.entry.id || !bytes) throw new Error('Google Drive answered with something else');
        got(op, bytes);
      },
    });
    for (const rel of p.deleteLocal) {
      const target = path.join(this.dir, rel);
      try {
        if (this.hashNow(rel) !== this.local[rel].sha256) continue;   // changed since it was looked at: kept, and sent next time
        let to = path.join(this.dir, '.trash', rel);
        for (let n = 2; fs.existsSync(to); n++) to = path.join(this.dir, '.trash', `${rel}.${n}`);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(target, to);
        delete this.state.base[rel];
        this.done.deletedHere++;
      } catch (e) {
        this.failed.push({ path: rel, why: `Could not be moved to .trash: ${e.message}` });
      }
    }
    this.saveState();
  }

  /* The Drive folders for these vault folders ('' is the vault's own), made level by level where they are missing. */
  async folders(dirs) {
    const w = this.w;
    w.folders[''] = this.state.folderId;
    const need = new Set();
    for (const d of dirs) for (let p = d; p && !w.folders[p]; p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') need.add(p);
    const depth = p => p.split('/').length;
    for (const level of [...new Set([...need].map(depth))].sort((a, b) => a - b)) {
      const ops = [...need].filter(p => depth(p) === level).sort().map(rel => ({ rel, title: rel.slice(rel.lastIndexOf('/') + 1), parent: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '' }))
        .filter(op => w.folders[op.parent]);
      await this.each(ops, {
        stage: 'Making folders',
        call: op => ({ tool: 'create_file', input: { title: op.title, parentId: w.folders[op.parent], contentMimeType: DRIVE_FOLDER_TYPE } }),
        done: (op, data) => {
          if (typeof data.id !== 'string' || data.mimeType !== DRIVE_FOLDER_TYPE) throw new Error('Google Drive did not make the folder');
          w.folders[op.rel] = data.id;
          this.dirty = true;
        },
      });
    }
  }

  /* Sends what changed here: uploads (new files, and changed ones, whose old copy goes to Drive's trash when the
     new manifest is up) and deletions (the copy in Drive is moved to _trash/<date>/). */
  async push() {
    const { path } = this, w = this.w, p = this.plan;
    const folderOf = rel => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
    const upload = p.upload.map(rel => ({ rel, title: rel.slice(rel.lastIndexOf('/') + 1), folder: folderOf(rel), local: this.local[rel] }));
    const record = (op, id) => {
      const old = w.files[op.rel];
      if (old && old.id && old.id !== id) w.stale.push(old.id);
      w.files[op.rel] = { sha256: op.local.sha256, size: op.local.size, mtime: op.local.mtime, id, device: this.device };
      this.state.base[op.rel] = op.local.sha256;
      this.dirty = true;
      this.done.uploaded++;
      this.done.bytesUp += op.local.size;
    };
    for (const op of upload.filter(o => o.local.size === 0)) record(op, null);   // Drive takes no empty file: the manifest alone records it
    const real = upload.filter(o => o.local.size > 0);
    await this.folders(real.map(op => op.folder));
    const ready = real.filter(op => w.folders[op.folder]);
    for (const op of real) if (!w.folders[op.folder]) this.failed.push({ path: op.rel, why: 'Uploading: its folder could not be made in Google Drive' });
    await this.each(ready, {
      stage: 'Uploading', size: op => op.local.size,
      call: op => ({
        tool: 'create_file',
        input: {
          title: op.title, parentId: w.folders[op.folder], contentMimeType: driveMime(op.title),
          disableConversionToGoogleType: true,
          base64Content: `sha256:${op.local.sha256}:${path.join(this.dir, op.rel).split(path.sep).join('/')}`,
        },
      }),
      done: (op, data) => {
        if (typeof data.id !== 'string') throw new Error('Google Drive gave no id for it');
        if (String(data.fileSize) !== String(op.local.size) || String(data.title).normalize('NFC') !== op.title.normalize('NFC') || data.parentId !== w.folders[op.folder]
            || data.mimeType !== driveMime(op.title)) {
          w.stale.push(data.id);
          this.dirty = true;
          throw new Error('what arrived in Google Drive is not the file that was sent');
        }
        record(op, data.id);
      },
    });
    const gone = p.deleteRemote.filter(rel => w.files[rel]);
    if (gone.length) {
      const d = this.now(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const bin = `_trash/${day}`;
      const moved = (rel, id) => {
        w.deleted.push({ path: rel, sha256: w.files[rel].sha256, size: w.files[rel].size, id, folder: id ? bin : null, at: d.toISOString(), device: this.device });
        delete w.files[rel];
        delete this.state.base[rel];
        this.dirty = true;
        this.done.deletedThere++;
      };
      for (const rel of gone.filter(rel => !w.files[rel].id)) moved(rel, null);
      const ops = gone.filter(rel => w.files[rel]).map(rel => ({ rel, id: w.files[rel].id }));
      if (ops.length) {
        await this.folders([bin]);
        if (!w.folders[bin]) for (const op of ops) this.failed.push({ path: op.rel, why: 'Deleting: the _trash folder could not be made in Google Drive' });
        else {
          await this.each(ops, {
            stage: 'Moving deleted files to _trash',
            call: op => ({ tool: 'update_file', input: { fileId: op.id, parentId: w.folders[bin] } }),
            done: (op, data) => {
              if (data.id !== op.id || data.parentId !== w.folders[bin]) throw new Error('Google Drive did not move it');
              moved(op.rel, op.id);
            },
          });
        }
      }
    }
    for (const rel of p.deleteRemote) if (!w.files[rel]) delete this.state.base[rel];
  }

  /* Uploads the manifest as it now is, then sends the old manifest and the old copies of changed files to Drive's
     trash. Until the new manifest is up, the old one stands and describes files that are all still there. */
  async publish() {
    const { fs, path } = this, w = this.w, st = this.state;
    this.say({ stage: 'Writing the list of files' });
    const stale = w.stale.concat(st.untidy, this.extraManifests, this.remoteId ? [this.remoteId] : []);
    w.schema = DRIVE_SCHEMA;
    w.app = 'scriptorium';
    w.vault = this.vault;
    w.seq = (this.remote ? this.remote.seq : 0) + 1;
    w.updated = this.now().toISOString();
    w.device = this.device;
    w.root = st.rootId;
    w.folder = st.folderId;
    w.stale = [];
    const file = path.join(this.work, DRIVE_MANIFEST);
    const bytes = Buffer.from(JSON.stringify(w, null, 1), 'utf8');
    fs.writeFileSync(file, bytes);
    const sha = this.crypto.createHash('sha256').update(bytes).digest('hex');
    let data;
    try {
      data = await this.must({
        tool: 'create_file',
        input: { title: DRIVE_MANIFEST, parentId: st.folderId, contentMimeType: 'application/json', disableConversionToGoogleType: true, base64Content: `sha256:${sha}:${file.split(path.sep).join('/')}` },
      }, 'The list of files could not be uploaded');
      if (typeof data.id !== 'string' || String(data.fileSize) !== String(bytes.length)) throw new Error('The list of files did not arrive whole in Google Drive.');
    } catch (e) {
      w.stale = stale.filter(id => id !== this.remoteId && !this.extraManifests.includes(id) && !st.untidy.includes(id));
      this.saveState();
      throw e;
    } finally {
      try { fs.unlinkSync(file); } catch (e) { /* gone */ }
    }
    this.remote = JSON.parse(JSON.stringify(w));
    this.remoteId = data.id;
    this.extraManifests = [];
    st.seq = w.seq;
    st.manifestId = data.id;
    st.journal = null;
    this.dirty = false;
    this.saveState();
    // Tidying: a failure here costs nothing but clutter in Drive, and is not reported as a failure of the backup.
    const left = [];
    if (stale.length) {
      const before = this.failed.length;
      const ops = [...new Set(stale)].map(id => ({ id }));
      const kept = await this.each(ops, { stage: 'Tidying old copies', call: op => ({ tool: 'trash_file', input: { fileId: op.id } }), done: () => {} });
      this.failed.length = before;
      for (const op of kept) if (!/not found|404/i.test(op.error || '')) left.push(op.id);
    }
    st.untidy = left;   // tried again with the next manifest
    this.untidy = left.length;
    this.saveState();
  }

  /* After a sync, what both sides have in common is remembered: the next sync compares against it. */
  settle() {
    const st = this.state, files = this.w.files;
    const s = driveScan(this.fs, this.path, this.crypto, this.dir, st.hashes, this.limits);
    st.hashes = s.hashes;
    const base = {};
    for (const rel of new Set(Object.keys(files).concat(Object.keys(s.files)))) {
      const l = s.files[rel] ? s.files[rel].sha256 : null, r = files[rel] ? files[rel].sha256 : null;
      if (l && l === r) base[rel] = l;
      else if (typeof st.base[rel] === 'string') base[rel] = st.base[rel];
    }
    st.base = base;
    st.seq = this.remote ? this.remote.seq : st.seq;
    st.synced = this.now().toISOString();
    this.saveState();
  }

  summary(started) {
    return Object.assign({}, this.done, {
      failed: this.failed, skipped: this.skipped || [], runs: this.runs, cost: this.cost, untidy: this.untidy || 0,
      files: Object.keys(this.w.files).length, seconds: Math.round((this.now() - started) / 100) / 10,
    });
  }

  /* The whole sync, after prepare(): bring in, look again, send, write the manifest. */
  async sync() {
    const started = this.now();
    if (!this.plan) await this.prepare();
    await this.pull();
    if (!this.state.folderId) { await this.locate(true); if (this.remote) throw new Error('A backup of this vault appeared in Google Drive just now. Run the sync again.'); }
    this.w.folder = this.state.folderId;
    this.scan();   // what is here now: the files brought in, and the conflict copies, which are sent like any new file
    await this.push();
    if (this.dirty || !this.remote || this.extraManifests.length || this.w.stale.length) await this.publish();
    this.settle();
    this.say({ stage: 'Done' });
    return this.summary(started);
  }

  /* The vaults backed up under the Drive folder: [{name, folderId, manifestId, manifest, files, bytes, updated,
     device}], by name. */
  async vaults() {
    this.say({ stage: 'Looking for vaults in Google Drive' });
    const rootId = await this.folderNamed(this.folder, 'root');
    if (!rootId) return [];
    const folders = (await this.find(`parentId = '${driveQuote(rootId)}' and mimeType = '${DRIVE_FOLDER_TYPE}'`)).filter(f => f.mimeType === DRIVE_FOLDER_TYPE && !f.trashed);
    const found = [];
    await this.each(folders.map(f => ({ title: f.title, id: f.id })), {
      stage: 'Looking for vaults in Google Drive',
      call: op => ({ tool: 'search_files', input: { query: this.manifestQuery(op.id), excludeContentSnippets: true, pageSize: 100 } }),
      done: (op, data) => {
        const m = (Array.isArray(data.files) ? data.files : []).filter(f => f && f.title === DRIVE_MANIFEST && !f.trashed && typeof f.id === 'string')
          .sort((a, b) => String(a.createdTime) > String(b.createdTime) ? -1 : 1);
        if (m.length) found.push({ name: op.title, folderId: op.id, rootId, manifestId: m[0].id });
      },
    });
    const out = [];
    await this.each(found.map(v => Object.assign({ title: v.name }, v)), {
      stage: 'Reading the backups’ lists of files', call: op => ({ tool: 'download_file_content', input: { fileId: op.manifestId } }),
      done: (op, data) => {
        const m = driveManifest(data);
        if (m instanceof Error) throw m;
        const list = Object.values(m.files);
        out.push({ name: op.name, folderId: op.folderId, rootId: op.rootId, manifestId: op.manifestId, manifest: m, files: list.length,
          bytes: list.reduce((n, f) => n + f.size, 0), updated: m.updated || null, device: m.device || null });
      },
    });
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /* Downloads the vault `entry` (one of vaults()) into this.dir, checking every file's SHA-256, and leaves the folder
     ready to sync with that backup. Nothing is sent to Drive. */
  async retrieve(entry) {
    const started = this.now();
    Object.assign(this.state, { rootId: entry.rootId, folderId: entry.folderId, journal: null, base: {} });
    this.remote = entry.manifest;
    this.remoteId = entry.manifestId;
    this.working();
    this.scan();
    await this.pull();
    this.state.manifestId = entry.manifestId;
    this.settle();
    this.say({ stage: 'Done' });
    return this.summary(started);
  }
}

/* Opens the folder as a vault in a new Obsidian window, the way Obsidian's own vault chooser does. False if it
   could not be asked. */
function openVaultWindow(dir) {
  try {
    return require('electron').ipcRenderer.sendSync('vault-open', dir, false) === true;
  } catch (e) {
    return false;
  }
}

function driveWhen(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return 'at an unknown time';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function driveCount(n, one, many) {
  return `${n} ${n === 1 ? one : (many || `${one}s`)}`;
}

const DRIVE_TITLES = { backup: 'Back up this vault to Google Drive', sync: 'Sync now with Google Drive', retrieve: 'Retrieve a vault from Google Drive' };
const DRIVE_PRIVACY = 'Your files go only to your own Google Drive, through your Claude account’s Google Drive connector, ' +
  'run by Claude Code on this computer. The model that makes the calls is given the names of your files and folders ' +
  '(with the vault’s path on this computer) and their Drive ids; it is not given what is in them: Claude Code sends ' +
  'and receives the contents itself. ' +
  'Each batch of about ten files is one short run of Claude Code and uses a little of your subscription’s usage.';

class DriveModal extends Modal {
  /* mode: 'backup', 'sync' (the same work under another name: bring in, then send) or 'retrieve'. */
  constructor(plugin, mode) {
    super(plugin.app);
    this.plugin = plugin;
    this.mode = mode;
  }

  onOpen() {
    this.modalEl.addClass('scriptorium-setup');
    this.modalEl.addClass('scriptorium-drive');
    this.titleEl.setText(DRIVE_TITLES[this.mode]);
    this.titleEl.createSpan({ cls: 'scriptorium-drive-tag', text: 'experimental' });
    this.stop = new AbortController();
    this.start().catch(e => this.fail(e));
  }

  onClose() {
    if (this.stop) this.stop.abort();
    if (this.work) { try { this.fs.rmSync(this.work, { recursive: true, force: true }); } catch (e) { /* the system clears its temporary folder */ } }
    this.contentEl.empty();
  }

  buttons() {
    return this.contentEl.createDiv({ cls: 'modal-button-container' });
  }

  closeButton(row, cta) {
    (row || this.buttons()).createEl('button', { cls: cta === false ? '' : 'mod-cta', text: 'Close' }).addEventListener('click', () => this.close());
  }

  wait(text) {
    const el = this.contentEl;
    el.empty();
    el.createEl('p', { cls: 'scriptorium-drive-wait', text });
    this.buttons().createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
  }

  fail(e) {
    if (!this.contentEl.isConnected) return;
    const el = this.contentEl;
    el.empty();
    if (e && e.name === 'AbortError') el.createEl('p', { text: 'Stopped. What was done so far is kept, here and in Google Drive: run it again to carry on from there.' });
    else el.createEl('p', { cls: 'scriptorium-setup-problem', text: (e && e.message) || String(e) });
    this.closeButton();
  }

  problem(text, steps) {
    const el = this.contentEl;
    el.empty();
    el.createEl('p', { cls: 'scriptorium-setup-problem', text });
    if (steps && steps.length) {
      el.createEl('p', { text: 'What to do:' });
      const ol = el.createEl('ol', { cls: 'scriptorium-drive-steps' });
      for (const s of steps) ol.createEl('li', { text: s });
    }
    el.createEl('p', { cls: 'scriptorium-setup-note', text: 'Google Drive is the only storage supported so far. Box and a ChatGPT account (Codex) are not supported yet.' });
    this.closeButton();
  }

  async start() {
    const tools = this.plugin.driveTools();
    if (tools.problem) { this.problem(tools.problem, []); return; }
    this.fs = require('fs');
    this.path = require('path');
    this.wait('Checking Claude Code and its Google Drive connector…');
    const check = await driveCheck(tools.cli, tools.custom);
    if (this.stop.signal.aborted) return;
    if (!check.ok) { this.problem(check.problem, check.steps); return; }
    const os = require('os');
    this.work = this.fs.mkdtempSync(this.path.join(os.tmpdir(), 'scriptorium-drive-'));
    this.settings = driveSettings(this.plugin.settings, os.hostname());
    this.vaultDir = this.plugin.app.vault.adapter.basePath;
    this.make = (dir, vault) => new DriveSync({
      fs: this.fs, path: this.path, crypto: require('crypto'), dir, work: this.work, vault, folder: this.settings.folder, device: this.settings.device,
      signal: this.stop.signal, say: p => this.progress(p),
      run: driveRunner({ cli: tools.cli, fs: this.fs, path: this.path, exe: check.exe, model: this.settings.model, dirs: [dir], work: this.work }),
    });
    if (this.mode === 'retrieve') await this.chooseVault(); else await this.showPlan();
  }

  /* ---- Back up, Sync now ---- */

  async showPlan() {
    const name = driveLinked(this.fs, this.path, this.vaultDir, this.settings.folder) || this.plugin.app.vault.getName();
    this.wait(`Looking at ${this.settings.folder}/${name} in Google Drive…`);
    const sync = this.make(this.vaultDir, name);
    const info = await sync.prepare();
    if (this.stop.signal.aborted) return;
    const el = this.contentEl, p = info.plan;
    el.empty();
    el.createEl('p', { cls: 'scriptorium-setup-where', text: `Google Drive: ${this.settings.folder}/${name}` });
    if (info.nothing) {
      el.createEl('p', { text: `Everything is backed up: ${driveCount(p.same, 'file')}, last sent ${driveWhen(info.remote.updated)}${info.remote.device ? ` from ${info.remote.device}` : ''}.` });
      this.skippedList(info.skipped);
      this.closeButton();
      return;
    }
    const lines = [];
    if (info.first) lines.push('There is no backup of this vault in Google Drive yet: this makes one.');
    else lines.push(`The backup has ${driveCount(Object.keys(info.remote.files).length, 'file')}, last sent ${driveWhen(info.remote.updated)}${info.remote.device ? ` from ${info.remote.device}` : ''}.`);
    if (info.resumed) lines.push('An earlier run was stopped part-way: this carries on from where it stopped.');
    el.createEl('p', { text: lines.join(' ') });
    const list = el.createEl('ul', { cls: 'scriptorium-drive-plan' });
    const item = text => list.createEl('li', { text });
    const pulls = p.download.length + p.conflicts.length + p.deleteLocal.length;
    if (pulls) item(`First, what changed in Google Drive is brought in: ${driveCount(p.download.length + p.conflicts.length, 'file')} to download (${driveBytes(info.downBytes)})` +
      `${p.deleteLocal.length ? `, and ${driveCount(p.deleteLocal.length, 'file')} deleted on another device to move to this vault’s .trash folder` : ''}.`);
    if (p.conflicts.length) item(`${driveCount(p.conflicts.length, 'file was', 'files were')} changed both here and in Google Drive. Both are kept: yours is renamed “name (conflict ${this.settings.device} date)”, and backed up too.`);
    if (p.upload.length) item(`${driveCount(p.upload.length, 'file')} to upload (${driveBytes(info.upBytes)}).`);
    if (p.deleteRemote.length) item(`${driveCount(p.deleteRemote.length, 'file')} deleted here: the copy in Google Drive is moved to the backup’s _trash folder, not deleted.`);
    if (p.same) item(`${driveCount(p.same, 'file is', 'files are')} the same on both sides.`);
    const runs = Math.ceil((p.upload.length + p.download.length + p.conflicts.length * 2) / DRIVE_LIMITS.batchFiles) + 4;
    el.createEl('p', { cls: 'scriptorium-setup-note', text: `About ${driveCount(runs, 'run')} of Claude Code (${this.settings.model}), roughly ${Math.max(1, Math.round(runs * 13 / 60))} min.` });
    this.skippedList(info.skipped);
    el.createEl('p', { cls: 'scriptorium-setup-note', text: DRIVE_PRIVACY });
    const row = this.buttons();
    const go = row.createEl('button', { cls: 'mod-cta', text: this.mode === 'sync' ? 'Sync' : 'Back up' });
    row.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    go.addEventListener('click', () => {
      this.showProgress();
      sync.sync().then(s => this.showDone(s, null), e => this.fail(e));
    });
  }

  skippedList(skipped) {
    if (!skipped || !skipped.length) return;
    const d = this.contentEl.createEl('details', { cls: 'scriptorium-drive-skipped' });
    d.createEl('summary', { text: `${driveCount(skipped.length, 'file is', 'files are')} not backed up` });
    d.createEl('pre', { cls: 'scriptorium-setup-plan', text: skipped.map(s => `${s.path}: ${s.why}`).join('\n'), attr: { tabindex: '0' } });
  }

  showProgress() {
    const el = this.contentEl;
    el.empty();
    this.stage = el.createEl('p', { cls: 'scriptorium-drive-stage', text: 'Starting…' });
    this.bar = el.createEl('progress', { cls: 'scriptorium-drive-bar', attr: { max: '1', value: '0' } });
    this.counts = el.createEl('p', { cls: 'scriptorium-setup-note', text: '' });
    this.log = el.createEl('p', { cls: 'scriptorium-setup-note scriptorium-drive-log', text: '' });
    el.createEl('p', { cls: 'scriptorium-setup-note', text: 'You can keep writing. Stopping is safe: what is done is kept, and running it again carries on.' });
    const stop = this.buttons().createEl('button', { text: 'Stop' });
    stop.addEventListener('click', () => { stop.disabled = true; stop.setText('Stopping…'); this.stop.abort(); });
    this.finished = new Map();
    this.began = Date.now();
    const tick = window.setInterval(() => {
      if (!this.log.isConnected) { window.clearInterval(tick); return; }
      const t = Math.round((Date.now() - this.began) / 1000);
      this.log.setText(t < 60 ? `${t} s` : `${Math.floor(t / 60)} min ${t % 60} s`);
    }, 1000);
  }

  progress(p) {
    if (!this.stage || !this.stage.isConnected) return;
    const total = p.total || 0, done = p.done || 0;
    if (total) this.finished.set(p.stage, `${p.stage.toLowerCase()} ${done} of ${total}`);
    this.stage.setText(total ? `${p.stage}: ${done} of ${total}` : `${p.stage}…`);
    if (total) { this.bar.max = total; this.bar.value = done; } else this.bar.removeAttribute('value');
    this.counts.setText([...this.finished].filter(([stage]) => stage !== p.stage).map(([, text]) => text).join(' · ').replace(/^./, c => c.toUpperCase()));
  }

  showDone(s, extra) {
    if (!this.contentEl.isConnected) return;
    const el = this.contentEl;
    el.empty();
    const took = s.seconds >= 90 ? `${Math.round(s.seconds / 60)} min` : `${Math.round(s.seconds)} s`;
    const parts = [];
    if (s.downloaded) parts.push(`${driveCount(s.downloaded, 'file')} downloaded and checked against the backup’s SHA-256 (${driveBytes(s.bytesDown)})`);
    if (s.uploaded) parts.push(`${driveCount(s.uploaded, 'file')} uploaded (${driveBytes(s.bytesUp)})`);
    if (s.deletedThere) parts.push(`${driveCount(s.deletedThere, 'deleted file')} moved to _trash in Google Drive`);
    if (s.deletedHere) parts.push(`${driveCount(s.deletedHere, 'file')} deleted on another device moved to this vault’s .trash`);
    el.createEl('p', { text: `${s.failed.length ? 'Finished, with problems' : 'Done'} in ${took}${parts.length ? `: ${parts.join('; ')}.` : ': nothing had to move.'}` });
    if (!extra) el.createEl('p', { text: `The backup now has ${driveCount(s.files, 'file')}.` });
    if (s.conflicts.length) {
      el.createEl('p', { text: `${driveCount(s.conflicts.length, 'file was', 'files were')} changed in both places. Both versions are kept; compare them and delete the one you do not want:` });
      el.createEl('pre', { cls: 'scriptorium-setup-plan', text: s.conflicts.map(c => `${c.path}\n    yours is now: ${c.kept}`).join('\n'), attr: { tabindex: '0' } });
    }
    if (s.failed.length) {
      el.createEl('p', { cls: 'scriptorium-setup-problem', text: `${driveCount(s.failed.length, 'file')} could not be done. Nothing was lost; run it again to try them again:` });
      el.createEl('pre', { cls: 'scriptorium-setup-plan', text: s.failed.map(f => `${f.path}: ${f.why}`).join('\n'), attr: { tabindex: '0' } });
    }
    this.skippedList(s.skipped);
    el.createEl('p', { cls: 'scriptorium-setup-note', text: `Claude Code was run ${driveCount(s.runs, 'time')}${s.cost ? ` (about $${s.cost.toFixed(2)} at API prices; on a subscription it counts toward your usage instead)` : ''}.` });
    if (extra) extra(el); else this.closeButton();
  }

  /* ---- Retrieve ---- */

  async chooseVault() {
    this.wait(`Looking for vaults in the Google Drive folder ${this.settings.folder}…`);
    const lister = this.make(this.work, '');
    lister.say = () => {};
    const vaults = await lister.vaults();
    if (this.stop.signal.aborted) return;
    const el = this.contentEl;
    el.empty();
    if (!vaults.length) {
      el.createEl('p', { text: `No backed-up vault was found in the Google Drive folder “${this.settings.folder}” of the Google account connected to Claude.` });
      el.createEl('p', { cls: 'scriptorium-setup-note', text: 'A vault gets there with “Scriptorium: Back up this vault to Google Drive”, run in that vault on a computer.' });
      this.closeButton();
      return;
    }
    el.createEl('p', { text: 'Choose a vault. It is downloaded into a new folder, every file is checked against the backup’s SHA-256, and Scriptorium is set up in it.' });
    const list = el.createDiv({ cls: 'scriptorium-drive-vaults', attr: { role: 'radiogroup', 'aria-label': 'Vaults in Google Drive' } });
    let chosen = vaults[0];
    const parent = this.path.dirname(this.vaultDir);
    const suggest = v => {
      let dir = this.path.join(parent, v.name);
      for (let n = 2; this.fs.existsSync(dir) && this.fs.readdirSync(dir).length; n++) dir = this.path.join(parent, `${v.name} ${n}`);
      return dir;
    };
    vaults.forEach((v, i) => {
      const label = list.createEl('label', { cls: 'scriptorium-drive-vault' });
      const radio = label.createEl('input', { type: 'radio', attr: { name: 'scriptorium-drive-vault' } });
      radio.checked = i === 0;
      const text = label.createDiv();
      text.createDiv({ cls: 'scriptorium-drive-vault-name', text: v.name });
      text.createDiv({ cls: 'scriptorium-setup-note', text: `${driveCount(v.files, 'file')}, ${driveBytes(v.bytes)} · last backed up ${driveWhen(v.updated)}${v.device ? ` from ${v.device}` : ''}` });
      radio.addEventListener('change', () => { if (radio.checked) { chosen = v; if (!input.dataset.typed) input.value = suggest(v); } });
    });
    const row = el.createDiv({ cls: 'scriptorium-setup-row' });
    const input = row.createEl('input', { type: 'text', cls: 'scriptorium-setup-path', attr: { placeholder: 'The new vault’s folder', 'aria-label': 'The new vault’s folder', spellcheck: 'false' } });
    input.value = suggest(chosen);
    input.addEventListener('input', () => { input.dataset.typed = '1'; });
    const dialog = setupDialog();
    if (dialog) {
      row.createEl('button', { text: 'Browse…' }).addEventListener('click', async () => {
        try {
          const r = await dialog.showOpenDialog({ title: 'Choose a new or empty folder for the vault', properties: ['openDirectory', 'createDirectory'] });
          if (r && !r.canceled && r.filePaths && r.filePaths[0]) { input.value = r.filePaths[0]; input.dataset.typed = '1'; input.focus(); }
        } catch (e) { new Notice('Could not open the folder chooser: type the folder’s path instead.'); }
      });
    }
    const said = el.createEl('p', { cls: 'scriptorium-setup-problem', text: '' });
    el.createEl('p', { cls: 'scriptorium-setup-note', text: DRIVE_PRIVACY });
    const buttons = this.buttons();
    const go = buttons.createEl('button', { cls: 'mod-cta', text: 'Retrieve' });
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    go.addEventListener('click', () => {
      const dir = setupFolder(this.path, input.value);
      let why = '';
      try {
        if (!dir) why = 'Give the folder’s full path.';
        else if (dir.split(/[\\/]/).includes('.obsidian')) why = 'That is a folder inside a vault’s settings.';
        else if (this.fs.existsSync(dir) && !this.fs.statSync(dir).isDirectory()) why = 'That is a file, not a folder.';
        else if (this.fs.existsSync(dir) && this.fs.readdirSync(dir).length) why = 'That folder is not empty. Choose a new or empty folder: retrieving never writes over what is already there.';
      } catch (e) { why = `That folder cannot be used: ${e.message}`; }
      if (why) { said.setText(why); input.focus(); return; }
      this.retrieve(chosen, dir).catch(e => this.fail(e));
    });
  }

  async retrieve(entry, dir) {
    this.showProgress();
    this.fs.mkdirSync(dir, { recursive: true });
    const s = await this.make(dir, entry.name).retrieve(entry);
    // The vault is made a Scriptorium vault with the same code as "Set up another vault".
    let setup = '';
    try {
      const plan = planVaultSetup(this.fs, this.path, setupPackage(this.fs, this.path, this.vaultDir), dir);
      applyVaultSetup(this.fs, this.path, dir, plan);
      setup = 'Scriptorium’s theme, snippet and plugins are set up in it.';
    } catch (e) {
      setup = `Scriptorium could not be set up in it (${e.message}); run “Scriptorium: Set up another vault” on it.`;
    }
    this.showDone(s, el => {
      el.createEl('p', { cls: 'scriptorium-setup-where', text: dir });
      el.createEl('p', { text: `${setup} When Obsidian asks, choose “Trust author and enable plugins”. To keep it backed up, run “Scriptorium: Sync now with Google Drive” in it.` });
      const row = el.createDiv({ cls: 'modal-button-container scriptorium-drive-open' });
      const open = row.createEl('button', { cls: 'mod-cta', text: 'Open the vault' });
      open.addEventListener('click', () => {
        if (openVaultWindow(dir)) this.close();
        else new Notice('Could not open it from here: in the vault switcher, choose “Open folder as vault” and pick that folder.', 10000);
      });
      this.closeButton(row, false);
    });
  }
}

/* ==========================================================
   The plugin
   ========================================================== */

class Scriptorium extends Plugin {
  async onload() {
    this.settings = normalizeSettings(await this.loadData());
    this.ribbon = this.addRibbonIcon('feather', 'Toggle fancy mode', () => {
      void this.setFancyMode(!this.settings.fancyMode);
    });
    this.status = this.addStatusBarItem();
    this.status.addClass('scriptorium-mode-switch');
    this.status.setAttribute('role', 'button');
    this.status.setAttribute('tabindex', '0');
    this.registerDomEvent(this.status, 'click', () => {
      void this.setFancyMode(!this.settings.fancyMode);
    });
    this.registerDomEvent(this.status, 'keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void this.setFancyMode(!this.settings.fancyMode);
      }
    });
    this.addCommand({
      id: 'toggle-fancy-mode',
      name: 'Toggle fancy mode',
      callback: () => this.setFancyMode(!this.settings.fancyMode)
    });
    this.addCommand({
      id: 'toggle-marginalia',
      name: 'Toggle marginalia (footnotes in the margin)',
      callback: () => this.updateSettings({ marginalia: !this.settings.marginalia })
    });
    // Setting up a vault reads and writes files outside this vault, which only Obsidian on a computer can do.
    const desktop = () => !(Platform && Platform.isDesktopApp === false) && Boolean(this.app.vault.adapter && this.app.vault.adapter.basePath);
    this.addCommand({
      id: 'set-up-another-vault',
      name: 'Set up another vault (make any vault a Scriptorium vault)',
      checkCallback: checking => {
        if (!desktop()) return false;
        if (!checking) new SetupVaultModal(this, null).open();
        return true;
      }
    });
    this.addCommand({
      id: 'set-up-this-vault',
      name: 'Set up this vault (turn Scriptorium’s theme, snippet and plugins back on)',
      checkCallback: checking => {
        if (!desktop()) return false;
        if (!checking) new SetupVaultModal(this, this.app.vault.adapter.basePath).open();
        return true;
      }
    });
    // Backing up to Google Drive (experimental). On a phone or tablet the commands say why they cannot run there.
    for (const [id, mode, name] of [
      ['drive-back-up', 'backup', 'Back up this vault to Google Drive (experimental)'],
      ['drive-sync-now', 'sync', 'Sync now with Google Drive (experimental)'],
      ['drive-retrieve', 'retrieve', 'Retrieve a vault from Google Drive (experimental)'],
    ]) this.addCommand({ id, name, callback: () => new DriveModal(this, mode).open() });
    this.addSettingTab(new ScriptoriumSettings(this.app, this));

    // Re-check an opening paragraph whenever its box changes (first layout, pane resize, fonts arriving).
    this.kept = new Set();
    this.resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const p = entry.target;
        if (!p.isConnected) { this.resizeObserver.unobserve(p); this.kept.delete(p); continue; }
        try { keepFirstLineWords(p); } catch (e) { /* never break rendering */ }
      }
    });
    this.registerMarkdownPostProcessor((el, ctx) => {
      const which = noteDropcap(ctx && ctx.frontmatter);      // a note's own drop cap (see "A drop cap for one note")
      const path = (ctx && ctx.sourcePath) || '';
      if (isPrintPage(el)) return this.dressPrint(el, which, path); // Export to PDF: the whole page comes at once
      this.mark(el, which, path);
      el.querySelectorAll(':scope > p').forEach(p => { this.kept.add(p); this.resizeObserver.observe(p); });
    });
    // Export to PDF prints the note's title by default: tick Obsidian's "Include file name as title" once.
    this.app.workspace.onLayoutReady(() => { void this.includeTitleInPdf(); void this.loadDropcapSets(); });
    this.dropcapSets = [];   // the sets of drop caps beside the four built in (see "Sets of drop caps")
    this.ratios = new Map();  // an image's shape (width over height), by its address
    this.addCommand({
      id: 'add-dropcap-set',
      name: 'Add a set of drop caps (your own images or a font of initials)',
      callback: () => new DropcapSetModal(this).open()
    });
    this.addCommand({
      id: 'download-dropcaps',
      name: 'Download more drop caps from gwern.net (Dropcat, Gene Wolfe, Ninit)',
      callback: () => new DropcapDownloadModal(this).open()
    });
    // When a note's "dropcap" property changes, its Reading views are drawn again with the new one.
    this.dropcaps = new Map();
    this.registerEvent(this.app.metadataCache.on('changed', (file, data, cache) => {
      const now = noteDropcap(cache && cache.frontmatter);
      if (this.dropcaps.has(file.path) ? this.dropcaps.get(file.path) === now : now === null) { this.dropcaps.set(file.path, now); return; }
      this.dropcaps.set(file.path, now);
      for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.file && view.file.path === file.path) this.previewDropcap(view, now);
      }
    }));
    this.addCommand({
      id: 'choose-dropcap',
      name: 'Choose the drop cap for this note',
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) return false;
        if (!checking) new DropcapModal(this, view).open();
        return true;
      }
    });
    this.registerEvent(this.app.workspace.on('css-change', () => this.recheck()));
    if (document.fonts) this.registerDomEvent(document.fonts, 'loadingdone', () => this.recheck());

    this.marginalia = new Marginalia(this);
    this.marginalia.load();
    this.imageFocus = new ImageFocus(this);
    this.imageFocus.load();
    this.applyMode();
    this.applyFeatures();
  }

  /* What the Google Drive backup needs to run Claude Code: Lagrange's {findCli, runCli, cliErrorMessage} and the path
     to `claude` set in Lagrange's settings, or {problem} where it cannot run. */
  driveTools() {
    if ((Platform && Platform.isDesktopApp === false) || !(this.app.vault.adapter && this.app.vault.adapter.basePath)) {
      return { problem: 'Backing up to Google Drive works only in Obsidian on a computer: it runs Claude Code, which a phone or tablet cannot. Open this vault on a computer to back it up or to retrieve one.' };
    }
    const lagrange = this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins.lagrange;
    const cli = lagrange && lagrange.constructor && lagrange.constructor.internals;
    if (!cli || typeof cli.runCli !== 'function' || typeof cli.findCli !== 'function' || cli.runCliTakesEnv !== true) {
      return { problem: 'Turn on the Lagrange plugin that comes with Scriptorium (Settings → Community plugins), then run this again: the backup runs Claude Code with Lagrange’s code. If it is on, update it with “Scriptorium: Set up this vault”.' };
    }
    return { cli, custom: lagrange.settings && lagrange.settings.claudeCodePath };
  }

  /* Export to PDF (see "Export to PDF: the page as Reading view sets it"). The returned promise is awaited by Obsidian
     before it prints: by then the drop cap's font has loaded. */
  dressPrint(page, which, path) {
    const doc = page.ownerDocument, body = doc.body, s = this.settings;
    body.classList.toggle('scriptorium-fancy', s.fancyMode);
    for (const [value] of INITIALS) body.classList.toggle(`scriptorium-initials-${value}`, value === s.initials && value !== 'yinit');
    dressPrint(page, null);
    const shapes = [];
    for (const child of Array.from(page.children)) if (child.tagName === 'DIV' && !child.classList.contains('mod-header')) shapes.push(this.mark(child, which, path));
    const faces = document.getElementById('scriptorium-dropcap-fonts');   // the fonts of the writer's sets
    if (faces && !doc.getElementById('scriptorium-dropcap-fonts')) doc.head.appendChild(doc.importNode(faces, true));
    const fonts = ['"Scriptorium Yinit"', '"Scriptorium Goudy"', '500 1em "Cormorant Garamond"', '1em "EB Garamond"', 'italic 1em "EB Garamond"'];
    for (const set of this.dropcapSets) if (set.kind === 'font') fonts.push(`"${set.family}"`);
    const loaded = doc.fonts && doc.fonts.load
      ? Promise.all(fonts.map(f => doc.fonts.load(f.includes('1em') ? f : `1em ${f}`, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ').catch(() => null)))
      : Promise.resolve();
    return Promise.race([Promise.all([loaded].concat(shapes)), new Promise(resolve => window.setTimeout(resolve, 2500))]);
  }

  /* Ticks "Include file name as title" in Obsidian's PDF export settings, once per vault: after that the choice is
     the writer's. */
  async includeTitleInPdf() {
    if (this.settings.pdfTitleSet) return;
    try {
      const now = this.app.vault.getConfig('pdfExportSettings') || {};
      if (!now.includeName) this.app.vault.setConfig('pdfExportSettings', Object.assign({}, now, { includeName: true }));
      this.settings.pdfTitleSet = true;
      await this.saveData(this.settings);
    } catch (e) { /* an Obsidian without these settings: nothing to tick */ }
  }

  /* The set a name asks for ('set:Dropcat', or the bare name; 'kanzlei' and 'de-zs', gwern.net's names, are known
     too), whatever its case; null if the vault has none such. */
  findSet(value) {
    const name = String(value || '').replace(/^set:/, '').trim().toLowerCase();
    if (!name) return null;
    return this.dropcapSets.find(s => s.name.toLowerCase() === name || s.label.toLowerCase() === name || (s.dir && s.dir === name) ||
      (s.also && s.also.includes(name))) || null;
  }

  /* Marks one rendered block: with the note's own drop cap if it has one, else with the vault's if that is a set
     (the four built in are classes on body, and need no mark). A set that is not in the vault counts as no choice.
     path is the note's. Returns a promise: an image's shape is known (the text wraps round it closely). */
  mark(el, which, path) {
    let set = which && which.startsWith('set:') ? this.findSet(which) : null;
    if (which && which.startsWith('set:') && !set) which = null;
    if (!which && this.settings.initials.startsWith('set:')) { set = this.findSet(this.settings.initials); which = set ? this.settings.initials : null; }
    const image = markDropcap(el, which, set, path);
    el.scriptoriumImage = image;
    if (!image) return Promise.resolve();
    return Promise.all([['light', '--scriptorium-dropcap-ratio'], ['dark', '--scriptorium-dropcap-ratio-dark']].map(([theme, name]) =>
      this.ratio(image[theme]).then(r => { if (r && el.scriptoriumImage === image) el.style.setProperty(name, String(r)); })));
  }

  /* An image's width over its height (0 if it cannot be read), found once. */
  ratio(url) {
    let known = this.ratios.get(url);
    if (!known) {
      known = new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve(img.naturalHeight ? Math.round(100 * img.naturalWidth / img.naturalHeight) / 100 : 0);
        img.onerror = () => resolve(0);
        img.src = url;
      });
      this.ratios.set(url, known);
    }
    return known;
  }

  /* Shows a drop cap in a note's Reading view without saving it: which is 'yinit' | 'goudy' | 'plain' | 'none' or
     'set:<name>', null for the vault's, or undefined for what the note's properties say. The initial is inked in
     (the snippet's scriptorium-dropcap-inked), unless quiet is set. */
  previewDropcap(view, which, quiet) {
    if (which === undefined) {
      const cache = view.file && this.app.metadataCache.getFileCache(view.file);
      which = noteDropcap(cache && cache.frontmatter);
    }
    const root = view.containerEl.querySelector('.markdown-preview-view');
    if (!root) return;
    const path = view.file ? view.file.path : '';
    root.querySelectorAll('.markdown-preview-sizer > div').forEach(el => {
      void this.mark(el, which, path);
      if (quiet || !el.classList.contains('el-p')) return;
      el.classList.remove('scriptorium-dropcap-inked');
      void el.offsetWidth;                              // so the animation starts again
      el.classList.add('scriptorium-dropcap-inked');
      window.clearTimeout(el.scriptoriumInked);
      el.scriptoriumInked = window.setTimeout(() => el.classList.remove('scriptorium-dropcap-inked'), 2600);
    });
    this.recheck();
  }

  /* Reads the sets of drop caps: those that come with Scriptorium, and the writer's own in the vault. */
  async loadDropcapSets() {
    const adapter = this.app.vault.adapter;
    const read = async (dir, name, extra) => {
      let listing;
      try { listing = await adapter.list(dir); } catch (e) { return null; }
      let meta = null;
      try { meta = JSON.parse(await adapter.read(`${dir}/set.json`)); } catch (e) { /* no set.json, or not JSON */ }
      const set = describeSet(name, listing.files.map(f => f.slice(f.lastIndexOf('/') + 1)), Object.assign({}, extra, meta));
      if (!set) return null;
      const url = file => adapter.getResourcePath(`${dir}/${file}`);
      if (set.kind === 'font') set.faces = fontFaces(set, url);
      for (const slot of Object.values(set.letters)) for (const theme of ['light', 'dark']) if (slot[theme]) slot[theme] = slot[theme].map(url);
      return set;
    };
    const sets = [];
    for (const b of BUNDLED_SETS) {
      const set = await read(`${this.manifest.dir}/dropcaps/${b.dir}`, b.name, b.meta);
      if (!set) continue;
      Object.assign(set, { dir: b.dir, about: b.about, also: b.also || [] });
      sets.push(set);
    }
    try {
      const mine = await adapter.list(DROPCAP_FOLDER);
      for (const dir of mine.folders.slice().sort()) {
        const name = dir.slice(dir.lastIndexOf('/') + 1);
        const own = YOUR_OWN_SETS.find(y => y.name.toLowerCase() === name.toLowerCase());
        const set = await read(dir, name, own && own.meta);
        if (!set) continue;
        const i = sets.findIndex(s => s.name.toLowerCase() === name.toLowerCase());
        if (i < 0) { if (own) set.also = own.also; sets.push(set); continue; }
        // a folder with the name of a set that comes with Scriptorium: its letters first, the others as they came
        const base = sets[i];
        if (set.kind === 'images' && base.kind === 'images') { set.letters = Object.assign({}, base.letters, set.letters); set.mono = set.mono || base.mono; }
        sets[i] = Object.assign(set, { name: base.name, dir: base.dir, about: base.about, also: base.also });
      }
    } catch (e) { /* no sets of the writer's own */ }
    for (const set of sets) if (set.label === set.name) set.label = setLabel(set, set.about);
    this.dropcapSets = sets;
    let style = document.getElementById('scriptorium-dropcap-fonts');
    if (!style) { style = document.head.createEl('style', { attr: { id: 'scriptorium-dropcap-fonts' } }); this.register(() => style.remove()); }
    style.textContent = sets.filter(s => s.kind === 'font').map(s => s.faces).join('\n');
    this.remarkAll();
    return sets;
  }

  /* Marks every open Reading view again (the sets, or the vault's drop cap, have changed). */
  remarkAll() {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView) this.previewDropcap(leaf.view, undefined, true);
    }
  }

  async makeFolder(dir) {
    const adapter = this.app.vault.adapter;
    let path = '';
    for (const part of dir.split('/')) { path = path ? `${path}/${part}` : part; if (!(await adapter.exists(path))) await adapter.mkdir(path); }
  }

  /* An image drawn again as a PNG: as a mask if it is of one colour on an opaque ground (monoMask), and no larger
     than `side` pixels. Returns the PNG's bytes, or null if the image can stay as it is. */
  async redraw(bytes, kind, opts) {
    const blob = new Blob([bytes], { type: kind === 'svg' ? 'image/svg+xml' : 'image/png' });
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('the image could not be read'));
        i.src = url;
      });
      const w0 = img.naturalWidth || 512, h0 = img.naturalHeight || 512, side = (opts && opts.side) || 640;
      const k = Math.min(1, side / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d');
      g.drawImage(img, 0, 0, w, h);
      const data = g.getImageData(0, 0, w, h);
      const mask = opts && opts.mono ? monoMask(data.data, w, h) : null;
      if (mask) { data.data.set(mask); g.putImageData(data, 0, 0); }
      else if (!(opts && opts.shrink && (k < 1 || kind !== 'png'))) return null;
      const out = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      return new Uint8Array(await out.arrayBuffer());
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /* Writes a set the writer has put together (DropcapSetModal) into the vault, and reads the sets again. */
  async saveDropcapSet(name, files, mono, meta) {
    const adapter = this.app.vault.adapter, dir = `${DROPCAP_FOLDER}/${name}`;
    if (await adapter.exists(dir)) throw new Error(`there is already a set called “${name}” (in ${dir})`);
    await this.makeFolder(dir);
    const buffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const fonts = files.filter(f => f.kind === 'font');
    const images = files.filter(f => f.kind !== 'font');
    const ext = f => f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
    if (images.length) {
      for (const f of images) {
        let bytes = f.bytes, kind = f.kind;
        if (mono) {
          const mask = await this.redraw(bytes, kind, { mono: true }).catch(() => null);
          if (mask) { bytes = mask; kind = 'png'; }
        }
        await adapter.writeBinary(`${dir}/${f.letter}${f.theme === 'dark' ? '-dark' : ''}.${kind}`, buffer(bytes));
      }
    } else if (fonts.some(f => f.letter)) {
      for (const f of fonts.filter(x => x.letter)) await adapter.writeBinary(`${dir}/${f.letter}${ext(f)}`, buffer(f.bytes));
    } else {
      await adapter.writeBinary(`${dir}/initials${ext(fonts[0])}`, buffer(fonts[0].bytes));
    }
    await adapter.write(`${dir}/set.json`, JSON.stringify(Object.assign({ mono: Boolean(mono && images.length) }, images.length ? null : meta), null, 2) + '\n');
    await this.loadDropcapSets();
  }

  /* The list of gwern.net's images (dropcaps/gwern.json, in the plugin's folder). */
  async gwernList() {
    return JSON.parse(await this.app.vault.adapter.read(`${this.manifest.dir}/dropcaps/gwern.json`));
  }

  /* Fetches a plan's images of one of Scriptorium's sets from gwern.net into the vault (DropcapDownloadModal), and
     reads the sets again. The only request Scriptorium ever makes, and only when the writer asks. */
  async downloadDropcapSet(bundled, plan, hooks) {
    const adapter = this.app.vault.adapter, dir = `${DROPCAP_FOLDER}/${bundled.name}`;
    const result = await fetchDropcapSet(plan, {
      get: async url => {
        const res = await requestUrl({ url, method: 'GET', throw: false });
        if (res.status !== 200) throw new Error(`gwern.net answered ${res.status}`);
        return new Uint8Array(res.arrayBuffer);
      },
      has: file => adapter.exists(`${dir}/${file}`),
      put: async (file, bytes) => {
        await this.makeFolder(dir);
        await adapter.writeBinary(`${dir}/${file}`, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      },
      progress: hooks && hooks.progress,
      stopped: hooks && hooks.stopped,
    });
    if (result.saved) {
      if (!(await adapter.exists(`${dir}/set.json`))) {
        await adapter.write(`${dir}/set.json`, JSON.stringify({ source: `https://gwern.net/dropcap#${bundled.dir}`, license: 'CC0 1.0 (public domain)' }, null, 2) + '\n');
      }
      await this.loadDropcapSets();
    }
    return result;
  }

  /* For Lagrange, which draws drop caps: puts one image into a set of the writer's (made if need be), as that
     letter's only image (an earlier one is kept in the set's "earlier" folder), and shows it, inked in, in `view`
     if the note's drop cap is that set. req: {set, letter, bytes (Uint8Array), kind: 'png' | 'svg', mono}. Returns
     {set, file}. Throws with a sentence if the image cannot be used. */
  async addDrawnDropcap(req, view) {
    const adapter = this.app.vault.adapter;
    const name = setName(req.set);
    const letter = openingLetter(req.letter);
    if (!name || !letter) throw new Error('a drawn drop cap needs a set’s name and a letter');
    if (INITIALS.some(([v]) => v === name.toLowerCase()) || BUNDLED_SETS.some(b => b.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`“${name}” is one of Scriptorium’s own drop caps: give the set another name`);
    }
    let checked = checkDropcapFile(`${letter}.${req.kind}`, req.bytes, 12 * 1024 * 1024);
    if (!checked.ok) throw new Error(checked.problem);
    let bytes = checked.bytes, kind = checked.kind;
    const dir = `${DROPCAP_FOLDER}/${name}`;
    let meta = {};
    try { meta = JSON.parse(await adapter.read(`${dir}/set.json`)); } catch (e) { /* a new set */ }
    const mono = typeof meta.mono === 'boolean' ? meta.mono : Boolean(req.mono);   // a set is of one colour, or it is not
    const drawn = await this.redraw(bytes, kind, { mono, shrink: kind === 'png', side: 640 });
    if (drawn) { bytes = drawn; kind = 'png'; }
    checked = checkDropcapFile(`${letter}.${kind}`, bytes);
    if (!checked.ok) throw new Error(checked.problem);
    await this.makeFolder(dir);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    for (const f of (await adapter.list(dir)).files) {
      const base = f.slice(f.lastIndexOf('/') + 1), what = dropcapFile(base);
      if (!what || what.font || what.letter !== letter || what.theme !== 'light') continue;
      await this.makeFolder(`${dir}/earlier`);
      await adapter.rename(f, `${dir}/earlier/${stamp} ${base}`);
    }
    const file = `${dir}/${letter}.${kind}`;
    await adapter.writeBinary(file, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (typeof meta.mono !== 'boolean') {
      meta.mono = mono;
      await adapter.write(`${dir}/set.json`, JSON.stringify(meta, null, 2) + '\n');
    }
    await this.loadDropcapSets();
    if (view) this.previewDropcap(view, `set:${name}`);
    return { set: name, file, mono: meta.mono };
  }

  /* Saves a note's drop cap in its properties (null removes the property: the vault's drop cap). */
  async setNoteDropcap(file, which) {
    try {
      await this.app.fileManager.processFrontMatter(file, fm => {
        for (const k of DROPCAP_KEYS) if (k !== 'dropcap') delete fm[k];
        if (which) fm.dropcap = which.replace(/^set:/, ''); else delete fm.dropcap;
      });
    } catch (e) {
      new Notice(`Could not save the drop cap in this note’s properties: ${e.message}`);
    }
  }

  recheck() {
    requestAnimationFrame(() => {
      for (const p of this.kept) {
        if (!p.isConnected) { this.resizeObserver.unobserve(p); this.kept.delete(p); continue; }
        try { keepFirstLineWords(p); } catch (e) { /* never break rendering */ }
      }
    });
  }

  async setFancyMode(value) {
    await this.updateSettings({ fancyMode: Boolean(value) });
  }

  async updateSettings(patch) {
    this.settings = normalizeSettings(Object.assign({}, this.settings, patch));
    this.applyMode();
    this.applyFeatures();
    await this.saveData(this.settings);
  }

  applyMode() {
    const active = this.settings.fancyMode;
    document.body.classList.toggle('scriptorium-fancy', active);
    if (this.kept) this.recheck();   // the two modes set the opening line differently
    this.status.setText(`Fancy mode: ${active ? 'on' : 'off'}`);
    for (const element of [this.status, this.ribbon]) {
      element.setAttribute('aria-label', `Toggle fancy mode (currently ${active ? 'on' : 'off'})`);
      element.setAttribute('aria-pressed', String(active));
    }
  }

  applyFeatures() {
    const s = this.settings, body = document.body;
    let changed = false;
    for (const [value] of INITIALS) {
      const cls = `scriptorium-initials-${value}`, on = value === s.initials && value !== 'yinit';
      if (body.classList.contains(cls) !== on) { body.classList.toggle(cls, on); changed = true; }
    }
    if (changed && this.kept) this.recheck();   // a different initial changes the opening line
    if (this.dropcapSets && this.lastInitials !== s.initials) { this.lastInitials = s.initials; this.remarkAll(); }
    body.classList.toggle('scriptorium-image-focus', s.imageFocus);
    if (!s.imageFocus && this.imageFocus) this.imageFocus.close();
    if (this.marginalia) this.marginalia.refreshSoon();
  }

  onunload() {
    document.body.classList.remove('scriptorium-fancy', 'scriptorium-image-focus');
    for (const [value] of INITIALS) document.body.classList.remove(`scriptorium-initials-${value}`);
    if (this.marginalia) this.marginalia.unload();
    if (this.imageFocus) this.imageFocus.unload();
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.kept) for (const p of this.kept) unwrapKept(p);
  }
}

module.exports = Scriptorium;
// Pure helpers, exported for plugins-tests/ (Obsidian uses only the class).
Object.assign(module.exports, {
  normalizeSettings, marginGeometry, stackNotes, footnoteMarkdown, footnoteDefinitions, parseFootnoteDefinitions,
  refLabel, captionFromParts, parseImageEmbed, externalImages, sourceKey,
  setupRule, setupPackage, planVaultSetup, describeVaultSetup, applyVaultSetup, setupFolder,
  noteDropcap, dropcapChoices, markDropcap, isPrintPage, dressPrint,
  openingLetter, dropcapFile, describeSet, setName, sanitizeSvg, checkDropcapFile, BUNDLED_SETS, YOUR_OWN_SETS, DROPCAP_FOLDER,
  seedOf, fontFaces, setLabel, monoMask, downloadPlan, fetchDropcapSet, describeDownload, sizeText,
  DRIVE_LIMITS, DRIVE_MANIFEST, DRIVE_STATE, DRIVE_TOOL, driveMime, driveSettings, driveRule, driveScan, drivePlan, driveConflictName, driveBatches,
  driveStable, drivePrompt, applyDriveLine, driveResult, driveResults, driveRunner, driveCheck, driveManifest, driveLinked, DriveSync
});
