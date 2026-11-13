// Where the pen writes, checked in a real Obsidian: for each kind of edit, Lagrange's pen must begin its handwriting
// where the first letter of the new text stands in the note (left edge and baseline, within 2 px, on every frame), start
// each further line at the left edge of the note's own line, and draw each equation that Live Preview typesets on that
// very equation. This cannot run under Node (it needs Obsidian's editor and its layout), so it is not part of
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
    { name: 'Reading view: equation', mode: 'reading', ops: [{ find: 'Momentum is conserved.', replace: 'Momentum is conserved: $p = mv$.' }], math: 1 },
  ];

  const path = 'Pen position check.md';
  let file = app.vault.getAbstractFileByPath(path);
  if (!file) file = await app.vault.create(path, NOTE);
  const leaf = app.workspace.getLeavesOfType('markdown')[0] || app.workspace.getLeaf(true);
  const saved = { speed: plugin.settings.penSpeed, pen: plugin.settings.showPen };
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
    const node = first.firstChild;
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
      const seen = { frames: 0, dx: 0, dy: 0, lineDx: 0, lines: 0, hands: 0, drawn: new Map(), unmatchedFrames: 0 };
      let sampling = true, handNo = -1, lastHand = null;
      const sample = () => {
        if (!sampling) return;
        const cm = leaf.view.editor && leaf.view.editor.cm;
        const hand = Array.from(document.querySelectorAll('.lagrange-pen-hand')).find(h => getComputedStyle(h).opacity === '1');
        if (hand && cm) {
          if (hand !== lastHand) { lastHand = hand; handNo++; seen.hands++; }
          const h = handStart(hand), g = glyphAt(cm, starts[Math.min(handNo, starts.length - 1)]);
          if (h && g) {
            seen.frames++;
            seen.dx = Math.max(seen.dx, Math.abs(h.x - g.x));
            seen.dy = Math.max(seen.dy, Math.abs(h.baseline - g.baseline));
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
        }
        for (const el of document.querySelectorAll('.lagrange-pen-drawing')) {
          const r = el.getBoundingClientRect(), scroll = cm ? cm.scrollDOM.scrollTop : 0;
          if (!seen.drawn.has(el)) seen.drawn.set(el, []);
          seen.drawn.get(el).push({ x: r.left, y: r.top + scroll, w: r.width, h: r.height, inNote: Boolean(cm && cm.contentDOM.contains(el)) });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      const view = leaf.view;
      await plugin.ensureEditing(view);
      const cm = view.editor.cm;
      const now = L.locateOps(cm.state.doc.toString(), ops);
      await plugin.applyEdits(view, now.located, now.skipped, null, null);
      await sleep(700);
      sampling = false;
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
          const r = now.getBoundingClientRect(), d = Math.hypot(r.left - last.x, r.top + cm.scrollDOM.scrollTop - last.y);
          if (d < best) { best = d; rest = { x: r.left, y: r.top + cm.scrollDOM.scrollTop, w: r.width, h: r.height }; }
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
    } catch (e) {
      fail(String((e && e.message) || e));
    }
    out.why = out.why.join('; ');
    results.push(out);
    console.log(`${out.ok ? 'ok  ' : 'FAIL'} ${out.name}${out.why ? ': ' + out.why : ''}`);
  }
  plugin.settings.penSpeed = saved.speed;
  plugin.settings.showPen = saved.pen;
  if (!options.keepNote) { try { await leaf.openFile(file, { state: { mode: 'source', source: false } }); leaf.view.editor.setValue(NOTE); await sleep(300); await app.vault.delete(file); } catch (e) { /* left in the vault */ } }
  try { console.table(results); } catch (e) { /* no console table */ }
  const failed = results.filter(r => !r.ok).length;
  return JSON.stringify({ ok: failed === 0, failed, cases: results });
})()
