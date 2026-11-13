// Drop caps in Live Preview, checked in a real Obsidian. They are a setting ("Show drop caps while editing (Live
// Preview)"), off by default. Off, the editor must be as it is without them: nothing of the extension in any
// editor, no class on any line, the opening paragraph set as every other. On (turned on here, with no restart), the
// editor must show the drop caps Reading view shows.
// For each case a note is opened in Live Preview and in Reading view, and the two are measured from the page:
//   - the same paragraphs have a drop cap in both (and no others);
//   - the initial has the same face, size, colour and margins (the computed style of ::first-letter, ::first-line
//     and ::before), for each kind of drop cap: the four built in, as the vault's and as a note's own, a font of
//     initials, a set of images, a set the writer adds, and one drawn for the note (Lagrange's road);
//   - the initial stands in the same place in its paragraph, and every line of the paragraph begins and ends in the
//     same place with the same words, within 2 px (so the text does not move between the two views);
//   - aligned text has no drop cap, and a standing initial where it asks for one, in both;
//   - the first letter is still text: the cursor goes before and after it, typing and deleting there changes the
//     note and the initial follows, a selection and the clipboard have the letter, the editor's own text has it;
//   - nothing moves while the paragraph is typed in, or when the cursor comes into it;
//   - Source mode is plain; a drop cap that is chosen is inked in, in the editor as well.
// This cannot run under Node (it needs Obsidian's editor and its layout), so it is not part of `node --test`; it
// is a manual check, or one a machine can run through the DevTools protocol.
//
// To run it: open a Scriptorium vault in Obsidian (the Scriptorium plugin and the manuscript snippet on), open the
// developer tools (Ctrl+Shift+I) and paste this file into the console; or evaluate it with Runtime.evaluate
// (awaitPromise: true). It makes a note "Drop cap check.md" and two sets of drop caps ("LPDC added", "LPDC drawn")
// in the vault, and takes them away again; the vault's settings are put back. It answers with a JSON text
// {ok, failed, cases: [{name, ok, why, ...numbers}]} and prints a table. Options: window.dropcapLiveOptions =
// {only: 'text in a case name', keep: true}.
//
// Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).
(async () => {
  const options = window.dropcapLiveOptions || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const frame = () => new Promise(r => requestAnimationFrame(r));
  const plugin = app.plugins.plugins.scriptorium;
  if (!plugin) throw new Error('Scriptorium is not enabled in this vault');
  if (typeof plugin.applyLiveDropcaps !== 'function') throw new Error('This Scriptorium has no drop caps in Live Preview');
  const S = plugin.constructor;
  const TOL = 2;

  const PARAS = {
    A: 'A body at rest stays at rest, and a body in motion keeps its motion, unless something acts on it; this much was known to Galileo, who rolled balls down smooth planes and saw that the smoother the plane, the farther they went, and guessed the rest.',
    B: 'Between the idea and the reality falls the measurement: an experimentalist distrusts whatever cannot be weighed, timed or counted, and a theoretician distrusts whatever can, and the science is made of their disagreement.',
    C: 'Conservation is the oldest of the bookkeeping rules of physics, and the strictest: whatever is counted before must be counted after, to the last farthing, however the columns are rearranged in between.',
    E: 'Energy is never lost, only moved about: what a falling stone loses in height it gains in speed, and what it gains in speed it gives up, when it lands, as heat and sound and a dent in the ground. The books balance to the last farthing, which is why a clock needs winding, and why nothing that runs has ever run for nothing.',
    G: 'Galileo is said to have dropped two unequal weights from the leaning tower, though nobody who was there wrote it down; what he certainly did was to roll balls down a grooved plank and time them with a water clock, which is duller and proves more.',
    I: 'Inertia was the hardest of the ideas to come by, since everything on earth that is set moving stops, and the Aristotelians were only describing, with considerable accuracy, a world that has friction in it everywhere.',
    Q: 'Questions of this kind were first put by people who watched pendulums: a bob let go from a height comes back to that height, or very nearly, whatever path the string forces on it, and never higher.',
    T: 'The pendulum keeps its own time, whatever the width of its swing, or near enough that the difference did not trouble anybody for a hundred years; the discovery is the reason there are clocks worth the name, and navigators who know where they are.',
    W: 'What a falling stone loses in height it gains in speed, the schoolbooks say, and the interesting thing about the sentence is that it was once not obvious: it took unconscionably long to distinguish momentum from energy.',
  };
  const SECOND = 'A second paragraph follows the first, and is long enough to wrap onto another line of the page.';
  const note = (props, ...blocks) => (props ? `---\n${props}\n---\n` : '') + blocks.join('\n\n') + '\n';

  const path = 'Drop cap check.md';
  let file = app.vault.getAbstractFileByPath(path);
  if (!file) file = await app.vault.create(path, '');
  const leaf = app.workspace.getLeavesOfType('markdown')[0] || app.workspace.getLeaf(true);
  const ws = app.workspace;
  const layout = { left: ws.leftSplit.collapsed, right: ws.rightSplit.collapsed, bounds: null, zoom: null, theme: app.vault.getConfig('theme') };
  try {
    const remote = require('@electron/remote'), win = remote.getCurrentWindow();
    layout.bounds = win.getBounds();
    layout.zoom = require('electron').webFrame.getZoomFactor();
    win.unmaximize(); win.setBounds({ x: layout.bounds.x, y: layout.bounds.y, width: 1180, height: 900 });
    require('electron').webFrame.setZoomFactor(1);
  } catch (e) { /* not the desktop app: the window is as it is */ }
  ws.leftSplit.collapse(); ws.rightSplit.collapse();
  const saved = { initials: plugin.settings.initials, fancy: plugin.settings.fancyMode, live: plugin.settings.liveDropcaps };
  const theme = async dark => { const name = dark ? 'obsidian' : 'moonstone'; app.vault.setConfig('theme', name); app.changeTheme(name); await sleep(400); };

  const cmOf = () => leaf.view.editor.cm;
  const setMode = async mode => {
    await leaf.setViewState(Object.assign({}, leaf.getViewState(), { state: Object.assign({}, leaf.getViewState().state, mode === 'reading' ? { mode: 'preview' } : { mode: 'source', source: mode === 'source' }) }));
    await sleep(options.settle || 700);
    if (mode === 'reading') leaf.view.containerEl.querySelector('.markdown-preview-view').scrollTop = 0;
    else cmOf().scrollDOM.scrollTop = 0;
    await sleep(120);
  };
  const open = async (text, mode) => {
    document.querySelectorAll('.modal-container').forEach(m => m.remove());
    await leaf.openFile(file, { state: { mode: 'source', source: false } });
    if (leaf.view.editor.getValue() !== text) { leaf.view.editor.setValue(text); await sleep(options.settle || 600); }
    leaf.view.editor.setCursor(leaf.view.editor.lastLine(), 0);
    await setMode(mode || 'live');
  };

  /* One paragraph as it stands on the page: el is Reading view's <p> or the editor's line. → {cap: the initial's
     box, lines: [{text, left, top, right}], style, box}, places counted from the paragraph's own top left corner. */
  const measure = el => {
    const cs = getComputedStyle(el), fs = parseFloat(cs.fontSize), base = el.getBoundingClientRect();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), r = document.createRange();
    let cap = null, n;
    const lines = [];
    while ((n = walker.nextNode())) {
      if (n.parentElement.closest('.scriptorium-fence')) continue;
      for (let i = 0; i < n.data.length; i++) {
        r.setStart(n, i); r.setEnd(n, i + 1);
        const rc = r.getClientRects()[0];
        if (!rc || !rc.width || !rc.height) continue;
        if (rc.height >= 2 * fs) { if (!cap) cap = { letter: n.data[i], left: rc.left - base.left, top: rc.top - base.top, width: rc.width, height: rc.height }; continue; }
        const last = lines[lines.length - 1];
        // (a line is measured by its letters: the editor keeps a space at a line's end where Reading view has none)
        const space = /\s/.test(n.data[i]);
        if (!last || rc.top - base.top > last.top + 0.6 * fs) { if (!space) lines.push({ text: n.data[i], left: rc.left - base.left, top: rc.top - base.top, right: rc.right - base.left }); }
        else { last.text += n.data[i]; if (!space) { last.left = Math.min(last.left, rc.left - base.left); last.right = Math.max(last.right, rc.right - base.left); } }
      }
    }
    const fl = getComputedStyle(el, '::first-letter'), line = getComputedStyle(el, '::first-line'), be = getComputedStyle(el, '::before');
    const image = be.content !== 'none' && be.content !== 'normal';
    const style = {
      float: fl.float, font: fl.fontFamily, size: fl.fontSize, weight: fl.fontWeight, leading: fl.lineHeight, transform: fl.textTransform,
      margin: `${fl.marginTop} ${fl.marginRight} ${fl.marginBottom} ${fl.marginLeft}`, color: fl.color,
      caps: line.fontVariantCaps, spacing: line.letterSpacing,
      align: cs.textAlign, pad: cs.paddingTop, indent: cs.textIndent, text: cs.fontSize, textLeading: cs.lineHeight, hyphens: cs.hyphens,
      image: image ? `${be.float} ${be.position} ${be.width} x ${be.height} ${be.marginTop} ${be.marginRight} ${be.marginBottom} ${be.marginLeft}` : '',
      picture: image ? `${be.backgroundImage} | ${be.webkitMaskImage || be.maskImage} | ${be.backgroundColor}` : '',
      kept: Array.from(el.querySelectorAll('.sc-keep')).map(k => k.textContent).join(''),   // the word kept whole on the small-capped line
    };
    const view = el.closest('.markdown-source-view, .markdown-preview-view'), title = view && view.querySelector('.inline-title');
    return { cap, lines, style, image, has: Boolean(cap) || image, box: { left: base.left, top: base.top, width: base.width, height: base.height, under: title ? base.top - title.getBoundingClientRect().bottom : NaN } };
  };
  /* The differences between a paragraph in the editor (a) and in Reading view (b): [why], and the largest in px.
     only: how many lines to compare (a paragraph of several lines of the note is several lines of the editor). */
  const compare = (a, b, only) => {
    const why = [];
    let max = 0;
    const d = (x, y, what) => { const v = Math.abs(x - y); max = Math.max(max, v); if (v > TOL) why.push(`${what}: ${x.toFixed(1)} in the editor, ${y.toFixed(1)} in Reading view`); };
    if (Boolean(a.cap) !== Boolean(b.cap)) why.push(`an initial of a font ${a.cap ? 'only in the editor' : 'only in Reading view'}`);
    else if (a.cap) {
      if (a.cap.letter !== b.cap.letter) why.push(`the initial is ${a.cap.letter} in the editor, ${b.cap.letter} in Reading view`);
      for (const k of ['left', 'top', 'width', 'height']) d(a.cap[k], b.cap[k], `the initial's ${k}`);
    }
    if (a.image !== b.image) why.push(`an initial that is an image ${a.image ? 'only in the editor' : 'only in Reading view'}`);
    for (const k of Object.keys(a.style)) if (a.style[k] !== b.style[k]) why.push(`${k}: “${String(a.style[k]).slice(0, 90)}” in the editor, “${String(b.style[k]).slice(0, 90)}” in Reading view`);
    const count = only || Math.max(a.lines.length, b.lines.length);
    if (!only && a.lines.length !== b.lines.length) why.push(`${a.lines.length} lines in the editor, ${b.lines.length} in Reading view`);
    const norm = t => t.replace(/\s+/g, ' ').trim();
    for (let i = 0; i < Math.min(count, a.lines.length, b.lines.length); i++) {
      if (norm(a.lines[i].text) !== norm(b.lines[i].text)) why.push(`line ${i + 1} is “${norm(a.lines[i].text).slice(0, 60)}” in the editor, “${norm(b.lines[i].text).slice(0, 60)}” in Reading view`);
      for (const k of ['left', 'top', 'right']) d(a.lines[i][k], b.lines[i][k], `line ${i + 1}'s ${k}`);
    }
    return { why, max };
  };
  const words = el => String(el.textContent || '').replace(/^\s*:{3,}[^\n]*\n/, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  /* The editor's line that begins with `start`, and Reading view's paragraph that does. */
  const liveLine = start => Array.from(cmOf().contentDOM.querySelectorAll('.cm-line')).find(l => l.textContent.replace(/[*_=~`\[\]]/g, '').trim().startsWith(start));
  const readPara = start => Array.from(leaf.view.containerEl.querySelectorAll('.markdown-preview-sizer > div > p')).find(p => words(p).startsWith(start));
  /* A drop cap that has just been chosen is inked in for a moment (its colour comes up): measured when it is dry. */
  const dry = async () => { for (let i = 0; i < 40 && leaf.view.containerEl.querySelector('.scriptorium-dropcap-inked'); i++) await sleep(100); };
  /* Every paragraph with a drop cap, by its first words: both views draw only what is near, so Reading view is
     scrolled through, and the editor is gone through line by line. */
  const kind = m => (m.has ? (m.image ? 'image' : m.style.float === 'left' ? 'dropped' : 'standing') : 'none');
  const readCaps = async () => {
    const scroller = leaf.view.containerEl.querySelector('.markdown-preview-view'), found = new Map();
    for (let y = 0, guard = 0; guard < 300; y += 350, guard++) {
      scroller.scrollTop = y; await sleep(130);
      for (const el of leaf.view.containerEl.querySelectorAll('.markdown-preview-sizer > div.el-p > p')) found.set(words(el), kind(measure(el)));
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) break;
    }
    scroller.scrollTop = 0;
    await sleep(100);
    return found;
  };
  const liveCaps = async () => {
    const cm = cmOf(), found = new Map(), doc = cm.state.doc;
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      if (!/\S/.test(line.text) || /^(?:#{1,6} |>|[-*] |\d+\. |```|\||\$\$|%%|\[\^|:::|=+$|-+$)/.test(line.text)) continue;
      cm.dispatch({ effects: cm.constructor.scrollIntoView(line.from, { y: 'center' }) });
      let el = null;
      for (let i = 0; i < 60 && !el; i++) {
        await frame();
        if (i === 30) cm.scrollDOM.scrollTop = Math.max(0, cm.lineBlockAt(line.from).top);   // (asked again, another way)
        if (line.from < cm.viewport.from || line.from > cm.viewport.to) continue;
        try { const at = cm.domAtPos(line.from + 1); el = (at.node.nodeType === 1 ? at.node : at.node.parentElement).closest('.cm-line'); if (el && !el.isConnected) el = null; } catch (e) { el = null; }
      }
      await frame();
      found.set(words({ textContent: S.shownLine(line.text) }), el ? kind(measure(el)) : 'not drawn');
    }
    cm.scrollDOM.scrollTop = 0;
    await sleep(100);
    return found;
  };

  // The sets of drop caps the harness adds: one as the writer adds files (colours kept), one as Lagrange hands a drawing over (one colour).
  const svg = (letter, w, h, fill) => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect x="6" y="6" width="${w - 12}" height="${h - 12}" fill="none" stroke="${fill}" stroke-width="12"/><text x="${w / 2}" y="${h * 0.78}" text-anchor="middle" font-family="Georgia, serif" font-size="${h * 0.8}" font-weight="700" fill="${fill}">${letter}</text></svg>`);
  const SETS = ['LPDC added', 'LPDC drawn'];
  const dropSets = async () => { for (const name of SETS) { const dir = `${S.DROPCAP_FOLDER}/${name}`; if (await app.vault.adapter.exists(dir)) await app.vault.adapter.rmdir(dir, true); } await plugin.loadDropcapSets(); };
  await dropSets();
  await plugin.saveDropcapSet(SETS[0], ['E', 'T'].flatMap(l => [S.checkDropcapFile(`${l}.svg`, svg(l, 300, 400, '#2a5d8f')), S.checkDropcapFile(`${l}-dark.svg`, svg(l, 400, 400, '#9fc4e8'))]), false);
  await plugin.addDrawnDropcap({ set: SETS[1], letter: 'E', bytes: svg('E', 360, 400, '#000'), kind: 'svg', mono: true }, null);
  await sleep(600);

  const TORTURE = note('',
    PARAS.A, 'Bravo is the second paragraph of the note and has no initial.',
    '# One', PARAS.C, 'Delta comes second under its heading.',
    '## Two', '> An epigraph stands between the heading and the text.', PARAS.E, 'Foxtrot follows it.',
    '###### A subtitle', 'Golf stands under a subtitle, which opens a chapter as a heading does.',
    '### Three', 'Hotel stands under a smaller heading and has no initial.',
    '## Four', '- a list', 'India comes after a list.',
    '## Five', '> [!note] A callout\n> with its text', 'Juliet comes after a callout.',
    '## Six', '```js\nconst code = 1;\n```', 'Kilo comes after code.',
    '## Seven', 'Lima is a paragraph of the note\nin three lines of the note\nwhich are one paragraph.', 'Mike follows it.',
    '## Eight', '---', 'November comes after a rule.',
    '## Nine', '$$\nx^2\n$$', 'Oscar comes after mathematics.',
    '## Ten', '| a | b |\n| - | - |\n| 1 | 2 |', 'Papa comes after a table.',
    '## Eleven', '> One quotation.', '> And another.', 'Quebec comes after two quotations.',
    'Twelve\n======', 'Romeo stands under a heading that is underlined.',
    '## Thirteen', '**Sierra** begins with bold words, and *then* goes on in the ordinary way for a while.',
    '## Fourteen', '[[Tango]] begins with a link to another note, and then goes on.',
    '## Fifteen', '“Uniform,” she said, “begins with a quotation mark.”',
    '## Sixteen', '::: center\nVictor is centred verse,\nand has no initial.\n:::', '::: right\n— its author\n:::', 'Whiskey is the first paragraph after the verse, and opens the chapter.',
    '## Seventeen', '::: center dropcap\nXray is centred verse\nthat asked for its initial.\n:::', 'Yankee follows the verse, which took the initial.',
    '## Eighteen', '%%\na comment in a block\n%%', 'Zulu comes after a comment.',
    '## Nineteen', '1984 begins with a figure.',
    '## Twenty', '[^1]: The text of a footnote.', 'Able comes after a footnote’s text.',
    '## Twenty-one', PARAS.G, filler(6), '## Twenty-two', PARAS.I, filler(6), '## The last', PARAS.W);
  function filler(n) { return Array.from({ length: n }, (_, i) => `Filler ${i + 1}: the quick brown fox jumps over the lazy dog, and the dog, who has seen it all before, does not get up.`).join('\n\n'); }

  const results = [];
  const run = async (name, body) => {
    if (options.only && !name.includes(options.only)) return;
    const out = { name, ok: true, why: [] };
    try { await body(out); } catch (e) { out.why.push(`threw: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); }
    out.ok = !out.why.length;
    out.why = out.why.join('; ');
    results.push(out);
  };
  /* Opens the note in both views and compares the paragraph that begins with `start`; expect: 'dropped' | 'standing'
     | 'image' | 'none'. */
  const both = async (out, text, start, expect, only) => {
    await open(text, 'live');
    const line = liveLine(start);
    if (!line) { out.why.push(`no line of the editor begins “${start}”`); return null; }
    await dry();
    const a = measure(line);
    await setMode('reading');
    await dry();
    const p = readPara(start);
    if (!p) { out.why.push(`no paragraph of Reading view begins “${start}”`); return null; }
    const b = measure(p);
    if (kind(b) !== expect) out.why.push(`Reading view has ${kind(b)}, the case expects ${expect}`);
    if (kind(a) !== expect) out.why.push(`the editor has ${kind(a)}, expected ${expect}`);
    if (expect !== 'none' || kind(a) !== 'none') {   // (a paragraph without an initial is set as every other paragraph of the view is)
      const diff = compare(a, b, only);
      out.why.push(...diff.why);
      out.maxPx = Math.max(out.maxPx || 0, Number(diff.max.toFixed(2)));
      out.lines = a.lines.length;
    }
    out.x = Number((a.box.left - b.box.left).toFixed(2));          // where the paragraph stands: the column, editor less Reading view
    out.y = Number((a.box.under - b.box.under).toFixed(2));        // and how far under the note's title (not asserted: the views space their blocks differently)
    if (Math.abs(a.box.left - b.box.left) > TOL || Math.abs(a.box.width - b.box.width) > TOL) out.why.push(`the column is at ${a.box.left.toFixed(1)}, ${a.box.width.toFixed(1)} wide in the editor; at ${b.box.left.toFixed(1)}, ${b.box.width.toFixed(1)} wide in Reading view`);
    return { a, b };
  };

  try {
    await theme(false);
    await plugin.updateSettings({ initials: 'yinit', fancyMode: false, liveDropcaps: false });

    // ---- the setting: off (the default), the editor is as it is without the feature ----
    const START = note('', '## A chapter', PARAS.A, SECOND, '## Another', `**The pendulum** ${PARAS.T.slice(13)}`, '## Verse', '::: center dropcap\nTyger Tyger, burning bright,\nIn the forests of the night;\n:::');
    const plain = out => {
      const cm = cmOf(), marked = cm.dom.querySelectorAll('.scriptorium-opening, .scriptorium-opening-gap, .sc-keep, [class*="scriptorium-dropcap"], .scriptorium-align-dropcap');
      if (marked.length) out.why.push(`${marked.length} element(s) of the editor carry a class of the drop caps`);
      for (const start of ['A body at rest', 'The pendulum keeps', 'Tyger']) {
        const line = liveLine(start), m = measure(line), cs = getComputedStyle(line);
        if (m.has || m.style.float !== 'none' || m.style.size !== m.style.text || m.style.caps === 'small-caps') out.why.push(`“${start}” has an initial (${m.style.float}, ${m.style.size}, ${m.style.caps})`);
        if (cs.whiteSpace !== 'break-spaces') out.why.push(`“${start}” is set with white-space: ${cs.whiteSpace}`);
        if (line.getAttribute('style')) out.why.push(`“${start}” has a style of its own: ${line.getAttribute('style').slice(0, 60)}`);
      }
      if (plugin.dropcapLive !== null || plugin.liveExtensions.length) out.why.push('the extension is in the list Obsidian was given');
    };
    await run('the setting is off by default; off, nothing of the drop caps is in the editor, and Reading view has them as ever', async out => {
      if (S.normalizeSettings({}).liveDropcaps !== false || S.normalizeSettings({ initials: 'goudy', fancyMode: true }).liveDropcaps !== false) out.why.push('the setting is not off by default');
      await open(START, 'live');
      plain(out);
      // nothing the plugin does for Reading view's drop caps reaches the editor: shown from the list, sets read again, a typed property
      const before = Array.from(cmOf().contentDOM.querySelectorAll('.cm-line')).map(l => `${l.className}|${Math.round(l.getBoundingClientRect().height * 10)}`).join(';');
      let dispatched = 0;
      const cm = cmOf(), real = cm.dispatch;
      cm.dispatch = function (...args) { dispatched++; return real.apply(this, args); };
      try {
        plugin.previewDropcap(leaf.view, 'goudy'); plugin.previewDropcap(leaf.view, undefined, true); plugin.remarkAll(); plugin.recheck();
        await sleep(300);
      } finally { delete cm.dispatch; }
      out.dispatches = dispatched;
      if (dispatched) out.why.push(`the plugin sent the editor ${dispatched} transaction(s)`);
      plain(out);
      const after = Array.from(cmOf().contentDOM.querySelectorAll('.cm-line')).map(l => `${l.className}|${Math.round(l.getBoundingClientRect().height * 10)}`).join(';');
      if (before !== after) out.why.push('the editor’s lines changed');
      await setMode('reading');
      await dry();
      if (kind(measure(readPara('A body at rest'))) !== 'dropped') out.why.push('Reading view has no drop cap');
    });
    await run('turned on, the drop caps are there at once (no restart, the note not opened again); turned off, they are gone at once', async out => {
      await open(START, 'live');
      const texts = () => Array.from(cmOf().contentDOM.querySelectorAll('.cm-line')).map(l => l.textContent).join('\n');
      const was = texts(), value = leaf.view.editor.getValue();
      await plugin.updateSettings({ liveDropcaps: true });
      await frame(); await frame(); await sleep(150);
      const kinds = ['A body at rest', 'The pendulum keeps', 'Tyger'].map(start => kind(measure(liveLine(start))));
      out.on = kinds.join(',');
      if (kinds.join(',') !== 'dropped,dropped,standing') out.why.push(`turned on, the three openings are ${kinds.join(', ')}`);
      if (texts() !== was || leaf.view.editor.getValue() !== value) out.why.push('turning it on changed the text');
      await plugin.updateSettings({ liveDropcaps: false });
      await frame(); await frame(); await sleep(150);
      plain(out);
      if (texts() !== was || leaf.view.editor.getValue() !== value) out.why.push('turning it off changed the text');
      // the command does the same
      app.commands.executeCommandById('scriptorium:toggle-live-dropcaps');
      await sleep(300);
      document.querySelectorAll('.notice').forEach(n => n.remove());
      if (!plugin.settings.liveDropcaps || kind(measure(liveLine('A body at rest'))) !== 'dropped') out.why.push('the command does not turn it on');
      app.commands.executeCommandById('scriptorium:toggle-live-dropcaps');
      await sleep(300);
      document.querySelectorAll('.notice').forEach(n => n.remove());
      if (plugin.settings.liveDropcaps) out.why.push('the command does not turn it off');
      plain(out);
    });
    // ---- on: everything below is with the setting on ----
    await plugin.updateSettings({ liveDropcaps: true });

    // ---- which paragraphs ----
    await run('the same paragraphs have a drop cap in Live Preview as in Reading view', async out => {
      await open(TORTURE, 'live');
      const live = await liveCaps();
      await setMode('reading');
      const read = await readCaps();
      const caps = m => Array.from(m).filter(([, v]) => v !== 'none').map(([k, v]) => `${k.slice(0, 12)}:${v}`);
      out.caps = caps(read).length;
      out.paragraphs = read.size;
      for (const [k, v] of read) if (v !== 'none' && live.get(k) !== v) out.why.push(`“${k}” is ${v} in Reading view, ${live.get(k) || 'not found'} in the editor`);
      for (const [k, v] of live) if (v !== 'none' && v !== 'not drawn' && read.get(k) !== v) out.why.push(`“${k}” is ${v} in the editor, ${read.get(k) || 'not found'} in Reading view`);
      const want = ['A body at re', 'Conservation', 'Energy is ne', 'Golf stands ', 'Lima is a pa', 'Romeo stands', 'Sierra begin', 'Tango begins', '“Uniform,” s', 'Whiskey is t', 'Xray is cent', '1984 begins ', 'Galileo is s', 'Inertia was ', 'What a falli'];
      out.editor = caps(live).filter(c => !/not drawn/.test(c)).length;
      const got = caps(read).map(c => c.split(':')[0]);
      for (const w of want) if (!got.includes(w)) out.why.push(`Reading view gives “${w}” no drop cap: the case is not what it was written for`);
      if (got.length !== want.length) out.why.push(`${got.length} drop caps in Reading view, ${want.length} expected: ${got.filter(g => !want.includes(g)).join(', ')}`);
    });
    await run('a note with properties: no drop cap at its top, in either view; one under its heading', async out => {
      const text = note('tags: [check]', PARAS.B, '## Two', PARAS.T);
      await open(text, 'live');
      const live = await liveCaps();
      await setMode('reading');
      const read = await readCaps();
      if (live.get(words({ textContent: PARAS.B })) !== 'none' || read.get(words({ textContent: PARAS.B })) !== 'none') out.why.push(`the top paragraph: ${live.get(words({ textContent: PARAS.B }))} in the editor, ${read.get(words({ textContent: PARAS.B }))} in Reading view`);
      if (live.get(words({ textContent: PARAS.T })) !== 'dropped' || read.get(words({ textContent: PARAS.T })) !== 'dropped') out.why.push(`under the heading: ${live.get(words({ textContent: PARAS.T }))} in the editor, ${read.get(words({ textContent: PARAS.T }))} in Reading view`);
    });

    // ---- each kind of drop cap: the same face, size and place, and the same lines ----
    const KINDS = [
      { name: 'Yinit (the default)', letter: 'E' }, { name: 'Yinit', letter: 'Q' }, { name: 'Yinit', letter: 'W' }, { name: 'Yinit, an initial that is a word by itself', letter: 'A' },
      { name: 'Goudy Initialen, the note’s own', props: 'dropcap: goudy', letter: 'T' },
      { name: 'a plain capital, the note’s own', props: 'dropcap: plain', letter: 'C' },
      { name: 'none, the note’s own', props: 'dropcap: none', letter: 'E', expect: 'none' },
      { name: 'Yinit, the note’s own, where the vault has Goudy', props: 'dropcap: yinit', vault: 'goudy', letter: 'G' },
      { name: 'Goudy Initialen, the vault’s', vault: 'goudy', letter: 'B' },
      { name: 'a plain capital, the vault’s', vault: 'plain', letter: 'I' },
      { name: 'none, the vault’s', vault: 'none', letter: 'Q', expect: 'none' },
      { name: 'a font of initials (Kanzlei Initialen)', props: 'dropcap: Kanzlei Initialen', letter: 'W' },
      { name: 'a font of initials, one file a letter (Deutsche Zierschrift), the vault’s', vault: 'set:Deutsche Zierschrift', letter: 'A' },
      { name: 'a set of images (Dropcat)', props: 'dropcap: Dropcat', letter: 'Q', expect: 'image' },
      { name: 'a set of images, an initial that is a word by itself', props: 'dropcap: Dropcat', letter: 'I', text: `I take it that inertia ${PARAS.I.slice(8)}`, start: 'I take it', expect: 'image' },
      { name: 'a set of images (Gene Wolfe), the vault’s', vault: 'set:Gene Wolfe', letter: 'T', expect: 'image' },
      { name: 'a set of images without the paragraph’s letter: the vault’s drop cap', props: 'dropcap: Dropcat', letter: 'E' },
      { name: 'a set the writer added (images in colour, not square)', props: `dropcap: ${SETS[0]}`, letter: 'E', expect: 'image' },
      { name: 'a drop cap drawn for the note (one colour, as Lagrange hands it over)', props: `dropcap: ${SETS[1]}`, letter: 'E', expect: 'image' },
      { name: 'Fancy mode: Yinit', fancy: true, letter: 'C' },
      { name: 'Fancy mode: a set of images', fancy: true, props: 'dropcap: Dropcat', letter: 'B', expect: 'image' },
      { name: 'dark theme: Yinit', dark: true, letter: 'I' },
      { name: 'dark theme: a set of images (Dropcat’s dark pictures)', dark: true, props: 'dropcap: Dropcat', letter: 'G', expect: 'image' },
      { name: 'dark theme: a set the writer added (its dark pictures are square)', dark: true, props: `dropcap: ${SETS[0]}`, letter: 'T', expect: 'image' },
      { name: 'dark theme: a drop cap drawn for the note', dark: true, props: `dropcap: ${SETS[1]}`, letter: 'E', expect: 'image' },
      { name: 'a short paragraph (the next one wraps round the initial)', letter: 'E', text: 'Energy is never lost.' },
      { name: 'under an epigraph', letter: 'Q', before: '> Nothing is lost, nothing is created.' },
      { name: 'a paragraph that begins in bold', letter: 'T', text: `**The pendulum** ${PARAS.T.slice(13)}`, start: 'The pendulum keeps' },
      { name: 'a paragraph that begins with a quotation mark', letter: 'W', text: `“${PARAS.W.slice(0, 40)}” ${PARAS.W.slice(41)}`, start: '“What a falling' },
    ];
    for (const k of KINDS) {
      await run(`${k.name}: the initial and every line stand where Reading view has them`, async out => {
        await theme(Boolean(k.dark));
        await plugin.updateSettings({ initials: k.vault || 'yinit', fancyMode: Boolean(k.fancy) });
        const text = k.text || PARAS[k.letter];
        const got = await both(out, note(k.props, '## A chapter', ...(k.before ? [k.before] : []), text, SECOND), k.start || text.replace(/[*“]/g, '').slice(0, 14), k.expect || 'dropped');
        if (got && (k.expect || 'dropped') === 'dropped') { out.initial = `${got.a.cap.letter} ${Math.round(got.a.cap.width)}x${Math.round(got.a.cap.height)}`; out.face = got.a.style.font.split(',')[0].replace(/"/g, ''); }
        if (got && k.expect === 'image') out.initial = got.a.style.image.split(' ').slice(2, 5).join('');
      });
    }
    await theme(false);
    await plugin.updateSettings({ initials: 'yinit', fancyMode: false });
    await run('no word is split across the small-capped first line: the word Reading view keeps whole is kept whole in the editor', async out => {
      // (a long word is moved along the first line until Reading view would break it there, and keeps it whole; the
      // word has hyphens of its own, so that the case does not hang on the system having a hyphenation dictionary)
      for (let k = 4; k <= 16 && !out.kept; k++) {
        const text = `The ${'old '.repeat(k)}never-to-be-forgotten-or-forgiven incomprehensibilities of the natural philosophers were at first a matter of words, and afterwards of numbers, and the numbers have not made them fewer.`;
        await open(note('', '## A chapter', text, SECOND), 'reading');
        const p = readPara('The old');
        const word = p && p.querySelector('.sc-keep');
        if (!word) continue;
        out.kept = word.textContent;
        const got = await both(out, note('', '## A chapter', text, SECOND), 'The old', 'dropped');
        if (got && got.a.style.kept !== out.kept) out.why.push(`the editor keeps “${got.a.style.kept}” whole, Reading view “${out.kept}”`);
        // typing in the paragraph leaves the note's text alone, and the word is still whole
        const cm = cmOf(); await setMode('live');
        const end = cm.state.doc.line(3).to;
        cm.dispatch({ changes: { from: end, insert: ' More.' }, userEvent: 'input.type' }); await sleep(200);
        const line = liveLine('The old');
        if (!line.querySelector('.sc-keep') || line.querySelector('.sc-keep').textContent !== out.kept) out.why.push('after typing in the paragraph the word is no longer kept whole');
        if (cm.state.doc.line(3).text !== `${text} More.`) out.why.push('the note’s text is not what was typed');
      }
      if (!out.kept) out.why.push('Reading view kept no word whole in any of the paragraphs tried: the case is not what it was written for');
    });

    // ---- aligned text ----
    const VERSE = ['Tyger Tyger, burning bright,', 'In the forests of the night;'];
    await run('centred text has no drop cap, in either view, and the paragraph after it opens the chapter', async out => {
      const text = note('', '## Verse', `::: center\n${VERSE.join('\n')}\n:::`, PARAS.E);
      const got = await both(out, text, 'Tyger', 'none', 1);
      if (got && got.a.style.align !== 'center') out.why.push(`the verse is set ${got.a.style.align} in the editor`);
      await both(out, text, 'Energy is never', 'dropped');
    });
    for (const [kind, props, marker] of [['centred', '', '::: center dropcap'], ['set to the right', '', '::: right dropcap'], ['centred, in a note that asks for it in its properties', 'dropcap-aligned: true', '::: center'],
      ['centred, with a set of images', 'dropcap: Dropcat', '::: center dropcap'], ['centred, with Goudy Initialen', 'dropcap: goudy', '::: center dropcap']]) {
      await run(`aligned text that asks for its drop cap (${kind}): a standing initial, where Reading view has it`, async out => {
        const text = note(props, '## Verse', `${marker}\n${VERSE.join('\n')}\n:::`, PARAS.E);
        const got = await both(out, text, 'Tyger', /images/.test(kind) ? 'image' : 'standing', 1);
        if (got) out.initial = got.a.cap ? `${got.a.cap.letter} ${Math.round(got.a.cap.width)}x${Math.round(got.a.cap.height)}` : got.a.style.image.split(' ').slice(0, 2).join(' ');
        await both(out, text, 'Energy is never', 'none');
      });
    }
    await run('a note that is centred as a whole: no drop cap unless its properties ask for one', async out => {
      await both(out, note('align: center', '## Verse', VERSE.join('\n'), 'More of it.'), 'Tyger', 'none', 1);
      // (other words: Reading view keeps a block it has drawn while the block's own text is the same, and marks it again only a moment after the properties change)
      await both(out, note('align: center\ndropcap-aligned: true', '## Verse', 'Tiger, tiger, burning bright\nIn the forests of the night,', 'More of it.'), 'Tiger', 'standing', 1);
    });

    // ---- the first letter is still the note's text ----
    const TEXT = note('', '## A chapter', PARAS.E, SECOND);
    const from = () => cmOf().state.doc.line(3).from;   // the paragraph's first letter
    const shape = () => {
      const el = liveLine(cmOf().state.doc.line(3).text.slice(0, 12)), m = measure(el);
      const next = Array.from(cmOf().contentDOM.querySelectorAll('.cm-line')).find(l => l.textContent.startsWith('A second paragraph'));
      return { cap: m.cap, tops: m.lines.map(l => Math.round(l.top * 10) / 10), lefts: m.lines.map(l => Math.round(l.left * 10) / 10), box: m.box, next: next ? next.getBoundingClientRect().top - m.box.top : 0, text: m.lines.map(l => l.text) };
    };
    const same = (a, b, what, out) => {
      const far = Math.max(Math.abs(a.cap.left - b.cap.left), Math.abs(a.cap.top - b.cap.top), Math.abs(a.cap.width - b.cap.width), Math.abs(a.next - b.next), Math.abs(a.box.height - b.box.height),
        ...a.tops.map((t, i) => Math.abs(t - (b.tops[i] == null ? 1e3 : b.tops[i]))), ...a.lefts.map((t, i) => Math.abs(t - (b.lefts[i] == null ? 1e3 : b.lefts[i]))));
      if (far > 0.5) out.why.push(`${what}: something moved by ${far.toFixed(1)} px`);
      return far;
    };
    await run('the first letter can be edited: typed before, replaced and deleted, and the initial follows', async out => {
      await open(TEXT, 'live');
      const cm = cmOf(), at = from();
      cm.focus();
      for (const pos of [at, at + 1]) {
        cm.dispatch({ selection: { anchor: pos } });
        await frame();
        if (cm.state.selection.main.head !== pos) out.why.push(`the cursor cannot be put at ${pos - at}`);
        const c = cm.coordsAtPos(pos);
        if (!c) out.why.push(`no place for the cursor at ${pos - at}`);
        const sel = window.getSelection();
        if (!sel.rangeCount || !cm.contentDOM.contains(sel.anchorNode)) out.why.push(`the page’s own cursor is not in the line at ${pos - at}`);
      }
      const letterNow = () => { const m = measure(Array.from(cm.contentDOM.querySelectorAll('.cm-line.scriptorium-opening'))[0] || cm.contentDOM); return m.cap ? m.cap.letter : null; };
      const step = async (spec, wantText, wantCap, what) => {
        cm.dispatch(Object.assign({ userEvent: 'input.type' }, spec));
        await frame(); await frame();
        const text = cm.state.doc.line(3).text;
        if (!text.startsWith(wantText)) out.why.push(`${what}: the note has “${text.slice(0, 12)}”`);
        if (letterNow() !== wantCap) out.why.push(`${what}: the initial is ${letterNow()}, not ${wantCap}`);
      };
      await step({ changes: { from: at, insert: 'X' }, selection: { anchor: at + 1 } }, 'XEnergy', 'X', 'a letter typed before the first');
      await step({ changes: { from: at, to: at + 1 }, selection: { anchor: at } }, 'Energy', 'E', 'and deleted again');
      await step({ changes: { from: at, to: at + 1, insert: 'I' }, selection: { anchor: at + 1 } }, 'Inergy', 'I', 'the first letter replaced');
      await step({ changes: { from: at, to: at + 1 }, selection: { anchor: at } }, 'nergy', 'n', 'the first letter deleted (the next one is the initial)');
      await step({ changes: { from: at, insert: 'E' }, selection: { anchor: at + 1 } }, 'Energy', 'E', 'and typed again');
      if (cm.state.doc.toString() !== TEXT) out.why.push('the note is not what it was after the edits');
      // the note's text is never changed by the drop cap itself
      await open(TEXT, 'live');
      if (leaf.view.editor.getValue() !== TEXT) out.why.push('opening the note in Live Preview changed its text');
    });
    await run('a click on the initial puts the cursor at the letter; a double click takes the first word', async out => {
      await open(TEXT, 'live');
      const cm = cmOf(), at = from(), line = liveLine('Energy is never'), cap = measure(line).cap, box = line.getBoundingClientRect();
      const click = (x, y, detail) => line.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, detail: detail || 1, clientX: box.left + cap.left + x, clientY: box.top + cap.top + y, view: window }));
      const mouseup = () => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, view: window }));
      const head = () => cm.state.selection.main.head - at, anchor = () => cm.state.selection.main.anchor - at;
      cm.dispatch({ selection: { anchor: cm.state.doc.length } });
      click(cap.width * 0.25, cap.height / 2); mouseup(); await frame();
      if (head() !== 0 || anchor() !== 0) out.why.push(`a click on the left of the initial puts the cursor at ${head()}`);
      click(cap.width * 0.8, cap.height * 0.8); mouseup(); await frame();
      if (head() !== 1 || anchor() !== 1) out.why.push(`a click on the right of the initial puts the cursor at ${head()}`);
      click(cap.width / 2 + 1, cap.height / 2, 2); mouseup(); await frame();
      if (cm.state.sliceDoc(cm.state.selection.main.from, cm.state.selection.main.to) !== 'Energy') out.why.push(`a double click on the initial selects “${cm.state.sliceDoc(cm.state.selection.main.from, cm.state.selection.main.to).slice(0, 20)}”`);
      if (!cm.hasFocus) out.why.push('the editor does not have the keyboard after the click');
      // a click in the text beside the initial is the editor's own affair
      cm.dispatch({ selection: { anchor: cm.state.doc.length } });
      const c = cm.coordsAtPos(at + 12, 1);
      line.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, detail: 1, clientX: c.left + 1, clientY: (c.top + c.bottom) / 2, view: window }));
      mouseup(); await frame();
      if (Math.abs(head() - 12) > 1) out.why.push(`a click in the text beside the initial puts the cursor at ${head()}, not 12`);
    });
    await run('a selection, the clipboard, the editor’s text and a search all have the first letter', async out => {
      await open(TEXT, 'live');
      const cm = cmOf(), at = from();
      cm.focus();
      cm.dispatch({ selection: { anchor: at, head: at + 21 } });
      await frame(); await frame();
      const picked = window.getSelection().toString();
      if (picked !== 'Energy is never lost,') out.why.push(`the page’s selection is “${picked}”`);
      const data = new DataTransfer();
      cm.contentDOM.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));   // the editor fills the clipboard itself
      const copied = data.getData('text/plain');
      out.copied = copied.slice(0, 12);
      if (copied !== 'Energy is never lost,') out.why.push(`the clipboard has “${copied.slice(0, 30)}”`);
      const line = liveLine('Energy is never');
      if (!line.textContent.startsWith('Energy is never lost')) out.why.push(`the line’s own text begins “${line.textContent.slice(0, 20)}”`);
      const node = document.createTreeWalker(line, NodeFilter.SHOW_TEXT).nextNode();
      if (!node || node.data[0] !== 'E' || node.parentElement.closest('[contenteditable="false"]') || !line.isContentEditable) out.why.push('the first letter is not editable text of the line (a spell-checker would not see it)');
      out.spellcheck = cm.contentDOM.getAttribute('spellcheck');
      if (line.querySelector('.cm-widgetBuffer, img, [contenteditable="false"]')) out.why.push('something was put into the line');
      if (cm.state.doc.toString().indexOf('Energy is never lost') !== at) out.why.push('a search of the note does not find the paragraph’s first words where they are');
    });
    await run('nothing moves when the cursor comes into the paragraph, or while it is typed in', async out => {
      await open(TEXT, 'live');
      const cm = cmOf(), at = from(), line = cm.state.doc.line(3);
      await sleep(300);
      const before = shape();
      let far = 0;
      cm.focus();
      for (const pos of [at, at + 1, at + 40, line.to]) { cm.dispatch({ selection: { anchor: pos } }); await frame(); await frame(); far = Math.max(far, same(before, shape(), `the cursor at ${pos - at}`, out)); }
      // typed at the end of the paragraph, a letter at a time, looked at on every frame
      let frames = 0, moved = 0, on = true;
      const watch = () => { if (!on) return; frames++; try { const s = shape(); const f = Math.max(Math.abs(s.cap.left - before.cap.left), Math.abs(s.cap.top - before.cap.top), Math.abs(s.cap.width - before.cap.width), Math.abs(s.box.width - before.box.width), ...before.tops.slice(0, 3).map((t, i) => Math.abs(t - s.tops[i])), ...before.lefts.slice(0, 3).map((t, i) => Math.abs(t - s.lefts[i]))); moved = Math.max(moved, f); } catch (e) { moved = Math.max(moved, 999); } requestAnimationFrame(watch); };
      requestAnimationFrame(watch);
      const typed = ' And more.';
      for (let i = 0; i < typed.length; i++) { const end = cm.state.doc.line(3).to; cm.dispatch({ changes: { from: end, insert: typed[i] }, selection: { anchor: end + 1 }, userEvent: 'input.type' }); await sleep(45); }
      // and inside the first line: a letter typed and deleted leaves everything where it was
      const mid = at + 8;
      cm.dispatch({ changes: { from: mid, insert: 'x' }, selection: { anchor: mid + 1 }, userEvent: 'input.type' }); await sleep(60);
      cm.dispatch({ changes: { from: mid, to: mid + 1 }, selection: { anchor: mid }, userEvent: 'delete.backward' }); await sleep(120);
      on = false;
      out.frames = frames;
      out.movedPx = Number(Math.max(far, moved).toFixed(2));
      if (moved > 0.5) out.why.push(`while typing, the initial or the first lines moved by ${moved.toFixed(1)} px`);
      const after = shape();
      if (Math.abs(after.cap.left - before.cap.left) > 0.5 || Math.abs(after.cap.top - before.cap.top) > 0.5 || after.tops.slice(0, 3).some((t, i) => Math.abs(t - before.tops[i]) > 0.5)) out.why.push('after the typing the paragraph is not where it was');
    });
    await run('a paragraph that begins with marks: plain while the cursor is on its line (the marks show), a drop cap again when it leaves', async out => {
      const text = note('', '## A chapter', `**The pendulum** ${PARAS.T.slice(13)}`, SECOND);
      await open(text, 'live');
      const cm = cmOf(), line = cm.state.doc.line(3);
      const has = () => { const el = Array.from(cm.contentDOM.querySelectorAll('.cm-line')).find(l => /The pendulum/.test(l.textContent)); return measure(el).has; };
      if (!has()) out.why.push('no drop cap with the cursor elsewhere');
      cm.focus();
      cm.dispatch({ selection: { anchor: line.from + 4 } }); await frame(); await frame();
      if (has()) out.why.push('the drop cap stays while the cursor shows the marks');
      cm.dispatch({ selection: { anchor: cm.state.doc.length } }); await frame(); await frame();
      if (!has()) out.why.push('no drop cap after the cursor left');
    });

    // ---- Source mode, the inking, the choice ----
    await run('Source mode is plain', async out => {
      await open(TEXT, 'source');
      const m = measure(liveLine('Energy is never'));
      if (m.has || m.style.float !== 'none' || m.style.size !== m.style.text || m.style.caps === 'small-caps') out.why.push(`Source mode has an initial (${m.style.float}, ${m.style.size}, ${m.style.caps})`);
      await setMode('live');
      if (!measure(liveLine('Energy is never')).has) out.why.push('no drop cap back in Live Preview');
    });
    await run('a drop cap that is shown from the list is shown in the editor, inked in, and taken back', async out => {
      await open(TEXT, 'live');
      const line = () => liveLine('Energy is never');
      plugin.previewDropcap(leaf.view, 'goudy');
      await frame(); await frame();
      let m = measure(line());
      if (!/Goudy/.test(m.style.font)) out.why.push(`the editor shows ${m.style.font.split(',')[0]} for Goudy`);
      if (!line().classList.contains('scriptorium-dropcap-inked')) out.why.push('not inked in');
      out.animation = getComputedStyle(line()).animationName;
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches && out.animation !== 'scriptorium-ink') out.why.push(`the animation is ${out.animation}`);
      plugin.previewDropcap(leaf.view, `set:${SETS[0]}`);
      await sleep(400);
      m = measure(line());
      if (!m.image) out.why.push('a set of images is not shown from the list');
      plugin.previewDropcap(leaf.view, 'none');
      await frame(); await frame();
      if (measure(line()).has) out.why.push('“None” is not shown from the list');
      plugin.previewDropcap(leaf.view, undefined);
      await frame(); await frame();
      m = measure(line());
      if (!/Yinit/.test(m.style.font) || !m.cap) out.why.push('not taken back to what the note says');
      await sleep(2800);
      if (line().classList.contains('scriptorium-dropcap-inked')) out.why.push('the inking does not end');
      if (leaf.view.editor.getValue() !== TEXT) out.why.push('showing a drop cap changed the note');
    });
    await run('the note’s “dropcap” property is followed as it is typed', async out => {
      await open(TEXT, 'live');
      const cm = cmOf();
      cm.dispatch({ changes: { from: 0, insert: '---\ndropcap: goudy\n---\n' } });
      await frame(); await frame();
      let m = measure(liveLine('Energy is never'));
      if (!/Goudy/.test(m.style.font)) out.why.push(`after “dropcap: goudy” the editor shows ${m.style.font.split(',')[0]}`);
      const a = cm.state.doc.toString().indexOf('goudy');
      cm.dispatch({ changes: { from: a, to: a + 5, insert: 'none' } });
      await frame(); await frame();
      if (measure(liveLine('Energy is never')).has) out.why.push('after “dropcap: none” there is still an initial');
    });
  } finally {
    await theme(layout.theme !== 'moonstone');
    await plugin.updateSettings({ initials: saved.initials, fancyMode: saved.fancy, liveDropcaps: saved.live });
    if (!options.keep) {
      await dropSets();
      try { await leaf.openFile(file, { state: { mode: 'source', source: false } }); await app.vault.delete(file); } catch (e) { /* stays */ }
    }
    if (!layout.left) ws.leftSplit.expand();
    if (!layout.right) ws.rightSplit.expand();
    try {
      if (layout.bounds) require('@electron/remote').getCurrentWindow().setBounds(layout.bounds);
      if (layout.zoom) require('electron').webFrame.setZoomFactor(layout.zoom);
    } catch (e) { /* as it is */ }
  }
  const failed = results.filter(r => !r.ok).length;
  console.table(results.map(r => ({ case: r.name, ok: r.ok, px: r.maxPx, why: r.why })));
  return JSON.stringify({ ok: failed === 0, failed, cases: results });
})()
