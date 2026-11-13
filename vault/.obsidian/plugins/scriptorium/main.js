const { Plugin, PluginSettingTab, Setting, MarkdownView, MarkdownRenderer, Component, Scope, Modal, Notice, Platform, requestUrl, apiVersion } = require('obsidian');

/* ==========================================================
   Settings
   ========================================================== */

const INITIALS = [
  ['yinit', 'Yinit (ornamental)'],
  ['goudy', 'Goudy Initialen (floriated)'],
  ['plain', 'Plain capital (Cormorant Garamond)'],
  ['none', 'None']
];
const DEFAULT_SETTINGS = { fancyMode: false, initials: 'yinit', liveDropcaps: true, marginalia: true, imageFocus: true, tikzRepair: true };

/* Saved settings with every known key checked and defaulted; keys this version does not know are kept. */
function normalizeSettings(saved) {
  const settings = Object.assign({}, saved && typeof saved === 'object' ? saved : {}, DEFAULT_SETTINGS);
  if (saved && typeof saved === 'object') {
    for (const key of ['fancyMode', 'liveDropcaps', 'marginalia', 'imageFocus', 'tikzRepair']) {
      if (typeof saved[key] === 'boolean') settings[key] = saved[key];
    }
    // one of the four built in, or a set of drop caps by name ("set:Dropcat", "set:My initials"; see "Sets of drop caps")
    if (INITIALS.some(([value]) => value === saved.initials) || (typeof saved.initials === 'string' && /^set:.+/.test(saved.initials))) settings.initials = saved.initials;
  }
  return settings;
}

/* "Show drop caps while editing" was off unless turned on in 1.4.0, and is on unless turned off since 1.4.1. What
   1.4.0 saved cannot tell a writer who turned it off from one who never touched it (the plugin saved all its
   settings, the default among them, when any one changed), so settings saved before 1.4.1 (they have no
   `liveDropcapsSince`) are brought to the new default once: -> {settings, told}, told being true where a saved "off"
   was turned on, which the plugin then says once, with where the switch is. Settings saved since are left as they
   are, so turning it off afterwards holds. Pure. */
const LIVE_DROPCAPS_SINCE = '1.4.1';
function migrateSettings(saved) {
  const had = saved && typeof saved === 'object' ? saved : null;
  if (had && had.liveDropcapsSince) return { settings: had, told: false };
  const settings = Object.assign({}, had || {}, { liveDropcapsSince: LIVE_DROPCAPS_SINCE });
  const told = Boolean(had && had.liveDropcaps === false);
  if (told) settings.liveDropcaps = true;
  return { settings, told };
}

/* ==========================================================
   TikZJax, repaired while it runs
   ==========================================================
   The TikZJax plugin (0.5.2) draws ```tikz blocks. It is not part of Scriptorium and none of its files is changed:
   what follows only stands beside it in the page, while "Repair TikZJax rendering" is on and the TikZJax in the
   vault is a version this was checked against. Three faults of its page script are met:

   1. A figure whose <script> comes into the page inside an element that came in during the same task (Obsidian's
      renderer filling a panel that is already on the page) is met twice by its observer. The second time it makes a
      new spinner, forgets the one it put on the page, and later puts the finished figure in place of the forgotten
      one: the spinner on the page turns for ever. The script keeps its spinner in a property, `loader`; here that
      property takes the first spinner it is given and no other, so the figure goes where the spinner is.
   2. If anything throws after TeX has run (a figure that comes out empty, for one), the figures after it wait for
      ever: its queue is never taken up again. Its worker still answers, so a spinner that has stood for two seconds
      while the worker has nothing to do is taken to be left behind, and the figure is asked of the worker here and
      put in the spinner's place, as TikZJax would have put it (not kept in TikZJax's store).
   3. An error in a figure's TikZ shows as a broken picture, and what TeX said only in the console. Here the picture
      gives way to a line that says so and TeX's own words.

   Nothing is done in windows other than the main one. repairTikzjax(win) -> {stop(), stats}. */
const TIKZJAX_ID = 'obsidian-tikzjax';
const TIKZJAX_REPAIRED = ['0.5.2'];        // the versions whose page script was read and tried; any other is left alone
const TIKZ_BROKEN = 'invalid.site/img-not-found';

/* Whether the repair is to stand: 'on', 'off' (the setting), 'absent' (no TikZJax in the vault), or 'unknown' (a
   TikZJax this was not checked against). version: the installed TikZJax's, or null. Pure. */
function tikzRepairState(settings, version) {
  if (!settings || settings.tikzRepair === false) return 'off';
  if (!version) return 'absent';
  return TIKZJAX_REPAIRED.includes(String(version)) ? 'on' : 'unknown';
}

/* What TeX said was wrong, from the lines of its log: each line that begins with "!" and the "l.<n> …" line that
   follows it (where in the source it stopped). -> text, '' when the log names no error. Pure. */
function texError(lines) {
  const all = (lines || []).map(l => String(l).replace(/\s+$/, '')), out = [];
  for (let i = 0; i < all.length && out.length < 6; i++) {
    if (!/^!/.test(all[i])) continue;
    out.push(all[i]);
    const where = all.slice(i + 1, i + 5).find(l => /^l\.\d+ /.test(l));
    if (where) out.push(where);
  }
  return out.join('\n').slice(0, 600);
}

/* A figure's ids made its own, as TikZJax makes them (so that two figures on a page do not share "pgf…" ids). Pure. */
function tikzOwnIds(svg, hash) {
  let out = String(svg);
  const ids = out.match(/\bid="pgf[^"]*"/g);
  if (ids) {
    ids.sort((a, b) => b.length - a.length);
    for (const id of ids) { const name = id.replace(/id="pgf(.*)"/, '$1'); out = out.split(`pgf${name}`).join(`pgf${hash}${name}`); }
  }
  return out.split('&#173;').join('&#172;');
}

function repairTikzjax(win) {
  const doc = win.document, now = () => win.performance.now();
  const stats = { twice: 0, errors: 0, rescued: 0, runs: 0 };
  const loaders = new WeakMap();   // a figure's <script> -> the spinner that is on the page for it
  const pending = new Set();       // {script, loader, since, taken}: spinners not yet replaced
  const own = new Map();           // our own questions to the worker: uid -> {resolve, reject}
  const busy = new Set();          // the worker's runs under way (TikZJax's and ours), by uid
  let worker = null, lines = [], idleSince = now(), timer = 0, uid = 2000000000, chain = Promise.resolve(), stopped = false, said = false;

  // 1. the spinner of a figure is the first it is given
  const proto = win.HTMLScriptElement.prototype;
  const plain = (el, value) => Object.defineProperty(el, 'loader', { value, writable: true, configurable: true, enumerable: true });
  Object.defineProperty(proto, 'loader', {
    configurable: true,
    get() { return loaders.get(this); },
    set(value) {
      if (stopped || this.getAttribute('type') !== 'text/tikz') { plain(this, value); return; }
      if (loaders.has(this)) { stats.twice++; return; }     // met a second time: its spinner is already on the page
      loaders.set(this, value);
      pending.add({ script: this, loader: value, since: now(), taken: false });
      if (!timer) timer = win.setInterval(tick, 500);
    },
  });

  // TikZJax's worker, known by the first figure it is asked for; what it answers, and TeX's log
  const WorkerProto = win.Worker.prototype, post = WorkerProto.postMessage;
  const onMessage = event => {
    const d = event.data;
    if (typeof d === 'string') { if (lines.length < 400) lines.push(d); return; }
    if (!d || typeof d.uid !== 'number' || !busy.has(d.uid)) return;
    if (d.type !== 'result' && d.type !== 'error') return;
    busy.delete(d.uid);
    if (!busy.size) idleSince = now();
    const mine = own.get(d.uid);
    own.delete(d.uid);
    if (d.type === 'error') {
      const said = texError(lines) || String((d.error && d.error.message) || '').slice(0, 300);
      if (mine) mine.reject(new Error(said));
      else win.setTimeout(() => showErrors(said), 0);      // (TikZJax puts its broken picture in first)
    } else if (mine) mine.resolve(d.payload);
  };
  const wrapped = function (message, ...rest) {
    try {
      if (!stopped && message && message.type === 'run' && message.method === 'texify' && typeof message.uid === 'number' && Array.isArray(message.args)) {
        if (worker !== this) { if (worker) worker.removeEventListener('message', onMessage); worker = this; worker.addEventListener('message', onMessage); }
        busy.add(message.uid);
        lines = [];
        stats.runs++;
      }
    } catch (e) { /* the message goes all the same */ }
    return post.call(this, message, ...rest);
  };
  WorkerProto.postMessage = wrapped;

  // 3. a broken picture gives way to what TeX said
  const errorBox = text => {
    const box = doc.createElement('div');
    box.className = 'scriptorium-tikz-error';
    box.appendChild(doc.createElement('strong')).textContent = 'TikZJax could not draw this figure.';
    box.appendChild(doc.createElement('pre')).textContent = text || 'TeX stopped at an error in the figure’s TikZ (its words are in the developer console).';
    return box;
  };
  const showErrors = text => {
    if (stopped) return;
    const broken = Array.from(doc.querySelectorAll(`img[src*="${TIKZ_BROKEN}"]`));
    for (const img of broken) { stats.errors++; img.replaceWith(errorBox(broken.length === 1 ? text : '')); }
  };

  // 2. a spinner left behind: the figure is asked of the worker here
  const ask = (source, options) => new Promise((resolve, reject) => {
    const id = uid++;
    own.set(id, { resolve, reject });
    busy.add(id);
    lines = [];
    post.call(worker, { type: 'run', uid: id, method: 'texify', args: [source, options] });
  });
  const rescue = async p => {
    if (stopped || !worker || !p.loader.isConnected) return;
    const script = p.script, source = script.childNodes[0] ? script.childNodes[0].nodeValue : '';
    try {
      const svg = tikzOwnIds(await ask(source, Object.assign({}, script.dataset)), script.md5hash || '');
      const figure = doc.createRange().createContextualFragment(svg).firstChild;
      if (stopped || !p.loader.isConnected) return;
      if (!figure || figure.nodeType !== 1) { p.loader.replaceWith(errorBox('The figure came out empty.')); stats.errors++; return; }
      p.loader.replaceWith(figure);
      stats.rescued++;
      figure.dispatchEvent(new win.Event('tikzjax-load-finished', { bubbles: true }));
      if (!said) { said = true; console.info('Scriptorium: a figure that TikZJax had left on its spinner was drawn by “Repair TikZJax rendering”.'); }
    } catch (e) {
      if (!stopped && p.loader.isConnected) { p.loader.replaceWith(errorBox(String((e && e.message) || ''))); stats.errors++; }
    }
  };
  function tick() {
    for (const p of Array.from(pending)) {
      if (!p.loader.isConnected) {
        // Replaced by its figure, or never shown. Or TikZJax was given no figure and put nothing in the spinner's place
        // (the word "null": the throw that stops its queue): the spinner goes back, and is taken up below.
        const home = p.home;
        if (home && home.isConnected && !home.firstElementChild && home.textContent.trim() === 'null') { home.textContent = ''; home.appendChild(p.loader); continue; }
        if (now() - p.since > 1000) pending.delete(p);
        continue;
      }
      p.home = p.loader.parentElement;
      if (p.taken || !worker || busy.size || now() - idleSince < 1000 || now() - p.since < 2000) continue;
      p.taken = true;
      chain = chain.then(() => rescue(p)).then(() => { pending.delete(p); }, () => { pending.delete(p); });
    }
    if (!pending.size && timer) { win.clearInterval(timer); timer = 0; }
  }

  return {
    stats,
    stop() {
      stopped = true;
      if (timer) win.clearInterval(timer);
      timer = 0;
      // (figures TikZJax is at keep their spinners, as plain properties, so that it finishes them as it would)
      for (const p of pending) { try { plain(p.script, p.loader); } catch (e) { /* gone */ } }
      pending.clear();
      delete proto.loader;
      if (WorkerProto.postMessage === wrapped) WorkerProto.postMessage = post;
      if (worker) worker.removeEventListener('message', onMessage);
      worker = null;
    },
  };
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

/* A paragraph's text as it is shown: without the marker line of centred or right-aligned text, which is in the
   paragraph but not on the page (see fenceLine). */
function shownText(p) {
  if (!p.childNodes) return String(p.textContent || '');
  let text = '';
  for (const node of Array.from(p.childNodes)) if (!(node.classList && node.classList.contains('scriptorium-fence'))) text += node.textContent;
  return text.replace(/^\s+/, '');
}

/* The marks of a drop cap, apart from any element: which is one of the four built in, or `set` is a set of drop
   caps (see "Sets of drop caps"); text is the paragraph as it is shown, key the note's path. → {classes, vars,
   image}: the classes and the custom properties that say so (the snippet reads them), and the image chosen
   ({light, dark}) or null. A set of images gives marks only if it has an image for the letter the paragraph begins
   with. Where a set has several images of a letter, key and the paragraph's opening words choose one, the same one
   each time the note is drawn. Pure. */
function dropcapMarks(which, set, text, key) {
  const none = { classes: [], vars: {}, image: null };
  if (set) {
    if (set.kind === 'font') {
      return {
        classes: ['scriptorium-dropcap', 'scriptorium-dropcap-font'],
        vars: {
          '--scriptorium-initial-font': `"${set.family}", var(--manuscript-display)`,
          '--scriptorium-initial-size': `${set.size || 4.2}em`,
          '--scriptorium-initial-margin': set.margin || '0.1em 0.1em -0.12em 0',
          '--scriptorium-initial-weight': 'normal',
        },
        image: null,
      };
    }
    text = String(text || '');
    const slot = set.letters[openingLetter(text)];
    if (!slot) return none;
    const seed = seedOf(`${key || ''}\n${text.slice(0, 48)}`);
    const one = v => (Array.isArray(v) ? v[seed % v.length] : v) || '';
    const image = { light: one(slot.light) || one(slot.dark), dark: one(slot.dark) || one(slot.light) };
    if (!image.light) return none;
    const url = u => `url("${String(u).replace(/["\\\n]/g, encodeURIComponent)}")`;
    return {
      classes: ['scriptorium-dropcap', 'scriptorium-dropcap-image'].concat(set.mono ? ['scriptorium-dropcap-mono'] : []),
      vars: { '--scriptorium-dropcap-light': url(image.light), '--scriptorium-dropcap-dark': url(image.dark) },
      image,
    };
  }
  if (which && !which.startsWith('set:')) return { classes: ['scriptorium-dropcap', `scriptorium-dropcap-${which}`], vars: {}, image: null };
  return none;
}

/* Marks (or unmarks) one rendered block with a drop cap (dropcapMarks): a set of images marks the block only if it
   has an image for the letter the block's paragraph begins with; otherwise the block keeps the vault's drop cap.
   Returns the image chosen ({light, dark}), or null. */
function markDropcap(el, which, set, key) {
  for (const c of Array.from(el.classList)) if (c.startsWith('scriptorium-dropcap') && c !== 'scriptorium-dropcap-inked') el.classList.remove(c);
  if (el.style && el.style.removeProperty) for (const v of DROPCAP_VARS) el.style.removeProperty(v);
  let text = '';
  if (set && set.kind !== 'font') {
    const p = el.querySelector ? el.querySelector(':scope > p') : null;
    if (!p) return null;
    text = shownText(p);
  }
  const marks = dropcapMarks(which, set, text, key);
  if (marks.classes.length) el.classList.add(...marks.classes);
  for (const [name, value] of Object.entries(marks.vars)) el.style.setProperty(name, value);
  return marks.image;
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
   Centred and right-aligned text
   ==========================================================
   A block of a note is centred, or set to the right, between two marker lines:
       ::: center
       Shall I compare thee to a summer's day?
       Thou art more lovely and more temperate:
       :::
   and "::: right" for the right (an attribution, a signature). It is the fenced container of Pandoc and of
   markdown-it ("::: center", or "::: {.center}"), so the note stays plain Markdown and reads as such anywhere. The
   opening line stands at the start of a block (a blank line or a heading before it, or the top of the note) and the
   closing line at the end of one (a blank line or a heading after it, or the end of the note); a block that is not
   closed aligns nothing. Inside, every line of the note is a line on the page (verse needs no two spaces at a line's
   end) and a blank line parts two stanzas. A note's property "align: center" (or right) aligns the whole note.

   Why marker lines and not a callout (> [!center]): Live Preview draws a callout as one block of its own, which the
   editor cannot write in line by line (nor can Lagrange's pen). Between marker lines the text stays ordinary lines
   of the editor: alignExtension marks each of them and the snippet sets them, so the same text is centred in Live
   Preview, in Reading view and in an exported PDF.

   Drop caps. Aligned text has no drop cap and no small-capped first line (the snippet's rules for
   .scriptorium-align), and it does not use up the chapter opening either: the first paragraph after a heading that
   is not aligned still has the drop cap, whatever centred or right-aligned blocks stand between the heading and it
   (an epigraph in verse, the name under a quotation). For that the last block of such a run is marked
   .scriptorium-opens, which the snippet's rules for chapter openings take as they take a heading. The writer can ask
   for a drop cap on aligned text all the same: "::: center dropcap" for one block (the commands "Use a drop cap on
   this aligned paragraph" and "Remove the drop cap from this aligned paragraph"), or the property
   "dropcap-aligned: true" for a note (the picker's "Also on centred and right-aligned text"). Such a block is a
   paragraph like any other: it has the drop cap where a chapter opens, and the paragraph after it has none.

   Reading view draws a note a section (a block) at a time and keeps a section for as long as its own text stays the
   same, so the marks are set from the note's text and each section's lines (alignPlan, sectionMarks), and set again
   for every section whenever the sections change (watchSizer). A page that is rendered all at once (Export to PDF,
   an embed) has no lines to go by: there the same plan is made from the blocks themselves (blockMarks). */

const ALIGN_OPEN = /^ {0,3}:{3,}[ \t]*\{?[ \t]*\.?(center|centre|centered|centred|right)(?![\w-])([^{}\n]*)\}?[ \t]*:*[ \t]*$/i;
const ALIGN_CLOSE = /^ {0,3}:{3,}[ \t]*$/;
const ALIGN_DROPCAP = /(^|[\s.])drop-?cap(?![\w-])/i;
const ALIGN_CLASSES = ['scriptorium-align', 'scriptorium-align-center', 'scriptorium-align-right', 'scriptorium-align-dropcap',
  'scriptorium-align-fence', 'scriptorium-align-lines', 'scriptorium-opens'];

/* 'center' | 'right' from a word of the marker line or of the "align" property, or null. */
function alignKind(word) {
  const w = String(word == null ? '' : word).trim().toLowerCase();
  return /^cent(?:er|re|ered|red)$/.test(w) ? 'center' : w === 'right' ? 'right' : null;
}

/* A marker line read: {align, dropcap} for an opening line ("::: center", "::: right dropcap", "::: {.center}"),
   {close: true} for a closing one (":::"), or null for any other line. */
function alignMarker(line) {
  const text = String(line == null ? '' : line);
  if (ALIGN_CLOSE.test(text)) return { close: true };
  const m = ALIGN_OPEN.exec(text);
  return m ? { align: alignKind(m[1]), dropcap: ALIGN_DROPCAP.test(m[2]) } : null;
}

/* The level of an ATX heading line (1 to 6), or 0. */
function headingLevel(line) {
  const m = /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(String(line || ''));
  return m ? m[1].length : 0;
}

/* What a note's properties say of its alignment: {align: 'center' | 'right' | null, dropcap: whether its aligned
   text may have drop caps ("dropcap-aligned: true")}. */
function noteAlign(frontmatter) {
  const fm = frontmatter && typeof frontmatter === 'object' ? frontmatter : {};
  const yes = v => v === true || (typeof v === 'string' && /^(?:true|yes|on)$/i.test(v.trim()));
  return { align: alignKind(typeof fm.align === 'string' ? fm.align : ''), dropcap: yes(fm['dropcap-aligned']) };
}

/* Where a note's text is aligned, from its lines: {lines, body, note, ranges}.
     body    the first line after the properties (0 without them)
     note    {align, dropcap}: what the properties say (read from the lines themselves, or given as `note` where the
             lines have no properties: a page rendered from its blocks)
     ranges  [{align, dropcap, own, open, close, lead}] in order: the lines of the two markers; dropcap, whether the
             block may have a drop cap (its own "dropcap", kept in `own`, or the note's); lead, whether a chapter
             opening may come where the block stands: it is the first thing under a heading of level 1, 2 or 6 or
             at the top of a note without properties, but for other aligned blocks without a drop cap and one
             quotation (the epigraph the snippet allows for).
   Marker lines inside a fenced code block are code. Pure. */
function alignPlan(lines, note) {
  const n = lines.length, blank = i => !/\S/.test(lines[i]);
  let body = 0;
  const said = { align: null, dropcap: false };
  if (n && /^---[ \t]*$/.test(lines[0])) {
    for (let j = 1; j < n; j++) if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[j])) { body = j + 1; break; }
    for (let j = 1; j < body - 1; j++) {
      const m = /^(align|dropcap-aligned)[ \t]*:[ \t]*["']?([^"'#\n]*?)["']?[ \t]*(?:#.*)?$/i.exec(lines[j]);
      if (m && m[1].toLowerCase() === 'align') said.align = alignKind(m[2]);
      else if (m) said.dropcap = /^(?:true|yes|on)$/i.test(m[2].trim());
    }
  }
  const of = note || said;
  const ranges = [];
  let code = null, open = null;
  for (let k = body; k < n; k++) {
    const line = lines[k];
    if (code) { if (code.test(line)) code = null; continue; }
    const fence = line.includes('```') || line.includes('~~~') ? /^ {0,3}(`{3,}|~{3,})/.exec(line) : null;
    if (fence) { code = new RegExp(`^ {0,3}\\${fence[1][0]}{${fence[1].length},}[ \\t]*$`); continue; }
    const m = line.includes(':::') ? alignMarker(line) : null;   // (most lines are no marker: not worth a closer look)
    if (!m) continue;
    if (m.close) {
      if (open && (k === n - 1 || blank(k + 1) || headingLevel(lines[k + 1]))) {
        ranges.push({ align: open.align, dropcap: open.dropcap || of.dropcap, own: open.dropcap, open: open.at, close: k, lead: false });
        open = null;
      }
    } else if (k === body || blank(k - 1) || headingLevel(lines[k - 1])) open = { align: m.align, dropcap: m.dropcap, at: k };
  }
  // What stands above each block: a chapter opening may come there, or not.
  const closes = new Map();
  const leads = (k, quote) => {
    let j = k - 1;
    while (j >= body && blank(j)) j--;
    if (j < body) return body === 0;
    const level = headingLevel(lines[j]);
    if (level) return level <= 2 || level === 6;
    if (closes.has(j)) { const r = closes.get(j); return r.lead && !r.dropcap; }
    if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[j]) && j > body && !blank(j - 1) && !headingLevel(lines[j - 1])) return true;   // a heading underlined
    if (!quote) return false;
    let q = j;
    while (q > body && !blank(q - 1)) q--;
    return /^ {0,3}>/.test(lines[q]) && !/^ {0,3}>[ \t]*\[!/.test(lines[q]) && leads(q, false);
  };
  for (const r of ranges) { r.lead = leads(r.open, true); closes.set(r.close, r); }
  return { lines, body, note: of, ranges };
}

/* The marks of one block of a note, which takes the lines from..to: null where nothing is aligned, else
   {align, dropcap, first, last, fence, opens}: first and last, whether the block begins with the opening marker and
   ends with the closing one (lines that are not shown); fence, whether it is nothing but markers; opens, whether a
   chapter opening may follow it (see above). Pure. */
function sectionMarks(plan, from, to) {
  const r = plan.ranges.find(x => x.close >= from && x.open <= to);
  if (!r) return plan.note.align && from >= plan.body ? { align: plan.note.align, dropcap: plan.note.dropcap, first: false, last: false, fence: false, opens: false } : null;
  const first = r.open >= from, last = r.close <= to;
  let fence = true;
  for (let k = Math.max(from, r.open); k <= Math.min(to, r.close) && fence; k++) if (k !== r.open && k !== r.close && /\S/.test(plan.lines[k])) fence = false;
  return { align: r.align, dropcap: r.dropcap, first, last, fence, opens: r.lead && (r.dropcap ? first && fence : last) };
}

/* The classes that say so on the block (the snippet's rules read them). */
function alignClasses(marks) {
  if (!marks) return [];
  const out = ['scriptorium-align', `scriptorium-align-${marks.align}`];
  if (marks.dropcap) out.push('scriptorium-align-dropcap');
  if (marks.fence) out.push('scriptorium-align-fence');
  if (marks.opens) out.push('scriptorium-opens');
  return out;
}

/* The lines a rendered block stands for, as nearly as its tag and text tell: a heading with its #s, a quotation with
   its >, a paragraph line by line (a marker line is a line of the paragraph it was written against); anything else
   that has no text, or is code, is one line that is no marker. */
function blockLines(tag, text, title) {
  const t = String(tag || '').toUpperCase(), lines = String(text == null ? '' : text).split('\n').map(l => l.trim()).filter(Boolean);
  if (title) return [`# ${lines.join(' ')}`];
  if (/^H[1-6]$/.test(t)) return [`${'#'.repeat(Number(t[1]))} ${lines.join(' ')}`];
  if (t === 'PRE' || t === 'TABLE' || !lines.length) return [`<${t.toLowerCase() || 'div'}>`];
  return t === 'BLOCKQUOTE' ? lines.map(l => `> ${l}`) : lines;
}

/* The marks of blocks that were rendered all at once (a page about to be printed, an embed): blocks is
   [{tag, text, title}] in order, note is the note's own alignment (noteAlign). → the marks of each. Pure. */
function blockMarks(blocks, note) {
  const lines = [], spans = [];
  for (const b of blocks) {
    const own = blockLines(b.tag, b.text, b.title);
    spans.push([lines.length, lines.length + own.length - 1]);
    lines.push(...own, '');
  }
  const plan = alignPlan(lines, note || { align: null, dropcap: false });
  return spans.map(([from, to]) => sectionMarks(plan, from, to));
}

/* What the commands change in a note, as edits of its lines: {line, insert} puts a new line before line `line` (which
   may be one past the last), {line, remove: true} takes a line out, {line, text} replaces one. All of them count
   lines as they are before any edit.
   alignEdits(lines, from, to, kind): the selection takes the lines from..to (the cursor's line twice, without one).
     kind 'center' | 'right': the paragraphs the selection touches are put between marker lines; where it touches
       blocks that are aligned already, those are given this alignment instead.
     kind null: the markers of the aligned blocks it touches are taken out.
   Centring and removing the alignment again leaves the note exactly as it was (unless a blank line had to be made
   for the opening marker: a heading that stood against the paragraph above it). Pure. */
function alignEdits(lines, from, to, kind) {
  const plan = alignPlan(lines), blank = i => !/\S/.test(lines[i] || '');
  const touched = plan.ranges.filter(r => r.close >= from && r.open <= to);
  if (touched.length) {
    if (!kind) return touched.flatMap(r => [{ line: r.open, remove: true }, { line: r.close, remove: true }]);
    return touched.filter(r => r.align !== kind).map(r => ({ line: r.open, text: lines[r.open].replace(/cent(?:ered|red|er|re)|right/i, kind) }));
  }
  from = Math.max(from, plan.body);
  to = Math.min(to, lines.length - 1);
  while (from <= to && blank(from)) from++;
  while (to >= from && blank(to)) to--;
  if (!kind || from > to) return [];
  const head = i => headingLevel(lines[i]) > 0;
  while (from > plan.body && !blank(from - 1) && !head(from - 1) && !head(from)) from--;
  while (to < lines.length - 1 && !blank(to + 1) && !head(to + 1)) to++;
  const edits = [];
  if (from > plan.body && !blank(from - 1) && !head(from - 1)) edits.push({ line: from, insert: '' });
  edits.push({ line: from, insert: `::: ${kind}` }, { line: to + 1, insert: ':::' });
  return edits;
}

/* The edit that gives the aligned block the line `line` is in a drop cap (on) or takes it away: "dropcap" on its
   opening marker. [] if it is so already; null if the line is in no aligned block. Pure. */
function alignDropcapEdits(lines, line, on) {
  const r = alignPlan(lines).ranges.find(x => x.open <= line && x.close >= line);
  if (!r) return null;
  if (r.own === Boolean(on)) return [];
  const text = lines[r.open];
  if (!on) return [{ line: r.open, text: text.replace(/[ \t]*\.?drop-?cap(?![\w-])/i, '') }];
  const m = /^( {0,3}:{3,}[ \t]*\{[^}\n]*?)[ \t]*\}(.*)$/.exec(text);
  return [{ line: r.open, text: m ? `${m[1]} .dropcap}${m[2]}` : text.replace(/[ \t]*:*[ \t]*$/, '') + ' dropcap' }];
}

/* The lines after the edits. Pure (the editor makes the same edits as changes: see alignCommand). */
function applyLineEdits(lines, edits) {
  const out = [];
  for (let i = 0; i <= lines.length; i++) {
    for (const e of edits) if (e.line === i && 'insert' in e) out.push(e.insert);
    if (i === lines.length) break;
    const e = edits.find(x => x.line === i && !('insert' in x));
    if (!e) out.push(lines[i]); else if (!e.remove) out.push(e.text);
  }
  return out;
}

/* Where line `line` is after the edits. */
function lineAfterEdits(edits, line) {
  let shift = 0;
  for (const e of edits) {
    if ('insert' in e) { if (e.line <= line) shift++; } else if (e.remove && e.line < line) shift--;
  }
  return Math.max(0, line + shift);
}

/* Hides the marker line a rendered block begins (which 'first') or ends ('last') with, or shows it again: the line
   is put in a span of its own, with the line break beside it, and the snippet does not show the span. The text is
   kept, because Reading view keeps the block: if the markers stop being markers, the line is shown again. */
function fenceLine(block, which, on) {
  const doc = block.ownerDocument, cls = `scriptorium-fence-${which}`;
  const old = Array.from(block.querySelectorAll('span.scriptorium-fence')).find(s => s.classList.contains(cls));
  if (old && on) return;
  if (old) { old.replaceWith(...Array.from(old.childNodes)); block.normalize(); return; }
  if (!on) return;
  const walker = doc.createTreeWalker(block, 4), nodes = [];   // 4: text nodes
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (/\S/.test(node.data) && !node.parentElement.closest('span.scriptorium-fence')) nodes.push(node);
  let node = which === 'first' ? nodes[0] : nodes[nodes.length - 1];
  if (!node) return;
  const span = doc.createElement('span');
  span.className = `scriptorium-fence ${cls}`;
  if (which === 'first') {
    const at = node.data.indexOf('\n', node.data.search(/\S/));
    const marker = alignMarker((at < 0 ? node.data : node.data.slice(0, at)).trim());
    if (!marker || marker.close) return;
    if (at >= 0 && at + 1 < node.data.length) node.splitText(at + 1);
    const next = node.nextSibling;
    node.replaceWith(span);
    span.appendChild(node);
    if (next && next.nodeName === 'BR') span.appendChild(next);
  } else {
    const text = node.data.replace(/\s+$/, ''), at = text.lastIndexOf('\n');
    const marker = alignMarker(text.slice(at + 1).trim());
    if (!marker || !marker.close) return;
    if (at > 0 && /\S/.test(text.slice(0, at))) node = node.splitText(at);
    const prev = node.previousSibling;
    node.replaceWith(span);
    span.appendChild(node);
    if (prev && prev.nodeName === 'BR') span.insertBefore(prev, node);
  }
}

/* Sets a rendered block's marks: el is the block Reading view made for a section (or the block itself where there
   is none around it). Returns whether its classes changed. */
function markAligned(el, marks) {
  const want = new Set(alignClasses(marks));
  const block = el.firstElementChild && /^(?:P|UL|OL|BLOCKQUOTE|H[1-6])$/.test(el.firstElementChild.tagName) && el.tagName === 'DIV' ? el.firstElementChild : el;
  if (marks && !marks.fence && block.tagName === 'P' && !block.querySelector('br') && /\n/.test(block.textContent.trim())) want.add('scriptorium-align-lines');   // "Strict line breaks": a line is a line all the same
  let changed = false;
  for (const c of ALIGN_CLASSES) if (el.classList.contains(c) !== want.has(c)) { el.classList.toggle(c, want.has(c)); changed = true; }
  if (el.querySelector) {
    try {
      fenceLine(el, 'first', Boolean(marks && marks.first));
      fenceLine(el, 'last', Boolean(marks && marks.last));
    } catch (e) { /* a block of some other make: its markers stay as text */ }
  }
  return changed;
}

/* Marks the blocks of something rendered all at once: the element children of `container`, each a block or the
   <div> around one (as on a page about to be printed). */
function alignBlocks(container, note) {
  const els = Array.from(container.children).filter(el => !el.classList.contains('mod-footer') && !el.classList.contains('markdown-preview-pusher'));
  const blocks = els.map(el => {
    const inner = el.tagName !== 'DIV' ? el : Array.from(el.children).find(c => c.tagName === 'PRE') || (el.children.length === 1 ? el.firstElementChild : el);
    return { tag: inner.tagName, text: el.textContent, title: el.classList.contains('mod-header') };
  });
  blockMarks(blocks, note).forEach((marks, i) => markAligned(els[i], marks));
}

/* Live Preview: the lines of an aligned block stay ordinary lines of the editor, each with a class the snippet sets
   (scriptorium-align-center or -right; scriptorium-align-fence on the two marker lines), and a note that is aligned
   as a whole has a class on the editor's content. A CodeMirror extension, made when the plugin loads. */
function alignExtension() {
  const { StateField, RangeSetBuilder } = require('@codemirror/state');
  const { Decoration, EditorView } = require('@codemirror/view');
  const made = new Map();
  const deco = cls => { if (!made.has(cls)) made.set(cls, Decoration.line({ class: cls })); return made.get(cls); };
  const nothing = { deco: Decoration.none, note: null };
  const build = state => {
    const plan = docPlan(state.doc).plan;
    if (!plan.ranges.length && !plan.note.align) return nothing;
    const builder = new RangeSetBuilder();
    for (const r of plan.ranges) {
      for (let k = r.open; k <= r.close; k++) {
        const at = state.doc.line(k + 1).from;
        builder.add(at, at, deco(`scriptorium-align scriptorium-align-${r.align}${k === r.open || k === r.close ? ' scriptorium-align-fence' : ''}`));
      }
    }
    return { deco: builder.finish(), note: plan.note.align };
  };
  return StateField.define({
    create: build,
    update: (value, tr) => (tr.docChanged ? build(tr.state) : value),
    provide: field => [
      EditorView.decorations.from(field, value => value.deco),
      EditorView.contentAttributes.from(field, value => (value.note ? { class: `scriptorium-align-note-${value.note}` } : {})),
    ],
  });
}

/* ==========================================================
   Drop caps in Live Preview
   ==========================================================
   The editor shows the drop caps that Reading view shows, so that what is written looks as it will read. Nothing in
   the note is changed and nothing is put into the line: the first line of each paragraph that opens a chapter gets
   a class (scriptorium-opening, with the drop cap's own classes and custom properties, the ones markDropcap gives a
   block of Reading view), and the snippet sets its first letter and its first line with the very rules it has for
   Reading view. The letter stays the note's own text: the cursor goes before and after it, it is selected, copied,
   found and spell-checked like any other, and when it is deleted the next letter is the initial. Source mode has
   the classes too, but the snippet's rules are for Live Preview only.

   Which paragraphs open a chapter is read from the note's lines as Reading view has it from its blocks: the first
   block after a heading of level 1, 2 or 6 (or at the top of a note without properties), if it is a paragraph; or
   the paragraph after one quotation there (an epigraph); with centred and right-aligned text passed over, or given
   a standing initial where it asks for one (see "Centred and right-aligned text": alignPlan, sectionMarks).

   The drop cap stays while its paragraph is edited (a paragraph does not change its shape because the cursor is in
   it). One exception: where the paragraph begins with marks that Live Preview shows only while the cursor is by
   them ("**Bold** beginning", "[[A link]] first"), the line is plain while the cursor is on it, since the initial
   would otherwise be the marks.

   No word is split across the end of the small-capped first line there either (see "No word split across the
   small-capped opening line"): the editor cannot have a span put into its text, so the word is marked with a
   decoration, found by measuring where the line would break without it. */

/* The blocks of a note, from its lines, as Reading view draws them one after another: [{type, from, to, level}],
   type 'p' (a paragraph), 'heading' (level 1 to 6), 'quote' (a quotation that is no callout) or 'other' (a list, a
   table, code, a rule, a callout, mathematics, HTML, a comment, a footnote's text). body is the first line after
   the properties. Only what tells a paragraph that opens a chapter is read closely. Pure. */
const BLOCK = {
  fence: /^ {0,3}(`{3,}|~{3,})/,
  quote: /^ {0,3}>/,
  callout: /^ {0,3}>[ \t]*\[!/,
  list: /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/,
  interrupts: /^ {0,3}(?:[-*+]|1[.)])[ \t]+\S/,   // a list that can begin right under a paragraph's line
  rule: /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/,
  starRule: /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/,
  setext: /^ {0,3}(=+|-+)[ \t]*$/,
  math: /^ {0,3}\$\$/,
  comment: /^ {0,3}%%/,
  footnote: /^ {0,3}\[\^[^\]\s]+\]:/,
  indented: /^(?: {4}|\t)/,
  html: /^ {0,3}<(?:!--|\/?(?:address|article|aside|blockquote|center|details|dialog|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|iframe|li|main|nav|ol|p|pre|script|section|style|summary|table|tbody|td|textarea|tfoot|th|thead|tr|ul)(?=[\s/>]|$))/i,
  tableRule: /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/,
};

function noteBlocks(lines, body) {
  const n = lines.length, blocks = [], blank = i => !/\S/.test(lines[i]);
  const table = i => i + 1 < n && lines[i].includes('|') && lines[i + 1].includes('|') && BLOCK.tableRule.test(lines[i + 1]);
  // (a line that begins a block of another kind right under a paragraph's line, or under a quotation's)
  const breaks = i => headingLevel(lines[i]) > 0 || BLOCK.fence.test(lines[i]) || BLOCK.starRule.test(lines[i]) || BLOCK.html.test(lines[i]) || BLOCK.math.test(lines[i]);
  let k = body || 0;
  while (k < n) {
    if (blank(k)) { k++; continue; }
    const line = lines[k];
    let to = k, type = 'other', level = 0;
    const until = test => { while (to + 1 < n && !test(to + 1)) to++; if (to + 1 < n) to++; };
    const fence = BLOCK.fence.exec(line);
    if (fence) {
      const close = new RegExp(`^ {0,3}\\${fence[1][0]}{${fence[1].length},}[ \\t]*$`);
      until(i => close.test(lines[i]));
    } else if (BLOCK.math.test(line)) {
      if (!/\$\$/.test(line.replace(BLOCK.math, ''))) until(i => lines[i].includes('$$'));
    } else if (BLOCK.comment.test(line) && !/%%/.test(line.replace(BLOCK.comment, ''))) {
      until(i => lines[i].includes('%%'));
    } else if ((level = headingLevel(line))) {
      type = 'heading';
    } else if (BLOCK.rule.test(line)) {
      // a rule (a scene break)
    } else if (BLOCK.quote.test(line)) {
      type = BLOCK.callout.test(line) ? 'other' : 'quote';
      while (to + 1 < n && !blank(to + 1) && !(breaks(to + 1) && !BLOCK.quote.test(lines[to + 1]))) to++;
    } else if (BLOCK.list.test(line) || BLOCK.footnote.test(line)) {
      // to the blank line after which the text is neither set in nor another item
      for (;;) {
        while (to + 1 < n && !blank(to + 1) && !headingLevel(lines[to + 1]) && !BLOCK.fence.test(lines[to + 1])) to++;
        let next = to + 1;
        while (next < n && blank(next)) next++;
        if (next < n && next > to + 1 && (/^(?: {2,}|\t)/.test(lines[next]) || (BLOCK.list.test(line) && BLOCK.list.test(lines[next]) && !BLOCK.rule.test(lines[next])))) to = next;
        else break;
      }
    } else if (BLOCK.html.test(line)) {
      if (/^ {0,3}<!--/.test(line)) { if (!line.includes('-->')) until(i => lines[i].includes('-->')); }
      else while (to + 1 < n && !blank(to + 1)) to++;
    } else if (BLOCK.indented.test(line)) {
      for (;;) {
        while (to + 1 < n && BLOCK.indented.test(lines[to + 1])) to++;
        let next = to + 1;
        while (next < n && blank(next)) next++;
        if (next < n && next > to + 1 && BLOCK.indented.test(lines[next])) to = next; else break;
      }
    } else if (table(k)) {
      while (to + 1 < n && !blank(to + 1)) to++;
    } else {
      type = 'p';
      for (; to + 1 < n && !blank(to + 1); to++) {
        const next = lines[to + 1], under = BLOCK.setext.exec(next);
        if (under) { type = 'heading'; level = under[1][0] === '=' ? 1 : 2; to++; break; }   // a heading underlined
        if (breaks(to + 1) || BLOCK.quote.test(next) || BLOCK.interrupts.test(next) || table(to + 1)) break;
      }
    }
    blocks.push({ type, from: k, to, level });
    k = to + 1;
  }
  return blocks;
}

/* A line of a note as Live Preview and Reading view show it, near enough: without the marks of emphasis, with a
   link's words in place of the link, without comments and embedded files. Used for the paragraph's opening words
   (which letter a drop cap image shows, and which of a letter's images). Pure. */
function shownLine(source) {
  return String(source == null ? '' : source)
    .replace(/\\([\\`*_{}\[\]()#+\-.!|<>~=$%^])/g, (m, c) => String.fromCharCode(0xE000 + c.charCodeAt(0)))   // (a mark that is escaped is a character)
    .replace(/%%.*?%%/g, '')
    .replace(/!\[\[[^\]\n]*\]\]|!\[[^\]\n]*\]\([^)\n]*\)/g, '')
    .replace(/\[\[[^\]|\n]*\|([^\]\n]*)\]\]/g, '$1')
    .replace(/\[\[([^\]\n]*)\]\]/g, '$1')
    .replace(/\[\^[^\]\s]+\]/g, '')
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/<\/?[A-Za-z][^>\n]*>/g, '')
    .replace(/\*+|~~|==|`+/g, '')
    .replace(/(^|[^\p{L}\p{N}])_+(?=\S)|(\S)_+(?![\p{L}\p{N}])/gu, (m, a, b) => (a || '') + (b || ''))
    .replace(/[-]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xE000));
}

/* The drop cap a note's properties ask for, read from its lines (the editor has the lines, and has them before
   Obsidian has read the properties again): what noteDropcap says of them. Pure. */
function linesDropcap(lines, body) {
  const said = {};
  for (let j = 1; j < (body || 0) - 1; j++) {
    const m = /^(dropcap|drop-cap|dropCap|drop cap)[ \t]*:[ \t]*(.*?)[ \t]*$/.exec(lines[j]);
    if (!m || m[1] in said) continue;
    let v = m[2];
    const quoted = /^(["'])(.*)\1$/.exec(v);
    if (quoted) v = quoted[2]; else v = v.replace(/[ \t]+#.*$/, '');
    said[m[1]] = !quoted && /^(?:false|no|off)$/i.test(v) ? false : !quoted && /^(?:true|yes|on|null|~|)$/i.test(v) ? null : v;
  }
  return noteDropcap(said);
}

/* The paragraphs of a note that open a chapter, from its lines: [{line, text, standing, led, gap}], line being the
   line of the note the paragraph's first letter is on (the line after the marker, in aligned text); text, the
   paragraph as it is shown; standing, whether it is aligned text that asked for its drop cap (a standing initial);
   led, whether the line begins with marks that Live Preview shows only by the cursor; gap, where the first word is
   the initial alone ("A body at rest", "I remember"), the space after it as [from, to] in the line: beside a
   dropped initial Reading view sets no space at the head of the line. A paragraph that opens a chapter
   but has no initial is left out: aligned text that did not ask for one, and a paragraph that begins with an
   embedded file, mathematics, a comment or an HTML tag. plan is alignPlan(lines). Pure. */
function openingPlan(lines, plan) {
  plan = plan || alignPlan(lines);
  const out = [];
  let prev = plan.body === 0 ? 'opens' : 'other', before = 'other';   // the title's block stands first where there are no properties
  for (const b of noteBlocks(lines, plan.body)) {
    const marks = sectionMarks(plan, b.from, b.to);
    if (b.type === 'p' && (prev === 'opens' || (prev === 'quote' && before === 'opens')) && !(marks && (marks.fence || !marks.dropcap))) {
      const first = marks && marks.first ? b.from + 1 : b.from, last = marks && marks.last ? b.to - 1 : b.to;
      if (first <= last && !/^\s*(?:!\[|\$|%%|<)/.test(lines[first])) {
        const text = lines.slice(first, last + 1).map(l => shownLine(l).replace(/\s+$/, '')).join('\n').replace(/^\s+/, '');
        const lone = /^(\s*\p{P}*[\p{L}\p{N}]\p{P}*)([ \t]+)\S/u.exec(lines[first]);
        out.push({ line: first, text, standing: Boolean(marks), led: /^\s*[*_~=\[`\\]/.test(lines[first]), gap: lone && !marks ? [lone[1].length, lone[1].length + lone[2].length] : null });
      }
    }
    before = prev;
    prev = (b.type === 'heading' && (b.level <= 2 || b.level === 6)) || (marks && marks.opens) ? 'opens' : b.type === 'quote' ? 'quote' : 'other';
  }
  return out;
}

/* What the editor's opening line is given: {classes, style} from the note's choice (which: 'yinit' | 'goudy' |
   'plain' | 'none' | 'set:<name>' as resolved, or null for the vault's; set, the set of drop caps if it is one),
   the vault's own drop cap (vault), the opening (openingPlan) and the note's path; ratio(url) gives an image's shape
   if it is known. null where the paragraph has no initial (None). Pure. */
function openingLine(opening, which, set, vault, path, ratio, inked) {
  if (which === 'none') return null;
  const marks = dropcapMarks(which, set, opening.text, path);
  if (!marks.classes.length && vault === 'none') return null;
  const classes = ['scriptorium-opening'].concat(marks.classes);
  if (opening.standing) classes.push('scriptorium-align-dropcap');
  if (inked) classes.push('scriptorium-dropcap-inked');
  const vars = Object.assign({}, marks.vars);
  if (marks.image && ratio) {
    const light = ratio(marks.image.light), dark = ratio(marks.image.dark);
    if (light) vars['--scriptorium-dropcap-ratio'] = String(light);
    if (dark) vars['--scriptorium-dropcap-ratio-dark'] = String(dark);
  }
  return { classes: classes.join(' '), style: Object.entries(vars).map(([name, value]) => `${name}: ${value}`).join('; ') };
}

/* A note's lines and its alignment, kept for the document they were read from (the two extensions below both ask,
   at every change). */
const docPlans = new WeakMap();
function docPlan(doc) {
  let hit = docPlans.get(doc);
  if (!hit) {
    const lines = [];
    for (const line of doc.iterLines()) lines.push(line);
    hit = { lines, plan: alignPlan(lines) };
    docPlans.set(doc, hit);
  }
  return hit;
}

/* The CodeMirror extension (made when the plugin loads) and what the plugin needs of it: {extension, refresh,
   preview, ink}. refresh is an effect that has every opening line set again (the vault's drop cap, the sets or a
   font changed); preview one that shows a drop cap without saving it ({which}: as previewDropcap takes it;
   undefined for what the note says) and inks it in ({ink: true}); ink switches the inking off again. */
function dropcapExtension(plugin) {
  const { StateField, StateEffect, RangeSetBuilder, Prec } = require('@codemirror/state');
  const { Decoration, EditorView, ViewPlugin } = require('@codemirror/view');
  const obsidian = require('obsidian');
  const refresh = StateEffect.define(), preview = StateEffect.define(), ink = StateEffect.define(), keep = StateEffect.define();
  const pathOf = state => {
    try { const info = obsidian.editorInfoField ? state.field(obsidian.editorInfoField, false) : null; return info && info.file ? info.file.path : ''; } catch (e) { return ''; }
  };
  const live = state => {
    try { return obsidian.editorLivePreviewField ? state.field(obsidian.editorLivePreviewField, false) !== false : true; } catch (e) { return true; }
  };
  const read = state => {
    const { lines, plan } = docPlan(state.doc);
    return { said: linesDropcap(lines, plan.body), openings: openingPlan(lines, plan) };
  };
  const gap = Decoration.mark({ class: 'scriptorium-opening-gap' });   // the space after an initial that is a word by itself
  const decorate = (state, value) => {
    const builder = new RangeSetBuilder(), froms = [];
    if (value.openings.length) {
      const choice = plugin.dropcapChoice(value.shown ? value.shown.which : value.said), path = pathOf(state);
      for (const o of value.openings) {
        if (o.line >= state.doc.lines) continue;
        const line = state.doc.line(o.line + 1);
        if (o.led && state.selection.ranges.some(r => r.to >= line.from && r.from <= line.to)) continue;   // its marks are showing
        const made = openingLine(o, choice.which, choice.set, plugin.settings.initials, path, url => plugin.ratioKnown(url), value.inked);
        if (!made) continue;
        builder.add(line.from, line.from, Decoration.line(made.style ? { class: made.classes, attributes: { style: made.style } } : { class: made.classes }));
        if (o.gap && line.from + o.gap[1] <= line.to) builder.add(line.from + o.gap[0], line.from + o.gap[1], gap);
        froms.push(line.from);
      }
    }
    return Object.assign({}, value, { deco: builder.finish(), froms });
  };
  const field = StateField.define({
    create: state => decorate(state, Object.assign({ shown: null, inked: false }, read(state))),
    update(value, tr) {
      let next = value, again = false;
      if (tr.docChanged) {
        next = Object.assign({}, next, read(tr.state));
        if (next.shown && next.shown.said !== next.said) next.shown = null;   // the note says something else now
        again = true;
      }
      for (const e of tr.effects) {
        if (e.is(refresh)) again = true;
        else if (e.is(preview)) { next = Object.assign({}, next, { shown: e.value.which === undefined ? null : { which: e.value.which, said: next.said }, inked: Boolean(e.value.ink) }); again = true; }
        else if (e.is(ink)) { next = Object.assign({}, next, { inked: Boolean(e.value) }); again = true; }
      }
      if (!again && tr.selection && value.openings.some(o => o.led)) again = true;
      return again ? decorate(tr.state, next) : value;
    },
    provide: f => EditorView.decorations.from(f, value => value.deco),
  });

  // The word kept whole on the small-capped first line.
  const kept = Decoration.mark({ class: 'sc-keep' });
  const keepField = StateField.define({
    create: () => Decoration.none,
    update(value, tr) {
      for (const e of tr.effects) if (e.is(keep)) return e.value.length ? Decoration.set(e.value.map(([from, to]) => kept.range(from, to)), true) : Decoration.none;
      return tr.docChanged ? value.map(tr.changes) : value;
    },
    provide: f => EditorView.decorations.from(f),
  });
  const keeper = ViewPlugin.fromClass(class {
    constructor(view) { this.ask(view); }
    update(u) {
      if (u.docChanged || u.geometryChanged || u.viewportChanged || u.startState.field(field) !== u.state.field(field) ||
        u.transactions.some(tr => tr.effects.some(e => e.is(refresh)))) this.ask(u.view);
    }
    ask(view) {
      view.requestMeasure({ key: this, read: v => this.read(v), write: (found, v) => this.write(found, v) });
    }
    /* Where the first line of each opening paragraph in view would break inside a word: [[from, to]] of the words. */
    read(view) {
      const state = view.state, froms = state.field(field).froms, found = [];
      if (!froms.length || !live(state)) return { state, found };
      const had = state.field(keepField).size > 0;
      if (had) view.dom.classList.add('scriptorium-keep-off');
      try {
        for (const from of froms) {
          if (from < view.viewport.from || from > view.viewport.to) continue;
          const at = view.domAtPos(from);
          const el = (at.node.nodeType === 1 ? at.node : at.node.parentElement).closest('.cm-line');
          if (!el || !el.classList.contains('scriptorium-opening')) continue;
          const cs = getComputedStyle(el, '::first-line');
          if (cs.fontVariantCaps !== 'small-caps') continue;   // (Source mode, or a snippet without the rules)
          const nodes = [], walker = el.ownerDocument.createTreeWalker(el, 4);   // 4: text nodes
          for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.parentElement.closest('[contenteditable="false"], .cm-widgetBuffer, mjx-container, .math, .cm-inline-code')) nodes.push(n);
          const split = firstLineSplit(nodes, parseFloat(getComputedStyle(el).fontSize));
          if (!split) continue;
          const [s, e] = wordBounds(nodes, split[0], split[1]);
          const a = view.posAtDOM(nodes[s[0]], s[1]), b = view.posAtDOM(nodes[e[0]], e[1] + 1), line = state.doc.lineAt(from);
          if (a >= line.from && b <= line.to && b > a) found.push([a, b]);
        }
      } catch (e) { /* never break the editor: the line is as it is */ }
      finally { if (had) view.dom.classList.remove('scriptorium-keep-off'); }
      return { state, found };
    }
    write({ state, found }, view) {
      const now = [];
      for (const it = state.field(keepField).iter(); it.value; it.next()) now.push([it.from, it.to]);
      if (now.length === found.length && now.every((r, i) => r[0] === found[i][0] && r[1] === found[i][1])) return;
      Promise.resolve().then(() => { if (view.state === state) try { view.dispatch({ effects: keep.of(found) }); } catch (e) { /* the view is gone */ } });
    }
  });
  /* A click on the initial puts the cursor at the letter: before it or after it, whichever is nearer (a double
     click takes the word, a triple click the line of the note). Left to itself, the browser has no place for a
     click on a letter that is floated out of its line, and puts the cursor at the end of the first line. */
  const clicks = Prec.highest(EditorView.domEventHandlers({
    mousedown(event, view) {
      try {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || !live(view.state)) return false;
        const el = event.target && event.target.closest ? event.target.closest('.cm-line.scriptorium-opening') : null;
        if (!el) return false;
        const line = view.state.doc.lineAt(view.posAtDOM(el, 0)), cs = getComputedStyle(el), tall = (parseFloat(cs.lineHeight) || 24) * 1.8;
        const inside = b => event.clientX >= b.left && event.clientX <= b.right && event.clientY >= b.top && event.clientY <= b.bottom;
        let first = -1, last = -1, box = null;
        for (let p = line.from; p < Math.min(line.to, line.from + 8); p++) {
          const c = view.coordsAtPos(p, 1), d = view.coordsAtPos(p + 1, -1);   // the letter's left edge, and its right one
          if (!c || c.bottom - c.top <= tall) { if (first >= 0) break; continue; }
          if (first < 0) first = p;
          last = p;
          const right = d && d.bottom - d.top > tall ? Math.max(c.right, d.right) : c.right;
          box = box ? { left: Math.min(box.left, c.left), right: Math.max(box.right, right), top: Math.min(box.top, c.top), bottom: Math.max(box.bottom, c.bottom) } : { left: c.left, right, top: c.top, bottom: c.bottom };
        }
        let at = -1;
        if (box && inside(box)) at = event.clientX < (box.left + box.right) / 2 ? first : last + 1;
        else if (!box) {
          // a picture stands for the letter: a click on it is a click before the paragraph's first letter
          const picture = getComputedStyle(el, '::before'), px = v => parseFloat(v) || 0, r = el.getBoundingClientRect();
          if (picture.content === 'none' || picture.content === 'normal' || picture.float !== 'left') return false;
          const left = r.left + px(cs.paddingLeft) + px(picture.marginLeft), top = r.top + px(cs.paddingTop) + px(picture.marginTop);
          if (inside({ left, right: left + px(picture.width), top, bottom: top + px(picture.height) })) at = line.from + Math.max(0, line.text.search(/\S/));
        }
        if (at < 0) return false;
        const word = /^[\p{L}\p{N}\p{M}'’-]*/u.exec(view.state.doc.sliceString(at, line.to))[0].length;
        const selection = event.shiftKey ? { anchor: view.state.selection.main.anchor, head: at }
          : event.detail >= 3 ? { anchor: line.from, head: line.to }
            : event.detail === 2 ? { anchor: Math.min(at, first < 0 ? at : first), head: Math.max(at, at + word) } : { anchor: at };
        event.preventDefault();
        view.dispatch({ selection, userEvent: 'select.pointer' });
        view.focus();
        return true;
      } catch (e) { return false; }
    },
  }));
  return { extension: [field, keepField, keeper, clicks], refresh, preview, ink, field, keepField };
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
   the page is printed. Centred and right-aligned blocks are marked there as well (alignBlocks). The title is included by default (the plugin ticks Obsidian's option once; untick it in the
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
    // Centred and right-aligned text has no drop cap unless the note asks for it: saved at once, with the list still open.
    const also = this.contentEl.createEl('label', { cls: 'scriptorium-dropcap-also' });
    const box = also.createEl('input', { attr: { type: 'checkbox' } });
    box.checked = noteAlign(cache && cache.frontmatter).dropcap;
    also.createSpan({ text: 'Also on centred and right-aligned text' });
    box.addEventListener('change', () => void this.plugin.setNoteDropcapAligned(file, box.checked));
    this.contentEl.createEl('p', {
      cls: 'scriptorium-dropcap-hint',
      text: 'Saved in the note’s properties as “dropcap”. It shows in Reading view (and while editing, if “Show drop caps while editing” is on in the settings). A set ' +
        'of images shows where it has the paragraph’s first letter. Centred and right-aligned text has no drop cap ' +
        'unless the box is ticked (“dropcap-aligned” in the properties) or its own marker line asks for one (“::: center dropcap”).',
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
      .setName('Show drop caps while editing (Live Preview)')
      .setDesc('On by default: Live Preview shows the same drop cap as Reading view on the same paragraph, in the same place, with the first line in small capitals, so the text does not move between the two views. The initial is still the letter you typed (the cursor goes before and after it; it is selected, copied, found and spell-checked as any other); nothing is added to the note. Off: the editor shows the opening paragraph as plain text, and drop caps are drawn in Reading view and in an exported PDF only. Source mode stays plain.')
      .addToggle(toggle => toggle
        .setValue(settings.liveDropcaps)
        .onChange(value => this.plugin.updateSettings({ liveDropcaps: value })));
    new Setting(el)
      .setName('Repair TikZJax rendering')
      .setDesc('On by default. The TikZJax plugin (0.5.2), which draws tikz figures, can leave a figure on its spinner for ever when the figure is shown in a panel (a chat, a sidebar), can stop drawing figures altogether after one goes wrong inside it, and shows an error in a figure only as a broken picture. With this on, Scriptorium stands beside TikZJax while it runs: the figure is drawn where its spinner is, a figure left behind is drawn all the same, and an error shows what TeX said. None of TikZJax’s files is changed, and another version of TikZJax is left alone. Off: TikZJax exactly as it comes.')
      .addToggle(toggle => toggle
        .setValue(settings.tikzRepair)
        .onChange(value => this.plugin.updateSettings({ tikzRepair: value })));
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

    // Syncing with Google Drive through rclone: see "Syncing with Google Drive" below.
    new Setting(el).setName('Google Drive sync (new)').setHeading();
    if (!this.plugin.onDesktop()) { new Setting(el).setName('Sync or retrieve').setDesc(SYNC_MOBILE); return; }
    const plugin = this.plugin, sync = syncSettings(settings), kit = plugin.syncKit();
    const setSync = patch => plugin.updateSettings({ sync: Object.assign({}, plugin.settings.sync, patch) });
    const link = plugin.syncLink(), conn = syncConnection(kit.fs, kit.paths.conf);
    const open = mode => new SyncModal(plugin, mode, { onClose: () => this.display() }).open();
    new Setting(el)
      .setName(link && link.first ? 'This vault is synced' : 'Sync this vault')
      .setDesc(link && link.first ? `With ${syncWhere(link)}. ${syncStatusText(plugin.engine.state, Date.now()).title}`
        : 'Keeps this vault and a folder of your own Google Drive the same, in both directions: sign in to Google, pick the folder, and it stays in step by itself. ' + SYNC_PRIVACY)
      .addButton(b => b.setButtonText(link && link.first ? 'Status…' : 'Set up…').setCta().onClick(() => open(link && link.first ? 'status' : 'setup')))
      .addButton(b => b.setButtonText('Retrieve a vault…').onClick(() => open('retrieve')));
    if (plugin.oldDriveBackup()) new Setting(el).setName('Coming from the older Google Drive backup?').setDesc(SYNC_MOVED);
    new Setting(el)
      .setName('Google account')
      .setDesc(conn.connected ? `This computer is signed in (${conn.own ? 'with a client ID of your own' : 'with rclone’s shared sign-in'}). The sign-in is kept outside every vault, in ${kit.paths.conf}. Disconnect withdraws it where Google allows and deletes it from this computer; your files stay where they are.`
        : `Not signed in. ${SYNC_UNVERIFIED}`)
      .addButton(b => b.setButtonText(conn.connected ? 'Disconnect' : 'Connect…').onClick(async () => {
        if (!conn.connected) { open('connect'); return; }
        try { await (await plugin.syncApi()).disconnect(); new Notice('Disconnected from Google Drive on this computer.'); }
        catch (e) { new Notice(`${e.message} ${e.next || ''}`.trim(), 12000); }
        plugin.engine.start(false);
        plugin.refreshSync();
        this.display();
      }));
    new Setting(el)
      .setName('Sync by itself')
      .setDesc('When Obsidian starts, on a timer, and shortly after a note changes. Off: only when you choose “Sync now”.')
      .addToggle(t => t.setValue(sync.auto).onChange(v => setSync({ auto: v })));
    new Setting(el)
      .setName('Minutes between syncs')
      .setDesc('From 1 to 720. Each sync asks Google Drive what changed; five minutes is a good balance.')
      .addText(t => t.setPlaceholder(String(SYNC_DEFAULTS.minutes)).setValue(String(sync.minutes)).onChange(v => { if (/^\d+$/.test(v.trim())) void setSync({ minutes: Number(v) }); }));
    new Setting(el)
      .setName('Sync Obsidian’s settings, plugins, themes and snippets')
      .setDesc('So that a second computer gets the same setup. Never synced either way: the layout of the windows, caches, and Lagrange’s settings (they hold API keys). Other plugins’ settings are synced as they are: if one of them keeps a password or key, it goes to your Drive with the rest. Every computer that syncs this vault should have this set the same way (the setting itself is synced when this is on).')
      .addToggle(t => t.setValue(sync.obsidian).onChange(v => setSync({ obsidian: v })));
    new Setting(el)
      .setName('Safety limit on deletions')
      .setDesc('A sync stops and asks if more than this share of the files (in percent) disappeared on one side since the last sync. rclone’s own default is 50.')
      .addText(t => t.setPlaceholder(String(SYNC_DEFAULTS.maxDelete)).setValue(String(sync.maxDelete)).onChange(v => { if (/^\d+$/.test(v.trim())) void setSync({ maxDelete: Number(v) }); }));
    new Setting(el)
      .setName('rclone')
      .setDesc(`The program that does the syncing (rclone.org, MIT licence; Scriptorium was written for version ${RCLONE.version}). Empty: Scriptorium looks for it, and offers to download it. Or the path to an rclone of your own. This is kept for this computer only.`)
      .addText(t => t.setPlaceholder('found by itself').setValue(kit.device().rclone || '').onChange(v => { kit.setDevice({ rclone: v.trim() }); plugin.rcloneFound = null; }))
      .addButton(b => b.setButtonText('Copy diagnostic report').onClick(() => plugin.copyDriveReport()));
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
const KEEP_SEL = '.markdown-rendered :is(.mod-header, .el-h1, .el-h2, .el-h6, .scriptorium-opens) + .el-p > p,' +
                 ' .markdown-rendered :is(.mod-header, .el-h1, .el-h2, .el-h6, .scriptorium-opens) + .el-blockquote + .el-p > p';
const WORD = /[\p{L}\p{M}\p{N}'’\-‐­]/u;   // letters, digits, apostrophes, and the hyphens (and soft hyphens) inside words

function unwrapKept(p) {
  const spans = p.querySelectorAll('span.sc-keep');
  if (!spans.length) return;
  spans.forEach(s => { while (s.firstChild) s.parentNode.insertBefore(s.firstChild, s); s.remove(); });
  p.normalize();
}

/* The whole word that the characters a and b ([node, offset] in the text nodes `nodes`) are in: [start, end]. */
function wordBounds(nodes, a, b) {
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
  return [s, e];
}

function wrapWord(nodes, a, b) {
  const [s, e] = wordBounds(nodes, a, b);
  for (let m = e[0]; m >= s[0]; m--) {
    const n = nodes[m], from = m === s[0] ? s[1] : 0, to = m === e[0] ? e[1] + 1 : n.data.length;
    if (to <= from) continue;
    const mid = n.splitText(from); mid.splitText(to - from);
    const span = document.createElement('span'); span.className = 'sc-keep';
    mid.parentNode.insertBefore(span, mid); span.appendChild(mid);
  }
}

/* Where the first line of the text in `nodes` (text nodes, in order) ends inside a word: [a, b], the last
   character of the first line and the first of the second ([node, offset] each), or null if the line ends between
   two words. fs is the text's size in px. */
function firstLineSplit(nodes, fs) {
  if (!nodes.length) return null;
  const r = nodes[0].ownerDocument.createRange();
  let top0 = null, prev = null;
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    for (let i = 0; i < n.data.length; i++) {
      r.setStart(n, i); r.setEnd(n, i + 1);
      const rc = r.getClientRects()[0];
      if (rc && rc.height && rc.height < 2 * fs) {   // skips the floated initial and collapsed white space
        if (top0 === null) top0 = rc.top;
        else if (rc.top > top0 + 0.6 * fs) {         // the first character of the second line
          return prev && WORD.test(nodes[prev[0]].data[prev[1]]) && WORD.test(n.data[i]) ? [prev, [k, i]] : null;
        }
      }
      prev = [k, i];
    }
  }
  return null;
}

function keepFirstLineWords(p) {
  unwrapKept(p);
  // No drop cap, no small caps: the note's own choice first, then the vault's.
  const block = p.parentElement;
  const none = block && block.classList.contains('scriptorium-dropcap')
    ? block.classList.contains('scriptorium-dropcap-none') : document.body.classList.contains('scriptorium-initials-none');
  // Nor on centred or right-aligned text, unless the writer asked for a drop cap there.
  const aligned = block && block.classList.contains('scriptorium-align') && !block.classList.contains('scriptorium-align-dropcap');
  if (!p.isConnected || !p.matches(KEEP_SEL) || none || aligned) return;
  const nodes = [], walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) if (!n.parentElement.closest('mjx-container, .math, code')) nodes.push(n);
  const split = firstLineSplit(nodes, parseFloat(getComputedStyle(p).fontSize));
  if (split) wrapWord(nodes, split[0], split[1]);
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
/* Said of a vault that syncs with Google Drive (it has the sync's check file): what the sync needs is this plugin's
   data.json, which setting up never writes over, and Scriptorium's own folder outside every vault, which it never
   reads or writes. The same words as Scriptorium Setup's and the script's. */
const SETUP_SYNC_KEPT = 'The sync of this vault with Google Drive is kept as it is: the sign-in, the Drive folder and its settings are not touched.';

/* How a file of the package is treated: 'replace', 'missing' (written only if the vault has none), 'plugins',
   'appearance' or 'app' (merged), or null (not part of setting up a vault). rel uses forward slashes. */
function setupRule(rel) {
  if (rel === '.obsidian/community-plugins.json') return 'plugins';
  if (rel === '.obsidian/appearance.json') return 'appearance';
  if (rel === '.obsidian/app.json') return 'app';
  if (rel === '.obsidian/core-plugins.json') return 'missing';
  if (rel === '.obsidian/snippets/manuscript.css' || rel === '.obsidian/plugins/lagrange/LagrangeHand-OFL.txt') return 'replace';
  if (rel.startsWith('.obsidian/themes/Typewriter/') || rel.startsWith('.obsidian/plugins/scriptorium/dropcaps/')) return 'replace';   // the theme; the plugin's own sets of drop caps
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
  if (existing(SYNC_SENTINEL)) notes.push(SETUP_SYNC_KEPT);
  return { changes, notes };
}

/* The plan in words, one line each. */
function describeVaultSetup(plan) {
  return plan.changes.map(c => (c.note ? `  merge    ${c.rel}: ${c.note}` : `  ${c.replaces ? 'replace ' : 'add     '} ${c.rel}`))
    .concat(plan.notes.map(n => `  note     ${n}`));
}

/* Makes the plan's changes in the vault in dir: backs up .obsidian as it is, then writes; on a failure every file is
   put back and the error is thrown. Returns the backup folder, or null if there was nothing to back up or to change. */
/* The two community plugins that draw diagrams (Lagrange writes TikZ figures and Excalidraw drawings). They are not
   part of Scriptorium: when a vault is set up, each is downloaded from its own GitHub release, at a pinned version,
   and every file is checked against its SHA-256 before anything is written (the same pins as the installers').
   TikZJax is MIT-licensed; the Excalidraw plugin is AGPL-3.0.
   installDiagramPlugins(fs, path, crypto, dir, fetch) -> {id: 'installed' | 'updated' | 'kept' | 'failed'}: a plugin
   the vault has at the pinned version or a newer one is left exactly as it is, and so are its settings; only a
   plugin installed new is turned on (one the writer turned off stays off, even if its files are updated); one that
   cannot be downloaded, or does not match, is not installed, and nothing of it is written. fetch(url) resolves to
   the bytes (a Buffer or a Uint8Array). */
const DIAGRAM_PLUGINS = [
  { id: 'obsidian-tikzjax', name: 'TikZJax', version: '0.5.2', base: 'https://github.com/artisticat1/obsidian-tikzjax/releases/download/0.5.2/',
    files: { 'main.js': 'cbae1ad4362d44173e56ba512f01e65de1f7cc69a4bf4733bc5711a2de101f41', 'manifest.json': '09fbbb05aeffc32bc65365d8526fc2222ee971417dcd4afddeb989498a5e1de1', 'styles.css': 'd9a7f741ec8fdcbe5e0145152c799238cee8df5a14ddc7dc9feb3bb835ce068d' } },
  { id: 'obsidian-excalidraw-plugin', name: 'Excalidraw', version: '2.29.2', base: 'https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/download/2.29.2/',
    files: { 'main.js': '49dfc5667a7730dbc124cdfc2a4a8e89188100636493a39d6493bf5696a55541', 'manifest.json': '8e82828fd9125615e8a361d0f15553e548cac2ee7a303e55387378a53b925fd9', 'styles.css': '6c7a9914f83305d09f9957248897ff2f25cf2c2d4b46b2d9ab42f3c7ee1d29f0' } },
];
function versionKey(v) {
  return (String(v).match(/\d+/g) || []).slice(0, 4).map(Number);
}
function versionAtLeast(a, b) {
  const x = versionKey(a), y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return true;
}
/* A file of a plugin's release, through Obsidian's own request (which is not held back by CORS). */
async function fetchRelease(url) {
  const res = await requestUrl({ url, method: 'GET', throw: false });
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  return new Uint8Array(res.arrayBuffer);
}
/* The names of the diagram plugins that installDiagramPlugins would download into the vault in dir. */
function diagramPluginsWanted(fs, path, dir, plugins) {
  return (plugins || DIAGRAM_PLUGINS).filter(p => {
    const folder = path.join(dir, '.obsidian', 'plugins', p.id);
    let had = null;
    try { had = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8')).version || null; } catch (e) { had = null; }
    return !(had !== null && versionAtLeast(had, p.version) && fs.existsSync(path.join(folder, 'main.js')));
  }).map(p => p.name);
}
/* The data.json written with a plugin that is installed new, where it has none; null for most. Excalidraw opens a
   "Welcome to Excalidraw" window the first time it runs, while its previousRelease is older than the plugin, and sets
   previousRelease to its own version when that window is closed: writing that one setting keeps the window shut.
   Excalidraw fills in the rest with its defaults, and still shows release notes after a later update. */
function diagramFirstSettings(p) {
  return p.id === 'obsidian-excalidraw-plugin' ? `{\n  "previousRelease": "${p.version}"\n}\n` : null;
}
async function installDiagramPlugins(fs, path, crypto, dir, fetch, plugins) {
  const result = {};
  for (const p of plugins || DIAGRAM_PLUGINS) {
    const folder = path.join(dir, '.obsidian', 'plugins', p.id);
    let had = null;
    try { had = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8')).version || null; } catch (e) { had = null; }
    if (had !== null && versionAtLeast(had, p.version) && fs.existsSync(path.join(folder, 'main.js'))) result[p.id] = 'kept';
    else {
      try {
        const files = {};
        for (const name of Object.keys(p.files)) {
          const data = Buffer.from(await fetch(p.base + name));
          if (crypto.createHash('sha256').update(data).digest('hex') !== p.files[name]) throw new Error(`${name} does not match its pinned SHA-256`);
          files[name] = data;
        }
        fs.mkdirSync(folder, { recursive: true });
        for (const name of Object.keys(files)) {         // (settings that are there, data.json, are never touched)
          const tmp = path.join(folder, `${name}.scriptorium-tmp`);
          fs.writeFileSync(tmp, files[name]);
          fs.renameSync(tmp, path.join(folder, name));
        }
        result[p.id] = had !== null ? 'updated' : 'installed';
        const settings = had === null ? diagramFirstSettings(p) : null;
        if (settings && !fs.existsSync(path.join(folder, 'data.json'))) fs.writeFileSync(path.join(folder, 'data.json'), settings);
      } catch (e) {
        result[p.id] = 'failed';
        continue;
      }
    }
    // Only a plugin installed new is turned on: one that was there and is not in the list was turned off by the writer.
    if (result[p.id] !== 'installed') continue;
    const listing = path.join(dir, '.obsidian', 'community-plugins.json');
    // (a list that is there but is not a JSON list is left as it is: the plugin is installed, and is turned on in Settings)
    let on = [];
    if (fs.existsSync(listing)) {
      try { on = JSON.parse(fs.readFileSync(listing, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { on = null; }
      if (!Array.isArray(on)) continue;
    }
    if (!on.includes(p.id)) {
      on.push(p.id);
      fs.mkdirSync(path.dirname(listing), { recursive: true });
      fs.writeFileSync(listing, JSON.stringify(on, null, 2) + '\n');
    }
  }
  return result;
}
/* What a set-up says about the diagram plugins, from installDiagramPlugins's result; '' if there is nothing to say. */
function diagramPluginsNote(result) {
  const name = id => (DIAGRAM_PLUGINS.find(p => p.id === id) || { name: id }).name;
  const got = Object.keys(result).filter(id => result[id] === 'installed' || result[id] === 'updated').map(name);
  const failed = Object.keys(result).filter(id => result[id] === 'failed').map(name);
  return [got.length ? `${got.join(' and ')} ${got.length === 1 ? 'was' : 'were'} added for diagrams.` : '',
    failed.length ? `${failed.join(' and ')} could not be downloaded: to add ${failed.length === 1 ? 'it' : 'them'}, open the vault and use Settings → Community plugins → Browse.` : ''].filter(Boolean).join(' ');
}

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
    // A vault that is kept in Google Drive is brought down, set up and linked in one go by the sync's own window.
    buttons.createEl('button', { text: 'Retrieve one from Google Drive…' }).addEventListener('click', () => { this.close(); new SyncModal(this.plugin, 'retrieve').open(); });
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
      // (a vault that was set up while the diagram plugins could not be downloaded can still be given them)
      const wanted = diagramPluginsWanted(this.fs, this.path, this.target);
      const row = buttons();
      if (wanted.length) {
        const diagrams = el.createEl('p', { cls: 'scriptorium-setup-note', text: `${wanted.join(' and ')}, for diagrams, ${wanted.length === 1 ? 'is' : 'are'} not in this vault: ${wanted.length === 1 ? 'it' : 'they'} can be downloaded from ${wanted.length === 1 ? 'its' : 'their'} own release${wanted.length === 1 ? '' : 's'} on GitHub.` });
        el.insertBefore(diagrams, row);
        const add = row.createEl('button', { text: `Add ${wanted.join(' and ')}` });
        add.addEventListener('click', () => {
          add.disabled = true;
          diagrams.setText(`Adding ${wanted.join(' and ')}…`);
          installDiagramPlugins(this.fs, this.path, require('crypto'), this.target, fetchRelease).then(
            r => diagrams.setText(diagramPluginsNote(r) || 'TikZJax and Excalidraw are already in the vault.'),
            () => diagrams.setText('The plugins could not be added; use Settings → Community plugins → Browse in the vault.'));
        });
      }
      row.createEl('button', { cls: 'mod-cta', text: 'Close' }).addEventListener('click', () => this.close());
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
      // the diagram plugins come from their own releases, a moment later
      const diagrams = el.createEl('p', { cls: 'scriptorium-setup-note', text: 'Adding the TikZJax and Excalidraw plugins for diagrams…' });
      installDiagramPlugins(this.fs, this.path, require('crypto'), this.target, fetchRelease).then(
        r => diagrams.setText(diagramPluginsNote(r) || 'TikZJax and Excalidraw are already in the vault.'),
        () => diagrams.setText('The TikZJax and Excalidraw plugins could not be added; use Settings → Community plugins → Browse in the vault.'));
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
   Syncing with Google Drive, through rclone (new)
   ==========================================================
   "Scriptorium: Sync this vault with Google Drive", "Sync now with Google Drive" and "Retrieve a vault from Google
   Drive" keep a vault and a folder of the writer's own Google Drive the same, in both directions, by running rclone
   (https://rclone.org, MIT licence): the writer signs in to Google in the browser, picks the Drive folder by hand,
   and the two are then synced on a timer with `rclone bisync`. How it works:
     - rclone is found on the computer (a path in the settings, PATH, the usual places) or, when the writer agrees,
       downloaded: one pinned version from downloads.rclone.org (or its GitHub release), checked against the SHA-256
       that rclone published for it and that is written below, and unpacked into Scriptorium's own folder outside
       every vault. A file whose hash differs is deleted, never run.
     - The sign-in is rclone's own: `rclone config update scriptorium-drive scope=drive` opens Google's page in the
       browser and listens on 127.0.0.1:53682 for the answer. The token is kept by rclone in a config file that
       belongs to Scriptorium alone (rclone.conf in that same folder, readable only by the writer; `--config` is on
       every call, so the writer's own rclone configuration is never read or changed). No token is ever in a vault,
       in this plugin's data or in a report.
     - The Drive folder is chosen in a small browser over `rclone lsjson --dirs-only`, and remembered for this vault
       in that folder too (sync-vaults.json), not in the vault: another computer makes its own choice.
     - The first sync is a `bisync --resync` after a page that says what is on each side. A file that differs on the
       two sides is kept twice by default. After that every run is a plain `bisync` with the guards below.
     - Guards: one run at a time (a lock file); a check file (.scriptorium-sync) that must be on both sides, so that
       a Drive folder that was emptied, moved or cannot be reached, or a vault whose disk is not there, stops the run
       instead of deleting the other side (rclone also refuses an empty side by itself); a limit on how much one run
       may delete (--max-delete, half the files unless changed); a file changed on both sides keeps both (the older
       one is renamed "name.conflict1.md"); whatever a run deletes or replaces on this computer is moved to a folder
       of Scriptorium's own for thirty days instead; Drive's own trash keeps what is deleted there; a run that is
       cut off is picked up by the next one (--resilient --recover).
   Not synced: Obsidian's workspace, caches and .trash, hidden folders, Lagrange's settings (they hold API keys),
   Google's own documents (Docs, Sheets), and what the older Drive backup left behind. The functions below take fs,
   path, spawn and the like as arguments and are tested under Node (plugins-tests/rclone-sync.test.js with a pretend
   rclone, rclone-real.test.js with the real one and a second folder standing in for Drive).
   NOT YET VERIFIED: the sign-in with the real Google. It follows rclone's documentation for the pinned version and
   is tested up to the moment the browser opens. */

const RCLONE = {
  version: '1.76.0',
  min: [1, 66, 0],            // bisync's --conflict-resolve, --recover and --max-lock came with 1.66
  remote: 'scriptorium-drive',
  port: 53682,                // rclone's sign-in listener: http://127.0.0.1:53682/
  licence: 'MIT',
  sources: ['https://downloads.rclone.org/v{v}/{f}', 'https://github.com/rclone/rclone/releases/download/v{v}/{f}'],
  hosts: ['downloads.rclone.org', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'],
  /* The official builds of that version: name on rclone's server, size, and the SHA-256 from its SHA256SUMS. */
  assets: {
    'win32-x64': ['windows-amd64', 32193987, '8b4fd2737ade4e70c057ef4a49deb7cffe94b0fb9d7587c189d149823f21a1dc'],
    'win32-arm64': ['windows-arm64', 29049527, 'c406c8a69a5a408e50624aa990fbb0a6266b3a4e83782a94de3cb96f50f86f10'],
    'win32-ia32': ['windows-386', 30225774, 'b9c8d062ff61e2addfc31c1981219d90f99e0012cba45b649f728082ad810d5c'],
    'darwin-x64': ['osx-amd64', 35749026, '4f5835733d52b818340f97b1fc0348a70461534d123363a183ca2b660219595a'],
    'darwin-arm64': ['osx-arm64', 33189281, 'e72dc90b70f4947a7b72b61bde4a4fbba5777b2874fb448951ffdde67ebd0ab7'],
    'linux-x64': ['linux-amd64', 32194302, 'b00f00b3266c3764413afe599d3ec316f6f43b3e0ea8a0bc1d186d2133e46df7'],
    'linux-arm64': ['linux-arm64', 29231141, 'ee169016675e23a69d77240565133ff7dbc9b33d16fa8f7053d4af39f1eaeb78'],
    'linux-arm': ['linux-arm-v7', 30389321, '090e1e2ce0f2a27c6c5ad5b2a2f7bbf7570933f3523e8bf83cb25ee50115f885'],
    'linux-ia32': ['linux-386', 30575312, 'ac5a696aff30c2806475d7c9ae6bbb4eeda47067e5add32448bf33db54552a09'],
  },
};
const SYNC_SENTINEL = '.scriptorium-sync';
const SYNC_SENTINEL_TEXT = 'Scriptorium keeps this file on both sides of the sync with Google Drive, to be sure that both sides are really there before it changes anything. Leave it where it is.\n';
const SYNC_DEFAULTS = { auto: true, minutes: 5, obsidian: true, maxDelete: 50, keepDays: 30 };
const SYNC_TIMES = { onStart: 8000, onChange: 45000, again: 5000, quit: 15000, signIn: 10 * 60 * 1000, call: 2 * 60 * 1000, lockStale: 6 * 60 * 60 * 1000 };
const SYNC_CONFLICT = /\.conflict\d+(?:\.[^./\\]+)?$/;
const SYNC_MOBILE = 'Syncing with Google Drive works only in Obsidian on a computer: it runs a program (rclone) beside Obsidian, which a phone or tablet does not allow. ' +
  'Open this vault on a computer to sync it or to retrieve one. On a phone, the Google Drive app can still show the files.';
const SYNC_PRIVACY = 'Your files go from this computer straight to your own Google Drive, carried by rclone. No server of ours and no model is involved. ' +
  'rclone is given access to your Drive (Google calls the permission “See, edit, create, and delete all of your Google Drive files”), which is what lets you pick any folder; ' +
  'Scriptorium only ever points it at the folder you choose. The sign-in is kept on this computer, outside every vault, and the copy in Drive is as private as your Google account: it is not encrypted by Scriptorium.';
/* What the writer is told about the Google app that asks for the permission. rclone's own (shared) client ID is
   being retired by rclone during 2026 (its documentation for 1.76 says so), so a sign-in with it may be refused. */
const SYNC_SHARED_CLIENT = 'rclone’s own sign-in with Google is shared by everyone who uses rclone, and rclone’s authors are retiring it during 2026. ' +
  'If Google refuses it (a page that says “Access blocked”, “deleted_client” or “This app is blocked”), use a client ID of your own instead: it takes about ten minutes, once.';
/* How to make a Google client ID for rclone: [text, link]. From rclone's documentation ("Making your own client_id"). */
const SYNC_CLIENT_STEPS = [
  ['Make a Google Cloud project: open the page below, sign in with any Google account (it need not be the one you sync with), name it (say “Scriptorium sync”) and click Create.', 'https://console.cloud.google.com/projectcreate'],
  ['Turn on the Drive API for it: Menu → APIs & Services → Library → Google Drive API → Enable.', 'https://console.cloud.google.com/apis/library/drive.googleapis.com'],
  ['Menu → Google Auth Platform → Get started. App name: rclone (or any name). Support email: yours. Audience: External. Contact: your email. Agree, then Create.', 'https://console.cloud.google.com/auth/overview'],
  ['Data Access → Add or remove scopes → tick the one ending in /auth/drive (not drive.file) → Update → Save.', 'https://console.cloud.google.com/auth/scopes'],
  ['Audience → Publish app → Confirm. (Left in “Testing”, Google signs you out after seven days, and only the accounts you list under Test users may sign in.)', 'https://console.cloud.google.com/auth/audience'],
  ['Clients → Create client → Application type: Desktop app → Create. Copy the client ID and the client secret now (Google shows the secret only once), or download the JSON.', 'https://console.cloud.google.com/auth/clients'],
  ['Paste them below. When you sign in, Google may say that it has not verified this app: it is your own, so choose Advanced → Go to (the name you gave it).', ''],
];

function syncSettings(saved) {
  const d = saved && saved.sync && typeof saved.sync === 'object' ? saved.sync : {};
  const num = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt; };
  return {
    auto: d.auto !== false,
    minutes: num(d.minutes, 1, 720, SYNC_DEFAULTS.minutes),
    obsidian: d.obsidian !== false,
    maxDelete: num(d.maxDelete, 1, 100, SYNC_DEFAULTS.maxDelete),
    keepDays: num(d.keepDays, 1, 365, SYNC_DEFAULTS.keepDays),
  };
}

function driveBytes(n) {
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)} kB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
  return `${(n / 1e9).toFixed(n < 1e10 ? 1 : 0)} GB`;
}

function driveCount(n, one, many) {
  return `${n} ${n === 1 ? one : (many || `${one}s`)}`;
}

/* ---------- Where things live on this computer ---------- */

/* Scriptorium's own folder for this user, outside every vault: rclone (if downloaded), its config with the sign-in,
   which Drive folder goes with which vault, and what a sync replaced. `path` is Node's path for the platform. */
function syncUserDir(path, env, platform, home) {
  env = env || {};
  if (env.SCRIPTORIUM_USER_DIR && path.isAbsolute(env.SCRIPTORIUM_USER_DIR)) return path.normalize(env.SCRIPTORIUM_USER_DIR);
  if (platform === 'win32') return path.join(env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : path.join(home, 'AppData', 'Local'), 'Scriptorium');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Scriptorium');
  return path.join(env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share'), 'scriptorium');
}

function syncPaths(path, dir, platform) {
  return {
    dir,
    conf: path.join(dir, 'rclone.conf'),
    exe: path.join(dir, 'rclone', `v${RCLONE.version}`, platform === 'win32' ? 'rclone.exe' : 'rclone'),
    vaults: path.join(dir, 'sync-vaults.json'),
    device: path.join(dir, 'sync-device.json'),
    work: path.join(dir, 'bisync'),
    kept: path.join(dir, 'replaced'),
    filters: path.join(dir, 'filters'),
    locks: path.join(dir, 'locks'),
  };
}

/* A short name for a vault's folder, the same every time on this computer. Windows and macOS do not tell
   capitals apart in a path. */
function syncVaultId(crypto, path, dir, platform) {
  let d = path.resolve(dir).replace(/[\\/]+$/, '');
  if (platform === 'win32' || platform === 'darwin') d = d.toLowerCase();
  return crypto.createHash('sha256').update(d).digest('hex').slice(0, 16);
}

/* JSON kept in Scriptorium's folder: read without throwing, written whole and in place of the old one. */
function syncReadJson(fs, file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; }
}
function syncWriteJson(fs, path, file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/* Which Drive folder goes with a vault: {root: 'my' | 'shared' | 'drive', driveId, driveName, path, linked, first,
   last, filters}, or null. */
function syncLink(fs, file, id) {
  const l = syncReadJson(fs, file)[id];
  return l && typeof l === 'object' && typeof l.path === 'string' && l.path ? l : null;
}
function syncSaveLink(fs, path, file, id, link) {
  const all = syncReadJson(fs, file);
  if (link) all[id] = link; else delete all[id];
  syncWriteJson(fs, path, file, all);
}

/* ---------- Finding rclone ---------- */

function rcloneAsset(platform, arch) {
  const a = RCLONE.assets[`${platform}-${arch}`];
  if (!a) return null;
  const file = `rclone-v${RCLONE.version}-${a[0]}.zip`;
  return { file, bytes: a[1], sha256: a[2], exe: platform === 'win32' ? 'rclone.exe' : 'rclone', urls: RCLONE.sources.map(s => s.replace('{v}', RCLONE.version).replace('{f}', file)) };
}

/* Where rclone may be, most wanted first: [{file, kind}], kind 'custom' (the path in the settings), 'downloaded'
   (Scriptorium's own copy), 'path' or 'usual'. A program started from the Dock or the Start menu is not given the
   PATH of a terminal, so the usual places are looked in as well. */
function rcloneCandidates(o) {
  const { path, platform, home } = o, env = o.env || {};
  const name = platform === 'win32' ? 'rclone.exe' : 'rclone';
  const out = [], seen = new Set();
  const add = (file, kind) => { if (file && !seen.has(file)) { seen.add(file); out.push({ file, kind }); } };
  if (o.custom) {
    let c = String(o.custom).trim().replace(/^"(.*)"$/, '$1');
    if (c.startsWith('~') && home) c = path.join(home, c.slice(1));
    add(c, 'custom');
    if (platform === 'win32' && !/\.exe$/i.test(c)) add(`${c}.exe`, 'custom');
    add(path.join(c, name), 'custom');   // a folder was given
    return out;
  }
  if (o.exe) add(o.exe, 'downloaded');
  const list = String(env.PATH || env.Path || env.path || '').split(platform === 'win32' ? ';' : ':');
  for (const d of list) { const dir = d.trim().replace(/^"(.*)"$/, '$1'); if (dir && path.isAbsolute(dir)) add(path.join(dir, name), 'path'); }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || (home && path.join(home, 'AppData', 'Local'));
    for (const d of [
      env.ProgramFiles && path.join(env.ProgramFiles, 'rclone'), env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'rclone'),
      local && path.join(local, 'Microsoft', 'WinGet', 'Links'), local && path.join(local, 'Programs', 'rclone'),
      home && path.join(home, 'scoop', 'shims'), env.ProgramData && path.join(env.ProgramData, 'chocolatey', 'bin'),
    ]) if (d) add(path.join(d, name), 'usual');
  } else {
    for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin', '/bin', '/snap/bin', home && path.join(home, '.local', 'bin'), home && path.join(home, 'bin')]) {
      if (d) add(path.join(d, name), 'usual');
    }
  }
  return out;
}

/* The first of them that is a program: {file, kind}, or null. */
function findRclone(fs, list, platform) {
  for (const c of list) {
    try {
      if (!fs.statSync(c.file).isFile()) continue;
      if (platform !== 'win32') fs.accessSync(c.file, fs.constants.X_OK);
      return c;
    } catch (e) { /* not there, or not a program */ }
  }
  return null;
}

/* [1, 76, 0] from what `rclone version` prints, or null. */
function rcloneVersion(text) {
  const m = /rclone v(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}
function rcloneOldEnough(v) {
  if (!v) return false;
  for (let i = 0; i < 3; i++) { if (v[i] !== RCLONE.min[i]) return v[i] > RCLONE.min[i]; }
  return true;
}

/* ---------- Downloading rclone ---------- */

/* Where in a zip file the entry called `want` (in any folder) is: {offset, packed, size, method}. `read(pos, len)`
   gives bytes of the file; `total` is its length. Throws if the zip is not one, or has no such entry. */
function zipEntry(read, total, want) {
  const tailLen = Math.min(total, 66000), tail = read(total - tailLen, tailLen);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { at = i; break; }
  if (at < 0) throw new Error('not a zip file');
  const count = tail.readUInt16LE(at + 10), size = tail.readUInt32LE(at + 12), start = tail.readUInt32LE(at + 16);
  if (start === 0xffffffff || start + size > total) throw new Error('a zip file of a kind that is not read here');
  const dir = read(start, size);
  for (let p = 0, n = 0; n < count && p + 46 <= dir.length; n++) {
    if (dir.readUInt32LE(p) !== 0x02014b50) throw new Error('a damaged zip file');
    const method = dir.readUInt16LE(p + 10), packed = dir.readUInt32LE(p + 20), full = dir.readUInt32LE(p + 24);
    const nameLen = dir.readUInt16LE(p + 28), extraLen = dir.readUInt16LE(p + 30), noteLen = dir.readUInt16LE(p + 32), local = dir.readUInt32LE(p + 42);
    const name = dir.toString('utf8', p + 46, p + 46 + nameLen);
    if (name.split('/').pop() === want && !name.endsWith('/')) {
      const head = read(local, 30);
      if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('a damaged zip file');
      if (method !== 0 && method !== 8) throw new Error('a zip file packed in a way that is not read here');
      return { offset: local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28), packed, size: full, method };
    }
    p += 46 + nameLen + extraLen + noteLen;
  }
  throw new Error(`there is no ${want} in the zip file`);
}

/* Fetches a URL into a file with https, following redirects to rclone's and GitHub's servers only.
   Resolves {bytes, sha256}. */
function syncFetch(o, url, file, hops) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(new Error('a bad address')); return; }
    if (u.protocol !== 'https:' || !RCLONE.hosts.includes(u.hostname)) { reject(new Error(`a redirect to ${u.hostname}, which is not one of rclone’s servers`)); return; }
    const req = o.https.get(u, { headers: { 'User-Agent': 'Scriptorium', Accept: 'application/octet-stream' } }, res => {
      const s = res.statusCode;
      if (s >= 300 && s < 400 && res.headers.location) {
        res.resume();
        if ((hops || 0) >= 5) { reject(new Error('too many redirects')); return; }
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch (e) { reject(new Error('a bad redirect')); return; }
        syncFetch(o, next, file, (hops || 0) + 1).then(resolve, reject);
        return;
      }
      if (s !== 200) { res.resume(); reject(new Error(`the server answered ${s}`)); return; }
      const hash = o.crypto.createHash('sha256'), out = o.fs.createWriteStream(file, { mode: 0o600 });
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length; hash.update(chunk);
        if (bytes > o.asset.bytes + 1024) { req.destroy(new Error('the download is larger than the file it should be')); return; }
        if (o.onProgress) o.onProgress(bytes, o.asset.bytes);
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve({ bytes, sha256: hash.digest('hex') }));
      res.pipe(out);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('the server stopped answering')));
    if (o.signal) {
      if (o.signal.aborted) req.destroy(new Error('stopped'));
      else o.signal.addEventListener('abort', () => req.destroy(new Error('stopped')), { once: true });
    }
  });
}

/* Downloads the pinned rclone for this computer, checks it, and unpacks the program to o.exe.
   o: {fs, path, crypto, zlib, https, asset, exe, onProgress, signal, fetch (tests)}. Throws a problem (syncProblem)
   in plain words; a file that fails the check is deleted and nothing is unpacked from it. */
async function rcloneInstall(o) {
  const { fs, path } = o, dir = path.dirname(o.exe);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    throw syncProblem('disk', `Scriptorium could not make its folder ${dir}.`, `The system said: ${e.code || e.message}.`, 'Check that your home folder can be written to, then try again.');
  }
  const zip = path.join(dir, `${o.asset.file}.download`);
  const fetch = o.fetch || syncFetch;
  let got = null, why = '';
  for (const url of o.asset.urls) {
    try { got = await fetch(o, url, zip); break; } catch (e) {
      why = (e && e.message) || String(e);
      try { fs.rmSync(zip, { force: true }); } catch (x) { /* nothing was written */ }
      if (o.signal && o.signal.aborted) throw syncProblem('stopped', 'The download was stopped.', '', 'Run it again when you like: nothing was installed.');
    }
  }
  if (!got) {
    throw syncProblem('network', 'rclone could not be downloaded.', `Neither rclone’s server nor GitHub could be reached from this computer (${why}).`,
      'Check the internet connection and try again. Or install rclone yourself from rclone.org/downloads and give its path in Settings → Scriptorium.');
  }
  if (got.sha256 !== o.asset.sha256 || got.bytes !== o.asset.bytes) {
    try { fs.rmSync(zip, { force: true }); } catch (x) { /* it is not used either way */ }
    throw syncProblem('checksum', 'The downloaded file is not the rclone that Scriptorium expects, so it was deleted and not run.',
      'Its SHA-256 or size differs from what rclone published for this version. The download may have been cut short, or changed on the way by a proxy or filter.',
      'Try again on another network. Or install rclone yourself from rclone.org/downloads and give its path in Settings → Scriptorium.');
  }
  const tmp = `${o.exe}.unpacking`;
  try {
    const fd = fs.openSync(zip, 'r');
    let entry;
    try {
      const read = (pos, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b; };
      entry = zipEntry(read, got.bytes, o.asset.exe);
    } finally { fs.closeSync(fd); }
    await new Promise((resolve, reject) => {
      const src = fs.createReadStream(zip, { start: entry.offset, end: entry.offset + entry.packed - 1 });
      const out = fs.createWriteStream(tmp, { mode: 0o755 });
      const mid = entry.method === 8 ? o.zlib.createInflateRaw() : null;
      for (const s of [src, mid, out]) if (s) s.on('error', reject);
      out.on('finish', resolve);
      (mid ? src.pipe(mid) : src).pipe(out);
    });
    if (fs.statSync(tmp).size !== entry.size) throw new Error('the unpacked program has the wrong size');
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, o.exe);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (x) { /* nothing to remove */ }
    throw syncProblem('disk', 'rclone was downloaded and checked, but could not be unpacked.', `The system said: ${(e && (e.code || e.message)) || e}.`,
      `Check that there is room on the disk (about 100 MB) and that ${dir} can be written to, then try again.`);
  } finally {
    try { fs.rmSync(zip, { force: true }); } catch (x) { /* the next download writes over it */ }
  }
  return o.exe;
}

/* ---------- Running rclone ---------- */

/* A failure in plain words: what happened, the likely cause, what to do next. kind names it for the buttons
   ('rclone', 'connect', 'client', 'network', 'busy', 'deletes', 'check', 'empty', 'resync', 'folder', 'quota',
   'rate', 'disk', 'stopped', 'unknown'); tail is rclone's own last lines, shown only on request. */
function syncProblem(kind, message, cause, next, tail) {
  const e = new Error(message);
  e.kind = kind; e.cause2 = cause || ''; e.next = next || ''; e.tail = tail || [];
  return e;
}

/* The environment rclone is run with: the writer's, without any RCLONE_ setting (one of those could point rclone at
   another config or change what a command does). */
function rcloneEnv(env) {
  const out = {};
  for (const k of Object.keys(env || {})) if (!/^RCLONE_/i.test(k)) out[k] = env[k];
  return out;
}

/* One line of rclone's log (--use-json-log): {level, msg, object, stats}. A line that is not JSON is kept as text. */
function syncLogLine(line) {
  const t = String(line || '').trim();
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      if (j && typeof j === 'object' && 'msg' in j) return { level: String(j.level || 'info'), msg: String(j.msg || '').trim(), object: j.object === undefined ? '' : String(j.object), stats: j.stats || null };
    } catch (e) { /* text after all */ }
  }
  return { level: 'text', msg: t, object: '', stats: null };
}

/* Runs rclone without a shell. o: {spawn, exe, args, env, onLine(parsed), signal, timeout}. Resolves, never
   rejects: {code, out (what it printed), lines (the last of its log, parsed), failed (it could not be started:
   the system's error), stopped, timedOut}. A stop or a timeout ends rclone at once. That is on purpose: in tests
   with the real rclone a sync cut off like this was picked up by the next run every time (--recover), while an
   interrupt, which makes bisync wind down by itself, left it needing a new first sync about one time in four. */
function rcloneExec(o) {
  return new Promise(resolve => {
    let child, done = false, out = '', rest = '', timer = null, stopped = false, timedOut = false;
    const lines = [];
    const finish = r => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (o.signal) o.signal.removeEventListener('abort', stop);
      if (rest.trim()) take(rest);
      resolve(Object.assign({ code: null, out, lines, failed: null, stopped, timedOut }, r));
    };
    const take = line => {
      if (!line.trim()) return;
      const l = syncLogLine(line);
      lines.push(l);
      if (lines.length > 400) lines.splice(0, lines.length - 300);
      if (o.onLine) { try { o.onLine(l); } catch (e) { /* a listener's trouble is not rclone's */ } }
    };
    const end = () => {
      if (!child || done) return;
      try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
    };
    function stop() { stopped = true; end(); }
    try {
      child = o.spawn(o.exe, o.args, { env: rcloneEnv(o.env), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { finish({ failed: e }); return; }
    child.on('error', e => finish({ failed: e }));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { if (out.length < 64 * 1024 * 1024) out += d; });
    child.stderr.on('data', d => {
      rest += d;
      let i;
      while ((i = rest.indexOf('\n')) >= 0) { take(rest.slice(0, i)); rest = rest.slice(i + 1); }
    });
    child.on('close', (code, sig) => finish({ code: code === null ? (sig ? -1 : null) : code }));
    if (o.timeout) timer = setTimeout(() => { timedOut = true; end(); }, o.timeout);
    if (o.signal) { if (o.signal.aborted) stop(); else o.signal.addEventListener('abort', stop); }
  });
}

/* ---------- Scriptorium's own rclone config ---------- */

/* The config file is rclone's INI: [name] and "key = value" lines. Only what is needed is read. */
function syncConfRead(fs, file) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return out; }
  let at = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { at = out[sec[1]] = {}; continue; }
    const kv = /^([^=;#\s][^=]*?)\s*=\s*(.*)$/.exec(line);
    if (at && kv) at[kv[1]] = kv[2];
  }
  return out;
}

/* Whether the sign-in is there: the remote exists and, for Google Drive, has a token. {connected, own (a client ID
   of the writer's), client, type}. No token is returned. */
function syncConnection(fs, file) {
  const r = syncConfRead(fs, file)[RCLONE.remote];
  if (!r) return { connected: false, own: false, client: '', type: '' };
  return { connected: r.type !== 'drive' || Boolean(r.token && r.token.includes('{')), own: Boolean(r.client_id), client: r.client_id || '', type: r.type || '' };
}

/* Writes the remote into the config, without a token: rclone adds that when the writer has signed in. Every other
   section of the file is kept. The file can be read by the writer alone. */
function syncConfPrepare(fs, path, file, client) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { /* a new file */ }
  const keep = [];
  let skip = false;
  for (const line of text.split(/\r?\n/)) {
    const sec = /^\s*\[(.+)\]\s*$/.exec(line);
    if (sec) skip = sec[1] === RCLONE.remote;
    if (!skip) keep.push(line);
  }
  while (keep.length && !keep[keep.length - 1].trim()) keep.pop();
  const clean = v => String(v || '').replace(/[\r\n]/g, '').trim();
  const mine = [`[${RCLONE.remote}]`, 'type = drive', 'scope = drive'];
  if (client && client.id) mine.push(`client_id = ${clean(client.id)}`, `client_secret = ${clean(client.secret)}`);
  const all = (keep.length ? keep.join('\n') + '\n\n' : '') + mine.join('\n') + '\n';
  fs.writeFileSync(file, all, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (e) { /* Windows keeps its own permissions: the folder is the user's */ }
}

/* A client ID and secret from what was pasted: the ID alone, or the whole JSON file Google offers for download
   ({"installed": {"client_id": ..., "client_secret": ...}}). {id, secret, problem}. */
function syncParseClient(text, secret) {
  let id = String(text || '').trim();
  secret = String(secret || '').trim();
  if (id.startsWith('{')) {
    try {
      const j = JSON.parse(id), c = j.installed || j.web || j;
      if (j.web && !j.installed) return { id: '', secret: '', problem: 'That file is for an OAuth client of type “Web application”. Make one of type “Desktop app”: only that kind may sign in from a program on a computer.' };
      id = String(c.client_id || '').trim();
      secret = String(c.client_secret || secret).trim();
    } catch (e) {
      return { id: '', secret: '', problem: 'That is not a client ID, and not the JSON file Google gives for one.' };
    }
  }
  if (!id) return { id: '', secret: '', problem: 'Paste the client ID (or the JSON file Google offers for download).' };
  if (!/^[0-9]+-[0-9a-z_]+\.apps\.googleusercontent\.com$/i.test(id)) {
    return { id: '', secret: '', problem: 'A Google client ID looks like 1234567890-abc…xyz.apps.googleusercontent.com. Copy it from Google Auth Platform → Clients.' };
  }
  if (!secret) return { id: '', secret: '', problem: 'Paste the client secret too (it starts with GOCSPX-). Google shows it once, when the client is made; if it is lost, add a new secret to the client.' };
  if (/[\s"']/.test(secret)) return { id: '', secret: '', problem: 'The client secret has a space or a quotation mark in it: copy it again.' };
  return { id, secret, problem: '' };
}

/* ---------- What is synced ---------- */

/* rclone's filter rules for a vault; the first rule that matches a file decides. Every computer that syncs the
   same Drive folder must use the same rules, so they depend only on settings that are synced themselves. */
function syncFilters(s) {
  const lines = [
    '# Written by Scriptorium. Changes made here are written over.',
    '# Litter of the system and of programs',
    '- .DS_Store', '- Thumbs.db', '- desktop.ini', '- *.scriptorium-tmp', '- *.partial', '- .~lock.*', '- ~$*',
    '# What the older Google Drive backup of Scriptorium left behind',
    '- /scriptorium-manifest.json', '- /_trash/**', '- scriptorium-google-drive.json',
    '# Obsidian’s bin, and the copies that setting up a vault keeps',
    '- /.trash/**', '- scriptorium-backup-*/**',
  ];
  if (s && s.obsidian === false) lines.push('# Obsidian’s settings are not synced (Settings → Scriptorium)', '- /.obsidian/**');
  else {
    lines.push(
      '# Obsidian’s settings, plugins, themes and snippets are synced, but not the layout of its windows, caches,',
      '# or Lagrange’s settings, which hold API keys',
      '- /.obsidian/workspace*', '- /.obsidian/cache/**', '- /.obsidian/plugins/lagrange/data.json', '- /.obsidian/plugins/*/node_modules/**',
      '- /.obsidian/plugins/scriptorium/drive-sync.json', '- /.obsidian/plugins/scriptorium/drive-uploads.json',
      '+ /.obsidian/**');
  }
  lines.push('# Other hidden folders (.git and the like)', '- .*/**', '- node_modules/**');
  return lines.join('\n') + '\n';
}

/* The Drive folder as rclone is told it: {fs: 'scriptorium-drive:Folder/Sub', flags}. */
function syncTarget(link) {
  const flags = link.root === 'shared' ? ['--drive-shared-with-me'] : link.root === 'drive' && link.driveId ? ['--drive-team-drive', String(link.driveId)] : [];
  return { fs: `${RCLONE.remote}:${String(link.path || '').replace(/^\/+|\/+$/g, '')}`, flags };
}

/* Where the folder is, in words: "My Drive › Notes › Vault". */
function syncWhere(link) {
  const root = link.root === 'shared' ? 'Shared with me' : link.root === 'drive' ? (link.driveName || 'Shared drive') : 'My Drive';
  return [root].concat(String(link.path || '').split('/').filter(Boolean)).join(' › ');
}

/* Why a name cannot be a new Drive folder, or ''. */
function syncFolderName(name) {
  const n = String(name || '').trim();
  if (!n) return 'Give the folder a name.';
  if (/[\\/]/.test(n)) return 'A folder’s name cannot have / or \\ in it.';
  if (n === '.' || n === '..' || /[\u0000-\u001f]/.test(n)) return 'That name cannot be used.';
  if (n.length > 200) return 'That name is too long.';
  return '';
}

/* The folders in rclone's `lsjson` answer: [{name, id}] in the order a reader expects. */
function syncParseDirs(text) {
  let j;
  try { j = JSON.parse(String(text || '').trim() || '[]'); } catch (e) { return null; }
  if (!Array.isArray(j)) return null;
  return j.filter(x => x && x.IsDir && typeof x.Name === 'string' && x.Name)
    .map(x => ({ name: x.Name, id: x.ID || '' }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/* What `rclone check --combined -` says about the two sides, file by file: "= same", "+ only on this computer",
   "- only in Drive", "* differs", "! could not be compared". */
function syncParseCheck(text) {
  const r = { same: [], local: [], drive: [], differ: [], unread: [] };
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([=+\-*!]) (.+)$/.exec(line);
    if (!m || m[2] === SYNC_SENTINEL) continue;
    r[{ '=': 'same', '+': 'local', '-': 'drive', '*': 'differ', '!': 'unread' }[m[1]]].push(m[2]);
  }
  return r;
}

/* A name for the copy that is kept beside a file: "a/note.md" -> "a/note.conflict1.md", the first number not in
   `taken` (a Set of paths, added to). The same shape as the names rclone gives. */
function syncConflictName(rel, taken) {
  const slash = rel.lastIndexOf('/'), dir = rel.slice(0, slash + 1), name = rel.slice(slash + 1);
  const dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; ; n++) {
    const c = `${dir}${stem}.conflict${n}${ext}`;
    if (!taken.has(c)) { taken.add(c); return c; }
  }
}

/* The arguments of the sync itself. o: {local, link, paths (syncPaths), id, settings, resync, mode ('newer',
   'path1', 'path2'), force, stamp (a date for the folder of replaced files), dryRun}. */
function syncBisyncArgs(o) {
  const t = syncTarget(o.link), path = o.path;
  const a = ['bisync', o.local, t.fs].concat(t.flags, [
    '--workdir', path.join(o.paths.work, o.id),
    '--filters-file', path.join(o.paths.filters, `${o.id}.txt`),
    '--check-access', '--check-filename', SYNC_SENTINEL,
    '--resilient', '--recover', '--max-lock', '2m',
    '--conflict-resolve', 'newer', '--conflict-loser', 'num', '--conflict-suffix', 'conflict', '--suffix-keep-extension',
    '--max-delete', String(o.settings.maxDelete),
    '--backup-dir1', path.join(o.paths.kept, o.id, o.stamp),
    '--create-empty-src-dirs', '--drive-skip-gdocs', '--skip-links',
    '--stats', '2s', '-v',
  ]);
  if (o.resync) a.push('--resync', '--resync-mode', o.mode || 'newer');
  if (o.force) a.push('--force');
  if (o.dryRun) a.push('--dry-run');
  return a;
}

/* What a run did, from its log: {copied, replaced, deleted, conflicts: [names], ok}. */
function syncSummary(lines) {
  const s = { copied: 0, replaced: 0, deleted: 0, conflicts: [], ok: false, nothing: false };
  for (const l of lines || []) {
    if (/^Copied \(replaced existing\)/.test(l.msg)) s.replaced++;
    else if (/^Copied \(/.test(l.msg)) s.copied++;   // "new", or a copy the storage made by itself
    else if (l.msg === 'Deleted') s.deleted++;
    else if (/Bisync successful/.test(l.msg)) s.ok = true;
    else if (/No changes found/.test(l.msg)) s.nothing = true;
    const c = /New or changed in both paths\s+- (.+)$/.exec(l.msg);
    if (c && !s.conflicts.includes(c[1])) s.conflicts.push(c[1]);
  }
  // a file moved into the folder of replaced files is logged as deleted or replaced as well: nothing to add
  return s;
}

function syncSummaryText(s) {
  const parts = [];
  if (s.copied) parts.push(`${driveCount(s.copied, 'new file')} copied`);
  if (s.replaced) parts.push(`${driveCount(s.replaced, 'file')} updated`);
  if (s.deleted) parts.push(`${driveCount(s.deleted, 'file')} removed`);
  if (s.conflicts.length) parts.push(`${driveCount(s.conflicts.length, 'file')} changed on both sides (both versions kept)`);
  return parts.length ? parts.join(', ') : 'nothing had changed';
}

/* ---------- Failures, in plain words ---------- */

/* Makes a problem out of a run of rclone that failed. r is rcloneExec's result; what says what was being done
   ('sign-in', 'list', 'sync', 'first', 'copy', 'check', 'version'). Never returns rclone's own words as the
   message: those go in tail. */
function syncExplain(r, what) {
  const tail = (r.lines || []).filter(l => l.level !== 'info' && l.level !== 'debug' || /error|fail|abort/i.test(l.msg)).slice(-12).map(l => l.msg);
  const text = (r.lines || []).map(l => l.msg).join('\n') + '\n' + (what === 'version' ? r.out || '' : '');
  const has = re => re.test(text);
  const P = (kind, message, cause, next) => syncProblem(kind, message, cause, next, tail);
  if (r.failed) {
    const code = r.failed.code || '';
    if (code === 'ENOENT') return P('rclone', 'rclone is not where Scriptorium expected it.', 'It was moved or removed since it was found.', 'Open Settings → Scriptorium → Google Drive sync and choose “Find or download rclone”.');
    if (code === 'EACCES' || code === 'EPERM') return P('rclone', 'This computer would not let rclone run.', 'The file is not marked as a program, or security software (or macOS Gatekeeper, or a company’s policy) refused it.', 'On macOS: System Settings → Privacy & Security → allow rclone. Otherwise install rclone yourself (rclone.org/downloads) and give its path in Settings → Scriptorium.');
    if (code === 'EBADARCH' || code === 'ENOEXEC' || /bad cpu|exec format/i.test(String(r.failed.message))) return P('rclone', 'That rclone is built for another kind of computer.', 'It is for a different processor or system than this one.', 'Remove the path in Settings → Scriptorium and let Scriptorium download the right one.');
    return P('rclone', 'rclone could not be started.', 'The system refused to run it.', 'Install rclone yourself (rclone.org/downloads) and give its path in Settings → Scriptorium, or copy the diagnostic report and ask for help.');
  }
  if (r.stopped) return P('stopped', what === 'sign-in' ? 'The sign-in was stopped.' : 'Stopped.', '', what === 'sign-in' ? 'Nothing was connected. Run it again when you like.' : 'What was done so far is kept on both sides. The next sync carries on from there.');
  if (r.timedOut) {
    if (what === 'sign-in') return P('connect', 'Google’s answer did not arrive in ten minutes, so the sign-in was given up.', 'The page in the browser was closed or never finished, or Google refused the sign-in (see what the page said).', 'Try again and finish the page in the browser. If Google’s page said “Access blocked” or “deleted_client”, use a client ID of your own.');
    return P('network', 'Google Drive took too long to answer.', 'The connection is slow or was lost.', 'Check the internet connection. The next sync tries again by itself.');
  }
  if (has(/address already in use|bind: (?:An attempt|Only one usage)/i)) return P('busy', 'Another sign-in is already waiting on this computer.', `rclone listens on port ${RCLONE.port} for Google’s answer, and something else (most likely another rclone, or a second Obsidian window) is using it.`, 'Finish or close the other sign-in, wait a few seconds, and try again.');
  if (has(/didn't find section in config file|empty token found|couldn't find token|failed to create oauth client|token.*not found/i)) return P('connect', 'This computer is not signed in to Google Drive.', 'The sign-in was never finished here, or it was removed.', 'Choose “Connect to Google Drive” and sign in.');
  if (has(/invalid_grant|token has been expired or revoked|invalid_token|unauthorized: 401|error 401/i)) return P('connect', 'Google no longer accepts this computer’s sign-in.', 'The sign-in ran out or was withdrawn (a changed password, access removed in your Google account, or a client ID left in “Testing”, which Google signs out after seven days).', 'Choose “Connect to Google Drive” and sign in again. Your files and the choice of folder are kept.');
  if (has(/deleted_client|invalid_client|unauthorized_client|disabled_client|org_internal/i)) return P('client', 'Google refused the app that asked to sign in.', 'With rclone’s shared sign-in: rclone’s authors are retiring it during 2026. With a client ID of your own: the ID or the secret is wrong, or the client was deleted.', 'Choose “Connect to Google Drive” → “Use a client ID of my own” and follow the steps there.');
  if (has(/access_denied/i)) return P('connect', 'Google did not give access.', 'The sign-in page was cancelled, or the Google app is in “Testing” and this account is not one of its test users.', 'Sign in again and choose Allow. With a client ID of your own: publish the app (Audience → Publish app) or add the account as a test user.');
  if (has(/accessNotConfigured|has not been used in project|API .* is disabled|SERVICE_DISABLED/i)) return P('client', 'The Google Drive API is not turned on for your client ID’s project.', 'Step 2 of making a client ID was skipped.', 'Open console.cloud.google.com/apis/library/drive.googleapis.com, choose the project, click Enable, wait a minute and try again.');
  if (has(/storageQuotaExceeded|storage quota has been exceeded|quota.*storage/i)) return P('quota', 'Your Google Drive is full.', 'There is no room left in the Google account for the files that need to go up.', 'Free some room in Drive (or its trash), then choose “Sync now”. Nothing was lost: the files are still on this computer.');
  if (has(/userRateLimitExceeded|rateLimitExceeded|rate limit exceeded|quota exceeded|too many requests|error 429/i)) return P('rate', 'Google asked rclone to slow down.', 'Too many requests were made in a short time. rclone’s shared sign-in is rationed among everyone who uses it.', 'Wait a few minutes: the next sync tries again by itself. If it keeps happening, connect with a client ID of your own.');
  if (has(/no such host|dial tcp|i\/o timeout|connection refused|connection reset|network is unreachable|tls handshake|no route to host|temporary failure in name resolution|context deadline exceeded|unexpected eof|server misbehaving|proxyconnect/i)) return P('network', 'Google Drive could not be reached.', 'This computer is offline, or a firewall or proxy is in the way.', 'Check the internet connection. Nothing was changed; the next sync tries again by itself.');
  const many = /too many deletes \(>(\d+)%, (\d+) of (\d+)\) on Path([12])/.exec(text);
  if (many) {
    const side = many[4] === '1' ? 'on this computer' : 'in the Drive folder';
    const e = P('deletes', `${many[2]} of the ${many[3]} files and folders that are synced disappeared ${side} since the last sync, which is more than the safety limit (${many[1]}%), so nothing was changed.`,
      `A folder was deleted, moved or renamed ${side}. If that was you, it is fine to go on; if not, look before you do.`,
      `Choose “Sync anyway” to remove the same files on the other side (they go to ${many[4] === '1' ? 'Drive’s trash' : 'Scriptorium’s folder of replaced files, for thirty days'}), or put the files back and sync again.`);
    e.deleted = Number(many[2]); e.side = many[4] === '1' ? 'local' : 'drive';
    return e;
  }
  const access = /Access test failed: Path1 count (\d+), Path2 count (\d+)/.exec(text);
  if (access || has(/check file check failed|Access test failed/)) {
    const side = access && Number(access[1]) === 0 ? 'in this vault' : access && Number(access[2]) === 0 ? 'in the Drive folder' : 'on one side';
    return P('check', `The file that proves both sides are there (${SYNC_SENTINEL}) is missing ${side}, so nothing was changed.`,
      'The Drive folder was emptied, replaced or moved, the vault’s folder is not the one that was synced, or that one file was deleted.',
      'Look at both sides. If they are as you expect, choose “Set up the sync again”: it compares the two sides and shows you what it will do first.');
  }
  const empty = /Empty current Path([12]) listing/.exec(text);
  if (empty) {
    return P('empty', `${empty[1] === '1' ? 'This vault’s folder' : 'The Drive folder'} looks empty or cannot be read, so nothing was changed.`,
      empty[1] === '1' ? 'The disk the vault is on is not connected, or its files were moved.' : 'The Drive folder was deleted, moved, renamed or emptied, or a different Google account is signed in.',
      'Nothing was deleted on the other side. Put the folder back, or choose “Set up the sync again” to pick the folder and compare the two sides.');
  }
  if (has(/directory not found|couldn't find root directory|error reading source root directory|error reading destination root directory/i)) return P('folder', 'The Drive folder was not found.', 'It was deleted, moved or renamed in Google Drive, or a different Google account is signed in.', 'Choose “Set up the sync again” and pick the folder. Nothing was deleted on this computer.');
  if (has(/prior lock file found|lock file found/i)) return P('busy', 'Another sync of this vault is still running, or one was cut off a moment ago.', 'A second Obsidian window, or a run that was interrupted. The lock clears by itself after two minutes.', 'Wait two minutes and choose “Sync now”.');
  if (has(/must run --resync|requires? --resync|run --resync to recover|cannot find prior Path|filters file (?:has changed|md5)|safety abort.*filters/i)) return P('resync', 'The sync lost its record of the last run, so it stopped rather than guess.', 'A run was cut off at a bad moment, the record was deleted, or the list of what is synced changed.', 'Choose “Set up the sync again”: it compares the two sides, shows you what it will do, and keeps both versions of anything that differs.');
  if (has(/no space left on device|not enough space|disk full|There is not enough space/i)) return P('disk', 'This computer’s disk is full.', 'There was no room for the files coming from Drive.', 'Free some room, then choose “Sync now”.');
  if (has(/permission denied|access is denied|operation not permitted|being used by another process/i)) return P('disk', 'A file on this computer could not be read or written.', 'It is open in another program, or the vault’s folder does not allow it.', 'Close programs that have the vault’s files open and choose “Sync now”. The details below name the file.');
  if (has(/\.(?:lck|lst)[\w-]*["']?: (?:file ?name too long|The filename, directory name)/i)) return P('setup', SYNC_RECORD.message, SYNC_RECORD.cause, SYNC_RECORD.next);
  if (has(/file name too long|path too long|filename too long/i)) return P('disk', 'A file’s name or path is too long for this computer.', 'A name that fits in Drive can be too long for a folder deep in this computer.', 'Shorten the name (the details below show which) on the side where it is, and sync again.');
  if (has(/unknown flag|unknown command|unknown shorthand flag|invalid argument/i)) return P('rclone', 'This rclone does not understand what Scriptorium asked of it.', `It is older or newer than the version Scriptorium was written for (${RCLONE.version}).`, 'In Settings → Scriptorium, clear the path to rclone and let Scriptorium download its own.');
  if (what === 'sign-in') return P('connect', 'The sign-in did not finish.', 'Google’s page was closed, or Google refused (see what the page in the browser said).', 'Try again. If Google’s page said “Access blocked” or “deleted_client”, use a client ID of your own.');
  if (what === 'version') return P('rclone', 'That file does not behave like rclone.', 'It did not answer the question “which version are you?”.', 'Give the path to rclone itself (rclone.exe on Windows) in Settings → Scriptorium, or clear it and let Scriptorium download rclone.');
  return P('unknown', what === 'list' ? 'The folders in Google Drive could not be listed.' : what === 'copy' ? 'The vault could not be copied from Google Drive.' : 'The sync stopped before it finished.',
    'rclone reported a problem that Scriptorium does not recognise.', 'Choose “Sync now” to try again: an interrupted sync is picked up where it stopped. If it happens again, copy the diagnostic report (it has rclone’s own words, without your sign-in) and ask for help.');
}

/* ---------- The calls Scriptorium makes ---------- */

/* rclone, ready to be asked things. o: {spawn, fs, path, exe, paths (syncPaths), env, log(run)}. Every method
   throws a problem in plain words (syncExplain) when rclone fails. */
function rcloneApi(o) {
  const { fs, path, paths } = o;
  const base = ['--config', paths.conf, '--color', 'NEVER', '--use-json-log'];
  const call = async (what, args, more) => {
    const began = Date.now();
    const r = await rcloneExec(Object.assign({ spawn: o.spawn, exe: o.exe, args: base.concat(args), env: o.env, timeout: SYNC_TIMES.call }, more));
    if (o.log) o.log({ what, ms: Date.now() - began, code: r.code, failed: r.failed ? (r.failed.code || 'error') : '', stopped: r.stopped, timedOut: r.timedOut, lines: r.lines });
    return r;
  };
  const must = async (what, args, more) => {
    const r = await call(what, args, more);
    if (r.failed || r.stopped || r.timedOut || r.code !== 0) throw syncExplain(r, what);
    return r;
  };
  const api = {
    exe: o.exe,
    /* [1, 76, 0], or throws: the file is not rclone, or is too old. */
    async version() {
      const r = await call('version', ['version'], { timeout: 20000 });
      const v = r.failed ? null : rcloneVersion(r.out);
      if (!v) throw syncExplain(r.failed ? r : Object.assign(r, { code: 1 }), 'version');
      if (!rcloneOldEnough(v)) {
        throw syncProblem('rclone', `The rclone on this computer is version ${v.join('.')}, which is too old to sync in both directions safely.`,
          `Scriptorium needs rclone ${RCLONE.min.join('.')} or newer (it was written for ${RCLONE.version}).`, 'Update rclone, or clear its path in Settings → Scriptorium and let Scriptorium download its own copy.');
      }
      return v;
    },
    connection() { return syncConnection(fs, paths.conf); },
    /* The sign-in. client is {id, secret} or null (rclone's shared one). onLink(url) is given the address of the
       sign-in page, in case the browser did not open by itself. */
    async connect(client, onLink, signal) {
      syncConfPrepare(fs, path, paths.conf, client);
      const r = await call('sign-in', ['config', 'update', RCLONE.remote, 'scope=drive'], {
        signal, timeout: SYNC_TIMES.signIn,
        onLine: l => { const m = /(http:\/\/127\.0\.0\.1:\d+\/auth\S*)/.exec(l.msg); if (m && onLink) onLink(m[1]); },
      });
      if (r.failed || r.stopped || r.timedOut || r.code !== 0 || !api.connection().connected) {
        throw syncExplain(r.code === 0 ? Object.assign(r, { code: 1 }) : r, 'sign-in');
      }
      await api.dirs({ root: 'my', path: '' });   // the sign-in is good only if Drive answers with it
    },
    /* Withdraws the sign-in at Google where rclone can, and removes it from the config. */
    async disconnect() {
      await call('disconnect', ['config', 'disconnect', `${RCLONE.remote}:`], { timeout: 30000 });
      await call('delete', ['config', 'delete', RCLONE.remote], { timeout: 30000 });
      const left = syncConfRead(fs, paths.conf);
      if (left[RCLONE.remote]) throw syncProblem('disk', 'The sign-in could not be removed from this computer.', `The file ${paths.conf} could not be changed.`, 'Delete that file by hand: it holds nothing else.');
    },
    /* The folders inside a Drive folder: [{name, id}]. */
    async dirs(link, signal) {
      const t = syncTarget(link);
      const r = await must('list', ['lsjson', t.fs].concat(t.flags, ['--dirs-only', '--no-modtime', '--no-mimetype', '--drive-skip-gdocs']), { signal });
      const dirs = syncParseDirs(r.out);
      if (!dirs) throw syncExplain(Object.assign(r, { code: 1 }), 'list');
      return dirs;
    },
    /* The shared drives of the account: [{name, id}]; none where there are none or rclone cannot say. */
    async drives(signal) {
      const r = await call('drives', ['backend', 'drives', `${RCLONE.remote}:`], { signal, timeout: 60000 });
      if (r.code !== 0) return [];
      try { return JSON.parse(r.out).filter(d => d && d.id && d.name).map(d => ({ name: String(d.name), id: String(d.id) })); } catch (e) { return []; }
    },
    async mkdir(link, signal) {
      const t = syncTarget(link);
      await must('list', ['mkdir', t.fs].concat(t.flags), { signal });
    },
    /* {count, bytes} of what would be synced on one side. where is a local folder or a link. */
    async size(where, filters, signal) {
      const t = typeof where === 'string' ? { fs: where, flags: [] } : syncTarget(where);
      const r = await must('check', ['size', t.fs, '--json', '--filter-from', filters, '--drive-skip-gdocs', '--skip-links'].concat(t.flags), { signal, timeout: 30 * 60 * 1000 });
      try { const j = JSON.parse(r.out); return { count: Number(j.count) || 0, bytes: Number(j.bytes) || 0 }; } catch (e) { throw syncExplain(Object.assign(r, { code: 1 }), 'check'); }
    },
    /* How the two sides compare, file by file (syncParseCheck). rclone ends with 1 when they differ: not a failure. */
    async compare(local, link, filters, signal) {
      const t = syncTarget(link);
      const r = await call('check', ['check', local, t.fs, '--combined', '-', '--filter-from', filters, '--drive-skip-gdocs', '--skip-links'].concat(t.flags), { signal, timeout: 60 * 60 * 1000 });
      if (r.failed || r.stopped || r.timedOut || (r.code !== 0 && r.code !== 1) || (r.code === 1 && !r.out.trim())) throw syncExplain(r, 'check');
      return syncParseCheck(r.out);
    },
    /* Puts the check file on the Drive side. */
    async sentinel(local, link, signal) {
      const t = syncTarget(link);
      await must('check', ['copyto', path.join(local, SYNC_SENTINEL), `${t.fs}/${SYNC_SENTINEL}`.replace(/:\//, ':')].concat(t.flags), { signal });
    },
    /* Copies a Drive folder into a local folder (retrieving a vault). onStats({bytes, totalBytes, transfers, totalTransfers}). */
    async copy(link, local, filters, onStats, signal) {
      const t = syncTarget(link);
      await must('copy', ['copy', t.fs, local, '--filter-from', filters, '--drive-skip-gdocs', '--create-empty-src-dirs', '--stats', '1s', '-v'].concat(t.flags), {
        signal, timeout: 0, onLine: l => { if (l.stats && onStats) onStats(l.stats); },
      });
    },
    /* One run of the sync; resolves rcloneExec's result with .summary, or throws a problem. */
    async bisync(args, onLine, signal) {
      const r = await call(args.includes('--resync') ? 'first' : 'sync', args, { signal, timeout: 0, onLine });
      if (r.failed || r.stopped || r.timedOut || r.code !== 0) throw syncExplain(r, 'sync');
      r.summary = syncSummary(r.lines);
      return r;
    },
  };
  return api;
}

/* ---------- One run at a time ---------- */

/* Takes the lock for a vault: true if it is ours now. The lock is a file holding who has it and since when; one
   left by a program that is gone, or older than six hours, is taken over. alive(pid) says whether a process runs. */
function syncLock(fs, path, file, pid, now, alive) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let tries = 0; tries < 2; tries++) {
    try { fs.writeFileSync(file, JSON.stringify({ pid, at: now }), { flag: 'wx' }); return true; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let held = null;
      try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (x) { /* half written, or gone: try again */ }
      if (held && alive(held.pid) && now - held.at < SYNC_TIMES.lockStale) return false;
      try { fs.unlinkSync(file); } catch (x) { /* someone else removed it */ }
    }
  }
  return false;
}
function syncUnlock(fs, file, pid) {
  try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === pid) fs.unlinkSync(file); } catch (e) { /* not ours, or gone */ }
}

/* rclone keeps a lock of its own beside its record of the sync, and leaves it behind when it is cut off (a crash,
   the computer going to sleep for good); it would then refuse to run for two minutes. Whoever holds Scriptorium's
   lock may remove one whose rclone is gone. */
function syncClearStale(fs, path, workdir, alive) {
  let names = [];
  try { names = fs.readdirSync(workdir); } catch (e) { return 0; }
  let n = 0;
  for (const name of names) {
    if (!name.endsWith('.lck')) continue;
    let pid = 0;
    try { pid = Number(JSON.parse(fs.readFileSync(path.join(workdir, name), 'utf8')).PID) || 0; } catch (e) { /* half written: its writer is gone */ }
    if (pid && alive(pid)) continue;
    try { fs.unlinkSync(path.join(workdir, name)); n++; } catch (e) { /* rclone says so if it is in the way */ }
  }
  return n;
}

/* Removes what past syncs replaced on this computer once it is older than `days` (folders named by date). */
function syncPrune(fs, path, dir, days, now) {
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return 0; }
  for (const name of names) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(name);
    if (!m) continue;
    if (now - new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() > (days + 1) * 86400000) {
      try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); removed++; } catch (e) { /* next time */ }
    }
  }
  return removed;
}

/* rclone names its record of a sync after both paths, in one file name ("local__<vault's path>..<remote>_<Drive
   path>.path1.lst-new"), and a file name has a limit (255 bytes on every system). A problem if the two paths
   together are too long for it, or null. */
const SYNC_RECORD = { message: 'This vault’s folder and the Drive folder have paths that are too long, taken together, for rclone to keep its record of the sync.',
  cause: 'rclone names that record after both paths, and a file’s name can be 255 characters at most.',
  next: 'Move the vault to a folder with a shorter path, or choose a Drive folder that is less deep, and set up the sync again.' };
function syncTooLong(dir, link) {
  if (Buffer.byteLength(String(dir)) + Buffer.byteLength(syncTarget(link).fs) <= 225) return null;
  return syncProblem('setup', SYNC_RECORD.message, SYNC_RECORD.cause, SYNC_RECORD.next);
}

/* One sync of a linked vault. o: {api, fs, path, crypto, paths, id, dir (the vault), link, settings, force, now,
   pid, alive, onLine, signal}. Resolves {summary, skipped} ('busy': another run has the lock); throws a problem.
   Before rclone is run: the vault's folder and its check file must be there (a vault whose disk is missing, or a
   folder that was swapped, never reaches rclone). */
async function syncOnce(o) {
  const { fs, path, paths, id } = o;
  const link = o.link;
  if (!link) throw syncProblem('setup', 'This vault is not set up to sync with Google Drive yet.', '', 'Run “Scriptorium: Sync this vault with Google Drive”.');
  if (!link.first) throw syncProblem('setup', 'The first sync of this vault was not finished.', 'The window was closed before it ran.', 'Run “Scriptorium: Sync this vault with Google Drive” and confirm the first sync.');
  let there = false;
  try { there = fs.statSync(o.dir).isDirectory(); } catch (e) { /* not there */ }
  if (!there) throw syncProblem('empty', 'This vault’s folder cannot be found, so nothing was changed.', 'The disk it is on is not connected, or the folder was moved.', 'Nothing was deleted in Drive. Reconnect the disk, or open the vault from where it is now and set up the sync again.');
  if (!fs.existsSync(path.join(o.dir, SYNC_SENTINEL))) {
    throw syncProblem('check', `The file that proves both sides are there (${SYNC_SENTINEL}) is missing in this vault, so nothing was changed.`,
      'It was deleted, or this folder is not the one that was synced.', 'Look at both sides. If they are as you expect, choose “Set up the sync again”: it compares the two sides and shows you what it will do first.');
  }
  const long = syncTooLong(o.dir, link);
  if (long) throw long;
  const lock = path.join(paths.locks, `${id}.lock`);
  if (!syncLock(fs, path, lock, o.pid, o.now(), o.alive)) return { skipped: 'busy' };
  try {
    const filters = path.join(paths.filters, `${id}.txt`), text = syncFilters(o.settings);
    const stamp = syncStamp(new Date(o.now()));
    const args = more => syncBisyncArgs(Object.assign({ path, local: o.dir, link, paths, id, settings: o.settings, stamp }, more));
    syncClearStale(fs, path, path.join(paths.work, id), o.alive);
    let old = null;
    try { old = fs.readFileSync(filters, 'utf8'); } catch (e) { /* written below */ }
    let r;
    if (old !== text) {
      // What is synced has changed (a setting, or a newer Scriptorium). What is waiting is synced under the old rules
      // first, so that a deletion is not undone; then both sides are matched up again under the new ones.
      if (old !== null) await o.api.bisync(args({ force: o.force }), o.onLine, o.signal);
      fs.mkdirSync(paths.filters, { recursive: true });
      fs.writeFileSync(filters, text);
      r = await o.api.bisync(args({ resync: true, mode: 'newer' }), o.onLine, o.signal);
    } else {
      r = await o.api.bisync(args({ force: o.force }), o.onLine, o.signal);
    }
    syncPrune(fs, path, path.join(paths.kept, id), o.settings.keepDays, o.now());
    return { summary: r.summary };
  } finally {
    syncUnlock(fs, lock, o.pid);
  }
}

function syncStamp(d) {
  const two = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/* What the first sync would do. Resolves {local: {count, bytes}, drive: {count, bytes}, same, onlyLocal, onlyDrive,
   differ: [names], unread: [names]}. Writes the filter rules (they are needed to look). */
async function syncPreview(o) {
  const { fs, path, paths, id } = o;
  fs.mkdirSync(paths.filters, { recursive: true });
  const filters = path.join(paths.filters, `${id}.preview.txt`);
  fs.writeFileSync(filters, syncFilters(o.settings));
  try {
    const local = await o.api.size(o.dir, filters, o.signal), drive = await o.api.size(o.link, filters, o.signal);
    const cmp = await o.api.compare(o.dir, o.link, filters, o.signal);
    const both = cmp.same.length + cmp.differ.length + cmp.unread.length;   // the check file is not counted
    return { local: { count: both + cmp.local.length, bytes: local.bytes }, drive: { count: both + cmp.drive.length, bytes: drive.bytes },
      same: cmp.same.length, onlyLocal: cmp.local.length, onlyDrive: cmp.drive.length, differ: cmp.differ, unread: cmp.unread,
      taken: cmp.drive.filter(n => SYNC_CONFLICT.test(n)) };   // kept copies that are in Drive already: their names are not given again
  } finally {
    try { fs.unlinkSync(filters); } catch (e) { /* written again next time */ }
  }
}

/* The first sync of a vault with its Drive folder (and a fresh start after trouble). o: as syncOnce, plus differ
   (names that differ, from syncPreview) and keep: 'both' (the default: this computer's version is renamed
   "name.conflict1.md" and both end up on both sides), 'local' or 'drive' (that side's version replaces the other;
   what is replaced here goes to the folder of replaced files, what is replaced in Drive stays in Drive's version
   history). Files that are on one side only are always copied to the other: a first sync deletes nothing.
   Resolves {summary, renamed: [[from, to]]}. */
async function syncFirst(o) {
  const { fs, path, paths, id } = o;
  const long = syncTooLong(o.dir, o.link);
  if (long) throw long;
  const lock = path.join(paths.locks, `${id}.lock`);
  if (!syncLock(fs, path, lock, o.pid, o.now(), o.alive)) throw syncProblem('busy', 'Another sync of this vault is running.', 'A second window, or a run that has not finished.', 'Wait for it to finish and try again.');
  try {
    const renamed = [];
    if ((o.keep || 'both') === 'both' && o.differ && o.differ.length) {
      const taken = new Set(o.taken || []);
      for (const rel of o.differ) {
        const from = path.join(o.dir, ...rel.split('/'));
        if (!fs.existsSync(from)) continue;
        let to;
        do { to = syncConflictName(rel, taken); } while (fs.existsSync(path.join(o.dir, ...to.split('/'))));
        fs.renameSync(from, path.join(o.dir, ...to.split('/')));
        renamed.push([rel, to]);
      }
    }
    const mark = path.join(o.dir, SYNC_SENTINEL);
    if (!fs.existsSync(mark)) fs.writeFileSync(mark, SYNC_SENTINEL_TEXT);
    await o.api.sentinel(o.dir, o.link, o.signal);
    fs.mkdirSync(paths.filters, { recursive: true });
    fs.writeFileSync(path.join(paths.filters, `${id}.txt`), syncFilters(o.settings));
    // A record of an earlier link of this vault would mislead rclone: the first sync starts from nothing.
    try { fs.rmSync(path.join(paths.work, id), { recursive: true, force: true }); } catch (e) { /* rclone says so if it is in the way */ }
    const mode = o.keep === 'local' ? 'path1' : o.keep === 'drive' ? 'path2' : 'newer';
    const args = syncBisyncArgs({ path, local: o.dir, link: o.link, paths, id, settings: o.settings, stamp: syncStamp(new Date(o.now())), resync: true, mode });
    const r = await o.api.bisync(args, o.onLine, o.signal);
    return { summary: r.summary, renamed };
  } finally {
    syncUnlock(fs, lock, o.pid);
  }
}

/* ---------- When to sync ---------- */

/* Decides when the sync runs: after Obsidian starts, every so many minutes, a little after the last change to a
   note, and when asked. Never two runs at once: a request made during a run is kept and run after it. A failure
   that needs the writer (a sign-in, a safety stop) pauses the timer until they act; any other is tried again,
   more slowly each time. o: {run(reason, opts) -> Promise<{summary, skipped}>, settings() -> syncSettings,
   linked() -> bool, onState(state), timers: {set, clear}, now}. */
class SyncEngine {
  constructor(o) {
    this.o = o;
    this.timers = o.timers || { set: (f, ms) => setTimeout(f, ms), clear: t => clearTimeout(t) };
    this.now = o.now || (() => Date.now());
    this.state = { status: 'off', last: 0, summary: null, problem: null, reason: '', since: 0 };
    this.tick = null;      // the timer of the next regular run
    this.soon = null;      // the timer of a run that follows a change, or a request made during a run
    this.running = null; this.again = null; this.touched = false; this.fails = 0; this.stopped = true;
  }
  set(patch) {
    Object.assign(this.state, patch);
    if (this.o.onState) { try { this.o.onState(this.state); } catch (e) { /* the status bar's trouble */ } }
  }
  static needsWriter(p) {
    return Boolean(p) && ['connect', 'client', 'deletes', 'check', 'empty', 'resync', 'folder', 'rclone', 'setup', 'quota'].includes(p.kind);
  }
  paused() { return this.state.status === 'problem' && SyncEngine.needsWriter(this.state.problem); }
  /* Starts (or restarts, after a setting changed or a run ended) the regular timer. first: Obsidian has just
     started, so the first run comes soon. */
  start(first) {
    this.stopped = false;
    this.cancel();
    if (!this.o.linked()) { this.set({ status: 'off', problem: null }); return; }
    if (this.state.status === 'off') this.set({ status: 'idle' });
    const s = this.o.settings();
    if (!s.auto || this.paused() || this.running) return;
    const ms = first ? SYNC_TIMES.onStart : s.minutes * 60000 * Math.min(12, Math.pow(2, this.fails));
    this.tick = this.timers.set(() => { this.tick = null; void this.run(first ? 'start' : 'timer'); }, ms);
  }
  stop() { this.stopped = true; this.cancel(); }
  cancel() {
    if (this.tick !== null) { this.timers.clear(this.tick); this.tick = null; }
    if (this.soon !== null) { this.timers.clear(this.soon); this.soon = null; }
  }
  /* A note changed: a run follows the last change by a little. The regular timer is left as it is, so that a long
     spell of writing is still synced on time. A change made while a run is going is synced by one more run after
     it (the run's own downloads look like changes too: the extra run then finds nothing to do). */
  touch() {
    if (this.stopped || !this.o.linked() || !this.o.settings().auto || this.paused()) return;
    if (this.running) { this.touched = true; return; }
    if (this.soon !== null) this.timers.clear(this.soon);
    this.soon = this.timers.set(() => { this.soon = null; void this.run('change'); }, SYNC_TIMES.onChange);
  }
  /* Whether a change is waiting to be synced, or a run is going. */
  pending() { return this.soon !== null || this.touched || Boolean(this.running); }
  /* Runs now. While a run is going, the request waits for it, and one more run follows if it was asked for by the
     writer or by a change. */
  run(reason, opts) {
    if (this.running) {
      if (reason !== 'timer' && reason !== 'start') this.again = { reason, opts };
      return this.running;
    }
    if (!this.o.linked()) return Promise.resolve({ skipped: 'off' });
    this.cancel();
    this.set({ status: 'syncing', reason: reason || 'manual', since: this.now() });
    const p = (async () => {
      let result = null;
      try {
        result = await this.o.run(reason, opts || {});
        if (result && result.skipped) this.set({ status: this.state.problem ? 'problem' : 'idle' });
        else { this.fails = 0; this.set({ status: 'idle', last: this.now(), summary: result && result.summary, problem: null }); }
      } catch (e) {
        const problem = e && e.kind ? e : syncProblem('unknown', 'The sync stopped before it finished.', 'Scriptorium itself tripped over something.', 'Choose “Sync now” to try again. If it happens again, copy the diagnostic report and ask for help.', [String((e && e.message) || e)]);
        if (problem.kind === 'stopped') this.set({ status: this.state.problem ? 'problem' : 'idle' });
        else { this.fails++; this.set({ status: 'problem', problem }); }
        result = { problem };
      }
      this.running = null;
      const again = this.again, touched = this.touched;
      this.again = null; this.touched = false;
      if (!this.stopped) {
        this.start(false);
        if (again && !this.paused()) this.soon = this.timers.set(() => { this.soon = null; void this.run(again.reason, again.opts); }, SYNC_TIMES.again);
        else if (touched) this.touch();
      }
      return result;
    })();
    this.running = p;
    return p;
  }
}

/* What the status bar says: {text, title}. */
function syncStatusText(state, now) {
  const hhmm = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  if (state.status === 'syncing') return { text: 'Drive: syncing…', title: 'Syncing this vault with Google Drive' };
  if (state.status === 'problem') return { text: 'Drive: needs a look', title: `${state.problem ? state.problem.message : 'The last sync did not finish.'} Click for what to do.` };
  if (state.status === 'idle') {
    if (!state.last) return { text: 'Drive: ready', title: 'This vault syncs with Google Drive. Click to sync now or to see more.' };
    const sameDay = new Date(state.last).toDateString() === new Date(now).toDateString();
    return { text: `Drive: synced ${sameDay ? hhmm(state.last) : new Date(state.last).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
      title: `Last synced ${new Date(state.last).toLocaleString()}${state.summary ? `: ${syncSummaryText(state.summary)}` : ''}. Click to sync now or to see more.` };
  }
  return { text: '', title: '' };
}

/* ---------- A report of what happened, for the writer to paste ---------- */

/* Text made safe to paste where others read it: tokens, codes and secrets are cut out, a client ID is shortened, an
   email keeps its first letter and its domain, and a path under the home folder starts at ~. */
function driveRedact(text, home) {
  let t = String(text === undefined || text === null ? '' : text);
  for (const h of [home, home && home.split('\\').join('/'), home && home.split('\\').join('\\\\')].filter(Boolean)) t = t.split(h).join('~');
  return t
    .replace(/\b(ya29\.|1\/\/|4\/|GOCSPX-)[\w\-./+=%]{6,}/g, '$1[hidden]')
    .replace(/\b(Bearer|refresh_token|access_token|client_secret|code|code_verifier|token|state)(["']?\s*[:=]\s*["']?|\s+)[\w\-./+=%]{12,}/gi, '$1$2[hidden]')
    .replace(/\b(\d{4})\d*-[0-9a-z_]{8,}\.apps\.googleusercontent\.com/gi, '$1…apps.googleusercontent.com')
    .replace(/\b([\w.+-])[\w.+-]*@([\w-]+(?:\.[\w-]+)+)/g, '$1…@$2')
    .replace(/\b[A-Za-z0-9_\-+/=]{48,}\b/g, '[hidden]');
}

/* A line of rclone's log with the names of files and folders taken out, as far as they can be recognised. */
function syncNameless(msg, hide) {
  let m = String(msg || '').split('\n')[0];
  for (const h of (hide || []).filter(x => x && x.length > 2).sort((a, b) => b.length - a.length)) m = m.split(h).join('[folder]');
  return m.replace(/\[folder\](?:[\\/][^:"\n]*)?/g, '[a file]').replace(/(\s-\s)(?!Path[12]\b)\S.*$/, '$1[a file]').replace(/"[^"\n]{1,400}"/g, '"…"').replace(/“[^”]*”/g, '“…”');
}

/* info: {version, obsidian, platform, arch, release, rclone: {kind, version}, connected, own, linked, where (root
   kind and depth), settings, state}; runs: what rcloneApi logged, newest last. */
function syncReport(info, runs, home, hide) {
  const out = [];
  out.push('Scriptorium: Google Drive sync diagnostic report');
  out.push('(No password, token or key. Names of files and folders are left out where Scriptorium recognises them; paths in your home folder start at ~. Read it over before you post it.)');
  out.push('');
  out.push(`Scriptorium ${info.version || '?'} · Obsidian ${info.obsidian || '?'} · ${info.platform || '?'} ${info.arch || ''} ${info.release || ''}`.trim());
  const rc = info.rclone || {};
  out.push(`rclone: ${rc.version ? `v${rc.version}` : 'not found'}${rc.kind ? ` (${{ custom: 'the path in the settings', downloaded: 'downloaded by Scriptorium', path: 'found on PATH', usual: 'found in a usual place' }[rc.kind] || rc.kind})` : ''} · written for v${RCLONE.version}`);
  out.push(`Signed in: ${info.connected ? 'yes' : 'no'} · Google app: ${info.own ? 'a client ID of the writer’s own' : 'rclone’s shared one'}${info.type && info.type !== 'drive' ? ` · NOT GOOGLE DRIVE (the remote is of type ${info.type}: a test)` : ''}`);
  out.push(`This vault: ${info.linked ? `linked (${info.where || '?'})` : 'not linked'}${info.first ? '' : info.linked ? ', first sync not done' : ''}`);
  if (info.settings) out.push(`Settings: automatic ${info.settings.auto ? `every ${info.settings.minutes} min` : 'off'} · Obsidian’s settings synced: ${info.settings.obsidian ? 'yes' : 'no'} · delete limit ${info.settings.maxDelete}%`);
  if (info.state) out.push(`Now: ${info.state.status}${info.state.problem ? ` (${info.state.problem.kind}: ${info.state.problem.message})` : ''}`);
  out.push('');
  out.push('The last things rclone was asked to do (newest last, times in UTC):');
  if (!runs || !runs.length) out.push('  nothing yet since Obsidian started');
  for (const r of (runs || []).slice(-12)) {
    out.push(`  ${r.at || ''} ${r.what}: ${r.failed ? `could not start (${r.failed})` : r.stopped ? 'stopped' : r.timedOut ? 'timed out' : `ended with ${r.code}`} after ${((r.ms || 0) / 1000).toFixed(1)} s`);
    const bad = (r.lines || []).filter(l => l.level !== 'info' && l.level !== 'debug' && !l.stats);
    if (r.code !== 0 || r.failed) for (const l of bad.slice(-8)) out.push(`      ${l.level}: ${syncNameless(l.msg, hide)}`);
  }
  return driveRedact(out.join('\n'), home) + '\n';
}

/* Why the folder cannot take a retrieved vault of `bytes` bytes, or ''. */
function driveTargetProblem(fs, path, dir, bytes) {
  try {
    if (dir.split(/[\\/]/).includes('.obsidian')) return 'That is a folder inside a vault’s settings.';
    if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) return 'That is a file, not a folder.';
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) return 'That folder is not empty. Choose a new or empty folder: retrieving never writes over what is already there.';
    // The nearest folder that exists must take a new file, and have the room.
    let at = dir;
    while (!fs.existsSync(at)) { const up = path.dirname(at); if (up === at) return `There is no ${path.parse(dir).root || 'such'} drive or disk on this computer.`; at = up; }
    try {
      const probe = path.join(at, `.scriptorium-probe-${process.pid}`);
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
    } catch (e) {
      return `Nothing can be written in ${at}. Choose a folder of your own, such as one in Documents.`;
    }
    try {
      const st = fs.statfsSync ? fs.statfsSync(at) : null;
      const free = st ? Number(st.bavail) * Number(st.bsize) : Infinity;
      if (free < bytes * 1.05 + 20e6) return `There is not enough room on that disk: the vault is ${driveBytes(bytes)} and ${driveBytes(free)} are free.`;
    } catch (e) { /* the room is not known: the download says so if it runs out */ }
  } catch (e) {
    return 'That folder cannot be used. Choose another, such as a new folder in Documents.';
  }
  return '';
}

/* Opens a folder as a vault in a new Obsidian window: true if Obsidian took it. */
function openVaultWindow(dir) {
  try {
    return require('electron').ipcRenderer.sendSync('vault-open', dir, false) === true;
  } catch (e) {
    return false;
  }
}

/* ---------- Choosing the Drive folder ---------- */

/* The little browser over the writer's Drive: where it is, what is there, going in and out, making a folder.
   api is rcloneApi's (dirs, drives, mkdir). The place is {root: 'my' | 'shared' | 'drive', driveId, driveName,
   parts: [names]}. Kept apart from the window so that it can be tested. */
class SyncBrowser {
  constructor(api, at) {
    this.api = api;
    this.at = Object.assign({ root: 'my', driveId: '', driveName: '', parts: [] }, at || {});
    this.cache = new Map();
  }
  link(parts) {
    return { root: this.at.root, driveId: this.at.driveId, driveName: this.at.driveName, path: (parts || this.at.parts).join('/') };
  }
  key() { return `${this.at.root}:${this.at.driveId}:${this.at.parts.join('/')}`; }
  /* The folders here: [{name, id}]. */
  async list(signal, fresh) {
    const k = this.key();
    if (!fresh && this.cache.has(k)) return this.cache.get(k);
    const dirs = await this.api.dirs(this.link(), signal);
    this.cache.set(k, dirs);
    return dirs;
  }
  enter(name) { this.at.parts = this.at.parts.concat([name]); }
  up() { if (this.at.parts.length) this.at.parts = this.at.parts.slice(0, -1); }
  /* Goes to the n-th part of the path (0: the root). */
  jump(n) { this.at.parts = this.at.parts.slice(0, n); }
  setRoot(root, drive) { this.at = { root, driveId: drive ? drive.id : '', driveName: drive ? drive.name : '', parts: [] }; }
  /* The roots there are: My Drive, Shared with me, and each shared drive. */
  async roots(signal) {
    if (!this.drives) this.drives = await this.api.drives(signal);
    return [{ root: 'my', name: 'My Drive' }, { root: 'shared', name: 'Shared with me' }].concat(this.drives.map(d => ({ root: 'drive', name: d.name, drive: d })));
  }
  /* Makes a folder here and goes into it. Throws a problem if the name will not do or is taken. */
  async create(name, signal) {
    const why = syncFolderName(name);
    if (why) throw syncProblem('name', why, '', '');
    const n = String(name).trim();
    if (this.at.root === 'shared' && !this.at.parts.length) throw syncProblem('name', 'A folder cannot be made among the things shared with you.', '', 'Go into a folder first, or make it in My Drive.');
    const here = await this.list(signal);
    if (here.some(d => d.name.toLowerCase() === n.toLowerCase())) throw syncProblem('name', 'There is already a folder of that name here.', '', 'Open it, or choose another name.');
    await this.api.mkdir(this.link(this.at.parts.concat([n])), signal);
    this.cache.delete(this.key());
    this.enter(n);
  }
  /* Whether this place can be the vault's folder: the top of a Drive cannot (the whole Drive would come down). */
  canChoose() { return this.at.parts.length > 0; }
  where() { return syncWhere(this.link()); }
}

/* ---------- The windows ---------- */

const SYNC_TITLES = { setup: 'Sync this vault with Google Drive', retrieve: 'Retrieve a vault from Google Drive', status: 'Google Drive sync', connect: 'Connect to Google Drive' };
const SYNC_UNVERIFIED = 'New: the sign-in follows rclone’s documentation, but has not yet been checked against the real Google on our side. If it fails, “Copy diagnostic report” tells us why.';
const SYNC_MOVED = 'Scriptorium now syncs with Google Drive through rclone, with a Google sign-in of your own and a folder you pick yourself; the older backup (through Claude Code, or the direct preview) is gone. ' +
  'A backup made through Claude Code can be carried on: pick its folder (Scriptorium › the vault’s name) as the Drive folder. Its list of files (scriptorium-manifest.json) and its _trash folder are left alone and not synced. ' +
  'A backup made with the direct preview can only be seen by the Google app that made it; download that folder from drive.google.com if you need it.';

class SyncModal extends Modal {
  /* mode: 'setup' (link this vault and sync it), 'retrieve' (bring a vault down from Drive), 'status' (what the
     sync is doing, its conflicts, and the buttons), 'connect' (sign in and stop). */
  constructor(plugin, mode, opts) {
    super(plugin.app);
    this.plugin = plugin;
    this.mode = mode;
    this.opts = opts || {};
  }

  onOpen() {
    this.modalEl.addClass('scriptorium-setup');
    this.modalEl.addClass('scriptorium-drive');
    this.titleEl.setText(SYNC_TITLES[this.mode]);
    this.titleEl.createSpan({ cls: 'scriptorium-drive-tag', text: 'new' });
    this.stop = new AbortController();
    this.start().catch(e => this.fail(e));
  }

  onClose() {
    if (this.stop) this.stop.abort();
    this.contentEl.empty();
    if (this.opts.onClose) this.opts.onClose();
  }

  buttons(el) { return (el || this.contentEl).createDiv({ cls: 'modal-button-container' }); }
  closeButton(row, text) { row.createEl('button', { text: text || 'Close' }).addEventListener('click', () => this.close()); }
  reportButton(row) { row.createEl('button', { cls: 'scriptorium-drive-report', text: 'Copy diagnostic report' }).addEventListener('click', () => this.plugin.copyDriveReport()); }
  alive() { return this.contentEl.isConnected && !this.stop.signal.aborted; }
  go(f) { Promise.resolve().then(f).catch(e => this.fail(e)); }

  page(text) {
    const el = this.contentEl;
    el.empty();
    if (this.kit && this.kit.test) el.createEl('p', { cls: 'scriptorium-setup-problem', text: 'TEST: the “Drive” here is a folder on this computer, not Google Drive.' });
    if (text) el.createEl('p', { text });
    return el;
  }

  wait(text, cancel) {
    const el = this.page();
    el.createEl('p', { cls: 'scriptorium-drive-wait', text });
    if (cancel !== false) this.buttons().createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    return el;
  }

  /* A failure: what happened, the likely cause, what to do, and the buttons that do it. rclone's own words are
     folded away below. */
  fail(e) {
    if (!this.contentEl.isConnected) return;
    if (!e || !e.kind) e = syncProblem('unknown', 'Something went wrong inside Scriptorium.', 'This is a fault in Scriptorium, not something you did.', 'Close this window and try again. If it happens again, copy the diagnostic report and ask for help.', [String((e && e.message) || e)]);
    this.plugin.syncNote(`window: ${e.kind}`, e.tail);
    const el = this.page();
    el.createEl('p', { cls: e.kind === 'stopped' ? '' : 'scriptorium-setup-problem', text: e.message });
    if (e.cause2) { const p = el.createEl('p'); p.createEl('strong', { text: 'Likely cause: ' }); p.appendText(e.cause2); }
    if (e.next) { const p = el.createEl('p'); p.createEl('strong', { text: 'What to do: ' }); p.appendText(e.next); }
    if (e.tail && e.tail.length && e.kind !== 'stopped' && e.kind !== 'name') {
      const d = el.createEl('details', { cls: 'scriptorium-drive-skipped' });
      d.createEl('summary', { text: 'Details (rclone’s own words)' });
      d.createEl('pre', { cls: 'scriptorium-setup-plan', text: driveRedact(e.tail.join('\n'), this.kit ? this.kit.home : '') });
    }
    const row = this.buttons();
    const cta = (text, f) => row.createEl('button', { cls: 'mod-cta', text }).addEventListener('click', () => this.go(f));
    if (e.kind === 'connect') cta('Connect to Google Drive', () => this.askConnect());
    else if (e.kind === 'client') cta('Use a client ID of my own', () => this.askConnect('own'));
    else if (e.kind === 'rclone') cta('Find or download rclone', () => this.askRclone());
    else if (e.kind === 'deletes') {
      cta('Sync anyway', () => this.syncNow({ force: true }));
    } else if (['check', 'empty', 'resync', 'folder', 'setup'].includes(e.kind)) cta('Set up the sync again', () => this.setupAgain());
    else if (e.kind === 'stopped') cta('Start again', () => this.start());
    else if (e.kind !== 'name') cta('Try again', () => this.start());
    if (e.kind !== 'stopped') this.reportButton(row);
    this.closeButton(row);
  }

  async start() {
    if (!this.plugin.onDesktop()) { this.page(SYNC_MOBILE); this.closeButton(this.buttons()); return; }
    this.kit = this.plugin.syncKit();
    this.wait('Looking for rclone…');
    try { this.api = await this.plugin.syncApi(); } catch (e) {
      if (e.kind === 'rclone' && e.missing) { this.askRclone(); return; }
      throw e;
    }
    if (!this.alive()) return;
    if (this.mode === 'status' && this.plugin.syncLink()) { this.showStatus(); return; }
    if (!this.api.connection().connected) { this.askConnect(); return; }
    this.connected();
  }

  /* What comes after the sign-in. */
  connected() {
    if (this.mode === 'connect') {
      this.page('This computer is signed in to Google Drive.');
      const row = this.buttons();
      row.createEl('button', { cls: 'mod-cta', text: 'Sync this vault…' }).addEventListener('click', () => { this.mode = 'setup'; this.titleEl.setText(SYNC_TITLES.setup); this.go(() => this.connected()); });
      this.closeButton(row);
      return;
    }
    const link = this.plugin.syncLink();
    if (this.mode === 'retrieve') { this.browse(); return; }
    if (link && link.first && !this.again) { this.showStatus(); return; }
    if (link && !this.again) { this.link = link; this.go(() => this.preview()); return; }
    this.browse(link);
  }

  setupAgain() {
    this.again = true;
    this.mode = 'setup';
    this.titleEl.setText(SYNC_TITLES.setup);
    return this.start();
  }

  /* ----- rclone ----- */

  askRclone(problem) {
    const k = this.kit, el = this.page();
    const asset = rcloneAsset(k.platform, k.arch);
    el.createEl('p', { text: 'Scriptorium syncs with Google Drive by running rclone, a free program (MIT licence) made for exactly this. It is not on this computer yet, or not where Scriptorium looked.' });
    if (problem) el.createEl('p', { cls: 'scriptorium-setup-problem', text: problem });
    if (asset) {
      el.createEl('p', { text: `Scriptorium can download it for you: rclone ${RCLONE.version} for ${{ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[k.platform] || k.platform} (${k.arch}), ${driveBytes(asset.bytes)}, from downloads.rclone.org. ` +
        'The file is checked against the SHA-256 that rclone published for this version before anything is run; if it differs it is deleted. It is unpacked here, outside every vault:' });
      el.createEl('p', { cls: 'scriptorium-setup-where', text: this.kit.path.dirname(k.paths.exe) });
      const d = el.createEl('details', { cls: 'scriptorium-drive-skipped' });
      d.createEl('summary', { text: 'The file and its SHA-256' });
      d.createEl('pre', { cls: 'scriptorium-setup-plan', text: `${asset.urls[0]}\nSHA-256 ${asset.sha256}\nLicence: MIT (https://rclone.org/licence/)` });
    } else {
      el.createEl('p', { text: `There is no ready-made rclone for this kind of computer (${k.platform} ${k.arch}) that Scriptorium knows of. Install it from rclone.org/downloads and give its path below.` });
    }
    el.createEl('p', { cls: 'scriptorium-setup-note', text: 'Or, if rclone is already installed somewhere else, give the path to the program:' });
    const rowIn = el.createDiv({ cls: 'scriptorium-setup-row' });
    const input = rowIn.createEl('input', { type: 'text', cls: 'scriptorium-setup-path', attr: { placeholder: k.platform === 'win32' ? 'C:\\…\\rclone.exe' : '/…/rclone', 'aria-label': 'Path to rclone', spellcheck: 'false' } });
    input.value = k.device().rclone || '';
    const dialog = setupDialog();
    if (dialog) {
      rowIn.createEl('button', { text: 'Browse…' }).addEventListener('click', async () => {
        try {
          const r = await dialog.showOpenDialog({ title: 'Choose the rclone program', properties: ['openFile'] });
          if (r && !r.canceled && r.filePaths && r.filePaths[0]) { input.value = r.filePaths[0]; input.focus(); }
        } catch (e) { new Notice('Could not open the file chooser: type the path instead.'); }
      });
    }
    const row = this.buttons();
    if (asset) row.createEl('button', { cls: 'mod-cta', text: `Download rclone (${driveBytes(asset.bytes)})` }).addEventListener('click', () => this.go(() => this.download(asset)));
    row.createEl('button', { cls: asset ? '' : 'mod-cta', text: 'Use the path above' }).addEventListener('click', () => this.go(async () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      k.setDevice({ rclone: v });
      try { this.api = await this.plugin.syncApi(true); } catch (e) {
        k.setDevice({ rclone: '' });
        this.askRclone(`${e.message} ${e.next || ''}`.trim());
        return;
      }
      await this.start();
    }));
    this.closeButton(row, 'Cancel');
  }

  async download(asset) {
    const k = this.kit, el = this.page();
    const stage = el.createEl('p', { cls: 'scriptorium-drive-stage', text: 'Downloading rclone…' });
    const bar = el.createEl('progress', { cls: 'scriptorium-drive-bar', attr: { max: String(asset.bytes), value: '0' } });
    this.buttons().createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    let shown = 0;
    await rcloneInstall({ fs: k.fs, path: k.path, crypto: k.crypto, zlib: k.zlib, https: k.https, asset, exe: k.paths.exe, signal: this.stop.signal,
      onProgress: (n, of) => { if (n - shown > 256 * 1024 || n === of) { shown = n; bar.value = n; stage.setText(`Downloading rclone… ${driveBytes(n)} of ${driveBytes(of)}`); } } });
    if (!this.alive()) return;
    k.setDevice({ rclone: '' });
    this.plugin.syncNote('rclone downloaded and checked');
    await this.start();
  }

  /* ----- The sign-in ----- */

  askConnect(way) {
    const el = this.page(), conn = this.api.connection();
    el.createEl('p', { text: 'Sign in to Google in your browser, once. After that you pick the folder in your Drive that this vault is kept in.' });
    el.createEl('p', { cls: 'scriptorium-setup-note', text: SYNC_PRIVACY });
    el.createEl('p', { cls: 'scriptorium-setup-note', text: SYNC_UNVERIFIED });
    const pick = el.createDiv({ cls: 'scriptorium-drive-vaults' });
    const choice = (value, title, text) => {
      const label = pick.createEl('label', { cls: 'scriptorium-drive-vault' });
      const radio = label.createEl('input', { type: 'radio', attr: { name: 'scriptorium-sync-client', value } });
      const t = label.createDiv();
      t.createDiv({ cls: 'scriptorium-drive-vault-name', text: title });
      t.createDiv({ cls: 'scriptorium-setup-note', text });
      return radio;
    };
    const shared = choice('shared', 'The quick way: rclone’s own sign-in', SYNC_SHARED_CLIENT);
    const own = choice('own', 'A client ID of my own (what rclone recommends)', 'You make a small Google “app” that only you use. Ten minutes, once; it does not cost anything. Steps below.');
    const guide = el.createDiv({ cls: 'scriptorium-drive-guide' });
    const ol = guide.createEl('ol', { cls: 'scriptorium-drive-steps' });
    for (const [text, href] of SYNC_CLIENT_STEPS) {
      const li = ol.createEl('li', { text });
      if (href) { li.createEl('br'); li.createEl('a', { text: href, href }); }
    }
    const id = guide.createEl('textarea', { cls: 'scriptorium-drive-client', attr: { rows: '2', placeholder: 'Client ID (…apps.googleusercontent.com), or the whole JSON file', 'aria-label': 'Client ID', spellcheck: 'false' } });
    const secret = guide.createEl('input', { type: 'password', cls: 'scriptorium-drive-secret', attr: { placeholder: 'Client secret (GOCSPX-…)', 'aria-label': 'Client secret', spellcheck: 'false', autocomplete: 'off' } });
    if (conn.own) id.value = conn.client;
    const said = el.createEl('p', { cls: 'scriptorium-setup-problem', text: '' });
    const show = () => { guide.style.display = own.checked ? '' : 'none'; said.setText(''); };
    (way === 'own' || conn.own ? own : shared).checked = true;
    shared.addEventListener('change', show); own.addEventListener('change', show);
    show();
    const row = this.buttons();
    row.createEl('button', { cls: 'mod-cta', text: 'Sign in with Google' }).addEventListener('click', () => {
      let client = null;
      if (own.checked) {
        const c = syncParseClient(id.value, secret.value);
        if (c.problem) { said.setText(c.problem); return; }
        client = { id: c.id, secret: c.secret };
      }
      this.go(() => this.connect(client));
    });
    this.closeButton(row, 'Cancel');
  }

  async connect(client) {
    const el = this.page();
    el.createEl('p', { cls: 'scriptorium-drive-wait', text: 'Your browser is opening Google’s sign-in page. Choose the account, allow access, and come back: this window carries on by itself.' });
    const linkRow = el.createDiv({ cls: 'scriptorium-setup-row' });
    el.createEl('p', { cls: 'scriptorium-setup-note', text: client ? 'If Google says it has not verified this app: it is your own, so choose Advanced → Go to (its name).'
      : 'If Google’s page says “Access blocked”, “deleted_client” or “This app is blocked”, rclone’s shared sign-in has been retired: cancel, and choose “A client ID of my own”.' });
    el.createEl('p', { cls: 'scriptorium-setup-note', text: `The browser may end on a page at 127.0.0.1:${RCLONE.port} that says “Success”: that is rclone on this computer, taking Google’s answer.` });
    const ctl = new AbortController();
    this.stop.signal.addEventListener('abort', () => ctl.abort(), { once: true });
    const row = this.buttons();
    row.createEl('button', { text: 'Cancel' }).addEventListener('click', () => ctl.abort());
    this.plugin.syncNote('sign-in started', [client ? 'own client ID' : 'shared client ID']);
    await this.api.connect(client, url => {
      if (linkRow.childElementCount || !this.alive()) return;
      linkRow.createEl('button', { text: 'Open the sign-in page again' }).addEventListener('click', () => this.plugin.openInBrowser(url));
      linkRow.createEl('button', { text: 'Copy its address' }).addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(url); new Notice('Copied. Paste it into a browser on this computer.'); } catch (e) { new Notice(url, 15000); }
      });
    }, ctl.signal);
    this.plugin.syncNote('signed in');
    // A sync that was waiting for the sign-in goes on by itself.
    const engine = this.plugin.engine, was = engine.state.problem;
    if (was && (was.kind === 'connect' || was.kind === 'client')) { engine.set({ status: 'idle', problem: null }); engine.start(false); void engine.run('manual'); }
    this.plugin.refreshSync();
    if (this.alive()) this.connected();
  }

  /* ----- The folder ----- */

  browse(link) {
    if (!this.browser) {
      const at = link ? { root: link.root, driveId: link.driveId, driveName: link.driveName, parts: String(link.path).split('/').filter(Boolean).slice(0, -1) } : null;
      this.browser = new SyncBrowser(this.api, at);
    }
    this.go(() => this.showFolder());
  }

  async showFolder(fresh) {
    const b = this.browser, retrieve = this.mode === 'retrieve';
    const el = this.page(retrieve ? 'Which folder in your Drive holds the vault? Open it, then choose it.' : 'Choose the folder in your Drive to keep this vault in: an empty or new folder for a first backup, or the folder that already holds this vault.');
    // Where we are: each part can be clicked
    const crumbs = el.createDiv({ cls: 'scriptorium-sync-crumbs' });
    const rootName = b.at.root === 'shared' ? 'Shared with me' : b.at.root === 'drive' ? b.at.driveName : 'My Drive';
    [rootName].concat(b.at.parts).forEach((name, i, all) => {
      if (i) crumbs.createSpan({ text: ' › ' });
      if (i === all.length - 1) crumbs.createEl('strong', { text: name });
      else crumbs.createEl('a', { text: name, href: '#' }).addEventListener('click', ev => { ev.preventDefault(); b.jump(i); this.go(() => this.showFolder()); });
    });
    const list = el.createDiv({ cls: 'scriptorium-sync-folders' });
    list.createDiv({ cls: 'scriptorium-drive-wait', text: 'Reading the folders…' });
    const said = el.createEl('p', { cls: 'scriptorium-setup-problem', text: '' });
    const row = this.buttons();
    const choose = row.createEl('button', { cls: 'mod-cta', text: b.canChoose() ? `Use “${b.at.parts[b.at.parts.length - 1]}”` : 'Open a folder to choose it' });
    choose.disabled = !b.canChoose();
    choose.addEventListener('click', () => { this.link = b.link(); this.go(() => retrieve ? this.askTarget() : this.preview()); });
    const make = row.createEl('button', { text: 'New folder here…' });
    if (retrieve) make.style.display = 'none';
    const roots = row.createEl('button', { text: 'Other places…' });
    this.closeButton(row, 'Cancel');
    make.addEventListener('click', () => {
      if (el.querySelector('.scriptorium-sync-new')) return;
      const r = el.createDiv({ cls: 'scriptorium-setup-row scriptorium-sync-new' });
      list.after(r);
      const input = r.createEl('input', { type: 'text', cls: 'scriptorium-setup-path', attr: { placeholder: 'The new folder’s name', 'aria-label': 'The new folder’s name' } });
      input.value = b.at.parts.length ? '' : this.plugin.app.vault.getName();
      const ok = r.createEl('button', { text: 'Make it' });
      const doIt = () => this.go(async () => {
        ok.disabled = true;
        try { await b.create(input.value, this.stop.signal); } catch (e) {
          ok.disabled = false;
          if (e.kind === 'name') { said.setText(`${e.message} ${e.next || ''}`.trim()); input.focus(); return; }
          throw e;
        }
        await this.showFolder();
      });
      ok.addEventListener('click', doIt);
      input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); doIt(); } });
      input.focus();
    });
    roots.addEventListener('click', () => this.go(async () => {
      roots.disabled = true;
      const all = await b.roots(this.stop.signal);
      if (!this.alive()) return;
      list.empty();
      for (const r of all) {
        list.createEl('button', { cls: 'scriptorium-sync-folder', text: r.name }).addEventListener('click', () => { b.setRoot(r.root, r.drive); this.go(() => this.showFolder()); });
      }
    }));
    const dirs = await b.list(this.stop.signal, fresh);
    if (!this.alive() || !list.isConnected) return;
    list.empty();
    if (b.at.parts.length) list.createEl('button', { cls: 'scriptorium-sync-folder scriptorium-sync-up', text: '↑ Up' }).addEventListener('click', () => { b.up(); this.go(() => this.showFolder()); });
    if (!dirs.length) list.createDiv({ cls: 'scriptorium-setup-note', text: b.at.parts.length ? 'No folders in here. (Files are not shown.)' : 'No folders here yet.' });
    for (const d of dirs) {
      list.createEl('button', { cls: 'scriptorium-sync-folder', text: d.name }).addEventListener('click', () => { b.enter(d.name); this.go(() => this.showFolder()); });
    }
  }

  /* ----- The first sync ----- */

  async preview() {
    const k = this.kit, link = this.link;
    this.wait(`Looking at both sides: this vault, and ${syncWhere(link)}…`);
    const settings = syncSettings(this.plugin.settings);
    const pv = await syncPreview({ api: this.api, fs: k.fs, path: k.path, paths: k.paths, id: k.id, dir: k.dir, link, settings, signal: this.stop.signal });
    if (!this.alive()) return;
    const el = this.page();
    el.createEl('p', { text: 'This is what the first sync will do. Nothing has been changed yet.' });
    const ul = el.createEl('ul', { cls: 'scriptorium-drive-plan' });
    ul.createEl('li', { text: `This vault: ${driveCount(pv.local.count, 'file')}, ${driveBytes(pv.local.bytes)}.` });
    ul.createEl('li', { text: `${syncWhere(link)}: ${driveCount(pv.drive.count, 'file')}, ${driveBytes(pv.drive.bytes)}.` });
    if (pv.onlyLocal) ul.createEl('li', { text: `${driveCount(pv.onlyLocal, 'file is', 'files are')} only on this computer: copied up to Drive.` });
    if (pv.onlyDrive) ul.createEl('li', { text: `${driveCount(pv.onlyDrive, 'file is', 'files are')} only in the Drive folder: copied down to this vault.` });
    if (pv.same) ul.createEl('li', { text: `${driveCount(pv.same, 'file is', 'files are')} the same on both sides: left alone.` });
    let keep = 'both';
    if (pv.differ.length) {
      const li = ul.createEl('li', { text: `${driveCount(pv.differ.length, 'file has', 'files have')} the same name on both sides but different contents:` });
      const pick = li.createDiv({ cls: 'scriptorium-drive-vaults' });
      for (const [value, title, text] of [
        ['both', 'Keep both (safest)', 'Drive’s version keeps the name; this computer’s is kept beside it as “name.conflict1.md”. Look them over and delete the one you do not want.'],
        ['local', 'Keep this computer’s version', 'It replaces the one in Drive (Drive keeps its earlier versions for a while).'],
        ['drive', 'Keep Drive’s version', 'It replaces the one here; the replaced files are kept for thirty days in Scriptorium’s own folder.'],
      ]) {
        const label = pick.createEl('label', { cls: 'scriptorium-drive-vault' });
        const radio = label.createEl('input', { type: 'radio', attr: { name: 'scriptorium-sync-keep', value } });
        radio.checked = value === 'both';
        radio.addEventListener('change', () => { if (radio.checked) keep = value; });
        const t = label.createDiv();
        t.createDiv({ cls: 'scriptorium-drive-vault-name', text: title });
        t.createDiv({ cls: 'scriptorium-setup-note', text });
      }
      const d = li.createEl('details', { cls: 'scriptorium-drive-skipped' });
      d.createEl('summary', { text: 'Which files' });
      d.createEl('pre', { cls: 'scriptorium-setup-plan', text: pv.differ.slice(0, 300).join('\n') + (pv.differ.length > 300 ? `\n… and ${pv.differ.length - 300} more` : '') });
    }
    if (pv.unread.length) ul.createEl('li', { text: `${driveCount(pv.unread.length, 'file')} could not be compared (they are treated as different, and the newer one is kept).` });
    el.createEl('p', { text: 'The first sync deletes nothing: afterwards each side holds everything from both.' });
    if (pv.local.count && pv.onlyDrive && !pv.same && !pv.differ.length) {
      el.createEl('p', { cls: 'scriptorium-setup-problem', text: 'These two folders have nothing in common. If that Drive folder is not meant for this vault, choose another: everything in it would be copied into this vault.' });
    }
    if (pv.onlyDrive > 5000 || pv.drive.bytes > 5e9) el.createEl('p', { cls: 'scriptorium-setup-problem', text: `That Drive folder is large (${driveBytes(pv.drive.bytes)}). All of it will be downloaded into this vault.` });
    el.createEl('p', { cls: 'scriptorium-setup-note', text: `After this, the vault is synced by itself every ${settings.minutes === 1 ? 'minute' : `${settings.minutes} minutes`} and shortly after you change a note${settings.auto ? '' : ' (automatic syncing is off in the settings: until you turn it on, only when you ask)'}. ` +
      `Not synced: Obsidian’s window layout and caches, .trash, hidden folders, Lagrange’s settings (API keys)${settings.obsidian ? '' : ', Obsidian’s settings'}, and Google Docs.` });
    const row = this.buttons();
    row.createEl('button', { cls: 'mod-cta', text: 'Start syncing' }).addEventListener('click', () => this.go(() => this.first(pv, keep)));
    row.createEl('button', { text: 'Choose another folder' }).addEventListener('click', () => this.browse(link));
    this.closeButton(row, 'Cancel');
  }

  /* A page with a line of what is happening and a bar. Returns onLine for rclone's log. */
  progress(text) {
    const el = this.page();
    const stage = el.createEl('p', { cls: 'scriptorium-drive-stage', text });
    const bar = el.createEl('progress', { cls: 'scriptorium-drive-bar' });
    const detail = el.createEl('p', { cls: 'scriptorium-setup-note', text: '' });
    this.buttons().createEl('button', { text: 'Stop' }).addEventListener('click', () => this.close());
    const stats = s => {
      if (s.totalBytes > 0) { bar.max = s.totalBytes; bar.value = s.bytes; }
      detail.setText(`${s.transfers || 0} of ${s.totalTransfers || 0} files, ${driveBytes(s.bytes || 0)}${s.totalBytes ? ` of ${driveBytes(s.totalBytes)}` : ''}`);
    };
    return { stage, stats, onLine: l => { if (l.stats) stats(l.stats); } };
  }

  async first(pv, keep) {
    const k = this.kit, link = this.link, settings = syncSettings(this.plugin.settings);
    const p = this.progress('Syncing for the first time…');
    await this.plugin.engine.running;   // a timer's run of an earlier link ends first
    const r = await syncFirst({ api: this.api, fs: k.fs, path: k.path, paths: k.paths, id: k.id, dir: k.dir, link, settings, differ: pv.differ, taken: pv.taken, keep,
      now: () => Date.now(), pid: process.pid, alive: k.alive, onLine: p.onLine, signal: this.stop.signal });
    this.plugin.saveSyncLink(Object.assign({}, link, { linked: link.linked || new Date().toISOString(), first: new Date().toISOString() }));
    this.plugin.engine.set({ status: 'idle', last: Date.now(), summary: r.summary, problem: null });
    this.plugin.engine.start(false);
    if (!this.contentEl.isConnected) return;
    const el = this.page('This vault and its Drive folder now hold the same files.');
    el.createEl('p', { cls: 'scriptorium-setup-where', text: syncWhere(link) });
    el.createEl('p', { text: `First sync: ${syncSummaryText(r.summary)}.` });
    if (r.renamed.length) {
      el.createEl('p', { text: `${driveCount(r.renamed.length, 'file')} differed and ${r.renamed.length === 1 ? 'was' : 'were'} kept twice. This computer’s version is now:` });
      el.createEl('pre', { cls: 'scriptorium-setup-plan', text: r.renamed.slice(0, 100).map(x => x[1]).join('\n') });
    }
    el.createEl('p', { cls: 'scriptorium-setup-note', text: 'From now on the status bar at the bottom says “Drive: synced” and the time. Click it to sync at once, or to see conflicts and problems.' });
    const row = this.buttons();
    row.createEl('button', { cls: 'mod-cta', text: 'Done' }).addEventListener('click', () => this.close());
  }

  /* ----- Syncing now, and the state of things ----- */

  async syncNow(opts) {
    this.wait('Syncing…', false);
    const row = this.buttons();
    row.createEl('button', { text: 'Close (the sync carries on)' }).addEventListener('click', () => this.close());
    const r = await this.plugin.engine.run('manual', opts);
    if (!this.contentEl.isConnected) return;
    if (r && r.problem) { this.fail(r.problem); return; }
    this.showStatus(r && r.skipped === 'busy' ? 'Another sync of this vault is running in another window; this one did not start.' : '');
  }

  showStatus(note) {
    const plugin = this.plugin, link = plugin.syncLink(), st = plugin.engine.state, settings = syncSettings(plugin.settings);
    const el = this.page();
    if (!link) { this.go(() => this.connected()); return; }
    el.createEl('p', { text: 'This vault is kept in step with:' });
    el.createEl('p', { cls: 'scriptorium-setup-where', text: syncWhere(link) });
    if (note) el.createEl('p', { text: note });
    const line = st.status === 'syncing' ? 'Syncing now…'
      : st.status === 'problem' && st.problem ? `The last sync did not finish: ${st.problem.message}`
        : st.last ? `Last synced ${new Date(st.last).toLocaleString()}: ${st.summary ? syncSummaryText(st.summary) : 'done'}.` : 'Not synced yet since Obsidian started.';
    el.createEl('p', { cls: st.status === 'problem' ? 'scriptorium-setup-problem' : '', text: line });
    if (st.status === 'problem' && st.problem) {
      if (st.problem.cause2) { const p = el.createEl('p'); p.createEl('strong', { text: 'Likely cause: ' }); p.appendText(st.problem.cause2); }
      if (st.problem.next) { const p = el.createEl('p'); p.createEl('strong', { text: 'What to do: ' }); p.appendText(st.problem.next); }
    }
    el.createEl('p', { cls: 'scriptorium-setup-note', text: settings.auto ? `Synced by itself every ${settings.minutes === 1 ? 'minute' : `${settings.minutes} minutes`}, shortly after a note changes, and when Obsidian starts.` : 'Automatic syncing is off (Settings → Scriptorium): the vault is synced only when you ask.' });
    const conflicts = plugin.syncConflicts();
    if (conflicts.length) {
      el.createEl('p', { text: `${driveCount(conflicts.length, 'file was', 'files were')} changed on both sides; the older version of each was kept under a “conflict” name. Compare them, keep what you want, and delete the conflict copy:` });
      const list = el.createDiv({ cls: 'scriptorium-sync-folders' });
      for (const f of conflicts.slice(0, 50)) {
        list.createEl('button', { cls: 'scriptorium-sync-folder', text: f }).addEventListener('click', () => { void plugin.app.workspace.openLinkText(f, '', true); this.close(); });
      }
      if (conflicts.length > 50) el.createEl('p', { cls: 'scriptorium-setup-note', text: `… and ${conflicts.length - 50} more.` });
    }
    const row = this.buttons();
    const p = st.problem;
    if (st.status === 'problem' && p && p.kind === 'deletes') row.createEl('button', { cls: 'mod-cta', text: 'Sync anyway' }).addEventListener('click', () => this.go(() => this.syncNow({ force: true })));
    else if (st.status === 'problem' && p && p.kind === 'connect') row.createEl('button', { cls: 'mod-cta', text: 'Connect to Google Drive' }).addEventListener('click', () => this.go(() => this.askConnect()));
    else if (st.status === 'problem' && p && p.kind === 'client') row.createEl('button', { cls: 'mod-cta', text: 'Use a client ID of my own' }).addEventListener('click', () => this.go(() => this.askConnect('own')));
    else if (st.status === 'problem' && p && p.kind === 'rclone') row.createEl('button', { cls: 'mod-cta', text: 'Find or download rclone' }).addEventListener('click', () => this.go(() => this.askRclone()));
    else if (st.status === 'problem' && p && ['check', 'empty', 'resync', 'folder', 'setup'].includes(p.kind)) row.createEl('button', { cls: 'mod-cta', text: 'Set up the sync again' }).addEventListener('click', () => this.go(() => this.setupAgain()));
    else row.createEl('button', { cls: 'mod-cta', text: 'Sync now' }).addEventListener('click', () => this.go(() => this.syncNow()));
    row.createEl('button', { text: 'Replaced files…' }).addEventListener('click', () => {
      const dir = this.kit.path.join(this.kit.paths.kept, this.kit.id);
      try { this.kit.fs.mkdirSync(dir, { recursive: true }); void require('electron').shell.openPath(dir); } catch (e) { new Notice(dir, 10000); }
    });
    row.createEl('button', { text: 'Choose another folder' }).addEventListener('click', () => this.go(() => this.setupAgain()));
    row.createEl('button', { text: 'Stop syncing this vault' }).addEventListener('click', () => {
      plugin.saveSyncLink(null);
      plugin.engine.start(false);
      this.page('This vault is no longer synced. Its files stay as they are, here and in Google Drive. This computer is still signed in to Google (Settings → Scriptorium → Disconnect removes that).');
      this.closeButton(this.buttons());
    });
    this.reportButton(row);
    this.closeButton(row);
  }

  /* ----- Retrieving a vault ----- */

  askTarget() {
    const k = this.kit, link = this.link;
    const name = link.path.split('/').pop();
    const el = this.page('Where should the vault go on this computer? A new or empty folder: retrieving never writes over what is already there.');
    el.createEl('p', { cls: 'scriptorium-setup-where', text: syncWhere(link) });
    const parent = k.path.dirname(k.dir);
    const row = el.createDiv({ cls: 'scriptorium-setup-row' });
    const input = row.createEl('input', { type: 'text', cls: 'scriptorium-setup-path', attr: { placeholder: 'The new vault’s folder', 'aria-label': 'The new vault’s folder', spellcheck: 'false' } });
    let suggested = k.path.join(parent, name);
    for (let n = 2; k.fs.existsSync(suggested) && n < 50; n++) suggested = k.path.join(parent, `${name} ${n}`);
    input.value = suggested;
    const dialog = setupDialog();
    if (dialog) {
      row.createEl('button', { text: 'Browse…' }).addEventListener('click', async () => {
        try {
          const r = await dialog.showOpenDialog({ title: 'Choose a new or empty folder for the vault', defaultPath: parent, properties: ['openDirectory', 'createDirectory', 'promptToCreate'] });
          if (r && !r.canceled && r.filePaths && r.filePaths[0]) { input.value = r.filePaths[0]; said.setText(''); input.focus(); }
        } catch (e) { new Notice('Could not open the folder chooser: type the folder’s path instead.'); }
      });
    }
    const said = el.createEl('p', { cls: 'scriptorium-setup-problem', text: '' });
    const buttons = this.buttons();
    const go = buttons.createEl('button', { cls: 'mod-cta', text: 'Retrieve' });
    buttons.createEl('button', { text: 'Choose another folder in Drive' }).addEventListener('click', () => this.go(() => this.showFolder()));
    this.closeButton(buttons, 'Cancel');
    go.addEventListener('click', () => this.go(async () => {
      const dir = setupFolder(k.path, input.value);
      if (!dir) { said.setText(`Give the folder’s full path, from the ${k.platform === 'win32' ? 'drive letter (for example C:\\Users\\you\\Documents\\My vault)' : 'first / (for example /Users/you/Documents/My vault)'}.`); input.focus(); return; }
      go.disabled = true;
      said.setText('Looking at the Drive folder…');
      k.fs.mkdirSync(k.paths.filters, { recursive: true });
      const filters = k.path.join(k.paths.filters, 'retrieve.txt');
      k.fs.writeFileSync(filters, syncFilters(SYNC_DEFAULTS));
      const size = await this.api.size(link, filters, this.stop.signal);
      go.disabled = false;
      if (!size.count) { said.setText('That Drive folder has no files in it (Google Docs do not count). Choose the folder that holds the vault.'); return; }
      const why = driveTargetProblem(k.fs, k.path, dir, size.bytes);
      if (why) { said.setText(why); input.focus(); return; }
      await this.retrieve(dir, filters, size);
    }));
  }

  async retrieve(dir, filters, size) {
    const k = this.kit, link = this.link;
    const p = this.progress(`Retrieving ${driveCount(size.count, 'file')}, ${driveBytes(size.bytes)}…`);
    k.fs.mkdirSync(dir, { recursive: true });
    await this.api.copy(link, dir, filters, p.stats, this.stop.signal);
    // The vault is made a Scriptorium vault with the same code as "Set up another vault".
    let setup = '';
    try {
      const plan = planVaultSetup(k.fs, k.path, setupPackage(k.fs, k.path, k.dir), dir);
      applyVaultSetup(k.fs, k.path, dir, plan);
      setup = 'Scriptorium’s theme, snippet and plugins are set up in it.';
      try { const note = diagramPluginsNote(await installDiagramPlugins(k.fs, k.path, require('crypto'), dir, fetchRelease)); if (note) setup += ` ${note}`; } catch (e) { /* the vault is set up without them */ }
    } catch (e) {
      setup = 'Scriptorium could not be set up in it; run “Scriptorium: Set up another vault” on it.';
      this.plugin.syncNote('setting up the retrieved vault failed', [String(e && e.message)]);
    }
    // Then it is linked to the Drive folder it came from, so that it stays in step from now on.
    p.stage.setText('Linking the new vault to its Drive folder…');
    let linked = '';
    try {
      const id = syncVaultId(k.crypto, k.path, dir, k.platform);
      const theirs = syncSettings(syncReadJson(k.fs, k.path.join(dir, '.obsidian', 'plugins', 'scriptorium', 'data.json')));
      await syncFirst({ api: this.api, fs: k.fs, path: k.path, paths: k.paths, id, dir, link, settings: theirs, differ: [], keep: 'both',
        now: () => Date.now(), pid: process.pid, alive: k.alive, onLine: p.onLine, signal: this.stop.signal });
      const now = new Date().toISOString();
      syncSaveLink(k.fs, k.path, k.paths.vaults, id, Object.assign({}, link, { linked: now, first: now }));
      linked = 'It is linked to that Drive folder: once it is open, it syncs by itself.';
    } catch (e) {
      linked = 'It could not be linked to the Drive folder yet: open it and run “Scriptorium: Sync this vault with Google Drive”.';
      this.plugin.syncNote('linking the retrieved vault failed', e && e.tail);
    }
    if (!this.contentEl.isConnected) return;
    const el = this.page('The vault is on this computer:');
    el.createEl('p', { cls: 'scriptorium-setup-where', text: dir });
    el.createEl('p', { text: `${setup} ${linked} When Obsidian asks, choose “Trust author and enable plugins”.` });
    const row = this.buttons();
    row.createEl('button', { cls: 'mod-cta', text: 'Open the vault' }).addEventListener('click', () => {
      if (openVaultWindow(dir)) this.close();
      else new Notice('Could not open it from here: in the vault switcher, choose “Open folder as vault” and pick that folder.', 10000);
    });
    row.createEl('button', { text: 'Show the folder' }).addEventListener('click', () => { try { void require('electron').shell.openPath(dir); } catch (e) { new Notice(dir, 10000); } });
    this.closeButton(row);
  }
}

/* ==========================================================
   A family whose upright face is missing
   ==========================================================
   The typography asks the system for EB Garamond and Cormorant Garamond. If a family is there with only its italic
   face (a font that was half installed, or half removed), the system gives the italic for upright text too: every
   heading, or all the text, stands in italics, and nothing says why. So once Obsidian has started, a capital I is
   drawn upright in each family and measured: if the family is there and the letter leans, a notice says so, once,
   and says what mends it (Scriptorium Setup and the script installers repair the fonts face by face). */

/* How far the ink leans to the right, as run over rise: about 0 for an upright letter, 0.15 or more for an italic.
   data is RGBA (ink is whatever has alpha). The top and the bottom fifth of the inked rows are compared. null if
   there is too little ink to say. */
function inkSlant(data, width, height) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    let sum = 0, n = 0;
    for (let x = 0; x < width; x++) { const a = data[(y * width + x) * 4 + 3]; if (a > 40) { sum += x * a; n += a; } }
    if (n) rows.push([y, sum / n]);
  }
  if (rows.length < 20) return null;
  const k = Math.max(2, Math.floor(rows.length / 5));
  const mean = part => part.reduce((t, r) => [t[0] + r[0] / part.length, t[1] + r[1] / part.length], [0, 0]);
  const top = mean(rows.slice(0, k)), bottom = mean(rows.slice(-k));
  return (top[1] - bottom[1]) / (bottom[0] - top[0]);
}

/* Whether the family is on this computer but draws upright text leaning: true, false, or null where it cannot be told
   (the family is not there, or there is no canvas). */
function uprightMissing(doc, family) {
  try {
    const canvas = doc.createElement('canvas');
    canvas.width = 240; canvas.height = 200;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    // Is the family there at all? With it, a line is not as wide as in the fallback alone.
    const probe = 'Hamburgefonstiv 0123';
    g.font = '400 60px monospace';
    const fallback = g.measureText(probe).width;
    g.font = `400 60px "${family}", monospace`;
    if (Math.abs(g.measureText(probe).width - fallback) < 0.5) return null;
    g.clearRect(0, 0, 240, 200);
    g.font = `normal 400 150px "${family}"`;
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#000';
    g.fillText('I', 90, 160);
    const slant = inkSlant(g.getImageData(0, 0, 240, 200).data, 240, 200);
    return slant === null ? null : slant > 0.09;
  } catch (e) {
    return null;
  }
}

/* ==========================================================
   The plugin
   ========================================================== */

class Scriptorium extends Plugin {
  async onload() {
    const saved = await this.loadData(), moved = migrateSettings(saved);
    this.settings = normalizeSettings(moved.settings);
    if (moved.told) {
      // (once: the settings are saved with their mark, so this is not said again, and "off" chosen from now on holds)
      try { await this.saveData(this.settings); } catch (e) { console.error('Scriptorium: the settings could not be saved', e); }
      new Notice('Scriptorium now shows drop caps while you edit (Live Preview), as Reading view does. To have the editor plain again, turn off Settings → Scriptorium → Show drop caps while editing.', 20000);
    }
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
      id: 'toggle-live-dropcaps',
      name: 'Toggle drop caps while editing (Live Preview)',
      callback: async () => {
        await this.updateSettings({ liveDropcaps: !this.settings.liveDropcaps });
        new Notice(this.settings.liveDropcaps ? 'Drop caps are shown while editing, in Live Preview.' : 'Drop caps are shown in Reading view only.');
      }
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
    // Syncing with Google Drive through rclone (new). On a phone or tablet the commands say why they cannot run there.
    // The ids are those of the older backup, so that a hotkey given to one of them still works.
    this.syncRuns = [];
    this.engine = new SyncEngine({
      run: (reason, opts) => this.syncRun(reason, opts),
      settings: () => syncSettings(this.settings),
      linked: () => { const l = this.syncLink(); return Boolean(l && l.first); },
      onState: () => this.refreshSync(),
    });
    this.syncBar = this.addStatusBarItem();
    this.syncBar.addClass('scriptorium-sync-status');
    this.syncBar.setAttribute('role', 'button');
    this.syncBar.setAttribute('tabindex', '0');
    this.registerDomEvent(this.syncBar, 'click', () => new SyncModal(this, 'status').open());
    this.registerDomEvent(this.syncBar, 'keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); new SyncModal(this, 'status').open(); } });
    for (const [id, mode, name] of [
      ['drive-back-up', 'setup', 'Sync this vault with Google Drive (set up, or see how it is doing)'],
      ['drive-retrieve', 'retrieve', 'Retrieve a vault from Google Drive'],
      ['drive-connect', 'connect', 'Connect to Google Drive (sign in to Google)'],
    ]) this.addCommand({ id, name, callback: () => new SyncModal(this, mode).open() });
    this.addCommand({ id: 'drive-sync-now', name: 'Sync now with Google Drive', callback: () => this.syncNowCommand() });
    this.addCommand({ id: 'drive-report', name: 'Copy the Google Drive diagnostic report', callback: () => this.copyDriveReport() });
    if (this.onDesktop()) {
      for (const what of ['modify', 'create', 'delete', 'rename']) this.registerEvent(this.app.vault.on(what, () => this.engine.touch()));
      // Before Obsidian quits, what is waiting is synced, for a quarter of a minute at most.
      this.registerEvent(this.app.workspace.on('quit', tasks => {
        if (!this.engine.pending() || !tasks || typeof tasks.add !== 'function') return;
        tasks.add(() => Promise.race([this.engine.run('quit'), new Promise(done => setTimeout(done, SYNC_TIMES.quit))]).then(() => { if (this.syncStop) this.syncStop.abort(); }));
      }));
      this.app.workspace.onLayoutReady(() => { this.engine.start(true); this.refreshSync(); void this.tellAboutTheMove(); });
    }
    this.addSettingTab(new ScriptoriumSettings(this.app, this));

    // Re-check an opening paragraph whenever its box changes (first layout, pane resize, fonts arriving).
    this.kept = new Set();
    this.sections = new WeakMap();   // a block Reading view drew -> what it was drawn with, which knows the block's lines
    this.sizers = new Map();         // the blocks of a Reading view -> what watches them come and go (watchSizer)
    this.plans = [];                 // the alignment of the notes drawn last, by their text (planFor)
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
      if (isPrintPage(el)) return this.dressPrint(el, which, path, ctx && ctx.frontmatter); // Export to PDF: the whole page comes at once
      this.align(el, ctx);              // first: a marker line of aligned text is not the paragraph's first letter
      this.mark(el, which, path);
      el.querySelectorAll(':scope > p').forEach(p => { this.kept.add(p); this.resizeObserver.observe(p); });
    });
    // Export to PDF prints the note's title by default: tick Obsidian's "Include file name as title" once.
    this.app.workspace.onLayoutReady(() => { void this.includeTitleInPdf(); void this.loadDropcapSets(); window.setTimeout(() => void this.checkFontFaces(), 4000); });
    this.dropcapSets = [];   // the sets of drop caps beside the four built in (see "Sets of drop caps")
    this.ratios = new Map();  // an image's shape (width over height), by its address
    this.shapes = new Map();  // the shapes that are known by now (the editor asks without waiting)
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
    // Centred and right-aligned text (see "Centred and right-aligned text"): Live Preview's lines, and the commands.
    try { this.registerEditorExtension(alignExtension()); } catch (e) { console.error('Scriptorium: text is not aligned in Live Preview', e); }
    // Drop caps in the editor (see "Drop caps in Live Preview"): a setting, off unless the writer turns it on. What
    // is registered is a list that stays empty while it is off (the editor is then exactly as it is without this),
    // and holds the extension while it is on (applyLiveDropcaps).
    this.inking = new WeakMap();   // an editor -> the timer that ends its inking
    this.dropcapLive = null;       // the extension and its effects, while the setting is on
    this.liveExtensions = [];
    try { this.registerEditorExtension(this.liveExtensions); } catch (e) { console.error('Scriptorium: no drop caps in Live Preview', e); }
    for (const [id, name, kind] of [
      ['align-center', 'Centre selection', 'center'],
      ['align-right', 'Right-align selection', 'right'],
      ['align-remove', 'Remove alignment', null],
    ]) this.addCommand({ id, name, editorCallback: editor => this.alignCommand(editor, kind) });
    for (const [id, name, on] of [
      ['aligned-dropcap-on', 'Use a drop cap on this aligned paragraph', true],
      ['aligned-dropcap-off', 'Remove the drop cap from this aligned paragraph', false],
    ]) this.addCommand({ id, name, editorCheckCallback: (checking, editor) => this.alignDropcapCommand(editor, on, checking) });
    this.registerEvent(this.app.workspace.on('css-change', () => this.recheck()));
    if (document.fonts) this.registerDomEvent(document.fonts, 'loadingdone', () => this.recheck());

    this.marginalia = new Marginalia(this);
    this.marginalia.load();
    this.imageFocus = new ImageFocus(this);
    this.imageFocus.load();
    this.applyMode();
    this.applyFeatures();
  }

  /* Whether this is Obsidian on a computer, with a vault in a folder: the backup needs Node. */
  onDesktop() {
    return !(Platform && Platform.isDesktopApp === false) && Boolean(this.app.vault.adapter && this.app.vault.adapter.basePath);
  }

  /* What the sync needs of this computer, made from Node's modules when first asked for: where Scriptorium's own
     folder is, this vault's folder and its short name there, and the settings that belong to this computer alone
     (the path to rclone), which are kept in that folder and not in the vault. */
  syncKit() {
    if (this.kit) return this.kit;
    const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
    const home = os.homedir(), platform = process.platform, dir = this.app.vault.adapter.basePath;
    const paths = syncPaths(path, syncUserDir(path, process.env, platform, home), platform);
    const kit = {
      fs, path, os, crypto, zlib: require('zlib'), https: require('https'), spawn: require('child_process').spawn,
      env: process.env, platform, arch: process.arch, home, paths, dir, id: syncVaultId(crypto, path, dir, platform),
      alive: pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } },
      device: () => syncReadJson(fs, paths.device),
      setDevice: patch => syncWriteJson(fs, path, paths.device, Object.assign(syncReadJson(fs, paths.device), patch)),
      get test() { const c = syncConnection(fs, paths.conf); return c.connected && c.type !== 'drive'; },
    };
    this.kit = kit;
    return kit;
  }

  /* rclone, found and asked for its version once (again after `fresh`, or when the path in the settings changed).
     Throws a problem in plain words; .missing when there is no rclone at all, so that the download can be offered. */
  async syncApi(fresh) {
    const k = this.syncKit(), custom = k.device().rclone || '';
    if (this.rcloneFound && !fresh && this.rcloneFound.custom === custom && k.fs.existsSync(this.rcloneFound.file)) return this.rcloneFound.api;
    const found = findRclone(k.fs, rcloneCandidates({ path: k.path, env: k.env, platform: k.platform, home: k.home, custom, exe: k.paths.exe }), k.platform);
    if (!found) {
      const e = custom
        ? syncProblem('rclone', 'There is no rclone at the path given in the settings.', 'The file was moved, or the path has a slip in it.', 'Correct the path in Settings → Scriptorium → rclone, or clear it and let Scriptorium find or download rclone.')
        : syncProblem('rclone', 'rclone is not on this computer yet.', 'Scriptorium syncs by running rclone, and did not find it.', 'Choose “Find or download rclone”.');
      e.missing = !custom;
      throw e;
    }
    const api = rcloneApi({ spawn: k.spawn, fs: k.fs, path: k.path, exe: found.file, paths: k.paths, env: k.env, log: r => this.syncLogRun(r) });
    const v = await api.version();
    this.rcloneFound = { file: found.file, kind: found.kind, version: v.join('.'), custom, api };
    return api;
  }

  syncLink() {
    if (!this.onDesktop()) return null;
    const k = this.syncKit();
    return syncLink(k.fs, k.paths.vaults, k.id);
  }

  saveSyncLink(link) {
    const k = this.syncKit();
    syncSaveLink(k.fs, k.path, k.paths.vaults, k.id, link);
    this.refreshSync();
  }

  /* What rclone was asked and how it ended, for the diagnostic report: the last forty calls. */
  syncLogRun(r) {
    this.syncRuns.push(Object.assign({ at: new Date().toISOString().slice(11, 19) }, r, { lines: (r.lines || []).filter(l => !l.stats).slice(-30) }));
    if (this.syncRuns.length > 40) this.syncRuns.splice(0, this.syncRuns.length - 40);
  }
  syncNote(what, lines) {
    this.syncLogRun({ what, ms: 0, code: 0, lines: (lines || []).map(m => ({ level: 'note', msg: String(m) })) });
  }

  /* One run of the sync for the engine. */
  async syncRun(reason, opts) {
    const k = this.syncKit(), api = await this.syncApi();
    this.syncStop = new AbortController();
    try {
      return await syncOnce({ api, fs: k.fs, path: k.path, paths: k.paths, id: k.id, dir: k.dir, link: this.syncLink(), settings: syncSettings(this.settings),
        force: Boolean(opts && opts.force), now: () => Date.now(), pid: process.pid, alive: k.alive, signal: this.syncStop.signal });
    } finally {
      this.syncStop = null;
    }
  }

  /* "Sync now": runs at once where the vault is set up, and says how it went; opens the set-up otherwise. */
  async syncNowCommand() {
    if (!this.onDesktop()) { new SyncModal(this, 'status').open(); return; }
    const link = this.syncLink();
    if (!link || !link.first) { new SyncModal(this, 'setup').open(); return; }
    const r = await this.engine.run('manual');
    if (r && r.problem) new SyncModal(this, 'status').open();
    else if (r && r.skipped === 'busy') new Notice('Another sync of this vault is already running.');
    else if (r && r.summary) new Notice(`Synced with Google Drive: ${syncSummaryText(r.summary)}.`);
  }

  /* The copies that a sync kept of files changed on both sides, by their names. */
  syncConflicts() {
    return this.app.vault.getFiles().map(f => f.path).filter(p => SYNC_CONFLICT.test(p)).sort();
  }

  /* The status bar's word on the sync. */
  refreshSync() {
    if (!this.syncBar) return;
    const t = syncStatusText(this.engine.state, Date.now());
    this.syncBar.setText(t.text);
    this.syncBar.style.display = t.text ? '' : 'none';
    this.syncBar.setAttribute('aria-label', t.title);
    this.syncBar.toggleClass('scriptorium-sync-problem', this.engine.state.status === 'problem');
  }

  /* Whether the older Google Drive backup was used in this vault (its settings or its record are there). */
  oldDriveBackup() {
    if (this.settings.drive && typeof this.settings.drive === 'object') return true;
    try { const k = this.syncKit(); return k.fs.existsSync(k.path.join(k.dir, '.obsidian', 'plugins', 'scriptorium', 'drive-sync.json')); } catch (e) { return false; }
  }

  /* Said once to those who used the older backup: how to move to the sync. */
  async tellAboutTheMove() {
    if (this.settings.syncMoveTold || !this.oldDriveBackup()) return;
    new Notice(`${SYNC_MOVED} (Settings → Scriptorium → Google Drive sync says this again.)`, 30000);
    await this.updateSettings({ syncMoveTold: true });
  }

  /* Says, once, that a family's upright face is missing on this computer (see "A family whose upright face is
     missing"). When the fonts are in order again the notice is armed again. */
  async checkFontFaces() {
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const missing = ['Cormorant Garamond', 'EB Garamond'].filter(family => uprightMissing(document, family) === true);
      this.fontFacesMissing = missing;
      if (!missing.length) { if (this.settings.fontNoticeTold) await this.updateSettings({ fontNoticeTold: false }); return; }
      if (this.settings.fontNoticeTold) return;
      const what = missing.includes('Cormorant Garamond') ? 'headings stand in italics' : 'the text stands in italics';
      new Notice(`${missing.join(' and ')}: the upright face is missing on this computer (only the italic is installed), so ${what}. ` +
        'Run Scriptorium Setup, or the installer script, again: it repairs the fonts. Then restart Obsidian.', 0);
      await this.updateSettings({ fontNoticeTold: true });
    } catch (e) { /* never in the way of writing */ }
  }

  /* Opens an address in the system's browser. */
  openInBrowser(url) {
    try { return require('electron').shell.openExternal(url); } catch (e) { window.open(url); return null; }
  }

  /* Puts the diagnostic report on the clipboard. */
  async copyDriveReport() {
    let text = 'Scriptorium: Google Drive sync diagnostic report\nThis is Obsidian on a phone or tablet, where the sync does not run.\n';
    if (this.onDesktop()) {
      const k = this.syncKit(), link = this.syncLink(), conn = syncConnection(k.fs, k.paths.conf), f = this.rcloneFound;
      text = syncReport({
        version: this.manifest && this.manifest.version, obsidian: typeof apiVersion === 'string' ? apiVersion : '', platform: k.platform, arch: k.arch, release: k.os.release(),
        rclone: f ? { kind: f.kind, version: f.version } : {}, connected: conn.connected, own: conn.own, type: conn.type,
        linked: Boolean(link), first: Boolean(link && link.first), where: link ? `${link.root === 'my' ? 'My Drive' : link.root === 'shared' ? 'Shared with me' : 'a shared drive'}, ${link.path.split('/').length} folders deep` : '',
        settings: syncSettings(this.settings), state: this.engine.state,
      }, this.syncRuns, k.home, [k.dir, k.dir.split('\\').join('/'), link ? link.path : '', this.app.vault.getName()]);
    }
    this.lastDriveReport = text;
    try { await navigator.clipboard.writeText(text); new Notice('The diagnostic report is copied. Paste it wherever you are asking for help.'); }
    catch (e) { new Notice('The report could not be copied to the clipboard.'); }
    return text;
  }

  /* Export to PDF (see "Export to PDF: the page as Reading view sets it"). The returned promise is awaited by Obsidian
     before it prints: by then the drop cap's font has loaded. */
  dressPrint(page, which, path, frontmatter) {
    const doc = page.ownerDocument, body = doc.body, s = this.settings;
    body.classList.toggle('scriptorium-fancy', s.fancyMode);
    for (const [value] of INITIALS) body.classList.toggle(`scriptorium-initials-${value}`, value === s.initials && value !== 'yinit');
    dressPrint(page, null);
    try { alignBlocks(page, noteAlign(frontmatter)); } catch (e) { /* printed as it is */ }
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
    const choice = this.dropcapChoice(which);
    const image = markDropcap(el, choice.which, choice.set, path);
    el.scriptoriumImage = image;
    if (!image) return Promise.resolve();
    return Promise.all([['light', '--scriptorium-dropcap-ratio'], ['dark', '--scriptorium-dropcap-ratio-dark']].map(([theme, name]) =>
      this.ratio(image[theme]).then(r => { if (r && el.scriptoriumImage === image) el.style.setProperty(name, String(r)); })));
  }

  /* What a note's choice of drop cap comes to: {which, set}. The note's own if it has one, else the vault's if that
     is a set (the four built in are classes on body, and need no mark). A set that is not in the vault counts as no
     choice. */
  dropcapChoice(which) {
    let set = which && which.startsWith('set:') ? this.findSet(which) : null;
    if (which && which.startsWith('set:') && !set) which = null;
    if (!which && this.settings.initials.startsWith('set:')) { set = this.findSet(this.settings.initials); which = set ? this.settings.initials : null; }
    return { which: which || null, set };
  }

  /* An image's shape if it is known already (the editor's lines are set at once, and set again when it is). */
  ratioKnown(url) {
    if (!url) return 0;
    if (this.shapes.has(url)) return this.shapes.get(url);
    if (!this.ratios.has(url)) void this.ratio(url).then(r => { if (r) this.refreshEditors(); });
    return 0;
  }

  /* "Show drop caps while editing (Live Preview)": puts the extension into the editors, or takes it out of them,
     at once (no restart). Off, nothing of it is in any editor. */
  applyLiveDropcaps() {
    const on = Boolean(this.settings.liveDropcaps);
    if (!this.liveExtensions || on === Boolean(this.dropcapLive)) return;
    try {
      this.liveExtensions.length = 0;
      this.dropcapLive = on ? dropcapExtension(this) : null;
      if (on) this.liveExtensions.push(this.dropcapLive.extension);
      this.app.workspace.updateOptions();
    } catch (e) { this.dropcapLive = null; this.liveExtensions.length = 0; console.error('Scriptorium: no drop caps in Live Preview', e); }
  }

  /* Has every editor set its opening lines again, and look again at where their first lines break. */
  refreshEditors() {
    if (!this.dropcapLive) return;
    this.app.workspace.iterateAllLeaves(leaf => {
      const cm = leaf.view && leaf.view.editor && leaf.view.editor.cm;
      if (cm && cm.dispatch) try { cm.dispatch({ effects: this.dropcapLive.refresh.of(null) }); } catch (e) { /* an editor that is going away */ }
    });
  }

  /* Shows a drop cap in a note's editor without saving it (which: as previewDropcap takes it), inked in unless
     quiet is set. */
  previewLive(view, which, quiet) {
    const cm = view && view.editor && view.editor.cm;
    if (!this.dropcapLive || !cm || !cm.dispatch) return;
    try {
      cm.dispatch({ effects: this.dropcapLive.preview.of({ which, ink: !quiet }) });
      window.clearTimeout(this.inking.get(cm));
      if (!quiet) this.inking.set(cm, window.setTimeout(() => { try { cm.dispatch({ effects: this.dropcapLive.ink.of(false) }); } catch (e) { /* gone */ } }, 2600));
    } catch (e) { /* an editor that is going away */ }
  }

  /* An image's width over its height (0 if it cannot be read), found once. */
  ratio(url) {
    let known = this.ratios.get(url);
    if (!known) {
      known = new Promise(resolve => {
        const img = new Image();
        img.onload = () => { const r = img.naturalHeight ? Math.round(100 * img.naturalWidth / img.naturalHeight) / 100 : 0; this.shapes.set(url, r); resolve(r); };
        img.onerror = () => { this.shapes.set(url, 0); resolve(0); };
        img.src = url;
      });
      this.ratios.set(url, known);
    }
    return known;
  }

  /* Shows a drop cap in a note's Reading view and in its editor without saving it: which is 'yinit' | 'goudy' | 'plain' | 'none' or
     'set:<name>', null for the vault's, or undefined for what the note's properties say. The initial is inked in
     (the snippet's scriptorium-dropcap-inked), unless quiet is set. */
  previewDropcap(view, which, quiet) {
    this.previewLive(view, which, quiet);
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
    this.refreshEditors();
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

  /* Marks a block that has just been rendered as centred or right-aligned, if its note says so (see "Centred and
     right-aligned text"). Reading view gives each block its lines; anything else is rendered all at once. */
  align(el, ctx) {
    try {
      const info = ctx && typeof ctx.getSectionInfo === 'function' ? ctx.getSectionInfo(el) : null;
      if (!info) {
        const note = noteAlign(ctx && ctx.frontmatter);
        if (note.align || /(?:^|\n)\s*:{3,}/.test(el.textContent)) alignBlocks(el, note);
        return;
      }
      this.sections.set(el, ctx);
      markAligned(el, sectionMarks(this.planFor(info.text), info.lineStart, info.lineEnd));
      this.watchSizer(el.parentElement);
    } catch (e) { /* never break rendering */ }
  }

  /* The alignment of a note from its text, kept for the notes drawn last (every block of a note asks for it). */
  planFor(text) {
    let hit = this.plans.find(p => p.text === text);
    if (!hit) {
      hit = { text, plan: alignPlan(String(text).split(/\r?\n/)) };
      this.plans.unshift(hit);
      this.plans.length = Math.min(this.plans.length, 6);
    }
    return hit.plan;
  }

  /* Reading view keeps a block it has drawn for as long as the block's own text stays the same, and takes blocks
     off the page and puts them back as the note is scrolled. A paragraph that comes to stand between two marker
     lines (or no longer does) is therefore not drawn again: whenever the blocks of a view change, the marks are set
     again, for all of them if the note's text has changed, else for those that came back. */
  watchSizer(sizer) {
    if (!sizer || this.sizers.has(sizer) || typeof MutationObserver === 'undefined') return;
    for (const [old, was] of this.sizers) if (!old.isConnected) { was.observer.disconnect(); this.sizers.delete(old); }
    const watch = { text: null, added: new Set(), frame: 0 };
    watch.observer = new MutationObserver(records => {
      for (const r of records) for (const node of r.addedNodes) watch.added.add(node);
      if (watch.frame) return;
      watch.frame = requestAnimationFrame(() => { watch.frame = 0; this.realign(sizer, watch); });
    });
    watch.observer.observe(sizer, { childList: true });
    this.sizers.set(sizer, watch);
  }

  realign(sizer, watch) {
    const added = watch.added, blocks = Array.from(sizer.children).filter(el => this.sections.has(el));
    watch.added = new Set();
    let changed = false;
    try {
      const lines = el => this.sections.get(el).getSectionInfo(el);
      const first = blocks.length ? lines(blocks[0]) : null;
      const all = !first || first.text !== watch.text;
      if (first) watch.text = first.text;
      for (const el of blocks) {
        if (!all && !added.has(el)) continue;
        const info = lines(el);
        if (info && markAligned(el, sectionMarks(this.planFor(info.text), info.lineStart, info.lineEnd))) changed = true;
      }
    } catch (e) { /* never break rendering */ }
    if (changed) this.recheck();   // an opening paragraph may have become one, or stopped being one
  }

  /* Makes edits of a note's lines (alignEdits, alignDropcapEdits) in the editor as one change, and keeps the
     selection on the text it was on. */
  editLines(editor, edits) {
    if (!edits.length) return;
    const count = editor.lineCount(), len = i => editor.getLine(i).length;
    const changes = edits.map(e => {
      if ('insert' in e) return e.line < count ? { from: { line: e.line, ch: 0 }, text: `${e.insert}\n` } : { from: { line: count - 1, ch: len(count - 1) }, text: `\n${e.insert}` };
      if (!e.remove) return { from: { line: e.line, ch: 0 }, to: { line: e.line, ch: len(e.line) }, text: e.text };
      if (e.line < count - 1) return { from: { line: e.line, ch: 0 }, to: { line: e.line + 1, ch: 0 }, text: '' };
      return { from: e.line ? { line: e.line - 1, ch: len(e.line - 1) } : { line: 0, ch: 0 }, to: { line: e.line, ch: len(e.line) }, text: '' };
    });
    const at = pos => ({ line: lineAfterEdits(edits, pos.line), ch: pos.ch });
    editor.transaction({ changes, selection: { from: at(editor.getCursor('anchor')), to: at(editor.getCursor('head')) } });
  }

  /* "Centre selection" and "Right-align selection" (kind 'center' | 'right'), and "Remove alignment" (null). */
  alignCommand(editor, kind) {
    const lines = editor.getValue().split('\n'), a = editor.getCursor('from'), b = editor.getCursor('to');
    const last = b.line > a.line && b.ch === 0 ? b.line - 1 : b.line;   // a selection that ends where a line begins does not take that line
    const edits = alignEdits(lines, a.line, last, kind);
    if (edits.length) { this.editLines(editor, edits); return; }
    const inBlock = alignPlan(lines).ranges.some(r => r.close >= a.line && r.open <= last);
    new Notice(!kind ? 'This text is not centred or right-aligned.'
      : inBlock ? `This text is already ${kind === 'center' ? 'centred' : 'right-aligned'}.` : `There is no text here to ${kind === 'center' ? 'centre' : 'right-align'}.`);
  }

  /* "Use a drop cap on this aligned paragraph" (on) and "Remove the drop cap from this aligned paragraph": offered
     when the cursor is in an aligned block that has none of its own (or has one). */
  alignDropcapCommand(editor, on, checking) {
    const lines = editor.getValue().split('\n'), line = editor.getCursor('head').line;
    const edits = alignDropcapEdits(lines, line, on);
    if (!edits || !edits.length) return false;
    if (checking) return true;
    const block = alignPlan(lines).ranges.find(r => r.open <= line && r.close >= line);
    this.editLines(editor, edits);
    if (on && block && !block.lead) new Notice('A drop cap is drawn where a chapter opens: this text will have one when it is the first paragraph under a heading.', 8000);
    return true;
  }

  /* Whether a note's centred and right-aligned text may have drop caps: the property "dropcap-aligned". */
  async setNoteDropcapAligned(file, on) {
    try {
      await this.app.fileManager.processFrontMatter(file, fm => { if (on) fm['dropcap-aligned'] = true; else delete fm['dropcap-aligned']; });
    } catch (e) {
      new Notice(`Could not save this in the note’s properties: ${e.message}`);
    }
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
    this.refreshEditors();
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
    if ('sync' in patch && this.engine) this.engine.start(false);
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

  /* "Repair TikZJax rendering": stands beside the TikZJax plugin's page script while the setting is on and the TikZJax
     of the vault is a version it was checked against (see repairTikzjax); taken away at once when it is turned off.
     TikZJax may come and go (installed, turned on or off, loaded before or after Scriptorium): this is looked at
     again whenever the layout changes. */
  applyTikzRepair() {
    const manifest = this.app.plugins && this.app.plugins.manifests ? this.app.plugins.manifests[TIKZJAX_ID] : null;
    const version = manifest ? manifest.version : null, state = tikzRepairState(this.settings, version);
    if (state === 'on' && !this.tikzRepair) {
      try { this.tikzRepair = repairTikzjax(window); } catch (e) { this.tikzRepair = null; console.error('Scriptorium: TikZJax could not be repaired', e); }
    } else if (state !== 'on' && this.tikzRepair) {
      try { this.tikzRepair.stop(); } catch (e) { console.error('Scriptorium', e); }
      this.tikzRepair = null;
    }
    if (state === 'unknown' && this.tikzUnknown !== version) {
      this.tikzUnknown = version;
      console.info(`Scriptorium: TikZJax ${version} is not a version “Repair TikZJax rendering” was checked against (${TIKZJAX_REPAIRED.join(', ')}), so it is left as it is.`);
    }
  }

  applyFeatures() {
    this.applyTikzRepair();
    const s = this.settings, body = document.body;
    this.applyLiveDropcaps();
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
    if (this.tikzRepair) { try { this.tikzRepair.stop(); } catch (e) { /* gone */ } this.tikzRepair = null; }
    document.body.classList.remove('scriptorium-fancy', 'scriptorium-image-focus');
    for (const [value] of INITIALS) document.body.classList.remove(`scriptorium-initials-${value}`);
    if (this.engine) this.engine.stop();
    if (this.syncStop) this.syncStop.abort();   // a run that is going is cut off; the next one picks it up
    if (this.marginalia) this.marginalia.unload();
    if (this.imageFocus) this.imageFocus.unload();
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.kept) for (const p of this.kept) unwrapKept(p);
    for (const [sizer, watch] of this.sizers || []) {
      watch.observer.disconnect();
      for (const el of Array.from(sizer.children)) markAligned(el, null);   // the markers are text again
    }
  }
}

// (for the checks that run in Obsidian's console, where require('obsidian') is not to be had)
Scriptorium.obsidian = { MarkdownRenderer, Component };
module.exports = Scriptorium;
// Pure helpers, exported for plugins-tests/ (Obsidian uses only the class).
Object.assign(module.exports, {
  normalizeSettings, tikzRepairState, texError, tikzOwnIds, repairTikzjax, TIKZJAX_REPAIRED, migrateSettings, LIVE_DROPCAPS_SINCE, marginGeometry, stackNotes, footnoteMarkdown, footnoteDefinitions, parseFootnoteDefinitions,
  refLabel, captionFromParts, parseImageEmbed, externalImages, sourceKey,
  setupRule, setupPackage, planVaultSetup, describeVaultSetup, applyVaultSetup, setupFolder,
  DIAGRAM_PLUGINS, installDiagramPlugins, diagramPluginsWanted, diagramPluginsNote, versionAtLeast,
  noteDropcap, dropcapChoices, markDropcap, dropcapMarks, isPrintPage, dressPrint,
  noteBlocks, shownLine, linesDropcap, openingPlan, openingLine, dropcapExtension,
  alignKind, alignMarker, noteAlign, alignPlan, sectionMarks, alignClasses, blockLines, blockMarks, alignEdits, alignDropcapEdits, applyLineEdits, lineAfterEdits, markAligned,
  openingLetter, dropcapFile, describeSet, setName, sanitizeSvg, checkDropcapFile, BUNDLED_SETS, YOUR_OWN_SETS, DROPCAP_FOLDER,
  seedOf, fontFaces, setLabel, monoMask, downloadPlan, fetchDropcapSet, describeDownload, sizeText,
  RCLONE, SYNC_SENTINEL, SYNC_DEFAULTS, SYNC_TIMES, SYNC_CONFLICT, SYNC_CLIENT_STEPS, syncSettings, syncUserDir, syncPaths, syncVaultId, syncReadJson, syncWriteJson,
  syncLink, syncSaveLink, rcloneAsset, rcloneCandidates, findRclone, rcloneVersion, rcloneOldEnough, zipEntry, syncFetch, rcloneInstall, syncProblem, rcloneEnv,
  syncLogLine, rcloneExec, syncConfRead, syncConnection, syncConfPrepare, syncParseClient, syncFilters, syncTarget, syncWhere, syncFolderName, syncParseDirs,
  syncParseCheck, syncConflictName, syncBisyncArgs, syncSummary, syncSummaryText, syncExplain, rcloneApi, syncLock, syncUnlock, syncClearStale, syncPrune, syncOnce, syncStamp,
  inkSlant, uprightMissing, syncPreview, syncFirst, syncTooLong, SyncEngine, syncStatusText, driveRedact, syncNameless, syncReport, driveTargetProblem, driveBytes, driveCount, SyncBrowser
});
