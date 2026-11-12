const { Plugin, PluginSettingTab, Setting, MarkdownView, MarkdownRenderer, Component, Scope, Modal, Notice, Platform } = require('obsidian');

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
    if (INITIALS.some(([value]) => value === saved.initials)) settings.initials = saved.initials;
  }
  return settings;
}

/* ==========================================================
   A drop cap for one note
   ==========================================================
   A note can ask for a drop cap of its own with the property "dropcap" (yinit, goudy, plain or none); without it the
   note has the vault's (Settings → Scriptorium → Drop cap). "Scriptorium: Choose the drop cap for this note" sets
   it, showing each choice in the note as you move through the list. In Reading view (and wherever a note is
   rendered: embeds, hover previews, PDF export) the plugin marks each block of such a note with .scriptorium-dropcap
   and .scriptorium-dropcap-<which>; the snippet does the rest. */

const DROPCAP_KEYS = ['dropcap', 'drop-cap', 'dropCap', 'drop cap'];

/* The drop cap a note's properties ask for: 'yinit' | 'goudy' | 'plain' | 'none', or null (the vault's). Forgiving
   about case, about the labels in the settings ("Goudy Initialen") and about no/off/false for none. */
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
  return null;
}

/* Marks (or unmarks) one rendered block with a note's drop cap. */
function markDropcap(el, which) {
  for (const c of Array.from(el.classList)) if (c.startsWith('scriptorium-dropcap')) el.classList.remove(c);
  if (which) el.classList.add('scriptorium-dropcap', `scriptorium-dropcap-${which}`);
}

/* The choices of the command: the vault's, then each drop cap. */
function dropcapChoices(vaultInitials) {
  const name = (INITIALS.find(([value]) => value === vaultInitials) || INITIALS[0])[1];
  return [{ value: null, label: `The vault’s drop cap (${name})` }].concat(INITIALS.map(([value, label]) => ({ value, label })));
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
    const current = noteDropcap(cache && cache.frontmatter);
    this.contentEl.createEl('p', { cls: 'scriptorium-dropcap-file', text: file.basename });
    const list = this.contentEl.createDiv({ cls: 'scriptorium-dropcap-list', attr: { role: 'listbox', 'aria-label': 'Drop cap' } });
    const items = [];
    for (const choice of dropcapChoices(this.plugin.settings.initials)) {
      const item = list.createEl('button', {
        cls: 'scriptorium-dropcap-choice', text: choice.label,
        attr: { role: 'option', 'aria-selected': String(choice.value === current) },
      });
      if (choice.value === current) item.addClass('is-current');
      // Moving through the list shows each drop cap in the note; nothing is saved until one is chosen.
      const show = () => this.plugin.previewDropcap(this.view, choice.value);
      item.addEventListener('focus', show);
      item.addEventListener('mouseenter', () => item.focus());
      item.addEventListener('click', () => { this.chosen = true; this.close(); void this.plugin.setNoteDropcap(file, choice.value); });
      item.addEventListener('keydown', ev => {
        const i = items.indexOf(item);
        if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(i + items.length - 1) % items.length].focus(); }
      });
      items.push(item);
    }
    this.contentEl.createEl('p', {
      cls: 'scriptorium-dropcap-hint',
      text: 'Saved in the note’s properties as “dropcap”. It shows in Reading view, where drop caps are drawn.',
    });
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
      if (isPrintPage(el)) return this.dressPrint(el, which); // Export to PDF: the whole page comes at once
      markDropcap(el, which);
      el.querySelectorAll(':scope > p').forEach(p => { this.kept.add(p); this.resizeObserver.observe(p); });
    });
    // Export to PDF prints the note's title by default: tick Obsidian's "Include file name as title" once.
    this.app.workspace.onLayoutReady(() => { void this.includeTitleInPdf(); });
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

  /* Export to PDF (see "Export to PDF: the page as Reading view sets it"). The returned promise is awaited by Obsidian
     before it prints: by then the drop cap's font has loaded. */
  dressPrint(page, which) {
    const doc = page.ownerDocument, body = doc.body, s = this.settings;
    body.classList.toggle('scriptorium-fancy', s.fancyMode);
    for (const [value] of INITIALS) body.classList.toggle(`scriptorium-initials-${value}`, value === s.initials && value !== 'yinit');
    dressPrint(page, which);
    const fonts = ['"Scriptorium Yinit"', '"Scriptorium Goudy"', '500 1em "Cormorant Garamond"', '1em "EB Garamond"', 'italic 1em "EB Garamond"'];
    const loaded = doc.fonts && doc.fonts.load
      ? Promise.all(fonts.map(f => doc.fonts.load(f.includes('1em') ? f : `1em ${f}`, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ').catch(() => null)))
      : Promise.resolve();
    return Promise.race([loaded, new Promise(resolve => window.setTimeout(resolve, 2500))]);
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

  /* Shows a drop cap in a note's Reading view without saving it: which is 'yinit' | 'goudy' | 'plain' | 'none', null
     for the vault's, or undefined for what the note's properties say. */
  previewDropcap(view, which) {
    if (which === undefined) {
      const cache = view.file && this.app.metadataCache.getFileCache(view.file);
      which = noteDropcap(cache && cache.frontmatter);
    }
    const root = view.containerEl.querySelector('.markdown-preview-view');
    if (!root) return;
    root.querySelectorAll('.markdown-preview-sizer > div').forEach(el => markDropcap(el, which));
    this.recheck();
  }

  /* Saves a note's drop cap in its properties (null removes the property: the vault's drop cap). */
  async setNoteDropcap(file, which) {
    try {
      await this.app.fileManager.processFrontMatter(file, fm => {
        for (const k of DROPCAP_KEYS) if (k !== 'dropcap') delete fm[k];
        if (which) fm.dropcap = which; else delete fm.dropcap;
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
  noteDropcap, dropcapChoices, markDropcap, isPrintPage, dressPrint
});
