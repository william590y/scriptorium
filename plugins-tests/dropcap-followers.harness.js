// What follows a short opening paragraph, checked in a real Obsidian, in Reading view and in Live Preview.
//
// An initial is three lines deep; a paragraph of one line or two is not, so what comes after it is beside the
// initial. Up to 1.4.4 a list's bullets, numbers and checkboxes were drawn on the initial in Reading view, a
// quotation's bar ran under it, callouts, tables, rules and mathematics were squeezed in beside it, and in the editor
// the text of a list or of a quotation was drawn through it (the two screenshots this began with: the vault's
// README, "Drop caps, marginalia and image focus", in both views). The rule since 1.4.5 (see "What follows a short
// opening paragraph" in the snippet, and openingPlan in the plugin):
//   - a paragraph goes round the initial; a list does too, item by item (an item beside the initial is set in past
//     it with its marker, and the items below it are back at the margin);
//   - everything else begins below the initial, on the fourth line: a quotation, a callout, code, a table, a heading,
//     an image, mathematics, a rule, aligned text, the end of the note.
// For each kind of follower, for an opening paragraph of one, two and three lines, at three widths, for the three
// initials (Yinit, Goudy Initialen, plain) and in both modes, the note is opened in the editor and in Reading view
// and measured from the page:
//   - nothing of what follows touches the initial's ink: no letter, no marker (bullet, number, checkbox), no
//     border, background or picture (the ink is measured from the font, or is the image's box);
//   - a list's markers are all there and inside the column, an item beside the initial is set in past it, and the
//     same items are set in, by the same amount within 2 px, in both views;
//   - what begins below the initial begins on or after the fourth line, in both views, and no further apart in the
//     two views than it is after a paragraph of three lines (what the views differ by there, they differed by
//     before: the editor shows the blank line between blocks);
//   - the opening paragraph and its initial are the same in both views within 1 px;
//   - in the editor no line is pushed down by a clearance the editor has not measured (each line begins where the
//     one before ends).
// Then, in the editor: the cursor in each of the lines concerned, typing in the paragraph and in the list, folding,
// a long note scrolled away and back, the window resized and zoomed with the note open, the drop cap changed and
// turned off and on again; Source mode stays plain; an initial that is an image; and the vault's own README at the
// widths of the two screenshots.
// This cannot run under Node (it needs Obsidian's layout), so it is not part of `node --test`; it is a manual check,
// or one a machine can run through the DevTools protocol.
//
// To run it: open a Scriptorium vault in Obsidian (the Scriptorium plugin and the manuscript snippet on), open the
// developer tools (Ctrl+Shift+I) and paste this file into the console; or evaluate it with Runtime.evaluate
// (awaitPromise: true). It makes a note "Drop cap followers check.md" and a picture beside it, and takes them away
// again; the vault's settings and the window are put back. It answers with a JSON text {ok, failed, cases: [{name,
// ok, why}]} and prints a table. Options: window.dropcapFollowOptions = {only: 'text in a case name', quick: true
// (one width, Yinit, normal mode), keep: true, settle: ms}.
//
// Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).
(async () => {
  const options = window.dropcapFollowOptions || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const frame = () => new Promise(r => requestAnimationFrame(r));
  const plugin = app.plugins.plugins.scriptorium;
  if (!plugin) throw new Error('Scriptorium is not enabled in this vault');
  if (typeof plugin.applyLiveDropcaps !== 'function') throw new Error('This Scriptorium has no drop caps in Live Preview');
  const S = plugin.constructor;
  if (typeof S.besideItems !== 'function') throw new Error('This Scriptorium does not set what follows a short opening paragraph (1.4.5)');
  const TOL = 2, NEAR = 0.6;

  // ---- the notes ----
  const LONG = 'Under the settings of Scriptorium there are three things to choose, and each of them is set out in what follows this paragraph, which is made long enough here to run onto a second line of the page and then onto a third and a fourth, at every one of the widths that are tried, so that as many of its words as are wanted can be taken from its beginning';
  const SHORT = 'Under **Settings → Scriptorium**:';
  const PICTURE = 'Drop cap followers check.png';
  // kind: 'text' (goes round the initial), 'list' (item by item), 'clear' (begins below it); tight: no blank line before it
  const FOLLOWERS = [
    { name: 'a list of bullets', kind: 'list', markers: 3, text: '- **Drop cap:** Yinit (ornamental, the default), Goudy Initialen (floriated), a plain Cormorant Garamond capital, or none.\n- **Marginalia:** in Reading view, footnotes are set in the right margin beside their references.\n- **Image focus:** click an image to see it on its own.' },
    { name: 'a list of short bullets', kind: 'list', markers: 4, text: '- one\n- two\n- three\n- four' },
    { name: 'a list right under the paragraph’s line', kind: 'list', markers: 4, tight: true, text: '- one\n- two\n- three\n- four' },
    { name: 'a numbered list', kind: 'list', markers: 3, text: '1. First of the numbered items, which is long enough to wrap onto a second line of the page at any of the widths that are tried here.\n2. Second.\n3. Third.' },
    { name: 'a task list', kind: 'list', markers: 3, text: '- [ ] A task to do, long enough to wrap onto a second line of the page at any of the widths that are tried here, and a little more.\n- [x] A task done.\n- [ ] Another.' },
    { name: 'a nested list', kind: 'list', markers: 5, text: '- Outer one\n    - inner one\n    - inner two\n- Outer two\n    1. numbered inner\n- Outer three' },
    { name: 'a list whose items are paragraphs', kind: 'list', markers: 3, text: '- First of the items, which is long enough to wrap onto a second line of the page at any of the widths that are tried here.\n\n- Second.\n\n- Third.' },
    { name: 'a paragraph', kind: 'text', text: 'A second paragraph follows the first, and is long enough to wrap onto another line of the page, and then onto a third, so that it is seen to go round the initial and back to the margin below it.' },
    { name: 'a quotation', kind: 'clear', text: '> A quotation follows the short paragraph, and is long enough to wrap onto a second line of the page at any width.' },
    { name: 'a callout', kind: 'clear', text: '> [!note] A callout\n> with its text, which is a sentence.' },
    { name: 'code', kind: 'clear', text: '```js\nconst code = 1;\nconst more = 2;\n```' },
    { name: 'a table', kind: 'clear', text: '| a | b |\n| - | - |\n| 1 | 2 |' },
    { name: 'a smaller heading', kind: 'clear', text: '### A smaller heading\n\nText under it.' },
    { name: 'an image', kind: 'clear', text: `![[${PICTURE}]]` },
    { name: 'mathematics', kind: 'clear', text: '$$\nx^2 + y^2 = z^2\n$$' },
    { name: 'a rule', kind: 'clear', text: '---\n\nAfter the rule.' },
    { name: 'centred text', kind: 'clear', text: '::: center\nA line of verse, centred,\nand its second line.\n:::' },
    { name: 'the end of the note', kind: 'clear', text: '', end: true },
  ];
  const noteOf = (para, f) => `## Drop caps\n\n${para}${f.tight ? '\n' : '\n\n'}${f.text}${f.text ? '\n\n' : ''}${f.end ? '' : '## Next\n\nAfter it all.\n'}`;

  const path = 'Drop cap followers check.md';
  let file = app.vault.getAbstractFileByPath(path);
  if (!file) file = await app.vault.create(path, '');
  if (!app.vault.getAbstractFileByPath(PICTURE)) {
    const c = document.createElement('canvas'); c.width = 480; c.height = 160;
    const x = c.getContext('2d'); x.fillStyle = '#7a8fa6'; x.fillRect(0, 0, 480, 160);
    await app.vault.createBinary(PICTURE, await (await new Promise(r => c.toBlob(r, 'image/png'))).arrayBuffer());
  }
  const leaf = app.workspace.getLeavesOfType('markdown')[0] || app.workspace.getLeaf(true);
  const ws = app.workspace;
  const layout = { left: ws.leftSplit.collapsed, right: ws.rightSplit.collapsed, bounds: null, zoom: null, theme: app.vault.getConfig('theme') };
  let win = null, webFrame = null;
  try {
    win = require('@electron/remote').getCurrentWindow(); webFrame = require('electron').webFrame;
    layout.bounds = win.getBounds(); layout.zoom = webFrame.getZoomFactor();
    win.unmaximize(); webFrame.setZoomFactor(1);
  } catch (e) { /* not the desktop app: the window is as it is */ }
  const resize = async width => { if (win) { win.setBounds({ x: layout.bounds.x, y: layout.bounds.y, width, height: 900 }); await sleep(450); } };
  ws.leftSplit.collapse(); ws.rightSplit.collapse();
  const saved = { initials: plugin.settings.initials, fancy: plugin.settings.fancyMode, live: plugin.settings.liveDropcaps };
  const settle = options.settle || 0;

  const cmOf = () => leaf.view.editor.cm;
  const scrollerOf = mode => (mode === 'reading' ? leaf.view.containerEl.querySelector('.markdown-preview-view') : cmOf().scrollDOM);
  const rootOf = mode => (mode === 'reading' ? leaf.view.containerEl.querySelector('.markdown-preview-sizer') : cmOf().contentDOM);
  /* Two frames and the measure the plugin asks for after them (the lines under an item are set in from a measure). */
  const quiet = async () => { for (let i = 0; i < 4; i++) await frame(); await sleep(60 + settle); await frame(); };
  const setMode = async mode => {
    await leaf.setViewState(Object.assign({}, leaf.getViewState(), { state: Object.assign({}, leaf.getViewState().state, mode === 'reading' ? { mode: 'preview' } : { mode: 'source', source: mode === 'source' }) }));
    await sleep(420 + settle);
    scrollerOf(mode).scrollTop = 0;
    await quiet();
  };
  const open = async (text, mode, at) => {
    document.querySelectorAll('.modal-container').forEach(m => m.remove());
    if (leaf.view.file !== file || leaf.getViewState().state.mode !== 'source' || leaf.getViewState().state.source) await leaf.openFile(file, { state: { mode: 'source', source: false } });
    if (leaf.view.editor.getValue() !== text) { leaf.view.editor.setValue(text); await sleep(380 + settle); }
    leaf.view.editor.setCursor(at == null ? leaf.view.editor.lastLine() : at, 0);
    await setMode(mode || 'live');
  };
  /* The opening paragraph that begins with `start` is brought near the top of the pane (both views draw only what is near). */
  const bring = async (mode, start) => {
    const sc = scrollerOf(mode);
    for (let i = 0; i < 40; i++) {
      const el = opening(mode, start);
      if (el) { sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 140; await quiet(); return opening(mode, start); }
      if (mode === 'reading') sc.scrollTop = i ? sc.scrollTop + 500 : 0; else {
        const doc = cmOf().state.doc, n = Array.from({ length: doc.lines }, (_, k) => k + 1).find(k => S.shownLine(doc.line(k).text).trim().startsWith(start));
        if (n) cmOf().dispatch({ effects: cmOf().constructor.scrollIntoView(doc.line(n).from, { y: 'center' }) });
      }
      await sleep(150);
    }
    return null;
  };
  const words = el => String(el.textContent || '').replace(/\s+/g, ' ').trim();
  const opening = (mode, start) => (mode === 'reading'
    ? Array.from(rootOf(mode).querySelectorAll(':scope > div.el-p > p')).find(p => words(p).startsWith(start))
    : Array.from(rootOf(mode).querySelectorAll(':scope > .cm-line')).find(l => words(l).replace(/[*_=~`\[\]]/g, '').startsWith(start)));

  // ---- measuring ----
  /* The text of el as it stands on the page, line by line: [{text, left, top, right, bottom}] (a line is measured by
     its letters), and the initial: a letter at least twice the size of the text. skip(element): what is left out. */
  const textOf = (el, skip) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), r = document.createRange(), lines = [];
    let cap = null, n;
    while ((n = walker.nextNode())) {
      const pe = n.parentElement;
      if (pe.closest('.cm-widgetBuffer, style, script, .scriptorium-fence') || (skip && skip(pe))) continue;
      const fs = parseFloat(getComputedStyle(pe).fontSize);
      for (let i = 0; i < n.data.length; i++) {
        r.setStart(n, i); r.setEnd(n, i + 1);
        const rc = r.getClientRects()[0], space = /\s/.test(n.data[i]), last = lines[lines.length - 1];
        if (!rc || !rc.height || (!rc.width && !space)) continue;
        if (!space && rc.height >= 2 * fs && !pe.closest('mjx-container, .math')) { if (!cap) cap = { letter: n.data[i], left: rc.left, top: rc.top, right: rc.right, bottom: rc.bottom }; continue; }
        if (space) { if (last && rc.top <= last.top + 0.6 * fs && rc.bottom >= last.top) last.text += ' '; continue; }
        if (!last || rc.top > last.top + 0.6 * fs || rc.bottom < last.top) lines.push({ text: n.data[i], left: rc.left, top: rc.top, right: rc.right, bottom: rc.bottom });
        else { last.text += n.data[i]; last.left = Math.min(last.left, rc.left); last.right = Math.max(last.right, rc.right); last.bottom = Math.max(last.bottom, rc.bottom); }
      }
    }
    return { cap, lines };
  };
  const canvas = document.createElement('canvas').getContext('2d');
  /* The ink of the initial of the opening paragraph el: a letter's, from the font's own measures of that letter
     (the box the page gives a letter is the font's, taller than any letter); an image's box. */
  const inkOf = el => {
    const be = getComputedStyle(el, '::before'), px = v => parseFloat(v) || 0;
    if (be.content !== 'none' && be.content !== 'normal' && be.float === 'left') {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el), left = r.left + px(cs.paddingLeft) + px(be.marginLeft), top = r.top + px(cs.paddingTop) + px(be.marginTop);
      return { kind: 'image', left, top, right: left + px(be.width), bottom: top + px(be.height), edge: left + px(be.width) + px(be.marginRight) };
    }
    const t = textOf(el);
    if (!t.cap) return null;
    const fl = getComputedStyle(el, '::first-letter');
    if (fl.float !== 'left') return null;
    canvas.font = `${fl.fontStyle} ${fl.fontWeight} ${fl.fontSize} ${fl.fontFamily}`;
    const m = canvas.measureText(t.cap.letter.toUpperCase());
    const base = t.cap.top + (t.cap.bottom - t.cap.top - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
    return { kind: 'letter', left: t.cap.left - m.actualBoundingBoxLeft, right: t.cap.left + m.actualBoundingBoxRight, top: base - m.actualBoundingBoxAscent, bottom: base + m.actualBoundingBoxDescent, edge: t.cap.right + px(fl.marginRight), font: fl.fontFamily.split(',')[0] };
  };
  const seen = c => c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c);
  const CHROME = '.cm-widgetBuffer, br, .collapse-indicator, .collapse-indicator *, .cm-fold-indicator, .copy-code-button, .edit-block-button, .edit-block-button *, .markdown-embed-link, .markdown-embed-link *, .embed-actions, .embed-actions *, .image-resize-corner, .table-col-drag-handle, .table-row-drag-handle, .table-col-drag-handle *, .table-row-drag-handle *, .table-col-btn, .table-row-btn, .table-col-btn *, .table-row-btn *';
  /* The opening paragraph that begins with `start` and what stands after it, down to the next heading (or the end):
     {ink, open: its box, lh, own: its lines, items: [{kind: 'text' | 'marker' | 'box', what, left, top, right,
     bottom}], rows: the list's items one by one [{top, left: where its words begin, edge: its box's left}],
     markers, first: the top of the first thing after it, gaps: (editor) lines that do not begin where the one
     before ends}. more: how many further lines of the note the paragraph has (the editor draws each as a line). */
  const scene = (mode, start, more) => {
    const root = rootOf(mode), el = opening(mode, start);
    if (!el) return { missing: true };
    const blocks = Array.from(root.children).filter(e => !e.matches('.markdown-preview-pusher, .mod-header, .mod-footer, .cm-gap'));
    const block = mode === 'reading' ? el.parentElement : el, at = blocks.indexOf(block);
    const cs = getComputedStyle(el), lh = parseFloat(cs.lineHeight), fs = parseFloat(cs.fontSize);
    const items = [], rows = [], own = textOf(el).lines.slice();
    const add = (kind, what, r) => { if (r && r.right - r.left > 0.2 && r.bottom - r.top > 0.2) items.push({ kind, what, left: r.left, top: r.top, right: r.right, bottom: r.bottom }); };
    let k = at + 1;
    for (let j = 0; mode !== 'reading' && j < (more || 0); j++, k++) own.push(...textOf(blocks[k]).lines);
    const box = el.getBoundingClientRect(), last = (mode !== 'reading' && more ? blocks[k - 1] : el).getBoundingClientRect();
    const open = { left: box.left, top: box.top, right: box.right, bottom: last.bottom, width: box.width };
    const followers = [];
    for (; k < blocks.length; k++) {
      const b = blocks[k], solid = e => e.getBoundingClientRect().height > 0 && (words(e) || e.querySelector('img:not(.cm-widgetBuffer), hr'));
      followers.push(b);
      if (b.matches('.el-h1, .el-h2, .el-h3, .el-h4, .el-h5, .el-h6, .HyperMD-header') && followers.slice(0, -1).some(solid)) break;
    }
    for (const b of followers) {
      const name = String(b.className || '').replace(/cm-line|cm-active|HyperMD-|scriptorium-|node-insert-event|is-loaded|mod-ui/g, '').replace(/\s+/g, ' ').trim().slice(0, 36) || b.tagName.toLowerCase();
      textOf(b).lines.forEach(l => add('text', `${name}: “${l.text.trim().slice(0, 24)}”`, l));
      for (const e of [b, ...b.querySelectorAll('*')]) {
        if (e.matches(CHROME)) continue;
        const es = getComputedStyle(e), r = e.getBoundingClientRect();
        if (es.display === 'none' || es.visibility === 'hidden') continue;
        if (e.matches('.list-bullet')) {
          if (!r.height) continue;
          const a = getComputedStyle(e, '::after'), w = parseFloat(a.width) || 6, h = parseFloat(a.height) || 6, cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
          add('marker', `${name}: bullet`, { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 });
          continue;
        }
        if (!r.width || !r.height) continue;
        if (e.matches('input[type=checkbox]')) { add('marker', `${name}: checkbox`, r); continue; }
        if (e.matches('.list-number')) { add('marker', `${name}: number`, r); continue; }
        if (e.tagName === 'LI' && e.parentElement.tagName === 'OL') {
          // Reading view's number: the item's own ::before where the snippet sets it there, or else the marker outside the item's box
          const b4 = getComputedStyle(e, '::before'), inside = b4.content !== 'none' && b4.content !== 'normal', n = Array.from(e.parentElement.children).indexOf(e) + parseInt(e.parentElement.getAttribute('start') || '1', 10);
          canvas.font = `${es.fontStyle} ${es.fontWeight} ${es.fontSize} ${es.fontFamily}`;
          const w = canvas.measureText(`${n}. `).width, x = r.left + (inside ? parseFloat(es.paddingLeft) : 0), y = r.top + parseFloat(es.paddingTop), l = parseFloat(es.lineHeight) || lh;
          add('marker', `${name}: number ${n}.`, { left: x - w, right: x, top: y + 0.25 * l, bottom: y + 0.8 * l });
        }
        if (e.matches('img, hr, svg, canvas, video, iframe')) { add('box', `${name}: ${e.tagName.toLowerCase()}`, r); continue; }
        if (e.closest('mjx-container')) continue;
        const border = ['Top', 'Right', 'Bottom', 'Left'].some(s => parseFloat(es[`border${s}Width`]) > 0 && es[`border${s}Style`] !== 'none' && seen(es[`border${s}Color`]));
        let pseudo = false;
        for (const p of ['::before', '::after']) {
          const ps = getComputedStyle(e, p);
          if (ps.content !== 'none' && ps.content !== 'normal' && ps.display !== 'none' && !e.matches('li > ul, li > ol, .cm-indent') && (seen(ps.backgroundColor) || ['Top', 'Right', 'Bottom', 'Left'].some(s => parseFloat(ps[`border${s}Width`]) > 0 && seen(ps[`border${s}Color`])))) pseudo = true;
        }
        if (seen(es.backgroundColor) || border || (es.boxShadow && es.boxShadow !== 'none') || pseudo) add('box', `${name}: ${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className ? `.${e.className.split(/\s+/)[0]}` : ''}`, r);
      }
      // a list's items, one by one: Reading view's <li>, the editor's lines that begin with a marker
      const lis = mode === 'reading' ? (b.matches('.el-ul, .el-ol') ? Array.from(b.querySelectorAll('li')) : []) : (b.matches('.HyperMD-list-line') && /^\s*(?:[-*+]|\d+[.)])\s/.test(b.textContent) || b.matches('.HyperMD-task-line') ? [b] : []);
      for (const li of lis) {
        const first = textOf(li, pe => pe.closest('.cm-formatting-list, .cm-hmd-list-indent, .list-bullet') || (mode === 'reading' && pe.closest('li') !== li)).lines[0], r = li.getBoundingClientRect();
        if (first) rows.push({ top: r.top, left: first.left, edge: r.left, deep: mode === 'reading' ? Boolean(li.parentElement.closest('li')) : !b.matches('.HyperMD-list-line-1') });
      }
    }
    const ink = inkOf(el);
    const gaps = [];
    if (mode !== 'reading') for (let e = block, j = 0; e && e.nextElementSibling && j <= (more || 0) + followers.length; e = e.nextElementSibling, j++) {
      const next = e.nextElementSibling;
      if (e.matches('.cm-gap') || next.matches('.cm-gap')) break;   // (lines that are not drawn: the editor's own spacer)
      const d = next.getBoundingClientRect().top - e.getBoundingClientRect().bottom;
      if (Math.abs(d) > NEAR) gaps.push(`${d.toFixed(1)} px after line ${j + 1} (“${words(e).slice(0, 18)}”)`);
    }
    const after = items.filter(i => i.kind !== 'own');
    const column = scrollerOf(mode).getBoundingClientRect();
    return { ink, open, lh, fs, own, items, rows, gaps, column, first: after.length ? Math.min(...after.map(i => i.top)) : null, firstLeft: after.length ? after.slice().sort((a, b) => a.top - b.top || a.left - b.left)[0].left : null, markers: items.filter(i => i.kind === 'marker') };
  };
  const touches = s => (s.ink ? s.items.filter(i => i.left < s.ink.right - 0.5 && i.right > s.ink.left + 0.5 && i.top < s.ink.bottom - 0.5 && i.bottom > s.ink.top + 0.5).map(i => `${i.kind} ${i.what} at ${i.left.toFixed(0)},${i.top.toFixed(0)}–${i.right.toFixed(0)},${i.bottom.toFixed(0)} (the initial: ${s.ink.left.toFixed(0)},${s.ink.top.toFixed(0)}–${s.ink.right.toFixed(0)},${s.ink.bottom.toFixed(0)})`) : []);

  // ---- the checks that every case makes ----
  /* One view of one note: s is its scene; kind is the follower's; lines, how many lines the paragraph has (0: not
     checked). → the reasons it fails. */
  const sound = (s, view, f, lines) => {
    const why = [];
    if (s.missing) return [`${view}: the opening paragraph is not on the page`];
    if (!s.ink) return [`${view}: the paragraph has no dropped initial`];
    if (lines && s.own.length !== lines) why.push(`${view}: the opening paragraph has ${s.own.length} lines, not the ${lines} the case is about`);
    for (const t of touches(s)) why.push(`${view}: on the initial: ${t}`);
    for (const g of s.gaps) why.push(`${view}: a gap the editor has not measured: ${g}`);
    const fourth = s.open.top + 3 * s.lh;
    if (f.kind === 'clear') {
      const deep = Math.max(3, s.own.length) * s.lh;
      if (Math.abs(s.open.bottom - s.open.top - deep) > NEAR) why.push(`${view}: the opening paragraph is ${(s.open.bottom - s.open.top).toFixed(1)} px deep, not ${deep.toFixed(1)} (three lines at least)`);
      if (s.first != null && s.first < fourth - NEAR) why.push(`${view}: what follows begins ${(fourth - s.first).toFixed(1)} px above the fourth line`);
      if (s.first == null && !f.end) why.push(`${view}: nothing was found after the paragraph`);
    } else if (Math.abs(s.open.bottom - s.open.top - s.own.length * s.lh) > NEAR) why.push(`${view}: the opening paragraph is ${(s.open.bottom - s.open.top).toFixed(1)} px deep for its ${s.own.length} lines`);
    if (f.kind === 'list') {
      if (s.markers.length < f.markers) why.push(`${view}: ${s.markers.length} markers of ${f.markers}`);
      for (const m of s.markers) if (m.left < s.open.left - 40 || m.right > s.column.right || m.left < s.column.left) why.push(`${view}: a marker outside the column (${m.what} at ${m.left.toFixed(0)})`);
      // (an item's place is its box's: where its words begin also depends on the indent Obsidian measures for each line of the editor)
      const top = s.rows.filter(r => !r.deep), home = top.length ? top[top.length - 1].edge : 0;
      for (const [i, r] of top.entries()) {
        if (r.top < s.ink.bottom - 0.5 && r.left < s.ink.right + 4) why.push(`${view}: item ${i + 1} is beside the initial and not set in past it (its words begin at ${r.left.toFixed(0)}, the initial ends at ${s.ink.right.toFixed(0)})`);
        if (r.top >= fourth - NEAR && Math.abs(r.edge - home) > 0.5) why.push(`${view}: item ${i + 1} is below the initial and not back at the margin (${r.edge.toFixed(1)} against ${home.toFixed(1)})`);
      }
      if (top.length && top[top.length - 1].top < fourth) why.push(`${view}: the list’s last item is still beside the initial (the case needs one below it)`);
    }
    return why;
  };
  /* The two views of one note against each other; base: the same follower after a paragraph of three lines
     ({live, reading} scenes), or null. */
  const agree = (a, b, f, base) => {
    const why = [];
    if (a.missing || b.missing || !a.ink || !b.ink) return why;
    const d = (x, y, what, tol) => { if (Math.abs(x - y) > (tol || 1)) why.push(`${what}: ${x.toFixed(1)} in the editor, ${y.toFixed(1)} in Reading view`); };
    d(a.open.bottom - a.open.top, b.open.bottom - b.open.top, 'the opening paragraph’s depth');
    d(a.open.left, b.open.left, 'the opening paragraph’s left');
    for (const k of ['left', 'right']) d(a.ink[k] - a.open.left, b.ink[k] - b.open.left, `the initial’s ${k}`);
    for (const k of ['top', 'bottom']) d(a.ink[k] - a.open.top, b.ink[k] - b.open.top, `the initial’s ${k}`);
    if (a.own.length !== b.own.length) why.push(`the opening paragraph has ${a.own.length} lines in the editor, ${b.own.length} in Reading view`);
    // (a list right under the paragraph's line has no blank line above it in the editor, and Reading view sets a line of
    // space there all the same: a known difference, so which of its items are beside the initial is not compared)
    if (f.kind === 'list' && !f.tight && base && base.live.rows.length === a.rows.length && base.reading.rows.length === b.rows.length) {
      if (a.rows.length !== b.rows.length) why.push(`${a.rows.length} items in the editor, ${b.rows.length} in Reading view`);
      else for (let i = 0; i < a.rows.length; i++) {
        const x = a.rows[i].edge - base.live.rows[i].edge, y = b.rows[i].edge - base.reading.rows[i].edge;
        if (Math.abs(x - y) > TOL) why.push(`item ${i + 1} is set in by ${x.toFixed(1)} px in the editor, ${y.toFixed(1)} in Reading view`);
      }
      if (a.rows.length && b.rows.length) d(a.rows[0].top - a.open.top, b.rows[0].top - b.open.top, 'where the list begins, below the paragraph’s top', TOL);
    } else if (f.kind === 'list' && !f.tight && base) why.push(`the list has ${a.rows.length} and ${b.rows.length} items here, ${base.live.rows.length} and ${base.reading.rows.length} after a long paragraph`);
    if (f.kind === 'clear' && base && a.first != null && b.first != null && base.live.first != null && base.reading.first != null) {
      const here = (a.first - a.open.bottom) - (b.first - b.open.bottom), there = (base.live.first - base.live.open.bottom) - (base.reading.first - base.reading.open.bottom);
      if (Math.abs(here - there) > TOL) why.push(`after the paragraph the views are ${here.toFixed(1)} px apart, and ${there.toFixed(1)} px after a paragraph of three lines`);
      for (const [v, s, t] of [['the editor', a, base.live], ['Reading view', b, base.reading]]) if (Math.abs((s.firstLeft - s.open.left) - (t.firstLeft - t.open.left)) > 1) why.push(`${v}: what follows begins ${(s.firstLeft - s.open.left).toFixed(1)} px from the margin, and ${(t.firstLeft - t.open.left).toFixed(1)} px after a paragraph of three lines`);
    }
    return why;
  };

  const results = [];
  const run = async (name, body) => {
    if (options.only && !name.includes(options.only)) return;
    const out = { name, ok: true, why: [] };
    try { await body(out); } catch (e) { out.why.push(`threw: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); }
    out.ok = !out.why.length;
    out.why = out.why.join('; ');
    results.push(out);
  };
  /* Paragraphs of one, two and three lines for the column as it is now: the words of LONG's first lines. */
  const paragraphs = async () => {
    await open(`## Drop caps\n\n${LONG}.\n`, 'live');
    const lines = scene('live', 'Under', 0).own.map(l => l.text.trim().split(/\s+/).length);
    const take = n => `${LONG.split(' ').slice(0, n).join(' ').replace(/[,;]$/, '')}:`;
    return { 1: SHORT, 2: take(lines[0] + Math.max(2, Math.ceil(lines[1] / 2))), 3: take(lines[0] + lines[1] + Math.max(2, Math.ceil(lines[2] / 2))) };
  };
  const both = async (text, more) => {
    await open(text, 'live');
    const live = scene('live', 'Under', more);
    await setMode('reading');
    const reading = scene('reading', 'Under', 0);
    return { live, reading };
  };

  try {
    // ---- 1. every follower, after a paragraph of one, two and three lines, at three widths, for each initial ----
    const WIDTHS = options.quick ? [1180] : [1180, 860, 620];
    const LOOKS = options.quick ? [['yinit', false]] : [['yinit', false], ['goudy', false], ['plain', false], ['yinit', true], ['goudy', true], ['plain', true]];
    for (const [initials, fancy] of LOOKS) {
      await plugin.updateSettings({ initials, fancyMode: fancy, liveDropcaps: true });
      await sleep(300);
      for (const width of initials === 'yinit' && !fancy ? WIDTHS : [WIDTHS[0]]) {
        await resize(width);
        const P = await paragraphs();
        for (const f of FOLLOWERS) {
          let base = null;
          for (const lines of initials === 'yinit' && !fancy ? [3, 1, 2] : [3, 1]) {
            await run(`${f.name} after a paragraph of ${lines} line${lines > 1 ? 's' : ''}: ${initials}${fancy ? ', Fancy mode' : ''}, ${width} px`, async out => {
              const s = await both(noteOf(P[lines], f), 0);
              out.why.push(...sound(s.live, 'the editor', f, lines), ...sound(s.reading, 'Reading view', f, lines), ...agree(s.live, s.reading, f, lines === 3 ? null : base));
              if (lines === 3) base = s;
              else if (!base) out.why.push('the paragraph of three lines was not measured');
              if (lines === 1 && f.kind === 'list' && !s.live.missing && !s.reading.missing) {
                for (const [v, sc] of [['the editor', s.live], ['Reading view', s.reading]]) if (!(sc.rows[0] && sc.ink && sc.rows[0].left > sc.ink.right)) out.why.push(`${v}: the first item is not beside the initial (the case is about one that is)`);
              }
            });
          }
        }
      }
    }
    await plugin.updateSettings({ initials: 'yinit', fancyMode: false, liveDropcaps: true });
    await resize(1180);
    await sleep(300);
    const P = await paragraphs();
    const byName = n => FOLLOWERS.find(f => f.name === n);
    const lineOf = start => { const doc = cmOf().state.doc; for (let n = 1; n <= doc.lines; n++) if (doc.line(n).text.startsWith(start)) return n - 1; return -1; };
    const snapshot = s => JSON.stringify([Math.round(s.open.bottom - s.open.top), s.ink && [s.ink.left, s.ink.right, s.ink.bottom - s.ink.top].map(Math.round), s.rows.map(r => [Math.round(r.edge), Math.round(r.top - s.open.top)])]);

    // ---- 2. the cursor in each of the lines concerned (the editor) ----
    for (const f of FOLLOWERS.filter(f => !f.end)) {
      await run(`the cursor in the paragraph, and in what follows it: ${f.name}`, async out => {
        const text = noteOf(P[1], f);
        await open(text, 'live');
        const away = scene('live', 'Under', 0);
        const ed = leaf.view.editor, first = lineOf('Under'), next = first + (f.tight ? 1 : 2), count = f.text.split('\n').length;
        for (const [what, line, ch] of [['at the head of the paragraph', first, 0], ['in the paragraph', first, 9], ['at the end of the paragraph', first, ed.getLine(first).length], ['in the blank line under it', first + 1, 0],
          ...Array.from({ length: Math.min(count, 4) }, (_, i) => [`in line ${i + 1} of what follows`, next + i, Math.min(3, ed.getLine(next + i).length)])]) {
          if (f.tight && what === 'in the blank line under it') continue;
          ed.setCursor(line, ch); ed.focus();
          await quiet(); await sleep(120);
          const s = scene('live', 'Under', 0);
          // with the cursor in it a callout, a table's cell, mathematics and an image show the note's own lines: nothing may touch the initial, and the paragraph stays as deep
          for (const t of touches(s)) out.why.push(`${what}: on the initial: ${t}`);
          for (const g of s.gaps) out.why.push(`${what}: a gap the editor has not measured: ${g}`);
          if (s.missing || !s.ink) { out.why.push(`${what}: the initial is gone`); continue; }
          if (Math.abs((s.open.bottom - s.open.top) - (away.open.bottom - away.open.top)) > NEAR) out.why.push(`${what}: the paragraph is ${(s.open.bottom - s.open.top).toFixed(1)} px deep, ${(away.open.bottom - away.open.top).toFixed(1)} with the cursor away`);
          if (f.kind === 'list' && snapshot(s) !== snapshot(away)) out.why.push(`${what}: the list moved: ${snapshot(s)} against ${snapshot(away)}`);
        }
      });
    }

    // ---- 3. typing ----
    await run('typing in the paragraph until it has three lines, a list after it: nothing touches the initial at any letter, and the items come back to the margin', async out => {
      const f = byName('a nested list');
      await open(noteOf(P[1], f), 'live');
      const ed = leaf.view.editor, first = lineOf('Under'), add = ` ${LONG.split(' ').slice(4, 44).join(' ')}`;
      let was = scene('live', 'Under', 0), seenLines = new Set(), under = 0;
      if (!(was.rows[0].left > was.ink.right)) out.why.push('before typing the first item is not beside the initial');
      const inner0 = was.rows[1].edge;
      for (let i = 0; i < add.length; i++) {
        ed.replaceRange(add[i], { line: first, ch: ed.getLine(first).length - 1 });
        await frame(); await frame();
        if (i % 6 && i !== add.length - 1) continue;
        await quiet();
        const s = scene('live', 'Under', 0);
        seenLines.add(s.own.length);
        for (const t of touches(s)) out.why.push(`after ${i + 1} letters: on the initial: ${t}`);
        for (const g of s.gaps) out.why.push(`after ${i + 1} letters: a gap: ${g}`);
        // the items set in under the first item go with it: beside the initial or back at the margin, never apart
        if (s.rows.length >= 2 && Math.abs((s.rows[1].edge - s.rows[0].edge) - (was.rows[1].edge - was.rows[0].edge)) > 1) out.why.push(`after ${i + 1} letters: the item under the first item is ${(s.rows[1].edge - s.rows[0].edge).toFixed(1)} px from it, ${(was.rows[1].edge - was.rows[0].edge).toFixed(1)} before`);
        under = rootOf('live').querySelectorAll('.scriptorium-under-initial').length;
      }
      const end = scene('live', 'Under', 0);
      if (end.own.length < 3) out.why.push(`the paragraph has ${end.own.length} lines after typing`);
      if (![1, 2, 3].every(n => seenLines.has(n))) out.why.push(`the paragraph was seen with ${Array.from(seenLines).join(', ')} lines, not with one, two and three`);
      if (end.rows[0].left > end.ink.right) out.why.push('under a paragraph of three lines the first item is still set in');
      if (Math.abs(end.rows[1].edge - (inner0 - (was.rows[0].edge - end.rows[0].edge))) > 1) out.why.push(`the item under the first item did not come back with it (${end.rows[1].edge.toFixed(1)})`);
      if (under) out.why.push(`${under} lines are still set in under an item that is at the margin`);
      // and back: the words are taken out again
      ed.setLine(first, P[1]);
      await quiet(); await sleep(200); await quiet();
      const back = scene('live', 'Under', 0);
      if (snapshot(back) !== snapshot(was)) out.why.push(`with the words taken out again the page is not as it was: ${snapshot(back)} against ${snapshot(was)}`);
    });
    await run('typing in the first item of a list beside the initial, and making a new item under it: the list stays clear of the initial', async out => {
      const f = byName('a list of short bullets');
      await open(noteOf(P[1], f), 'live');
      const ed = leaf.view.editor, item = lineOf('- one'), was = scene('live', 'Under', 0);
      for (const [i, c] of Array.from(' and some more words, enough of them to run onto a second line of the page beside the initial and below it').entries()) {
        ed.replaceRange(c, { line: item, ch: ed.getLine(item).length });
        await frame();
        if (i % 9) continue;
        await quiet();
        const s = scene('live', 'Under', 0);
        for (const t of touches(s)) out.why.push(`after ${i + 1} letters: on the initial: ${t}`);
        if (Math.abs(s.rows[0].edge - was.rows[0].edge) > 0.5) out.why.push(`after ${i + 1} letters the first item begins at ${s.rows[0].edge.toFixed(1)}, ${was.rows[0].edge.toFixed(1)} before`);
      }
      ed.replaceRange('\n    - set in under it\n    - and another', { line: item, ch: ed.getLine(item).length });
      await quiet(); await sleep(200); await quiet();
      const s = scene('live', 'Under', 0);
      for (const t of touches(s)) out.why.push(`with items set in under it: on the initial: ${t}`);
      for (const g of s.gaps) out.why.push(`with items set in under it: a gap: ${g}`);
      if (!(s.rows[1] && s.rows[1].deep && s.rows[1].left > s.rows[0].left + 10)) out.why.push(`the item set in under the first item begins at ${s.rows[1] && s.rows[1].left.toFixed(1)}, the first item at ${s.rows[0].left.toFixed(1)}`);
      await setMode('reading');
      const r = scene('reading', 'Under', 0);
      if (r.rows.length === s.rows.length) { for (const i of [0, 3]) if (Math.abs((s.rows[i].edge - s.rows[s.rows.length - 1].edge) - (r.rows[i].edge - r.rows[r.rows.length - 1].edge)) > TOL) out.why.push(`item ${i + 1} is ${(s.rows[i].edge - s.rows[s.rows.length - 1].edge).toFixed(1)} px right of the last item in the editor, ${(r.rows[i].edge - r.rows[r.rows.length - 1].edge).toFixed(1)} in Reading view`); if (!(r.rows[1].left > r.ink.right && s.rows[1].left > s.ink.right)) out.why.push('the items set in under the first item are not past the initial in both views'); }
      else out.why.push(`${s.rows.length} items in the editor, ${r.rows.length} in Reading view`);
    });
    await run('typing a list under a paragraph that ends the note: the paragraph gives its three lines up as the list begins, and takes them again when the list is gone', async out => {
      await open(`## Drop caps\n\n${P[1]}\n`, 'live');
      const ed = leaf.view.editor, first = lineOf('Under'), lh = scene('live', 'Under', 0).lh;
      const deep = () => { const s = scene('live', 'Under', 0); return (s.open.bottom - s.open.top) / lh; };
      if (Math.abs(deep() - 3) > 0.05) out.why.push(`at the end of the note the paragraph is ${deep().toFixed(2)} lines deep`);
      ed.replaceRange('\n- ', { line: first + 1, ch: 0 });
      await quiet();
      if (Math.abs(deep() - 1) > 0.05) out.why.push(`with a list begun under it the paragraph is ${deep().toFixed(2)} lines deep`);
      for (const c of 'an item') { ed.replaceRange(c, { line: first + 2, ch: ed.getLine(first + 2).length }); await frame(); }
      await quiet();
      const s = scene('live', 'Under', 0);
      for (const t of touches(s)) out.why.push(`on the initial: ${t}`);
      if (!(s.rows[0] && s.rows[0].left > s.ink.right)) out.why.push('the item typed is not set in past the initial');
      ed.setLine(first + 2, '> a quotation instead');
      await quiet();
      if (Math.abs(deep() - 3) > 0.05) out.why.push(`with the list turned into a quotation the paragraph is ${deep().toFixed(2)} lines deep`);
      for (const t of touches(scene('live', 'Under', 0))) out.why.push(`as a quotation: on the initial: ${t}`);
    });
    await run('a paragraph of two lines of the note before a quotation, and before a list: the space is under its last line', async out => {
      const para = 'Under the settings\nthere are three things:';
      for (const f of [byName('a quotation'), byName('a list of short bullets'), byName('a callout')]) {
        const s = await both(noteOf(para, f), 1);
        for (const [v, sc] of [['the editor', s.live], ['Reading view', s.reading]]) {
          for (const t of touches(sc)) out.why.push(`${f.name}, ${v}: on the initial: ${t}`);
          for (const g of sc.gaps) out.why.push(`${f.name}, ${v}: a gap: ${g}`);
        }
        // Reading view sets the two lines of the note as one line of the page; the editor keeps them two
        if (f.kind === 'clear') for (const [v, sc] of [['the editor', s.live], ['Reading view', s.reading]]) if (Math.abs(sc.open.bottom - sc.open.top - 3 * sc.lh) > NEAR) out.why.push(`${f.name}, ${v}: the paragraph is ${(sc.open.bottom - sc.open.top).toFixed(1)} px deep`);
      }
      await open(noteOf(para, byName('a quotation')), 'live');
      const marked = Array.from(rootOf('live').querySelectorAll('.scriptorium-opening-end')).map(words).filter(w => !w.startsWith('After it all'));   // (the last paragraph of the note is one too)
      if (marked.length !== 1 || !marked[0].startsWith('there are')) out.why.push(`the lines marked as the paragraph’s end: ${JSON.stringify(marked)}`);
    });

    await run('an initial that is a word by itself (“A body at rest”) before what begins below it: the mark of the paragraph’s end and the mark of the space are on one line, and the editor draws it', async out => {
      for (const f of [byName('a quotation'), byName('the end of the note'), byName('a list of short bullets'), byName('a smaller heading')]) {
        await open(noteOf('A body at rest:', f), 'live');
        const live = scene('live', 'A body', 0);
        if (live.missing || !live.ink) { out.why.push(`${f.name}: the editor has no initial`); continue; }
        out.why.push(...sound(live, `${f.name}, the editor`, Object.assign({}, f, { markers: 0 }), 1));
        if (!rootOf('live').querySelector('.scriptorium-opening .scriptorium-opening-gap')) out.why.push(`${f.name}: the space after the initial is not marked`);
        await setMode('reading');
        out.why.push(...sound(scene('reading', 'A body', 0), `${f.name}, Reading view`, Object.assign({}, f, { markers: 0 }), 1));
      }
    });

    // ---- 4. folding ----
    await run('folding the first item of a list beside the initial, and the heading: nothing touches the initial, and unfolded the page is as it was', async out => {
      const f = byName('a nested list');
      await open(noteOf(P[1], f), 'live');
      const ed = leaf.view.editor, was = scene('live', 'Under', 0), item = lineOf('- Outer one');
      const folding = { foldIndent: app.vault.getConfig('foldIndent'), foldHeading: app.vault.getConfig('foldHeading') };
      app.vault.setConfig('foldIndent', true); app.vault.setConfig('foldHeading', true);
      await sleep(300); await quiet();
      ed.setCursor(item, 3); ed.focus();
      ed.exec('toggleFold');
      await quiet(); await sleep(250); await quiet();
      const folded = scene('live', 'Under', 0);
      if (folded.rows.length >= was.rows.length) out.why.push(`the item did not fold (${folded.rows.length} items drawn, ${was.rows.length} before)`);
      for (const t of touches(folded)) out.why.push(`folded: on the initial: ${t}`);
      for (const g of folded.gaps) out.why.push(`folded: a gap: ${g}`);
      if (!(folded.rows[0].left > folded.ink.right)) out.why.push('folded: the first item is not set in past the initial');
      ed.exec('toggleFold');
      await quiet(); await sleep(250); await quiet();
      const again = scene('live', 'Under', 0);
      if (snapshot(again) !== snapshot(was)) out.why.push(`unfolded the page is not as it was: ${snapshot(again)} against ${snapshot(was)}`);
      ed.setCursor(lineOf('## Drop caps'), 3);
      ed.exec('toggleFold');
      await quiet(); await sleep(250);
      ed.exec('toggleFold');
      await quiet(); await sleep(250); await quiet();
      ed.setCursor(ed.lastLine(), 0);
      await quiet();
      const last = scene('live', 'Under', 0);
      if (snapshot(last) !== snapshot(was)) out.why.push(`with the heading folded and unfolded the page is not as it was: ${snapshot(last)} against ${snapshot(was)}`);
      app.vault.setConfig('foldIndent', folding.foldIndent); app.vault.setConfig('foldHeading', folding.foldHeading);
    });

    // ---- 5. a long note, scrolled away and back (both views draw only what is near) ----
    await run('a long note scrolled away and back: the list and the quotation after short paragraphs are as they were, in both views', async out => {
      const filler = n => Array.from({ length: n }, (_, i) => `Filler ${i + 1}: the quick brown fox jumps over the lazy dog, and the dog, who has seen it all before, does not get up.`).join('\n\n');
      const text = `## Before\n\n${filler(14)}\n\n## A list\n\n${P[1].replace('Under', 'Vnder')}\n\n${byName('a nested list').text}\n\n${filler(14)}\n\n## A quotation\n\n${P[1].replace('Under', 'Wnder')}\n\n${byName('a quotation').text}\n\n${filler(14)}\n`;
      for (const mode of ['live', 'reading']) {
        await open(text, mode);
        const view = mode === 'live' ? 'the editor' : 'Reading view', first = {};
        for (const pass of [1, 2]) for (const [start, f] of [['Vnder', byName('a nested list')], ['Wnder', byName('a quotation')]]) {
          if (!await bring(mode, start)) { const sc = scrollerOf(mode); out.why.push(`${view}: “${start}” was not drawn (pass ${pass}; scrolled to ${Math.round(sc.scrollTop)} of ${sc.scrollHeight}; ${rootOf(mode).querySelectorAll(':scope > div.el-p').length} paragraphs drawn, the first “${words(rootOf(mode).querySelector(':scope > div.el-p') || document.body).slice(0, 30)}”)`); continue; }
          await sleep(200); await quiet();
          const s = scene(mode, start, 0);
          out.why.push(...sound(s, `${view}, ${start}, pass ${pass}`, Object.assign({}, f, { markers: 0 }), 1));
          if (pass === 1) first[start] = snapshot(s); else if (first[start] !== snapshot(s)) out.why.push(`${view}, ${start}: after scrolling away and back: ${snapshot(s)} against ${first[start]}`);
          scrollerOf(mode).scrollTop = pass === 1 ? scrollerOf(mode).scrollHeight : 0;
          await sleep(250);
        }
      }
    });

    // ---- 6. the window resized, and zoomed, with the note open ----
    for (const f of [byName('a list of bullets'), byName('a nested list'), byName('a quotation'), byName('a table')]) {
      await run(`the window made narrower and wider again with the note open, then zoomed: ${f.name}`, async out => {
        for (const mode of ['live', 'reading']) {
          const view = mode === 'live' ? 'the editor' : 'Reading view';
          await resize(1180);
          await open(noteOf(P[1], f), mode);
          const was = scene(mode, 'Under', 0);
          for (const width of [700, 560, 980, 1180]) {
            await resize(width); await quiet(); await sleep(150); await quiet();
            out.why.push(...sound(scene(mode, 'Under', 0), `${view} at ${width} px`, Object.assign({}, f, { markers: 0 }), 0));
          }
          const back = scene(mode, 'Under', 0);
          if (snapshot(back) !== snapshot(was)) out.why.push(`${view}: back at 1180 px the page is not as it was: ${snapshot(back)} against ${snapshot(was)}`);
          if (webFrame) for (const zoom of [1.35, 0.8, 1]) {
            webFrame.setZoomFactor(zoom); await sleep(500); await quiet();
            out.why.push(...sound(scene(mode, 'Under', 0), `${view} at ${Math.round(zoom * 100)} %`, Object.assign({}, f, { markers: 0 }), 0));
          }
        }
      });
    }

    // ---- 7. the drop cap changed, turned off and on, with the note open ----
    await run('the drop cap changed with the note open (Goudy, plain, Yinit), none, and “Show drop caps while editing” off and on', async out => {
      const f = byName('a nested list'), q = byName('a quotation');
      for (const [g, text] of [[f, noteOf(P[1], f)], [q, noteOf(P[1], q)]]) {
        await open(text, 'live');
        for (const initials of ['goudy', 'plain', 'yinit']) {
          await plugin.updateSettings({ initials });
          await sleep(350); await quiet();
          const s = scene('live', 'Under', 0);
          out.why.push(...sound(s, `the editor, changed to ${initials}`, Object.assign({}, g, { markers: 0 }), 1));
          if (s.ink && g.kind === 'list' && s.rows.length >= 2 && !(s.rows[1].left > s.rows[0].left)) out.why.push(`changed to ${initials}: the item under the first item is not set in with it`);
        }
        const marks = () => rootOf('live').querySelectorAll('.scriptorium-opening, .scriptorium-opening-end, .scriptorium-beside-initial, .scriptorium-under-initial').length;
        const plain = () => { const el = opening('live', 'Under'), next = Array.from(rootOf('live').querySelectorAll(g.kind === 'list' ? '.HyperMD-list-line' : '.HyperMD-quote')); return { deep: el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight), lefts: next.map(n => Math.round(n.getBoundingClientRect().left - el.getBoundingClientRect().left)).join(',') }; };
        if (!marks()) out.why.push('on: no line is marked');
        await plugin.updateSettings({ initials: 'none' });
        await sleep(350); await quiet();
        if (marks()) out.why.push(`with no drop cap ${marks()} lines are still marked`);
        const none = plain();
        if (Math.abs(none.deep - 1) > 0.05 || /[1-9]/.test(none.lefts)) out.why.push(`with no drop cap the paragraph is ${none.deep.toFixed(2)} lines deep and what follows is set in by ${none.lefts}`);
        await plugin.updateSettings({ initials: 'yinit', liveDropcaps: false });
        await sleep(350); await quiet();
        if (marks()) out.why.push(`with drop caps off in the editor ${marks()} lines are still marked`);
        const off = plain();
        if (Math.abs(off.deep - 1) > 0.05 || /[1-9]/.test(off.lefts)) out.why.push(`with drop caps off in the editor the paragraph is ${off.deep.toFixed(2)} lines deep and what follows is set in by ${off.lefts}`);
        await plugin.updateSettings({ liveDropcaps: true });
        await sleep(350); await quiet();
        out.why.push(...sound(scene('live', 'Under', 0), 'the editor, on again', Object.assign({}, g, { markers: 0 }), 1));
        // Reading view with no drop cap: the paragraph has its one line, and the list its markers
        await plugin.updateSettings({ initials: 'none' });
        await setMode('reading');
        const p = opening('reading', 'Under');
        if (Math.abs(p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight) - 1) > 0.05) out.why.push(`Reading view with no drop cap: the paragraph is ${(p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight)).toFixed(2)} lines deep`);
        await plugin.updateSettings({ initials: 'yinit' });
        await sleep(300);
      }
    });
    await run('Source mode is plain: no mark changes a line there', async out => {
      await open(noteOf(P[1], byName('a nested list')), 'source');
      const root = rootOf('source'), el = Array.from(root.querySelectorAll('.cm-line')).find(l => l.textContent.startsWith('Under'));
      const lists = Array.from(root.querySelectorAll('.HyperMD-list-line'));
      if (Math.abs(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight) - 1) > 0.05) out.why.push('the paragraph is not one line deep');
      for (const l of lists) { const cs = getComputedStyle(l); if (cs.display !== 'block' || parseFloat(cs.marginLeft)) out.why.push(`a list line is ${cs.display} with a margin of ${cs.marginLeft}`); }
      if (getComputedStyle(el, '::after').content !== 'none') out.why.push('the paragraph’s line has the block that clears the float');
    });

    // ---- 8. an initial that is an image ----
    await run('an initial that is an image (a set of drop caps): a list and a quotation after a paragraph of one line', async out => {
      const name = 'Followers check set', dir = `${S.DROPCAP_FOLDER}/${name}`;
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400" width="300" height="400"><rect x="6" y="6" width="288" height="388" fill="#2a5d8f"/></svg>');
      try {
        await plugin.saveDropcapSet(name, [S.checkDropcapFile('U.svg', svg)], false);
        await sleep(500);
        for (const f of [byName('a list of bullets'), byName('a nested list'), byName('a quotation'), byName('a callout')]) {
          const s = await both(`---\ndropcap: ${name}\n---\n${noteOf(P[1], f)}`, 0);
          for (const [v, sc] of [['the editor', s.live], ['Reading view', s.reading]]) {
            if (!sc.ink || sc.ink.kind !== 'image') { out.why.push(`${f.name}, ${v}: the initial is not the image`); continue; }
            for (const t of touches(sc)) out.why.push(`${f.name}, ${v}: on the initial: ${t}`);
            for (const g of sc.gaps) out.why.push(`${f.name}, ${v}: a gap: ${g}`);
            if (f.kind === 'clear' && sc.first < sc.ink.bottom - NEAR) out.why.push(`${f.name}, ${v}: what follows begins ${(sc.ink.bottom - sc.first).toFixed(1)} px above the image’s foot`);
            if (f.kind === 'list' && !(sc.rows[0].left > sc.ink.right)) out.why.push(`${f.name}, ${v}: the first item is not set in past the image`);
          }
          if (s.live.ink && s.reading.ink && Math.abs((s.live.open.bottom - s.live.open.top) - (s.reading.open.bottom - s.reading.open.top)) > 1) out.why.push(`${f.name}: the paragraph is ${(s.live.open.bottom - s.live.open.top).toFixed(1)} px deep in the editor, ${(s.reading.open.bottom - s.reading.open.top).toFixed(1)} in Reading view`);
        }
      } finally {
        if (await app.vault.adapter.exists(dir)) await app.vault.adapter.rmdir(dir, true);
        await plugin.loadDropcapSets();
      }
    });

    // ---- 9. two short paragraphs, then a callout (Reading view sets no gap between paragraphs) ----
    await run('two paragraphs of one line, then a callout, a list, a quotation: what follows the second begins below the initial', async out => {
      for (const f of [byName('a callout'), byName('a list of short bullets'), byName('a quotation'), byName('a table')]) {
        const s = await both(`## Drop caps\n\n${P[1]}\n\nAnd a second line of text.\n\n${f.text}\n\n## Next\n\nAfter it all.\n`, 0);
        for (const [v, sc] of [['the editor', s.live], ['Reading view', s.reading]]) {
          for (const t of touches(sc)) out.why.push(`${f.name}, ${v}: on the initial: ${t}`);
          for (const g of sc.gaps) out.why.push(`${f.name}, ${v}: a gap: ${g}`);
          const after = sc.items.filter(i => !/And a second/.test(i.what) && i.top > sc.open.top + sc.lh * 1.5), left = after.length ? Math.min(...after.filter(i => i.kind !== 'marker').map(i => i.left)) : 0;
          if (after.length && left > sc.ink.right) out.why.push(`${f.name}, ${v}: what follows the second paragraph is set in beside the initial (from ${left.toFixed(0)})`);
        }
      }
    });

    // ---- 10. the two screenshots: the vault's README, "Drop caps, marginalia and image focus", in both views ----
    const readme = app.vault.getAbstractFileByPath('README.md');
    const shipped = readme ? await app.vault.read(readme) : '';
    const section = shipped.includes('## Drop caps, marginalia and image focus') ? shipped : '';
    for (const [name, mode, zoom] of [['the screenshot of the editor: the README’s list under “Under Settings → Scriptorium:” is not drawn through the initial', 'live', 1],
      ['the screenshot of Reading view: the first bullet of the README’s list is not on the initial', 'reading', 1],
      ['the screenshots at the size they were taken (135 %): the editor', 'live', 1.35], ['the screenshots at the size they were taken (135 %): Reading view', 'reading', 1.35]]) {
      await run(name, async out => {
        if (!section) { out.why.push('the vault has no README.md with the section “Drop caps, marginalia and image focus” (the note the screenshots show)'); return; }
        await resize(zoom === 1 ? 1180 : 1600);
        if (webFrame) { webFrame.setZoomFactor(zoom); await sleep(450); }
        try {
          await open(section, mode);
          if (!await bring(mode, 'Under Settings')) { out.why.push('the paragraph “Under Settings → Scriptorium:” was not drawn'); return; }
          await sleep(250); await quiet();
          const s = scene(mode, 'Under Settings', 0), view = mode === 'live' ? 'the editor' : 'Reading view';
          out.why.push(...sound(s, view, { kind: 'list', markers: 3 }, 1));
          if (s.ink && s.rows.length) {
            if (!(s.rows[0].left > s.ink.right)) out.why.push('the first item (“Drop cap:”) is not set in past the initial');
            const bullet = s.markers[0];
            if (!bullet || bullet.left < s.ink.right) out.why.push(`the first bullet is at ${bullet ? bullet.left.toFixed(0) : 'nowhere'}, the initial ends at ${s.ink.right.toFixed(0)}`);
            // the item's second line hangs under its first (the editor set it far to the right)
            const item = s.items.filter(i => i.kind === 'text' && i.top < s.rows[1].top - 2);
            if (item.length < 2) out.why.push(`the first item has ${item.length} line${item.length === 1 ? '' : 's'} (the screenshots show it on two)`);
            else if (Math.abs(item[1].left - s.rows[0].left) > 3) out.why.push(`the first item’s second line begins at ${item[1].left.toFixed(1)}, its first at ${s.rows[0].left.toFixed(1)}`);
            if (Math.abs(s.rows[1].left - s.rows[2].left) > 0.5 || !(s.rows[1].left < s.ink.right)) out.why.push('the second and third items are not back at the margin');
          }
        } finally { if (webFrame) { webFrame.setZoomFactor(1); await sleep(300); } await resize(1180); }
      });
    }
  } finally {
    await plugin.updateSettings({ initials: saved.initials, fancyMode: saved.fancy, liveDropcaps: saved.live });
    try { if (webFrame) webFrame.setZoomFactor(layout.zoom || 1); if (win && layout.bounds) win.setBounds(layout.bounds); } catch (e) { /* as it is */ }
    if (!layout.left) ws.leftSplit.expand();
    if (!layout.right) ws.rightSplit.expand();
    if (!options.keep) {
      try { await leaf.setViewState(Object.assign({}, leaf.getViewState(), { state: Object.assign({}, leaf.getViewState().state, { mode: 'source', source: false }) })); } catch (e) { /* as it is */ }
      for (const p of [path, PICTURE]) { const f = app.vault.getAbstractFileByPath(p); if (f) try { await app.vault.delete(f); } catch (e) { /* left */ } }
    }
  }
  const failed = results.filter(r => !r.ok).length;
  console.table(results.map(r => ({ case: r.name, ok: r.ok, why: r.why.slice(0, 200) })));
  return JSON.stringify({ ok: failed === 0, failed, cases: results });
})()
