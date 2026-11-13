// Where the pen writes, checked in a real Obsidian: for each kind of edit, Lagrange's pen must begin its handwriting
// where the first letter of the new text stands in the note (left edge and baseline, within 2 px, on every frame but
// for a reflow of at most three frames, which is counted), start
// each further line at the left edge of the note's own line, and draw each equation that Live Preview typesets on that
// very equation. Since 1.2.4 it also checks, in every case, that the handwriting of a line is never seen before the pen
// comes to it, that no letter is cut by the box that uncovers it (ascenders, descenders and swashes included), that
// the note does not scroll when the run ends and the last text written is in view; and, in cases of their own, that
// the handwriting stays on its text while the note is scrolled, that a click or a key in the note ends the run with
// the note exactly as an uninterrupted run would leave it (plus the key), that with "Let me edit while the pen writes"
// the writer's typing and Lagrange's edits both stand, that the chat's log keeps to its bottom while the loader
// shows, and that hovering Lagrange's controls shows no bubble. This cannot run under Node (it needs Obsidian's editor and its layout), so it is not part of
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
    { name: 'three edits far apart: the view at the end is the view that was watched', ops: [
      { find: 'Short line here.', replace: 'Short sentence here.' }, { find: 'mentions energy once', replace: 'speaks of energy only the one time' }, { append: 'An appended closing remark.' }] },
    { name: 'Reading view: equation', mode: 'reading', ops: [{ find: 'Momentum is conserved.', replace: 'Momentum is conserved: $p = mv$.' }], math: 1 },
  ];

  const path = 'Pen position check.md';
  let file = app.vault.getAbstractFileByPath(path);
  if (!file) file = await app.vault.create(path, NOTE);
  const leaf = app.workspace.getLeavesOfType('markdown')[0] || app.workspace.getLeaf(true);
  const saved = { speed: plugin.settings.penSpeed, pen: plugin.settings.showPen, concurrent: plugin.settings.editWhileWriting, provider: plugin.settings.provider, trail: plugin.settings.penTrail };
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
  // The left edge of each line of handwriting after the first.
  const handLines = hand => {
    const lefts = new Map();
    for (const span of hand.children) {
      if (span.classList.contains('lagrange-pen-base')) continue;
      for (const r of span.getClientRects()) {
        if (r.width < 1) continue;
        const key = Math.round((r.top + r.bottom) / 2 / 4);
        lefts.set(key, Math.min(lefts.has(key) ? lefts.get(key) : Infinity, r.left));
      }
    }
    return Array.from(lefts.entries()).sort((a, b) => a[0] - b[0]).map(e => e[1]);
  };

  const results = [];
  for (const c of cases) {
    if (options.only && !c.name.includes(options.only)) continue;
    const text = c.note != null ? c.note : NOTE;
    const mode = c.mode || 'live';
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
      const seen = { frames: 0, dx: 0, dy: 0, lineDx: 0, lines: 0, hands: 0, drawn: new Map(), unmatchedFrames: 0, early: 0, clipped: 0, clipWhy: '', segs: 0, scrolled: 0, tops: [], inked: new WeakSet(), cutWord: '' };
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
            if (lefts.length > 1) {
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
      Object.assign(out, { frames: seen.frames, dx: +seen.dx.toFixed(2), dy: +seen.dy.toFixed(2), lines: seen.lines, lineDx: +seen.lineDx.toFixed(2), equations: drawn, mathDx: +mdx.toFixed(2), mathSize: +(mdsize * 100).toFixed(2) });
      if (expectText && !seen.frames && !c.loose) fail('no handwriting was seen');
      if (seen.dx > TOL) fail(`the handwriting begins ${seen.dx.toFixed(1)} px to the side of the text's first letter`);
      if (seen.dy > TOL) fail(`the handwriting's baseline is ${seen.dy.toFixed(1)} px off the text's`);
      if (seen.lineDx > TOL) fail(`a later line of handwriting starts ${seen.lineDx.toFixed(1)} px from the note line's left edge`);
      if (c.lines && seen.lines < c.lines) fail(`the pen wrote ${seen.lines} line(s), not ${c.lines}`);
      if (c.math != null && !c.loose && drawn !== c.math) fail(`the pen drew on ${drawn} of the note's equations, not ${c.math}`);
      if (mdx > TOL) fail(`an equation was drawn ${mdx.toFixed(1)} px from where it rests`);
      if (mdsize > 0.02) fail(`an equation was drawn ${(mdsize * 100).toFixed(1)}% off its final size`);
      for (const o of c.ops) {
        const want = o.replace != null ? o.replace : o.text != null ? o.text : o.append;
        if (!c.loose && !cm.state.doc.toString().includes(want)) fail('the note does not hold the new text');
      }
      if (document.querySelector('.lagrange-pen-unwritten, .lagrange-pen-revealing, .lagrange-pen-drawing')) fail('the pen left a mark on the note');
      // one line at a time, and no letter cut
      Object.assign(out, { segs: seen.segs, early: seen.early, clipped: seen.clipped, reflowFrames: seen.reflow || 0 });
      if (seen.early) fail(`a later line of handwriting was visible before the pen came to it (in ${seen.early} frames)`);
      if (seen.clipped) fail(`a letter is cut: ${seen.clipWhy}`);
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

  plugin.settings.penSpeed = saved.speed;
  plugin.settings.editWhileWriting = saved.concurrent;
  plugin.settings.provider = saved.provider;
  plugin.settings.showPen = saved.pen;
  if (!options.keepNote) { try { await leaf.openFile(file, { state: { mode: 'source', source: false } }); leaf.view.editor.setValue(NOTE); await sleep(300); await app.vault.delete(file); } catch (e) { /* left in the vault */ } }
  try { console.table(results); } catch (e) { /* no console table */ }
  const failed = results.filter(r => !r.ok).length;
  return JSON.stringify({ ok: failed === 0, failed, cases: results });
})()
