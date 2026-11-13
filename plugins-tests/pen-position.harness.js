// Where the pen writes, checked in a real Obsidian: for each kind of edit, Lagrange's pen must begin its handwriting
// where the first letter of the new text stands in the note (left edge and baseline, within 2 px, on every frame but
// for a reflow of at most three frames, which is counted), start
// each further line at the left edge of the note's own line, and draw each equation that Live Preview typesets on that
// very equation. Where the note centres text or sets it to the right (Scriptorium's "::: center" and "::: right": the
// Scriptorium plugin and its snippet must be on), each line of handwriting must start where the note starts that line,
// within 2 px, and the marker lines are never written. Since 1.2.4 it also checks, in every case, that the handwriting of a line is never seen before the pen
// comes to it, that no letter is cut by the box that uncovers it (ascenders, descenders and swashes included), that
// the note does not scroll when the run ends and the last text written is in view; and, in cases of their own, that
// the handwriting stays on its text while the note is scrolled, that a click or a key in the note ends the run with
// the note exactly as an uninterrupted run would leave it (plus the key), that with "Let me edit while the pen writes"
// the writer's typing and Lagrange's edits both stand, that the chat's log keeps to its bottom while the loader
// shows, and that hovering Lagrange's controls shows no bubble. And, for several pens at once: that two and three pens
// do write at the same time where the edits stand apart (and one pen where they do not: in one paragraph, or a line or
// two from each other), that every pen's handwriting begins on its own text within 2 px on every frame, that no two
// pens' handwriting ever meets, that the note is in the end exactly what one pen leaves (the same edits are run again
// with "Several pens at once" off) in less time, that the view does not move when the run ends, and that a key, a
// click, typing alongside and Undo do with three pens what they do with one.
// This cannot run under Node (it needs Obsidian's editor and its layout), so it is not part of
// `node --test`; it is a manual check, or one a machine can run through the DevTools protocol.
//
// To run it: open a Scriptorium vault in Obsidian (Lagrange enabled, "Show the pen" on, reduced motion off), open the
// developer tools (Ctrl+Shift+I) and paste this file into the console; or evaluate it with Runtime.evaluate
// (awaitPromise: true). It makes a note "Pen position check.md" in the vault, runs each case in it through the same
// road as a chat edit (locateOps, then the pen), and answers with {ok, failed, cases: [{name, ok, ...}]}; it prints a
// table too. Pass options by setting window.penPositionOptions = {only: 'text in a case name', speed: 3,
// keepNote: true, settle: ms} first. The note is deleted afterwards unless keepNote is set.
//
// Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).
(async () => {
  const options = window.penPositionOptions || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const frame = () => new Promise(r => requestAnimationFrame(r));
  const plugin = app.plugins.plugins.lagrange;
  if (!plugin) throw new Error('Lagrange is not enabled in this vault');
  const L = plugin.constructor.internals;
  const TOL = 2;

  const filler = n => Array.from({ length: n }, (_, i) => `Filler paragraph ${i + 1}. The quick brown fox jumps over the lazy dog, and the dog, who has seen it all before, does not get up.`).join('\n\n');
  const LONG = 'A body at rest stays at rest, and a body in motion keeps its motion, unless something acts on it; this much was known to Galileo, who rolled balls down smooth planes and saw that the smoother the plane, the farther they went, and guessed the rest. The kinetic energy of a moving body grows with the square of its speed. Momentum is conserved.';
  const NOTE = [
    '# Pen position check', LONG, 'Short line here.',
    '- first item of a list\n- second item of a list, long enough to say something\n- third item',
    '> A quotation, set off from the text, which says a thing worth quoting.',
    '> [!note] A callout\n> The text of the callout goes here.',
    '| Quantity | Symbol |\n| --- | --- |\n| mass | m |\n| speed | v |',
    'The paragraph before the filler.', filler(40), 'The far paragraph, well below the fold, mentions energy once.', filler(3), 'The last paragraph of the note.',
  ].join('\n\n') + '\n';
  // (verse and an attribution between Scriptorium's marker lines: centred and right-aligned text)
  const VERSE = [
    '# Pen position check', 'A paragraph of prose stands before the verse, long enough to wrap onto a second line of the page, so that the column is plain to see.',
    '::: center\nTyger Tyger, burning bright,\nIn the forests of the night;\n:::', '::: right\n— William Blake\n:::', 'The paragraph after the verse.',
  ].join('\n\n') + '\n';
  const PARA = 'Energy is never lost, only moved about: what a falling stone loses in height it gains in speed, and what it gains in speed it gives up, when it lands, as heat and sound and a dent in the ground. The books balance to the last farthing, which is why the idea has outlived every theory that was built upon it, and why a perpetual motion machine is a fraud before it is switched on. Nobody has yet caught the universe cheating.';

  // name, mode ('live' | 'source' | 'reading'), note text (default NOTE), the operations, and what to expect
  const cases = [
    { name: 'replace mid-paragraph', ops: [{ find: 'The kinetic energy of a moving body grows with the square of its speed.', replace: 'The energy of motion grows as the square of the speed, so twice as fast is four times as hard to stop.' }] },
    { name: 'replace at a line wrap (first words of the paragraph)', ops: [{ find: 'A body at rest stays at rest, and a body in motion keeps its motion', replace: 'What is still stays still, and what moves keeps moving' }] },
    { name: 'replace one word', ops: [{ find: 'Short line here.', replace: 'Short sentence here.' }] },
    { name: 'insert after a sentence', ops: [{ insert_after: 'Short line here.', text: ' And a second sentence comes after it.' }] },
    { name: 'insert a new paragraph', ops: [{ insert_after: 'Short line here.', text: '\n\nA new paragraph is put in after the short line, and it runs on for a while so that it wraps.' }] },
    { name: 'append at the end of the note', ops: [{ append: 'An appended closing remark, written at the very end of the note.' }] },
    { name: 'append a paragraph-length text (three lines written)', ops: [{ append: PARA }], lines: 3 },
    { name: 'replace with a paragraph-length text', ops: [{ find: 'Short line here.', replace: PARA }], lines: 3 },
    { name: 'edit in an off-screen paragraph', ops: [{ find: 'mentions energy once', replace: 'speaks of energy only the one time' }] },
    { name: 'an empty note', note: '', ops: [{ append: 'The first words of an empty note.' }] },
    { name: 'a heading and a paragraph appended', ops: [{ append: '## A new section\n\nIts first paragraph follows the heading.' }] },
    { name: 'a list item', ops: [{ find: 'second item of a list, long enough to say something', replace: 'second item, rewritten by the pen' }] },
    { name: 'a new list item', ops: [{ insert_after: '- third item', text: '\n- fourth item, added at the end of the list' }] },
    { name: 'a blockquote', ops: [{ find: 'which says a thing worth quoting', replace: 'which says something the writer wished he had said' }] },
    { name: 'two edits in one paragraph (the first changes the length before the second)', ops: [
      { find: 'this much was known to Galileo', replace: 'Galileo knew as much' }, { find: 'Momentum is conserved.', replace: 'Momentum, too, is conserved.' }] },
    { name: 'inline equation at the end of a sentence', ops: [{ find: 'Momentum is conserved.', replace: 'Momentum is conserved: $p = mv$.' }], math: 1 },
    { name: 'inline equation mid-sentence', ops: [{ find: 'The kinetic energy of a moving body grows with the square of its speed.', replace: 'The kinetic energy of a body of mass $m$ and speed $v$ is $E_k = \\tfrac{1}{2}mv^2$, so it grows with the square of its speed.' }], math: 3 },
    { name: 'inline equation at a line wrap', ops: [{ find: 'and guessed the rest.', replace: 'and guessed the rest, which we now write $\\sum_i \\mathbf{F}_i = \\frac{d\\mathbf{p}}{dt} = m\\,\\frac{d^2\\mathbf{x}}{dt^2}$ and call the second law.' }], math: 1 },
    { name: 'equation first in a paragraph', ops: [{ insert_after: 'Short line here.', text: '\n\n$E = mc^2$ is the best known of them.' }], math: 1 },
    { name: 'only an inline equation', ops: [{ insert_after: 'Short line here.', text: ' $p = mv$' }], math: 1 },
    { name: 'display equation appended', ops: [{ append: '$$E_k = \\frac{1}{2}mv^2$$' }], math: 1 },
    { name: 'display equation after a sentence', ops: [{ insert_after: 'Short line here.', text: '\n\n$$\n\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}\n$$' }], math: 1 },
    { name: 'prose, then a display equation', ops: [{ find: 'Momentum is conserved.', replace: 'Momentum is conserved, and force is its rate of change:\n\n$$F = \\frac{dp}{dt}$$' }], math: 1 },
    { name: 'equation in a list item', ops: [{ find: 'third item', replace: 'third item, $a^2 + b^2 = c^2$' }], math: 1 },
    { name: 'equation in a blockquote', ops: [{ find: 'worth quoting.', replace: 'worth quoting: $e^{i\\pi} + 1 = 0$.' }], math: 1 },
    // (loose: Live Preview draws a callout and a table as one block each, which the pen does not write inside; these two
    // only have to leave the note right)
    { name: 'equation in a callout', ops: [{ find: 'The text of the callout goes here.', replace: 'The text of the callout has $x^2$ in it.' }], math: 0, loose: true },
    { name: 'equation in a table cell', ops: [{ find: '| speed | v |', replace: '| speed | $v = \\frac{dx}{dt}$ |' }], math: 0, loose: true },
    { name: 'Source mode: replace', mode: 'source', ops: [{ find: 'Short line here.', replace: 'Short sentence here, in Source mode.' }] },
    { name: 'Source mode: equation (drawn in the script)', mode: 'source', ops: [{ find: 'Momentum is conserved.', replace: 'Momentum is conserved: $p = mv$.' }], math: 0 },
    { name: 'Reading view: append', mode: 'reading', ops: [{ append: 'Appended from Reading view, which Lagrange leaves for the editor.' }] },
    // (scroll: the note is scrolled down and back up, a few pixels a frame, while the handwriting is on the page)
    { name: 'the note is scrolled while the pen writes three lines', ops: [{ find: 'Short line here.', replace: PARA }], lines: 3, scroll: true },
    { name: 'the note is scrolled while the pen strikes and rewrites a wrapped sentence', scroll: true, ops: [{ find: 'A body at rest stays at rest, and a body in motion keeps its motion', replace: 'What is still stays still, and what moves keeps moving' }] },
    { name: 'Source mode: the note is scrolled while the pen writes', mode: 'source', scroll: true, ops: [{ find: 'Short line here.', replace: PARA }], lines: 3 },
    // (several: false: one pen writes them in turn, which is what this case watches; the last two may be in view
    // together, and are then written by two pens at once: see "several pens: one pen, then two" below)
    { name: 'three edits far apart: the view at the end is the view that was watched', several: false, ops: [
      { find: 'Short line here.', replace: 'Short sentence here.' }, { find: 'mentions energy once', replace: 'speaks of energy only the one time' }, { append: 'An appended closing remark.' }] },
    // (edits that build on one another are joined into one, and written as one)
    { name: 'an edit that builds on the one before it (the second is anchored on words the first writes)', ops: [
      { find: 'Short line here.', replace: 'Short sentence here.' }, { insert_after: 'Short sentence here.', text: ' And a second sentence comes after it.' }] },
    // (noMarks: the handwriting has none of the Markdown marks that Live Preview hides)
    { name: 'emphasis, a link and a code span: the hand writes the words, not their marks', noMarks: true, ops: [
      { find: 'Short line here.', replace: 'A *short* line with **bold** words, a [link](https://example.org) and `code` here.' }] },
    { name: 'Source mode: emphasis is on the page, and is written with its marks', mode: 'source', marks: true, ops: [
      { find: 'Short line here.', replace: 'A *short* line here.' }] },
    // (panel: the width of the right sidebar for the case; 610 leaves a text column of about 450 px)
    { name: 'a narrow column, Source mode: equation (drawn in the script)', panel: 610, mode: 'source', ops: [{ find: 'Momentum is conserved.', replace: 'Momentum is conserved: $p = mv$.' }], math: 0 },
    { name: 'a narrow column: inline equation at the end of a sentence', panel: 610, ops: [{ find: 'Momentum is conserved.', replace: 'Momentum is conserved: $p = mv$.' }], math: 1 },
    { name: 'a narrow column: replace mid-paragraph', panel: 610, ops: [{ find: 'The kinetic energy of a moving body grows with the square of its speed.', replace: 'The energy of motion grows as the square of the speed, so twice as fast is four times as hard to stop.' }] },
    { name: 'Reading view: equation', mode: 'reading', ops: [{ find: 'Momentum is conserved.', replace: 'Momentum is conserved: $p = mv$.' }], math: 1 },
    // (aligned: each line of handwriting starts where the note starts that line; the first of them is set as said)
    { name: 'centred verse appended (three lines, each where the note sets it)', note: VERSE, aligned: 'center', lines: 3,
      ops: [{ append: '::: center\nWhat immortal hand or eye,\nCould frame thy fearful symmetry?\nIn what distant deeps or skies.\n:::' }] },
    { name: 'two centred stanzas appended (a blank line between them)', note: VERSE, aligned: 'center', lines: 3,
      ops: [{ append: '::: center\nWhat immortal hand or eye,\nCould frame thy fearful symmetry?\n\nIn what distant deeps or skies.\n:::' }] },
    { name: 'a long centred line that wraps', note: VERSE, aligned: 'center', lines: 2,
      ops: [{ append: '::: center\nWhen the stars threw down their spears and watered heaven with their tears, did he smile his work to see, did he who made the Lamb make thee?\n:::' }] },
    { name: 'a line set to the right appended (an attribution)', note: VERSE, aligned: 'right', ops: [{ append: '::: right\n— from *Songs of Experience*, 1794\n:::' }] },
    { name: 'a line added to a centred block', note: VERSE, aligned: 'center', ops: [{ insert_after: 'In the forests of the night;', text: '\nWhat immortal hand or eye,' }] },
    { name: 'a line rewritten in a right-aligned block', note: VERSE, aligned: 'right', ops: [{ find: '— William Blake', replace: '— William Blake, in the year 1794' }] },
    { name: 'prose, then centred verse, in one edit', note: VERSE, aligned: 'left', lines: 3,
      ops: [{ append: 'A sentence of prose comes first.\n\n::: center\nWhat immortal hand or eye,\nCould frame thy fearful symmetry?\n:::' }] },
    { name: 'Source mode: centred verse appended (not aligned there; the markers are not written)', mode: 'source', note: VERSE,
      ops: [{ append: '::: center\nWhat immortal hand or eye,\nCould frame thy fearful symmetry?\n:::' }] },
  ];

  const path = 'Pen position check.md';
  let file = app.vault.getAbstractFileByPath(path);
  if (!file) file = await app.vault.create(path, NOTE);
  const leaf = app.workspace.getLeavesOfType('markdown')[0] || app.workspace.getLeaf(true);
  // The harness sets its own layout, and puts back what it found: the left sidebar shut, the right one (Lagrange's)
  // open at PANEL px, in a window of 1180 by 760 where the window can be sized (the desktop app).
  const PANEL = 390, ws = app.workspace;
  const layout = { left: ws.leftSplit.collapsed, right: ws.rightSplit.collapsed, width: ws.rightSplit.collapsed ? null : ws.rightSplit.containerEl.getBoundingClientRect().width, bounds: null, zoom: null };
  const setPanel = async width => { if (ws.rightSplit.collapsed) ws.rightSplit.expand(); ws.rightSplit.setSize(width); await sleep(150); };
  try {
    const remote = require('@electron/remote'), win = remote.getCurrentWindow();
    layout.bounds = win.getBounds();
    layout.zoom = require('electron').webFrame.getZoomFactor();
    if (!win.isMaximized() || options.resize !== false) { win.unmaximize(); win.setBounds({ x: layout.bounds.x, y: layout.bounds.y, width: 1180, height: 760 }); }
    require('electron').webFrame.setZoomFactor(1);
  } catch (e) { /* not the desktop app: the window is as it is */ }
  await plugin.activateView(false);
  ws.leftSplit.collapse();
  await setPanel(PANEL);
  const saved = { speed: plugin.settings.penSpeed, pen: plugin.settings.showPen, concurrent: plugin.settings.editWhileWriting, provider: plugin.settings.provider, trail: plugin.settings.penTrail, several: plugin.settings.severalPens, max: plugin.settings.maxPens };
  plugin.settings.severalPens = true;
  plugin.settings.maxPens = 3;
  plugin.settings.showPen = true;
  if (options.speed) plugin.settings.penSpeed = options.speed;

  const canvas = document.createElement('canvas').getContext('2d');
  // Where the character at pos stands in the note: its left edge and its baseline.
  const glyphAt = (cm, pos) => {
    const c = cm.coordsAtPos(pos, 1) || cm.coordsAtPos(pos, -1);
    if (!c) return null;
    const at = cm.domAtPos(pos), el = at.node.nodeType === 1 ? at.node : at.node.parentElement, cs = getComputedStyle(el);
    canvas.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const m = canvas.measureText('x'), ratio = m.fontBoundingBoxAscent / (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent);
    return { x: c.left, baseline: c.top + (c.bottom - c.top) * ratio };
  };
  // Where the handwriting begins: the left edge of its first letter, and the baseline of its first line.
  const handStart = hand => {
    const base = hand.querySelector('.lagrange-pen-base');
    const first = base && base.nextElementSibling;
    if (!first) return null;
    let x = first.getBoundingClientRect().left;
    // (the first letter itself: words are in one box per line, see .lagrange-pen-seg)
    const walker = document.createTreeWalker(first, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.length) node = walker.nextNode();
    if (first.classList.contains('lagrange-pen-math') || first.classList.contains('lagrange-pen-code')) node = null;
    if (node && node.nodeType === 3 && node.length) {
      const r = document.createRange();
      r.setStart(node, 0); r.setEnd(node, 1);
      const rects = r.getClientRects();
      if (rects.length) x = rects[0].left;
    }
    return { x, baseline: base.getBoundingClientRect().bottom };
  };
  // The left edge of each line the note sets its text in, from the character at pos on: `n` lines at most, measured
  // from the note's own lines in the page (the lines that only mark an alignment are passed over).
  const noteLines = (cm, pos, n) => {
    const out = [], at = cm.domAtPos(pos);
    let el = (at.node.nodeType === 1 ? at.node : at.node.parentElement).closest('.cm-line'), first = true;
    for (; el && out.length < n; el = el.nextElementSibling, first = false) {
      if (!el.classList.contains('cm-line') || /^:{3,}/.test(el.textContent.trim()) || !el.textContent.trim()) continue;
      const r = document.createRange();
      r.selectNodeContents(el);
      if (first) r.setStart(at.node, at.offset);
      const rects = Array.from(r.getClientRects()).filter(q => q.width >= 1).sort((a, b) => a.top - b.top || a.left - b.left);
      let top = null;
      for (const q of rects) {
        if (top === null || q.top - top > q.height * 0.6) { out.push(q.left); top = q.top; }
        else out[out.length - 1] = Math.min(out[out.length - 1], q.left);
      }
    }
    return out.slice(0, n);
  };
  // The left edge of each line of handwriting, the first included.
  // (boxes are one line when one's middle lies within the other's height: an equation typeset in the script is a
  // taller box than the words beside it, with its middle a little off theirs)
  const handLines = hand => {
    const boxes = [];
    for (const span of hand.children) {
      if (span.classList.contains('lagrange-pen-base') || span.classList.contains('lagrange-pen-lead')) continue;
      for (const r of span.getClientRects()) if (r.width >= 1) boxes.push(r);
    }
    boxes.sort((a, b) => (a.top + a.bottom) - (b.top + b.bottom));
    const lines = [];
    for (const r of boxes) {
      const mid = (r.top + r.bottom) / 2, line = lines[lines.length - 1];
      if (line && ((mid > line.top && mid < line.bottom) || ((line.top + line.bottom) / 2 > r.top && (line.top + line.bottom) / 2 < r.bottom))) {
        line.left = Math.min(line.left, r.left); line.top = Math.min(line.top, r.top); line.bottom = Math.max(line.bottom, r.bottom);
      } else lines.push({ left: r.left, top: r.top, bottom: r.bottom });
    }
    return lines.map(l => l.left);
  };

  const results = [];
  for (const c of cases) {
    await setPanel(c.panel || PANEL);
    if (options.only && !c.name.includes(options.only)) continue;
    const text = c.note != null ? c.note : NOTE;
    const mode = c.mode || 'live';
    plugin.settings.severalPens = c.several !== false;
    await leaf.openFile(file, { state: { mode: 'source', source: false } });
    leaf.view.editor.setValue(text);
    await sleep(options.settle || 500);
    leaf.view.editor.setCursor(0, 0);
    leaf.view.editor.cm.scrollDOM.scrollTop = 0;
    await leaf.setViewState(Object.assign({}, leaf.getViewState(), { state: Object.assign({}, leaf.getViewState().state, mode === 'reading' ? { mode: 'preview' } : { mode: 'source', source: mode === 'source' }) }));
    await sleep(options.settle || 500);
    const out = { name: c.name, ok: true, why: [] };
    const fail = why => { out.ok = false; out.why.push(why); };
    try {
      const ops = L.parseAgentReply('```lagrange-edits\n' + JSON.stringify(c.ops) + '\n```').ops;   // as a chat reply's edits are read
      const located = L.locateOps(text, ops);
      if (located.skipped.length || !located.located.length) throw new Error('the case could not be located: ' + JSON.stringify(located.skipped));
      // where each edit's first written letter will be, in the document as it will be once the edits before it are made
      let shift = 0;
      const starts = located.located.map(e => { const s = e.from + shift + L.inkOffset(e.replace); shift += e.replace.length - (e.to - e.from); return s; });
      const seen = { frames: 0, dx: 0, dy: 0, lineDx: 0, lines: 0, hands: 0, set: '', rows: 0, markers: 0, drawn: new Map(), unmatchedFrames: 0, early: 0, clipped: 0, clipWhy: '', segs: 0, scrolled: 0, tops: [], inked: new WeakSet(), cutWord: '' };
      // The ink of one line of handwriting (a .lagrange-pen-seg), from the font's own measure of its glyphs, against
      // the box that uncovers it: a letter that reaches outside the box would be cut.
      const inkCheck = seg => {
        const cs = getComputedStyle(seg), node = seg.firstChild;
        if (!node || node.nodeType !== 3) return;
        canvas.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const m = canvas.measureText(node.data), r = document.createRange();
        r.selectNodeContents(node);
        const t = r.getBoundingClientRect(), box = seg.getBoundingClientRect();
        const baseline = t.top + (t.height - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
        const ink = { left: t.left - m.actualBoundingBoxLeft, right: t.left + m.actualBoundingBoxRight, top: baseline - m.actualBoundingBoxAscent, bottom: baseline + m.actualBoundingBoxDescent };
        seen.segs++;
        const over = Math.max(box.left - ink.left, ink.right - box.right, box.top - ink.top, ink.bottom - box.bottom);
        if (over > 0) { seen.clipped++; seen.clipWhy = `“${node.data.slice(0, 24)}” reaches ${over.toFixed(1)} px outside its box`; }
        if (cs.clipPath !== 'none' || getComputedStyle(seg.parentElement.parentElement).clipPath !== 'none') { seen.clipped++; seen.clipWhy = 'the handwriting is clipped'; }
      };
      let sampling = true, handNo = -1, lastHand = null;
      seen.off = [];
      seen.reflow = 0;
      // a run of frames in which the hand was off its text has ended: a reflow if it was short, else a failure
      const settle = () => {
        const run = seen.off.splice(0);
        if (run.length <= 3) seen.reflow += run.length;
        else for (const [a, b] of run) { seen.dx = Math.max(seen.dx, a); seen.dy = Math.max(seen.dy, b); }
      };
      const sample = () => {
        if (!sampling) return;
        const cm = leaf.view.editor && leaf.view.editor.cm;
        const hand = Array.from(document.querySelectorAll('.lagrange-pen-hand')).find(h => getComputedStyle(h).opacity === '1');
        if (hand && cm) {
          if (hand !== lastHand) { lastHand = hand; handNo++; seen.hands++; }
          const h = handStart(hand), g = glyphAt(cm, starts[Math.min(handNo, starts.length - 1)]);
          if (h && g) {
            seen.frames++;
            // The note's text may move under the hand for a frame or two when an equation in it is typeset for the first
            // time in a session (the hand is put back on it in the next frame): up to three frames in a row are let
            // pass as such a reflow, and counted; a hand that stays off its text is not.
            const ddx = Math.abs(h.x - g.x), ddy = Math.abs(h.baseline - g.baseline);
            if (ddx > TOL || ddy > TOL) seen.off.push([ddx, ddy]);
            else {
              settle();
              seen.dx = Math.max(seen.dx, ddx);
              seen.dy = Math.max(seen.dy, ddy);
            }
            const lefts = handLines(hand);
            seen.lines = Math.max(seen.lines, lefts.length);
            if (/:{3}/.test(hand.textContent)) seen.markers++;
            if (c.aligned) {
              // centred or right-aligned text: line for line where the note starts each of its own
              const start = starts[Math.min(handNo, starts.length - 1)], at = cm.domAtPos(start);
              const line = (at.node.nodeType === 1 ? at.node : at.node.parentElement).closest('.cm-line');
              if (line) { const a = getComputedStyle(line).textAlign; seen.set = /center/.test(a) ? 'center' : /right|end/.test(a) ? 'right' : 'left'; }
              const want = noteLines(cm, start, lefts.length);
              seen.rows = Math.max(seen.rows, want.length);
              if (want.length < lefts.length) seen.lineDx = Math.max(seen.lineDx, 999);
              else if (ddx <= TOL && ddy <= TOL) for (let i = 1; i < lefts.length; i++) seen.lineDx = Math.max(seen.lineDx, Math.abs(lefts[i] - want[i]));
            } else if (lefts.length > 1) {
              const at = cm.domAtPos(starts[Math.min(handNo, starts.length - 1)]);
              const line = (at.node.nodeType === 1 ? at.node : at.node.parentElement).closest('.cm-line');
              if (line) {
                const edge = line.getBoundingClientRect().left + parseFloat(getComputedStyle(line).paddingLeft);
                for (const x of lefts.slice(1)) seen.lineDx = Math.max(seen.lineDx, Math.abs(x - edge));
              }
            }
          } else seen.unmatchedFrames++;
          // one line at a time: every line after the one being written is unseen
          const segs = Array.from(hand.querySelectorAll('.lagrange-pen-seg'));
          const done = hand.classList.contains('is-done');
          let open = false;
          for (const seg of segs) {
            if (!seen.inked.has(seg)) { seen.inked.add(seg); inkCheck(seg); }
            const visible = getComputedStyle(seg).visibility !== 'hidden';
            if (open && visible && !done) seen.early++;
            if (!seg.classList.contains('is-written')) open = true;
          }
          const said = hand.textContent.replace(/\s+/g, ' ').trim();
          if (/[*`[\]]|\]\(/.test(said)) seen.marks = said;
          if (/…$/.test(said) && !seen.cutWord) seen.cutWord = said;
          if (c.scroll && cm) {
            // down for 24 frames, up for 24: the text stays on screen
            const n = seen.scrolled++;
            if (n < 48) cm.scrollDOM.scrollTop += n < 24 ? 3 : -3;
          }
        }
        if (cm) {
          seen.tops.push(cm.scrollDOM.scrollTop);
          // where the text last written stands in the window
          const g = handNo >= 0 ? cm.coordsAtPos(Math.min(cm.state.doc.length, starts[Math.min(handNo, starts.length - 1)]), 1) : null;
          if (g) seen.textY = g.top;
        }
        for (const el of document.querySelectorAll('.lagrange-pen-drawing')) {
          // (measured from the top of its own line, which moves with whatever is above it)
          const r = el.getBoundingClientRect(), line = el.closest('.cm-line, .cm-embed-block') || el, scroll = line.getBoundingClientRect().top;
          if (!seen.drawn.has(el)) seen.drawn.set(el, []);
          seen.drawn.get(el).push({ x: r.left, y: r.top - scroll, w: r.width, h: r.height, inNote: Boolean(cm && cm.contentDOM.contains(el)) });
        }
        // (asked for from a timer, so that it runs after the pen's own frame callbacks: what is measured is what is painted)
        setTimeout(() => requestAnimationFrame(sample), 0);
      };
      requestAnimationFrame(sample);
      const view = leaf.view;
      await plugin.ensureEditing(view);
      const cm = view.editor.cm;
      const now = L.locateOps(cm.state.doc.toString(), ops);
      await plugin.applyEdits(view, now.located, now.skipped, null, null);
      // The scroll position when the run ends, against the last one seen while it ran and the one it settles at.
      const endTop = cm.scrollDOM.scrollTop, lastTop = seen.tops.length ? seen.tops[seen.tops.length - 1] : endTop;
      const textAt = () => { const g = seen.hands ? cm.coordsAtPos(Math.min(cm.state.doc.length, starts[Math.min(handNo, starts.length - 1)]), 1) : null; return g ? g.top : null; };
      const endY = textAt();
      await frame(); await frame();
      const nextTop = cm.scrollDOM.scrollTop, nextY = textAt();
      await sleep(700);
      sampling = false;
      settle();
      document.querySelectorAll('.notice').forEach(n => n.remove());
      // the equations the pen drew on, against where they rest now
      let drawn = 0, mdx = 0, mdsize = 0;
      for (const [el, list] of seen.drawn) {
        drawn++;
        // Once the run is over the editor may have drawn the equation afresh: it is compared with the note's equation
        // of the same source that now stands nearest to where the pen drew.
        const last = list[list.length - 1];
        let rest = null, best = Infinity;
        for (const now of cm.contentDOM.querySelectorAll('mjx-container')) {
          const a = now.querySelector('[data-latex]'), b = el.querySelector('[data-latex]');
          if (!a || !b || a.getAttribute('data-latex') !== b.getAttribute('data-latex')) continue;
          const line = now.closest('.cm-line, .cm-embed-block') || now;
          const r = now.getBoundingClientRect(), y = r.top - line.getBoundingClientRect().top, d = Math.hypot(r.left - last.x, y - last.y);
          if (d < best) { best = d; rest = { x: r.left, y, w: r.width, h: r.height }; }
        }
        if (!rest) { fail('an equation the pen drew is not in the note afterwards'); continue; }
        for (const s of list) {
          if (!s.inNote) fail('the pen drew an equation that is not the note\'s own');
          mdx = Math.max(mdx, Math.abs(s.x - rest.x), Math.abs(s.y - rest.y));
          mdsize = Math.max(mdsize, Math.abs(s.w - rest.w) / Math.max(1, rest.w), Math.abs(s.h - rest.h) / Math.max(1, rest.h));
        }
      }
      const expectText = located.located.some(e => e.replace.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, '').trim().length > 0);
      if (c.panel) { const line = cm.contentDOM.querySelector('.cm-line'); out.column = line ? Math.round(line.getBoundingClientRect().width) : 0; if (out.column > 480) fail(`the column is ${out.column} px wide, not narrow`); }
      Object.assign(out, { frames: seen.frames, dx: +seen.dx.toFixed(2), dy: +seen.dy.toFixed(2), lines: seen.lines, lineDx: +seen.lineDx.toFixed(2), equations: drawn, mathDx: +mdx.toFixed(2), mathSize: +(mdsize * 100).toFixed(2) });
      if (expectText && !seen.frames && !c.loose) fail('no handwriting was seen');
      if (seen.dx > TOL) fail(`the handwriting begins ${seen.dx.toFixed(1)} px to the side of the text's first letter`);
      if (seen.dy > TOL) fail(`the handwriting's baseline is ${seen.dy.toFixed(1)} px off the text's`);
      if (seen.lineDx > TOL) fail(c.aligned ? `a later line of handwriting starts ${seen.lineDx.toFixed(1)} px from where the note starts that line` : `a later line of handwriting starts ${seen.lineDx.toFixed(1)} px from the note line's left edge`);
      if (c.aligned && seen.frames && seen.set !== c.aligned) fail(`the note sets this text ${seen.set || 'nowhere'}, not ${c.aligned}: are the Scriptorium plugin and its snippet on?`);
      if (seen.markers) fail(`the handwriting wrote a marker line (in ${seen.markers} frames)`);
      if (c.lines && seen.lines < c.lines) fail(`the pen wrote ${seen.lines} line(s), not ${c.lines}`);
      if (c.math != null && !c.loose && drawn !== c.math) fail(`the pen drew on ${drawn} of the note's equations, not ${c.math}`);
      if (mdx > TOL) fail(`an equation was drawn ${mdx.toFixed(1)} px from where it rests`);
      if (mdsize > 0.02) fail(`an equation was drawn ${(mdsize * 100).toFixed(1)}% off its final size`);
      for (const o of c.ops) {
        const want = o.replace != null ? o.replace : o.text != null ? o.text : o.append;
        if (!c.loose && !cm.state.doc.toString().includes(want)) fail('the note does not hold the new text');
      }
      if (document.querySelector('.lagrange-pen-unwritten, [class*="lagrange-pen-revealing"], .lagrange-pen-drawing')) fail('the pen left a mark on the note');
      // one line at a time, and no letter cut
      Object.assign(out, { segs: seen.segs, early: seen.early, clipped: seen.clipped, reflowFrames: seen.reflow || 0 });
      if (seen.early) fail(`a later line of handwriting was visible before the pen came to it (in ${seen.early} frames)`);
      if (seen.clipped) fail(`a letter is cut: ${seen.clipWhy}`);
      if (c.noMarks && seen.marks) fail(`the handwriting shows Markdown marks: “${seen.marks.slice(0, 60)}”`);
      if (c.marks && !seen.marks) fail('the handwriting left out marks that are on the page in Source mode');
      if (seen.cutWord) {
        // what is written before the ellipsis ends at a whole word of the text
        const flat = t => t.replace(/[#>*_`$\\-]/g, '').replace(/\s+/g, ' ').trim();
        const head = flat(seen.cutWord.replace(/\s*…$/, '')), tail = head.slice(-18);
        const wants = located.located.map(e => flat(e.replace));
        if (!/\$/.test(located.located.map(e => e.replace).join('')) && !wants.some(w => { const i = w.indexOf(tail); return i >= 0 && (i + tail.length === w.length || /\s/.test(w[i + tail.length])); })) fail(`the handwriting ends inside a word: “…${tail} …”`);
      }
      // the view the writer watched is the view they are left with
      const restTop = cm.scrollDOM.scrollTop;
      // The scroll offset is the same before and after the end of the run, and the text last written has not moved in
      // the window. (Where something above the text changes its height as the run ends, as Typewriter Mode's padding
      // does after a switch from Reading view, the offset has to change for the text to stay; then only the text is held to.)
      const restY = textAt();
      out.endJump = +Math.max(Math.abs(endTop - lastTop), Math.abs(nextTop - lastTop), Math.abs(restTop - lastTop)).toFixed(1);
      out.endMove = seen.textY == null || restY == null ? null : +Math.max(Math.abs((endY == null ? restY : endY) - seen.textY), Math.abs((nextY == null ? restY : nextY) - seen.textY), Math.abs(restY - seen.textY)).toFixed(1);
      if (out.endMove != null ? out.endMove > 1 : (out.endJump > 1 && !c.loose)) fail(`the view moved when the run ended: the text last written by ${out.endMove} px, the scroll offset by ${out.endJump} px (${lastTop.toFixed(0)} while it ran, ${endTop.toFixed(0)} at its end, ${restTop.toFixed(0)} after)`);
      if (out.endJump > 1 && !/Reading view|callout|table/.test(c.name)) fail(`the note scrolled by ${out.endJump} px when the run ended (${lastTop.toFixed(0)} while it ran, ${endTop.toFixed(0)} at its end, ${restTop.toFixed(0)} after)`);
      if (!c.scroll && !c.loose) {
        const lastStart = cm.state.doc.toString().lastIndexOf((located.located[located.located.length - 1].replace || '').slice(L.inkOffset(located.located[located.located.length - 1].replace)).slice(0, 24));
        const at = lastStart >= 0 ? cm.coordsAtPos(lastStart, 1) : null, sr = cm.scrollDOM.getBoundingClientRect();
        if (!at || at.top < sr.top - 1 || at.bottom > sr.bottom + 1) fail('the last text written is not in view when the run ends');
      }
      if (c.scroll && seen.scrolled < 48) fail(`the note was scrolled for ${seen.scrolled} frames only`);
    } catch (e) {
      fail(String((e && e.message) || e));
    }
    out.why = out.why.join('; ');
    results.push(out);
    console.log(`${out.ok ? 'ok  ' : 'FAIL'} ${out.name}${out.why ? ': ' + out.why : ''}`);
  }

  /* ---- A click or a key while the pen writes; typing alongside it; the chat's log; hover bubbles ---- */
  const extra = async (name, body) => {
    if (options.only && !name.includes(options.only)) return;
    const out = { name, ok: true, why: [] };
    const fail = why => { out.ok = false; out.why.push(why); };
    try { await body(out, fail); } catch (e) { fail(String((e && e.stack) || e)); }
    plugin.settings.editWhileWriting = false;
    plugin.settings.severalPens = true;
    plugin.settings.maxPens = 3;
    out.why = out.why.join('; ');
    results.push(out);
    console.log(`${out.ok ? 'ok  ' : 'FAIL'} ${out.name}${out.why ? ': ' + out.why : ''}`);
  };
  const OPS3 = [{ find: 'Short line here.', replace: 'Short sentence here, rewritten by the pen at some length.' },
    { find: 'mentions energy once', replace: 'speaks of energy only the one time' }, { append: 'An appended closing remark.' }];
  const afterOps = t => t.replace('Short line here.', 'Short sentence here, rewritten by the pen at some length.')
    .replace('mentions energy once', 'speaks of energy only the one time').replace(/\n*$/, '') + '\n\nAn appended closing remark.';
  const same = (a, b) => a.replace(/\n*$/, '') === b.replace(/\n*$/, '');
  // Opens the note in Live Preview with the cursor after `caret`, starts a run of OPS3 and resolves when the pen is writing.
  const begin = async (caret, ops) => {
    await leaf.openFile(file, { state: { mode: 'source', source: false } });
    leaf.view.editor.setValue(NOTE);
    await sleep(options.settle || 500);
    const ed = leaf.view.editor, cm = ed.cm;
    ed.focus();
    ed.setCursor(ed.offsetToPos(NOTE.indexOf(caret) + caret.length));
    await sleep(300);
    const parsed = L.parseAgentReply('```lagrange-edits\n' + JSON.stringify(ops || OPS3) + '\n```').ops;
    const now = L.locateOps(cm.state.doc.toString(), parsed);
    const run = plugin.applyEdits(leaf.view, now.located, now.skipped, null, null);
    for (let i = 0; i < 600 && !document.querySelector('.lagrange-pen-seg.is-writing'); i++) await frame();
    return { ed, cm, run };
  };
  const overlays = () => document.querySelectorAll('.lagrange-pen-hand, .lagrange-pen-unwritten, .lagrange-pen-gone').length;
  const penShown = () => Array.from(document.querySelectorAll('.lagrange-pen')).some(p => p.style.display !== 'none');

  await extra('a key in the note ends the run: the note is as an uninterrupted run leaves it, then the key lands at the cursor', async (out, fail) => {
    const { ed, cm, run } = await begin('The paragraph before the filler.');
    const target = cm.contentDOM;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'X', bubbles: true, cancelable: true }));
    // at once, before the key's own effect: every edit is in the note and nothing of the pen is left
    if (!same(cm.state.doc.toString(), afterOps(NOTE))) fail('the note is not what an uninterrupted run leaves, right after the key');
    if (overlays() || penShown()) fail('the pen or its handwriting is still on the page right after the key');
    cm.dispatch(cm.state.replaceSelection('X'), { userEvent: 'input.type' });   // what the key then does
    const res = await run;
    await sleep(300);
    const want = afterOps(NOTE).replace('The paragraph before the filler.', 'The paragraph before the filler.X');
    if (!same(cm.state.doc.toString(), want)) fail('the key did not land at the cursor, after the edits');
    if (res.ended !== 'key' || res.applied.length !== 3 || res.skipped.length) fail(`the run reports ended=${res.ended}, ${res.applied.length} made, ${res.skipped.length} skipped`);
    // one undo step for the run, kept apart from the key; Lagrange's own Undo keeps the key
    const rec = plugin.edits[plugin.edits.length - 1];
    plugin.undoEdit(rec);
    await sleep(150);
    if (cm.state.doc.toString() !== NOTE.replace('The paragraph before the filler.', 'The paragraph before the filler.X')) fail('Undo did not take back exactly the run');
    plugin.redoEdit(rec);
    await sleep(150);
    if (!same(cm.state.doc.toString(), want)) fail('Redo did not make the run again');
    ed.undo(); ed.undo();
    await sleep(150);
    out.afterEditorUndo = cm.state.doc.toString() === NOTE;
    document.querySelectorAll('.notice').forEach(n => n.remove());
  });

  await extra('a click in the note ends the run; the click lands on the text that was under the pointer', async (out, fail) => {
    const { cm, run } = await begin('# Pen position check');
    const word = 'third item';                               // below the edit being written, above the others
    const at = cm.coordsAtPos(cm.state.doc.toString().indexOf(word) + 5, 1);
    if (!at) throw new Error('the word to click is not on screen');
    const x = at.left, y = (at.top + at.bottom) / 2, el = document.elementFromPoint(x, y) || cm.contentDOM;
    const init = { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: 1, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, isPrimary: true }, init)));
    if (!same(cm.state.doc.toString(), afterOps(NOTE))) fail('the note is not what an uninterrupted run leaves, right after the pointer went down');
    if (overlays() || penShown()) fail('the pen or its handwriting is still on the page right after the click');
    const under = cm.posAtCoords({ x, y });
    out.underPointer = cm.state.doc.toString().slice(under - 5, under + 5);
    if (out.underPointer !== word) fail(`the text under the pointer moved: now “${out.underPointer}”`);
    el.dispatchEvent(new MouseEvent('mousedown', init));
    el.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, init, { buttons: 0 })));
    const res = await run;
    await sleep(200);
    cm.dispatch({ selection: { anchor: under } });            // where the click puts the cursor
    cm.dispatch(cm.state.replaceSelection('Y'), { userEvent: 'input.type' });
    const want = afterOps(NOTE).replace('- third item', '- thirdY item');
    if (!same(cm.state.doc.toString(), want)) fail('typing after the click did not land where the click was');
    if (res.ended !== 'click' || res.applied.length !== 3) fail(`the run reports ended=${res.ended}, ${res.applied.length} made`);
    document.querySelectorAll('.notice').forEach(n => n.remove());
  });

  await extra('scrolling, the arrow keys, Ctrl+C and a change that changes nothing do not end the run', async (out, fail) => {
    const { cm, run } = await begin('The paragraph before the filler.');
    cm.scrollDOM.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true }));
    cm.scrollDOM.scrollTop += 20;
    for (const init of [{ key: 'ArrowDown' }, { key: 'c', ctrlKey: true }, { key: 'Shift' }, { key: 'PageDown' }]) cm.contentDOM.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init)));
    // nor does Obsidian's own change that replaces the first character by itself (it makes one to highlight a note afresh)
    cm.dispatch({ changes: { from: 0, to: 1, insert: cm.state.doc.sliceString(0, 1) }, userEvent: 'set' });
    await sleep(200);
    if (!document.querySelector('.lagrange-pen-hand')) fail('the handwriting went');
    const res = await run;
    if (res.ended) fail(`the run was ended (${res.ended})`);
    if (res.touched) fail('a change that left the text as it was is taken for the writer’s typing');
    if (!same(cm.state.doc.toString(), afterOps(NOTE))) fail('the note is not right');
    document.querySelectorAll('.notice').forEach(n => n.remove());
  });

  await extra('“Let me edit while the pen writes”: typing elsewhere goes in at once, the pen goes on, and both stand', async (out, fail) => {
    plugin.settings.editWhileWriting = true;
    const { cm, run } = await begin('The paragraph before the filler.');
    let typed = 0;
    for (const ch of ' I am typing this meanwhile.') {
      cm.dispatch(cm.state.replaceSelection(ch), { userEvent: 'input.type' });
      typed++;
      await sleep(40);
    }
    // and near the top, above every edit, so that every pending edit has to move
    cm.dispatch({ changes: { from: 0, to: 0, insert: 'A line typed at the very top.\n\n' }, userEvent: 'input.type' });
    await sleep(120);
    const stillWriting = Boolean(document.querySelector('.lagrange-pen-hand')) || penShown();
    const res = await run;
    await sleep(500);
    if (!stillWriting) fail('the pen stopped');
    if (res.ended) fail(`the run was ended (${res.ended})`);
    const want = 'A line typed at the very top.\n\n' + afterOps(NOTE).replace('The paragraph before the filler.', 'The paragraph before the filler. I am typing this meanwhile.');
    if (!same(cm.state.doc.toString(), want)) fail('the note does not hold both the typing and the three edits');
    if (res.applied.length !== 3 || res.skipped.length || !res.touched) fail(`the run reports ${res.applied.length} made, ${res.skipped.length} skipped, touched=${res.touched}`);
    if (overlays()) fail('the pen left a mark on the note');
    // Lagrange's Undo takes back its edits and keeps the typing
    const rec = plugin.edits[plugin.edits.length - 1];
    plugin.undoEdit(rec);
    await sleep(150);
    const undone = 'A line typed at the very top.\n\n' + NOTE.replace('The paragraph before the filler.', 'The paragraph before the filler. I am typing this meanwhile.');
    if (cm.state.doc.toString() !== undone) fail('Undo did not take back exactly Lagrange’s edits');
    document.querySelectorAll('.notice').forEach(n => n.remove());
  });

  await extra('“Let me edit while the pen writes”: an edit whose words the writer changed is skipped, and the rest are made', async (out, fail) => {
    plugin.settings.editWhileWriting = true;
    const { cm, run } = await begin('The paragraph before the filler.');
    const i = cm.state.doc.toString().indexOf('mentions energy once');
    cm.dispatch({ changes: { from: i, to: i + 8, insert: 'talks about' }, userEvent: 'input.type' });   // the second edit's words
    const res = await run;
    await sleep(500);
    const doc = cm.state.doc.toString();
    if (!doc.includes('talks about energy once')) fail('the writer’s words were overwritten');
    if (!doc.includes('Short sentence here, rewritten by the pen at some length.') || !doc.includes('An appended closing remark.')) fail('the other edits were not made');
    if (res.applied.length !== 2 || res.skipped.length !== 1 || !/you changed/.test(res.skipped[0].why)) fail(`the run reports ${res.applied.length} made, skipped: ${JSON.stringify(res.skipped.map(s => s.why))}`);
    document.querySelectorAll('.notice').forEach(n => n.remove());
  });

  /* ---- Several pens at once ---- */
  // Four paragraphs of three or four lines each, and a short one: edits in different paragraphs stand well apart.
  const MP = [
    'Energy is never lost, only moved about: what a falling stone loses in height it gains in speed, and what it gains in speed it gives up, when it lands, as heat and sound and a dent in the ground. The books balance to the last farthing.',
    'A body at rest stays at rest, and a body in motion keeps its motion, unless something acts on it; this much was known to Galileo, who rolled balls down smooth planes and saw that the smoother the plane, the farther they went, and guessed the rest.',
    'The kinetic energy of a moving body grows with the square of its speed. Momentum is conserved. Nobody has yet caught the universe cheating, though many have tried, and a perpetual motion machine is a fraud before it is switched on.',
    'A clock needs winding, and nothing that runs has ever run for nothing; jolly good, quipped the physicist, glancing gravely at the gauge, and went back to his sums, which came out as they always had.',
  ];
  const MULTI = ['# Pen position check', ...MP, 'The last paragraph of the note says little, and says it briefly.'].join('\n\n') + '\n';
  const THREE = [
    { find: 'what a falling stone loses in height it gains in speed', replace: 'what a falling stone gives up in height it wins back in speed' },
    { find: 'this much was known to Galileo', replace: 'Galileo knew as much' },
    { find: 'Momentum is conserved.', replace: 'Momentum, too, is conserved.' },
  ];
  const pensShown = () => Array.from(document.querySelectorAll('.lagrange-pen')).filter(p => p.style.display !== 'none').length;
  // The ink of a hand that shows: the box around its words, equations and code that the pen has come to.
  const inkBox = hand => {
    const done = hand.classList.contains('is-done');
    let box = null;
    const add = r => { if (r.width < 0.5 || r.height < 0.5) return; box = box ? { left: Math.min(box.left, r.left), top: Math.min(box.top, r.top), right: Math.max(box.right, r.right), bottom: Math.max(box.bottom, r.bottom) } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
    for (const seg of hand.querySelectorAll('.lagrange-pen-seg')) {
      if (!done && !seg.classList.contains('is-writing') && !seg.classList.contains('is-written')) continue;
      const r = document.createRange();
      r.selectNodeContents(seg);
      for (const q of r.getClientRects()) add(q);
    }
    for (const el of hand.querySelectorAll('.lagrange-pen-math, .lagrange-pen-code')) if (done || el.classList.contains('is-on')) add(el.getBoundingClientRect());
    return box;
  };
  /* Runs ops on `note` (Live Preview) and watches every frame. o: {several (default true), pens (the setting), scroll,
     during(cm): called once two pens are out}. -> what was seen: {text, ms, pens (the most at once), hands, lanes (what
     the rule gives for these edits on this page), perHand: [{edit, dx, dy, frames, reflow}], meets (frames in which two
     hands' ink met), gap (the least clear height between two hands' ink, px), endJump, res}. */
  const penRun = async (note, ops, o) => {
    o = o || {};
    plugin.settings.severalPens = o.several !== false;
    plugin.settings.maxPens = o.pens || 3;
    await leaf.openFile(file, { state: { mode: 'source', source: false } });
    leaf.view.editor.setValue(note);
    await sleep(options.settle || 500);
    leaf.view.editor.setCursor(0, 0);
    leaf.view.editor.cm.scrollDOM.scrollTop = 0;
    await sleep(options.settle || 500);
    const view = leaf.view, cm = view.editor.cm;
    const parsed = L.parseAgentReply('```lagrange-edits\n' + JSON.stringify(ops) + '\n```').ops;
    const now = L.locateOps(cm.state.doc.toString(), parsed);
    if (now.skipped.length || now.located.length !== ops.length) throw new Error('the edits could not be located: ' + JSON.stringify(now.skipped));
    // what the rule gives for these edits here (the note is scrolled as the run would scroll it)
    const lanes = o.several === false ? null : await L.penWave(cm, now.located.map(e => ({ from: e.from, to: e.to, replace: e.replace })), plugin.settings.maxPens, () => true);
    await sleep(200);
    const inks = now.located.map(e => e.replace.slice(L.inkOffset(e.replace)).replace(/^\s+/, '').slice(0, 24));
    const seen = { pens: 0, hands: 0, meets: 0, gap: Infinity, tops: [], frames: 0, scrolled: 0, typewriter: 0, drawing: 0, long: 0, strokes: 0, strokeOff: 0, strokeRun: 0, moved: 0, y0: null };
    const recs = new Map(), perHand = [];
    const settle = rec => { const run = rec.off.splice(0); if (run.length <= 3) rec.reflow += run.length; else for (const [a, b] of run) { rec.dx = Math.max(rec.dx, a); rec.dy = Math.max(rec.dy, b); } };
    let on = true, called = false, last = performance.now();
    const sample = () => {
      if (!on) return;
      const t = performance.now();
      if (t - last > 34) seen.long++;
      last = t;
      seen.frames++;
      const doc = cm.state.doc.toString();
      const hands = Array.from(document.querySelectorAll('.lagrange-pen-hand')).filter(h => getComputedStyle(h).opacity === '1');
      seen.pens = Math.max(seen.pens, pensShown());
      seen.hands = Math.max(seen.hands, hands.length);
      if (Array.from(document.querySelectorAll('.lagrange-typewriter')).some(p => p.style.display !== 'none')) seen.typewriter++;
      if (document.querySelector('.lagrange-pen-drawing')) seen.drawing++;
      const boxes = [];
      for (const hand of hands) {
        let rec = recs.get(hand);
        if (!rec) { rec = { edit: -1, dx: 0, dy: 0, frames: 0, reflow: 0, off: [] }; recs.set(hand, rec); perHand.push(rec); }
        const h = handStart(hand);
        // the edit whose text this hand is on: the nearest of those now in the note
        let best = null;
        if (h) inks.forEach((ink, i) => {
          const p = ink ? doc.indexOf(ink) : -1, g = p >= 0 ? glyphAt(cm, p) : null;
          if (!g) return;
          const d = Math.hypot(h.x - g.x, h.baseline - g.baseline);
          if (!best || d < best.d) best = { i, d, ddx: Math.abs(h.x - g.x), ddy: Math.abs(h.baseline - g.baseline) };
        });
        if (best) {
          rec.frames++;
          if (rec.edit < 0) rec.edit = best.i;
          if (best.ddx > TOL || best.ddy > TOL) rec.off.push([best.ddx, best.ddy]);
          else { settle(rec); rec.dx = Math.max(rec.dx, best.ddx); rec.dy = Math.max(rec.dy, best.ddy); }
        }
        const b = inkBox(hand);
        if (b) boxes.push(b);
      }
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const clear = Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom), side = Math.max(a.left, b.left) - Math.min(a.right, b.right);
        if (clear < 0 && side < 0) seen.meets++;
        seen.gap = Math.min(seen.gap, clear);
      }
      // The strokes that strike words out lie on those words, wherever the note has moved them to (another pen's
      // edit above pushes them down): the middle of each stroke is in one of the struck lines. Up to three frames in
      // a row off them are let pass, as a reflow.
      const gone = Array.from(cm.contentDOM.querySelectorAll('.lagrange-pen-gone')).flatMap(el => Array.from(el.getClientRects()));
      let off = 0;
      if (gone.length) for (const p of document.querySelectorAll('.lagrange-pen-strike path')) {
        const r = p.getBoundingClientRect(), y = (r.top + r.bottom) / 2;
        if (p.style.opacity === '0' || r.width < 2) continue;
        seen.strokes++;
        if (!gone.some(g => y >= g.top - 1 && y <= g.bottom + 1 && r.left >= g.left - 8 && r.left <= g.right + 8)) off++;
      }
      seen.strokeRun = off ? seen.strokeRun + 1 : 0;
      if (seen.strokeRun > 3) seen.strokeOff++;
      // how far the last edit's text has been pushed down the page since the pens set out (what is above it grew)
      if (o.watch) {
        const p = doc.indexOf(o.watch), c = p >= 0 ? cm.coordsAtPos(p, 1) : null;
        if (c) { const y = c.top + cm.scrollDOM.scrollTop; if (seen.y0 === null) seen.y0 = y; seen.moved = Math.max(seen.moved, y - seen.y0); }
      }
      // (the note is scrolled down by three lines and back again, over 0.8 s from the first hand's appearing: by the
      // clock, so that a slow machine scrolls as far in fewer frames)
      if (o.scroll && hands.length && !seen.back) {
        if (seen.s0 == null) { seen.s0 = t; seen.base = cm.scrollDOM.scrollTop; }
        const u = (t - seen.s0) / 800;
        cm.scrollDOM.scrollTop = seen.base + (u < 1 ? Math.round(96 * (1 - Math.abs(2 * u - 1))) : 0);
        if (u < 1) seen.scrolled++; else seen.back = true;
      }
      if (o.during && !called && seen.pens >= 2 && document.querySelector('.lagrange-pen-seg.is-writing')) { called = true; try { o.during(cm); } catch (e) { console.error(e); } }
      seen.tops.push(cm.scrollDOM.scrollTop);
      const y = textAt();
      if (y !== null) seen.textY = y;
      setTimeout(() => requestAnimationFrame(sample), 0);
    };
    // where the text last written (the last edit's, in the order of the note) stands in the window
    const textAt = () => {
      const ink = inks[inks.length - 1], p = ink ? cm.state.doc.toString().indexOf(ink) : -1, c = p >= 0 ? cm.coordsAtPos(p, 1) : null;
      return c ? c.top : null;
    };
    requestAnimationFrame(sample);
    const t0 = performance.now();
    const res = await plugin.applyEdits(view, now.located, now.skipped, null, null);
    const ms = Math.round(performance.now() - t0);
    const endTop = cm.scrollDOM.scrollTop, lastTop = seen.tops.length ? seen.tops[seen.tops.length - 1] : endTop, endY = textAt();
    await frame(); await frame();
    const nextTop = cm.scrollDOM.scrollTop, nextY = textAt();
    await sleep(700);
    on = false;
    for (const rec of perHand) { settle(rec); delete rec.off; }
    document.querySelectorAll('.notice').forEach(n => n.remove());
    const restTop = cm.scrollDOM.scrollTop, restY = textAt();
    return {
      // (the text last written has not moved in the window: where the editor comes to know the height of something
      // above it better as the run ends, the scroll offset has to change for the text to stay, see the cases above)
      endMove: seen.textY == null || restY == null ? null : +Math.max(Math.abs((endY == null ? restY : endY) - seen.textY), Math.abs((nextY == null ? restY : nextY) - seen.textY), Math.abs(restY - seen.textY)).toFixed(1),
      cm, res, ms, lanes, perHand, text: cm.state.doc.toString(), pens: seen.pens, hands: seen.hands, meets: seen.meets, gap: seen.gap, frames: seen.frames, long: seen.long,
      scrolled: seen.scrolled, typewriter: seen.typewriter, drawing: seen.drawing, strokes: seen.strokes, strokeOff: seen.strokeOff, moved: seen.moved,
      endJump: +Math.max(Math.abs(endTop - lastTop), Math.abs(nextTop - lastTop), Math.abs(restTop - lastTop)).toFixed(1),
      left: document.querySelectorAll('.lagrange-pen-hand, .lagrange-pen-unwritten, .lagrange-pen-gone, .lagrange-pen-drawing, [class*="lagrange-pen-revealing"]').length,
    };
  };
  // What every run of several pens must show, whatever it writes.
  const penChecks = (r, n, ops, out, fail) => {
    Object.assign(out, { pens: r.pens, lanes: r.lanes ? r.lanes.map(l => l.length).join('+') : '', ms: r.ms, frames: r.frames, longFrames: r.long, gap: r.gap === Infinity ? null : +r.gap.toFixed(1), endJump: r.endJump, endMove: r.endMove,
      dx: +Math.max(0, ...r.perHand.map(h => h.dx)).toFixed(2), dy: +Math.max(0, ...r.perHand.map(h => h.dy)).toFixed(2), reflowFrames: r.perHand.reduce((a, h) => a + h.reflow, 0) });
    if (!r.lanes || r.lanes.length !== n) fail(`the rule gives ${r.lanes ? r.lanes.length : 0} pen(s) for these edits on this page, not ${n}: is the window too small? (the harness is made for an editor about 680 px high and 460 px wide)`);
    if (r.pens !== n) fail(`${r.pens} pen(s) were out at once, not ${n}`);
    if (r.res.applied.length !== ops.length || r.res.skipped.length) fail(`${r.res.applied.length} edits made, ${r.res.skipped.length} skipped`);
    const hands = r.perHand.filter(h => h.frames);
    if (hands.length < ops.length) fail(`handwriting was seen on its text for ${hands.length} of ${ops.length} edits`);
    if (new Set(hands.map(h => h.edit)).size < Math.min(hands.length, ops.length)) fail('two pens wrote on the same text');
    for (const h of hands) {
      if (h.dx > TOL) fail(`the handwriting of edit ${h.edit + 1} begins ${h.dx.toFixed(1)} px to the side of its text's first letter`);
      if (h.dy > TOL) fail(`the baseline of edit ${h.edit + 1}'s handwriting is ${h.dy.toFixed(1)} px off its text's`);
    }
    if (r.meets) fail(`two pens' handwriting met (in ${r.meets} frames)`);
    if (r.strokeOff) fail(`a stroke that strikes words out was off its words (in ${r.strokeOff} frames)`);
    if (r.left) fail('the pens left a mark on the note');
    if (r.endMove != null ? r.endMove > 1 : r.endJump > 1) fail(`the view moved when the run ended: the text last written by ${r.endMove} px, the scroll offset by ${r.endJump} px`);
  };
  const afterThree = t => t.replace(THREE[0].find, THREE[0].replace).replace(THREE[1].find, THREE[1].replace).replace(THREE[2].find, THREE[2].replace);

  await extra('several pens: three pens: three edits in three paragraphs are written at once, each hand on its own text, and the note is what one pen leaves, sooner', async (out, fail) => {
    const r = await penRun(MULTI, THREE);
    penChecks(r, 3, THREE, out, fail);
    if (r.hands < 2) fail('no two hands were on the page at the same time');
    const one = await penRun(MULTI, THREE, { several: false });
    Object.assign(out, { msOnePen: one.ms });
    if (one.pens !== 1) fail(`with “Several pens at once” off, ${one.pens} pens were out`);
    if (r.text !== one.text) fail('the note is not what one pen leaves');
    if (r.text !== afterThree(MULTI)) fail('the note does not hold the three edits');
    if (!(r.ms < one.ms)) fail(`three pens took ${r.ms} ms, one pen ${one.ms} ms`);
  });

  await extra('several pens: two pens: two edits in two paragraphs; and three edits with “Pens at most” at 2 (the third waits its turn)', async (out, fail) => {
    const two = THREE.slice(0, 2);
    const r = await penRun(MULTI, two);
    penChecks(r, 2, two, out, fail);
    const one = await penRun(MULTI, two, { several: false });
    if (r.text !== one.text) fail('the note is not what one pen leaves');
    if (!(r.ms < one.ms)) fail(`two pens took ${r.ms} ms, one pen ${one.ms} ms`);
    Object.assign(out, { msOnePen: one.ms });
    const capped = await penRun(MULTI, THREE, { pens: 2 });
    out.capped = capped.pens;
    if (capped.pens !== 2) fail(`with “Pens at most” at 2, ${capped.pens} pens were out at once`);
    if (capped.text !== afterThree(MULTI)) fail('with “Pens at most” at 2, the note does not hold the three edits');
    if (capped.meets) fail('with “Pens at most” at 2, two pens’ handwriting met');
  });

  await extra('several pens: one pen where the edits are too near: two in one paragraph, and one in the very next line', async (out, fail) => {
    const NEAR = ['# Pen position check', MP[0], 'A short line.\nAnother short line, right under it.\nAnd a third.', MP[2]].join('\n\n') + '\n';
    const samePara = [{ find: 'A body at rest stays at rest', replace: 'What is still stays still' }, { find: 'and guessed the rest.', replace: 'and guessed what remained.' }];
    const a = await penRun(MULTI, samePara);
    Object.assign(out, { pens: a.pens, lanes: a.lanes ? a.lanes.length : 0, ms: a.ms });
    if (a.lanes) fail('the rule gives several pens to two edits in one paragraph');
    if (a.pens !== 1) fail(`${a.pens} pens were out for two edits in one paragraph`);
    if (a.text !== MULTI.replace(samePara[0].find, samePara[0].replace).replace(samePara[1].find, samePara[1].replace)) fail('the note does not hold the two edits');
    const nextLine = [{ find: 'A short line.', replace: 'A short line, rewritten.' }, { find: 'Another short line, right under it.', replace: 'Another, right under it.' }, { find: 'And a third.', replace: 'And a third, too.' }];
    const b = await penRun(NEAR, nextLine);
    out.pensNextLine = b.pens;
    if (b.lanes) fail('the rule gives several pens to edits in lines that follow one another');
    if (b.pens !== 1) fail(`${b.pens} pens were out for edits in lines that follow one another`);
    if (b.res.applied.length !== 3) fail('the three edits were not all made');
    if (a.meets || b.meets) fail('handwriting met');
  });

  await extra('several pens: two pens and a wait: two edits in one paragraph go to one pen, in turn, while another pen writes further down', async (out, fail) => {
    const ops = [{ find: 'A body at rest stays at rest', replace: 'What is still stays still' }, { find: 'and guessed the rest.', replace: 'and guessed what remained.' }, { find: 'jolly good, quipped the physicist', replace: 'very well, said the physicist' }];
    const r = await penRun(MULTI, ops);
    penChecks(r, 2, ops, out, fail);
    if (!r.lanes || r.lanes.map(l => l.length).join('+') !== '2+1') fail(`the lanes are ${r.lanes ? r.lanes.map(l => l.length).join('+') : 'none'}, not 2+1`);
    const one = await penRun(MULTI, ops, { several: false });
    if (r.text !== one.text) fail('the note is not what one pen leaves');
  });

  await extra('several pens: three pens, and the first puts two lines in above the others while they strike and write: strokes and hands go down with their words', async (out, fail) => {
    const ops = [
      { insert_after: 'Energy is never lost, only moved about:', text: ' nothing is ever paid out that was not first paid in, and the ledger of the world, kept since the beginning, has never once been found a penny short;' },
      THREE[1], { find: 'Nobody has yet caught the universe cheating', replace: 'No one has yet caught the universe out' },
    ];
    const r = await penRun(MULTI, ops, { watch: 'Nobody has yet caught the universe cheating' });
    penChecks(r, 3, ops, out, fail);
    Object.assign(out, { strokes: r.strokes, moved: +r.moved.toFixed(1) });
    if (!r.strokes) fail('no stroke was seen on struck words');
    if (!(r.moved > 20)) fail(`the words below the first edit moved down by ${r.moved.toFixed(1)} px only: the case shows nothing`);
    const one = await penRun(MULTI, ops, { several: false });
    if (r.text !== one.text) fail('the note is not what one pen leaves');
  });

  await extra('several pens: six edits over two screens are written in two rounds of three pens, with one scroll between them', async (out, fail) => {
    const MORE = [
      'Heat is motion that has lost its way: the stone that lands is still, but the ground it struck is a little warmer, and the air a little louder, than they were before it fell; nothing was mislaid.',
      'A pendulum trades height for speed and speed for height, over and over, and would do so for ever if the air and the pivot took no toll; they do, and so the swings grow shorter by degrees.',
      'Friction is no thief, only a spendthrift, turning the motion we can see into motion we cannot; the sum never changes, and a careful enough accountant can always find the missing part.',
      'So the oldest rule of the workshop, that nothing is to be had for nothing, turned out to be a law of nature, and the dream of an engine that feeds itself was put away with the rest.',
    ];
    const LONG6 = ['# Pen position check', ...MP, 'A short paragraph stands between the two halves of the note.', ...MORE, filler(4), 'The last paragraph of the note says little, and says it briefly.'].join('\n\n') + '\n';
    const ops = THREE.concat([
      { find: 'they do, and so the swings grow shorter by degrees', replace: 'they do, and the swings die away' },
      { find: 'only a spendthrift', replace: 'only a spender' },
      { find: 'was put away with the rest', replace: 'was laid to rest' },
    ]);
    const r = await penRun(LONG6, ops);
    penChecks(r, 3, ops, out, fail);
    out.hands = r.perHand.filter(h => h.frames).length;
    const one = await penRun(LONG6, ops, { several: false });
    Object.assign(out, { msOnePen: one.ms });
    if (r.text !== one.text) fail('the note is not what one pen leaves');
    if (!(r.ms < one.ms)) fail(`the pens took ${r.ms} ms, one pen ${one.ms} ms`);
    const cm = r.cm, at = cm.coordsAtPos(cm.state.doc.toString().indexOf('was laid to rest'), 1), sr = cm.scrollDOM.getBoundingClientRect();
    if (!at || at.top < sr.top - 1 || at.bottom > sr.bottom + 1) fail('the last text written is not in view when the run ends');
  });

  await extra('several pens: one pen, then two: an edit that stands alone, then two far below it that are in view together; the view at the end is the view that was watched', async (out, fail) => {
    const r = await penRun(NOTE, OPS3);
    const hands = r.perHand.filter(h => h.frames);
    Object.assign(out, { pens: r.pens, ms: r.ms, hands: hands.length, endJump: r.endJump, endMove: r.endMove, dx: +Math.max(0, ...hands.map(h => h.dx)).toFixed(2), dy: +Math.max(0, ...hands.map(h => h.dy)).toFixed(2), gap: r.gap === Infinity ? null : +r.gap.toFixed(1) });
    if (r.lanes) fail('the rule gives several pens to edits that are not in view together');
    if (r.pens > 2) fail(`${r.pens} pens were out at once`);
    if (r.pens < 2) fail('the last two edits were not written at once: is the window too small? (they are some ten lines apart, at the end of the note)');
    if (hands.length < 3) fail(`handwriting was seen on its text for ${hands.length} of 3 edits`);
    for (const h of hands) if (h.dx > TOL || h.dy > TOL) fail(`the handwriting of edit ${h.edit + 1} is ${h.dx.toFixed(1)} px to the side of its text, ${h.dy.toFixed(1)} px off its baseline`);
    if (r.meets) fail(`two pens' handwriting met (in ${r.meets} frames)`);
    if (r.left) fail('the pens left a mark on the note');
    // (the first edit's paragraph is far above by then, and the editor only guesses at its height when the run is
    // made one undo step: the scroll offset may change by a line for the text in view to stay where it is)
    if (r.endMove == null || r.endMove > 1) fail(`the text last written moved by ${r.endMove} px when the run ended (the scroll offset by ${r.endJump} px)`);
    if (!same(r.text, afterOps(NOTE))) fail('the note does not hold the three edits');
    const cm = r.cm, at = cm.coordsAtPos(cm.state.doc.toString().indexOf('An appended closing remark.'), 1), sr = cm.scrollDOM.getBoundingClientRect();
    if (!at || at.top < sr.top - 1 || at.bottom > sr.bottom + 1) fail('the last text written is not in view when the run ends');
    const one = await penRun(NOTE, OPS3, { several: false });
    Object.assign(out, { msOnePen: one.ms });
    if (r.text !== one.text) fail('the note is not what one pen leaves');
    if (one.pens !== 1) fail(`with “Several pens at once” off, ${one.pens} pens were out`);
  });

  await extra('several pens: three pens, the note scrolled while they write: every hand stays on its text', async (out, fail) => {
    const r = await penRun(MULTI, THREE, { scroll: true });
    penChecks(r, 3, THREE, out, fail);
    out.scrolled = r.scrolled;
    if (r.scrolled < 10) fail(`the note was scrolled for ${r.scrolled} frames only`);
    if (r.text !== afterThree(MULTI)) fail('the note does not hold the three edits');
  });

  await extra('several pens: three pens: prose, an equation and code are written at once (the pen, the note’s own equation, the typewriter)', async (out, fail) => {
    const ops = [THREE[0], { find: 'Momentum is conserved.', replace: 'Momentum is conserved: $p = mv$.' }, { find: 'and went back to his sums', replace: 'and went back to `sum(forces)`' }];
    const NOTE3 = ['# Pen position check', MP[0], MP[2], MP[3], MP[1]].join('\n\n') + '\n';
    const r = await penRun(NOTE3, ops);
    penChecks(r, 3, ops, out, fail);
    Object.assign(out, { typewriter: r.typewriter, drawing: r.drawing });
    if (!r.typewriter) fail('the typewriter was not seen');
    if (!r.drawing) fail('the note’s equation was not drawn');
    const one = await penRun(NOTE3, ops, { several: false });
    if (r.text !== one.text) fail('the note is not what one pen leaves');
  });

  // Opens MULTI with the cursor after `caret`, starts a run of THREE and resolves when three pens are out and writing.
  const beginThree = async caret => {
    plugin.settings.severalPens = true;
    plugin.settings.maxPens = 3;
    await leaf.openFile(file, { state: { mode: 'source', source: false } });
    leaf.view.editor.setValue(MULTI);
    await sleep(options.settle || 500);
    const ed = leaf.view.editor, cm = ed.cm;
    ed.focus();
    ed.setCursor(ed.offsetToPos(MULTI.indexOf(caret) + caret.length));
    await sleep(300);
    const parsed = L.parseAgentReply('```lagrange-edits\n' + JSON.stringify(THREE) + '\n```').ops;
    const now = L.locateOps(cm.state.doc.toString(), parsed);
    const run = plugin.applyEdits(leaf.view, now.located, now.skipped, null, null);
    let pens = 0;
    for (let i = 0; i < 900 && !(pensShown() >= 3 && document.querySelector('.lagrange-pen-seg.is-writing')); i++) { await frame(); pens = Math.max(pens, pensShown()); }
    return { ed, cm, run, pens: Math.max(pens, pensShown()) };
  };

  await extra('several pens: three pens, a key in the note: every pen stops, the note is as an uninterrupted run leaves it, then the key lands; one undo step', async (out, fail) => {
    const caret = 'says it briefly.';
    const { ed, cm, run, pens } = await beginThree(caret);
    out.pens = pens;
    if (pens !== 3) fail(`${pens} pens were out when the key was pressed, not 3`);
    cm.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'X', bubbles: true, cancelable: true }));
    if (cm.state.doc.toString() !== afterThree(MULTI)) fail('the note is not what an uninterrupted run leaves, right after the key');
    if (overlays() || penShown()) fail('a pen or its handwriting is still on the page right after the key');
    if (document.querySelector('[class*="lagrange-pen-revealing"]')) fail('the editor is still marked as showing a pen’s text');
    cm.dispatch(cm.state.replaceSelection('X'), { userEvent: 'input.type' });   // what the key then does
    const res = await run;
    await sleep(300);
    const want = afterThree(MULTI).replace(caret, caret + 'X');
    if (cm.state.doc.toString() !== want) fail('the key did not land at the cursor, after the edits');
    if (res.ended !== 'key' || res.applied.length !== 3 || res.skipped.length) fail(`the run reports ended=${res.ended}, ${res.applied.length} made, ${res.skipped.length} skipped`);
    const rec = plugin.edits[plugin.edits.length - 1];
    plugin.undoEdit(rec);
    await sleep(150);
    if (cm.state.doc.toString() !== MULTI.replace(caret, caret + 'X')) fail('Undo did not take back exactly the run');
    plugin.redoEdit(rec);
    await sleep(150);
    if (cm.state.doc.toString() !== want) fail('Redo did not make the run again');
    // and the editor's own undo: Lagrange's Redo, then its Undo, then the key, then the run, which is one step
    for (let i = 0; i < 4; i++) ed.undo();
    await sleep(150);
    if (cm.state.doc.toString() !== MULTI) fail('the run is not one step of the editor’s own undo');
    document.querySelectorAll('.notice').forEach(n => n.remove());
  });

  await extra('several pens: three pens, a click in the note: every pen stops, every edit is made, and the text under the pointer has not moved', async (out, fail) => {
    const { cm, run, pens } = await beginThree('# Pen position check');
    out.pens = pens;
    const word = 'says little';
    const at = cm.coordsAtPos(cm.state.doc.toString().indexOf(word) + 5, 1);
    if (!at) throw new Error('the word to click is not on screen');
    const x = at.left, y = (at.top + at.bottom) / 2, el = document.elementFromPoint(x, y) || cm.contentDOM;
    const init = { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: 1, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, isPrimary: true }, init)));
    if (cm.state.doc.toString() !== afterThree(MULTI)) fail('the note is not what an uninterrupted run leaves, right after the pointer went down');
    if (overlays() || penShown()) fail('a pen or its handwriting is still on the page right after the click');
    const under = cm.posAtCoords({ x, y });
    out.underPointer = cm.state.doc.toString().slice(under - 5, under + 6);
    if (out.underPointer !== word) fail(`the text under the pointer moved: now “${out.underPointer}”`);
    el.dispatchEvent(new MouseEvent('mousedown', init));
    el.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, init, { buttons: 0 })));
    const res = await run;
    await sleep(200);
    if (res.ended !== 'click' || res.applied.length !== 3) fail(`the run reports ended=${res.ended}, ${res.applied.length} made`);
    document.querySelectorAll('.notice').forEach(n => n.remove());
  });

  await extra('several pens: three pens and “Let me edit while the pen writes”: typing above them all goes in at once, the pens go on, and Undo takes back theirs alone', async (out, fail) => {
    plugin.settings.editWhileWriting = true;
    const { cm, run, pens } = await beginThree('says it briefly.');
    out.pens = pens;
    for (const ch of ' Typed meanwhile.') { cm.dispatch(cm.state.replaceSelection(ch), { userEvent: 'input.type' }); await sleep(30); }
    // and a line at the very top, so that every pen's text moves down under it
    cm.dispatch({ changes: { from: 0, to: 0, insert: 'A line typed at the very top.\n\n' }, userEvent: 'input.type' });
    await sleep(120);
    const stillWriting = Boolean(document.querySelector('.lagrange-pen-hand')) || penShown();
    const res = await run;
    await sleep(500);
    if (!stillWriting) fail('the pens stopped');
    if (res.ended) fail(`the run was ended (${res.ended})`);
    const typed = t => 'A line typed at the very top.\n\n' + t.replace('says it briefly.', 'says it briefly. Typed meanwhile.');
    if (cm.state.doc.toString() !== typed(afterThree(MULTI))) fail('the note does not hold both the typing and the three edits');
    if (res.applied.length !== 3 || res.skipped.length || !res.touched) fail(`the run reports ${res.applied.length} made, ${res.skipped.length} skipped, touched=${res.touched}`);
    if (overlays()) fail('the pens left a mark on the note');
    const rec = plugin.edits[plugin.edits.length - 1];
    plugin.undoEdit(rec);
    await sleep(150);
    if (cm.state.doc.toString() !== typed(MULTI)) fail('Undo did not take back exactly Lagrange’s edits');
    document.querySelectorAll('.notice').forEach(n => n.remove());
  });

  await extra('the chat’s log keeps to its bottom when a message is sent and while the loader shows', async (out, fail) => {
    plugin.settings.provider = 'demo';
    const chat = await plugin.activateView(false);
    if (!chat) throw new Error('the chat could not be opened');
    chat.clear();
    const log = chat.logEl, gap = () => log.scrollHeight - log.clientHeight - log.scrollTop;
    const say = async (text, during) => {
      const seen = { frames: 0, loader: 0, gap: 0, loaderOut: 0 };
      let on = true;
      const tick = () => {
        if (!on) return;
        seen.frames++;
        seen.gap = Math.max(seen.gap, gap());
        const l = log.querySelector('.lagrange-loader');
        if (l) { seen.loader++; const r = l.getBoundingClientRect(), b = log.getBoundingClientRect(); if (r.bottom > b.bottom + 1 || r.top < b.top - 1) seen.loaderOut++; }
        requestAnimationFrame(tick);
      };
      chat.inputEl.value = text;
      chat.send();
      seen.gap = gap();                                       // right after the send, before a frame is drawn
      requestAnimationFrame(tick);
      if (during) await during();
      for (let i = 0; i < 400 && (chat.pending || plugin.editing); i++) await sleep(50);
      await sleep(200);
      on = false;
      return seen;
    };
    for (const q of ['What is this note about?', 'And how long is it?', 'What does it say about energy?']) await say(q);
    if (log.scrollHeight <= log.clientHeight + 50) throw new Error('the log is not long enough to scroll; make the panel shorter');
    const a = await say('One more question, with the log full.');
    Object.assign(out, { loaderFrames: a.loader, gap: +a.gap.toFixed(1) });
    if (!a.loader) fail('no loader was seen');
    if (a.gap > 1) fail(`the log was ${a.gap.toFixed(0)} px short of its bottom after the send`);
    if (a.loaderOut) fail(`the loader was out of view in ${a.loaderOut} frames`);
    // a writer who scrolls up during a reply is left there; sending again takes hold of the bottom
    const up = await say('I scroll up while this one is answered.', async () => { await sleep(60); log.scrollTop = 0; log.dispatchEvent(new Event('scroll')); });
    if (log.scrollTop > 2) fail('a writer who scrolled up was pulled back down');
    const again = await say('And I send again.');
    out.gapAgain = +again.gap.toFixed(1);
    if (again.gap > 1 || gap() > 1) fail('sending a message did not take the log back to its bottom');
    chat.clear();
  });

  await extra('hovering Lagrange’s controls shows no bubble: tooltips are off for each of them (and a scripted hover shows none)', async (out, fail) => {
    const chat = await plugin.activateView(false);
    plugin.constructor.mountLoader(chat.logEl.createDiv({ cls: 'lagrange-loader-slot' }), 'orbit');
    chat.openPicker();
    await sleep(200);
    const hover = async el => {
      document.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await sleep(80);
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window }));
      await sleep(options.hover || 1300);
      const tip = document.querySelector('.tooltip');
      const text = tip ? tip.textContent : '';
      el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
      document.querySelectorAll('.tooltip').forEach(t => t.remove());
      return text;
    };
    const ribbon = document.querySelector('.side-dock-ribbon-action[aria-label]');
    out.control = ribbon ? await hover(ribbon) : '';
    // (Obsidian shows tooltips for scripted hovers only in some states of the window; when the ribbon icon shows
    // none, the hovering below proves nothing, and the check rests on --no-tooltip, which is what Obsidian reads)
    out.hoverTells = Boolean(out.control);
    const els = Array.from(chat.contentEl.querySelectorAll('[aria-label], button, input, label, .lagrange-loader')).filter(e => e.getBoundingClientRect().width > 0);
    out.controls = els.length;
    for (const el of els) {
      if (el.hasAttribute('title')) fail(`a title attribute on “${el.getAttribute('title')}”`);
      if (getComputedStyle(el).getPropertyValue('--no-tooltip').trim() !== 'true') fail(`Obsidian would show a tooltip over ${el.getAttribute('aria-label') || el.className}: its --no-tooltip is not true`);
      const text = out.hoverTells ? await hover(el) : '';
      if (text) fail(`a bubble “${text.slice(0, 40)}” over ${el.getAttribute('aria-label') || el.className}`);
    }
    if (!chat.contentEl.querySelectorAll('button[aria-label]').length) fail('the buttons lost their accessible names');
    chat.closePicker();
    chat.clear();
  });


  /* ---- Diagrams (TikZJax figures, Excalidraw drawings) and the loader's plates ---- */
  const figureCase = async (label, has, selector, makeText) => {
    await extra(`${label}: the pen draws it where the note has it, shapes first and labels last; a key ends it; Undo takes it out`, async (out, fail) => {
      if (!has()) { out.skipped = true; fail(`${label}: the plugin is not installed and enabled in this vault`); return; }
      const text = await makeText();
      const open = async () => {
        await leaf.openFile(file, { state: { mode: 'source', source: false } });
        leaf.view.editor.setValue(NOTE);
        await sleep(options.settle || 500);
        leaf.view.editor.setCursor(0, 0);
        const cm = leaf.view.editor.cm;
        const now = L.locateOps(cm.state.doc.toString(), L.parseAgentReply('```lagrange-edits\n' + JSON.stringify([{ insert_after: 'Short line here.', text }]) + '\n```').ops);
        return { cm, run: plugin.applyEdits(leaf.view, now.located, now.skipped, null, null) };
      };
      const shown = n => getComputedStyle(n).opacity !== '0';
      const parts = svg => Array.from(svg.querySelectorAll('path, line, polyline, polygon, rect, circle, ellipse, text')).filter(n => !n.closest('defs, mask, clipPath, marker, metadata') && (n.getBoundingClientRect().width > 0.3 || n.getBoundingClientRect().height > 0.3));
      // 1. a whole run
      let { cm, run } = await open();
      const seen = { early: 0, frames: 0, away: 0, order: 0, counts: [] };
      let on = true;
      const tick = () => {
        if (!on) return;
        for (const svg of cm.contentDOM.querySelectorAll(selector)) {
          // (before the pen has begun: once the run is over the note may draw the figure afresh, and then it simply shows)
          if (!seen.frames && !svg.hasAttribute('data-lagrange-seen') && shown(svg)) seen.early++;
          if (!svg.hasAttribute('data-lagrange-drawing')) continue;
          seen.frames++;
          const d = Number(svg.getAttribute('data-lagrange-drawn'));
          if (seen.counts[seen.counts.length - 1] !== d) seen.counts.push(d);
          const ps = parts(svg), shapesLeft = ps.some(n => n.tagName !== 'text' && !shown(n));
          if (shapesLeft && ps.filter(n => n.tagName === 'text').some(shown)) seen.order++;
          // the nib is on the figure (within its box, give or take the flight to the next part)
          const pen = Array.from(document.querySelectorAll('.lagrange-pen')).find(p => p.style.display !== 'none');
          const m = pen && /translate\(([-\d.]+)[ ,]+([-\d.]+)\)/.exec(pen.getAttribute('transform') || '');
          if (m) {
            const sheet = pen.closest('.lagrange-pen-sheet').getBoundingClientRect(), r = svg.getBoundingClientRect();
            const x = sheet.left + Number(m[1]), y = sheet.top + Number(m[2]);
            if (x < r.left - 60 || x > r.right + 60 || y < r.top - 60 || y > r.bottom + 60) seen.away++;
          }
        }
        setTimeout(() => requestAnimationFrame(tick), 0);
      };
      requestAnimationFrame(tick);
      let res = await run;
      await sleep(500);
      on = false;
      const svg = cm.contentDOM.querySelector(selector);
      Object.assign(out, { frames: seen.frames, parts: svg ? parts(svg).length : 0, counts: seen.counts.join(',') });
      if (!svg) fail('the note did not draw the diagram');
      if (seen.early) fail(`the diagram was visible before the pen drew it (${seen.early} frames)`);
      if (seen.frames < 10) fail('the pen did not draw the diagram');
      if (seen.order) fail(`a label was shown before the shapes were finished (${seen.order} frames)`);
      if (seen.away > seen.frames * 0.1) fail(`the nib was off the figure in ${seen.away} of ${seen.frames} frames`);
      if (seen.counts.some((c, i) => i && c !== seen.counts[i - 1] + 1)) fail(`the parts were not drawn one after another: ${seen.counts.join(',')}`);
      if (svg && (parts(svg).some(n => !shown(n)) || svg.querySelector('[style*="dash"]'))) fail('the pen left the figure half drawn');
      if (res.applied.length !== 1 || !cm.state.doc.toString().includes(text.trim())) fail('the note does not hold the diagram');
      if (cm.dom.classList.contains('lagrange-pen-figures')) fail('the editor is still marked as waiting for figures');
      // Undo takes it out again, in one step
      plugin.undoEdit(plugin.edits[plugin.edits.length - 1]);
      await sleep(300);
      if (cm.state.doc.toString() !== NOTE) fail('Undo did not take the diagram out');
      document.querySelectorAll('.notice').forEach(n => n.remove());
      // 2. a key while the pen draws: the figure is whole at once, and the run is over
      ({ cm, run } = await open());
      for (let i = 0; i < 1500 && !cm.contentDOM.querySelector(`${selector.split(',')[0].trim()}[data-lagrange-drawing], svg[data-lagrange-drawing]`); i++) await frame();
      for (let i = 0; i < 20; i++) await frame();
      cm.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'X', bubbles: true, cancelable: true }));
      // at once: nothing of a figure is hidden or half drawn (the note may be drawing it afresh at this moment, the
      // run's undo step having been made: then it is whole when it comes)
      const whole = () => Array.from(cm.contentDOM.querySelectorAll(selector)).every(g => shown(g) && !g.hasAttribute('data-lagrange-drawing') && !parts(g).some(n => !shown(n)) && !g.querySelector('[style*="dash"]'));
      if (!whole()) fail('right after a key a figure is hidden or half drawn');
      for (let i = 0; i < 300 && !cm.contentDOM.querySelector(selector); i++) await frame();
      if (!cm.contentDOM.querySelector(selector) || !whole()) fail('after a key the figure is not whole');
      if (cm.dom.classList.contains('lagrange-pen-figures')) fail('after a key the editor is still marked as waiting for figures');
      res = await run;
      if (res.ended !== 'key') fail(`the run reports ended=${res.ended}`);
      await sleep(300);
      document.querySelectorAll('.notice').forEach(n => n.remove());
    });
  };
  const has = id => Boolean(app.plugins.enabledPlugins.has(id) && app.plugins.plugins[id]);
  await figureCase('a TikZ figure', () => has('obsidian-tikzjax'), '.block-language-tikz svg',
    async () => '\n\n```tikz\n\\begin{document}\n\\begin{tikzpicture}\n\\draw (0,0) circle (1.5);\n\\draw[->, thick] (1.5,0) -- (1.5,1.4) node[right] {$v$};\n\\draw[dashed] (-2.2,0) -- (2.2,0);\n\\draw (0,0) -- (1.5,0) node[midway, below] {$r$};\n\\end{tikzpicture}\n\\end{document}\n```');
  await figureCase('an Excalidraw drawing', () => has('obsidian-excalidraw-plugin') && Boolean(window.ExcalidrawAutomate), '.excalidraw-embedded-img svg, svg.excalidraw-svg', async () => {
    let f = app.vault.getFiles().find(x => /Pen position sketch\.excalidraw/.test(x.path));
    if (!f) {
      const ea = window.ExcalidrawAutomate;
      ea.reset();
      ea.addEllipse(0, 20, 90, 90); ea.addEllipse(300, 45, 40, 40); ea.addArrow([[95, 65], [295, 65]]); ea.addText(28, 55, 'M'); ea.addText(170, 30, 'r');
      await ea.create({ filename: 'Pen position sketch', foldername: '', onNewPane: false, silent: true });
      for (let i = 0; i < 40 && !f; i++) { await sleep(100); f = app.vault.getFiles().find(x => /Pen position sketch\.excalidraw/.test(x.path)); }
    }
    return `\n\n![[${f.path.replace(/\.md$/, '')}]]`;
  });

  await extra('the loader’s plates come in turn: three sends show three different plates', async (out, fail) => {
    const was = plugin.settings.loaderTheme;
    plugin.settings.loaderTheme = 'cycle';
    plugin.settings.provider = 'demo';
    const chat = await plugin.activateView(false);
    chat.clear();
    const plates = [];
    for (const q of ['What is this note about?', 'And how long is it?', 'What does it say about energy?', 'And once more?']) {
      chat.inputEl.value = q;
      chat.send();
      const l = chat.logEl.querySelector('.lagrange-loader');
      plates.push(l ? (/lagrange-loader--(\w+)/.exec(l.className) || [])[1] : null);
      for (let i = 0; i < 400 && (chat.pending || plugin.editing); i++) await sleep(50);
      await sleep(150);
    }
    out.plates = plates.join(',');
    if (plates.some(p => !p)) fail('a send showed no loader');
    if (new Set(plates.slice(0, 3)).size !== 3) fail(`three sends in a row showed ${plates.slice(0, 3).join(', ')}`);
    if (plates[3] !== plates[0]) fail(`the fourth send showed ${plates[3]}, not the first plate again (${plates[0]})`);
    plugin.settings.loaderTheme = was;
    chat.clear();
  });

  await setPanel(PANEL);
  plugin.settings.penSpeed = saved.speed;
  plugin.settings.severalPens = saved.several;
  plugin.settings.maxPens = saved.max;
  plugin.settings.editWhileWriting = saved.concurrent;
  plugin.settings.provider = saved.provider;
  plugin.settings.showPen = saved.pen;
  try {
    if (layout.bounds) { require('@electron/remote').getCurrentWindow().setBounds(layout.bounds); require('electron').webFrame.setZoomFactor(layout.zoom || 1); }
    if (layout.width) ws.rightSplit.setSize(layout.width);
    if (layout.right) ws.rightSplit.collapse();
    if (!layout.left) ws.leftSplit.expand();
  } catch (e) { /* left as the harness set it */ }
  if (!options.keepNote) { try { await leaf.openFile(file, { state: { mode: 'source', source: false } }); leaf.view.editor.setValue(NOTE); await sleep(300); await app.vault.delete(file); } catch (e) { /* left in the vault */ } }
  try { console.table(results); } catch (e) { /* no console table */ }
  const failed = results.filter(r => !r.ok).length;
  return JSON.stringify({ ok: failed === 0, failed, cases: results });
})()
