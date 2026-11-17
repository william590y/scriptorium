// Lagrange's diagrams (1.5.0), checked in a real Obsidian: the pen draws a Mermaid diagram it writes into the note,
// piece by piece as one would by hand (a flowchart grows from its first node: each node, then each edge that leaves
// it with its label, then the node it reaches), and the diagram is unseen until the pen comes to it and whole when
// it has gone; one Undo takes it back. A reply that brings a Mermaid diagram into the chat has it draw itself in
// ink, in the same order (not in the list of edits, which shows it whole). "Draw the diagram again" has the pen draw
// a Mermaid, TikZ or Excalidraw diagram the note already shows (an Excalidraw drawing element by element, in the
// drawing's own order), and Escape shows it whole at once. "Turn this Mermaid diagram into an Excalidraw drawing"
// makes a hand-drawn drawing of the diagram (its boxes, diamond, rounds, arrows and words), puts its embed where the
// block was with the pen, and one Undo brings the block back; the demo's "draw a sketch" makes one from Mermaid too.
// A Mermaid block Obsidian cannot read does not keep the pen waiting, and the chat says so. The model is told about
// Mermaid. With reduced motion nothing moves.
//
// This cannot run under Node (it needs Obsidian, its Mermaid renderer and the plugins), so it is not part of
// `node --test`. To run it:
//   1. start the mock server:  node plugins-tests/mock-chat-server.mjs 48914
//   2. open a Scriptorium vault in Obsidian with Lagrange on, and Excalidraw (and TikZJax, for the TikZ case) on;
//   3. paste this file into the developer console, or evaluate it with Runtime.evaluate (awaitPromise: true).
// It answers with a JSON string {ok, failed, cases: [{name, ok, why}], info} and prints a table. Options, set
// first: window.diagramsOptions = {server: 'http://127.0.0.1:48914', only: 'text in a case name'}. It sets
// Lagrange to demo mode or to the server for the run and puts the settings back afterwards; the notes it writes are
// in a folder "Lagrange diagrams harness" (removed at the end, with the drawings it made).
//
// Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).
(async () => {
  const opt = window.diagramsOptions || {};
  const server = String(opt.server || 'http://127.0.0.1:48914').replace(/\/+$/, '');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const plugin = app.plugins.plugins.lagrange;
  const I = plugin.constructor.internals;
  const cases = [], info = [];
  const has = id => app.plugins.enabledPlugins.has(id) && Boolean(app.plugins.plugins[id]);
  const DIR = 'Lagrange diagrams harness';
  const saved = Object.assign({}, plugin.settings), savedSession = plugin.session;
  const savedMatch = window.matchMedia;
  document.querySelectorAll('.modal-container').forEach(m => m.remove());
  if (!app.vault.getAbstractFileByPath(DIR)) await app.vault.createFolder(DIR);
  app.workspace.rightSplit.expand();
  await plugin.activateView(false);
  const chat = () => app.workspace.getLeavesOfType('lagrange-chat')[0].view;
  const until = async (fn, ms) => { for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (fn()) return true; await sleep(60); } return Boolean(fn()); };
  const queue = async replies => {
    const r = await fetch(`${server}/__queue`, { method: 'POST', body: JSON.stringify(replies.map(t => (typeof t === 'string' ? { text: t, chunk: 60, delay: 3, first: 120 } : t))) });
    if (!r.ok) throw new Error(`the mock server did not take the replies (${r.status})`);
  };
  const requests = async () => (await fetch(`${server}/__requests`)).json();
  const useDemo = () => Object.assign(plugin.settings, { provider: 'demo', agenticEdits: true, showPen: true, penSpeed: 3, editWhileWriting: false, severalPens: false });
  const useServer = () => Object.assign(plugin.settings, { provider: 'openai', openaiBaseUrl: `${server}/v1`, openaiModel: 'llava-mock', openaiApiKey: '', agenticEdits: true, showPen: true, penSpeed: 3, editWhileWriting: false, severalPens: false });
  plugin.session = { noFallback: false, noEffort: {}, noPictures: {} };
  // a note of the harness's own, open in Live Preview in the main pane, with the cursor at its start
  const open = async (name, text) => {
    const path = `${DIR}/${name}.md`;
    let f = app.vault.getAbstractFileByPath(path);
    if (f) await app.vault.modify(f, text); else f = await app.vault.create(path, text);
    const leaf = app.workspace.getLeavesOfType('markdown')[0] || app.workspace.getLeaf(false);
    await leaf.openFile(f, { state: { mode: 'source', source: false } });
    app.workspace.setActiveLeaf(leaf, { focus: true });
    await sleep(700);
    const v = leaf.view;
    v.editor.cm.dispatch({ selection: { anchor: 0 } });
    await sleep(500);
    return v;
  };
  const send = async text => {
    const c = chat();
    c.inputEl.value = text;
    const p = c.send();
    return p;
  };
  const settle = async () => { for (let i = 0; i < 800 && (chat().pending || plugin.editing); i++) await sleep(50); await sleep(300); };
  const PARTS = 'path, line, polyline, polygon, rect, circle, ellipse, text, foreignObject, image';
  const partsOf = svg => Array.from(svg.querySelectorAll(PARTS)).filter(n => !n.closest('defs, mask, clipPath, marker, metadata, pattern, symbol') && !(n.tagName.toLowerCase() !== 'text' && n.closest('text')));
  const shown = n => { let e = n; while (e && e.nodeType === 1) { if (getComputedStyle(e).opacity === '0') return false; e = e.parentElement; } return true; };
  const desc = n => { const g = n.closest('[data-id]'); return `${n.tagName.toLowerCase()}:${g ? g.getAttribute('data-id') : '-'}`; };
  // Watches the svgs fn finds, at every frame while body() runs: the order their parts first show in (while the svg
  // is being drawn), whether one was ever seen whole before the drawing began, and the most parts seen at once.
  const watch = async (find, body) => {
    const log = { order: [], early: false, partial: false, drawing: false, frames: 0, pen: false };
    const first = new Set();
    let on = true;
    const look = () => {
      if (!on) return;
      log.frames++;
      const pen = document.querySelector('.lagrange-pen');
      if (pen && pen.style.display !== 'none' && pen.getBoundingClientRect().width > 0) log.pen = true;
      for (const svg of find()) {
        const parts = partsOf(svg), vis = parts.filter(shown);
        const drawing = svg.hasAttribute('data-lagrange-drawing');
        if (drawing) log.drawing = true;
        if (!drawing && !log.drawing && vis.length && vis.length === parts.length && !svg.hasAttribute('data-lagrange-seen') && log.watchEarly) log.early = true;
        if (drawing && vis.length > 0 && vis.length < parts.length) log.partial = true;
        if (drawing) for (const n of vis) if (!first.has(n)) { first.add(n); log.order.push(desc(n)); }
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
    try { await body(log); } finally { on = false; }
    return log;
  };
  // every part shown, with no style of the pen's left on it
  const whole = svg => {
    const parts = partsOf(svg), hidden = parts.filter(n => !shown(n)).length;
    const styled = parts.filter(n => ['opacity', 'clip-path', 'stroke-dasharray', 'stroke-dashoffset', 'fill-opacity'].some(p => n.style.getPropertyValue(p))).length;
    const bad = [];
    if (hidden) bad.push(`${hidden} of ${parts.length} parts are still unseen`);
    if (styled) bad.push(`${styled} parts keep a style of the drawing`);
    if (svg.hasAttribute('data-lagrange-drawing')) bad.push('the svg is still marked as being drawn');
    return bad;
  };
  const run = async (name, fn) => {
    if (opt.only && !name.includes(opt.only)) return;
    const c = { name, ok: false, why: '' };
    try {
      chat().clear();
      const why = await fn();
      c.ok = !why;
      c.why = why || '';
    } catch (e) { c.why = `threw: ${String((e && e.stack) || e).slice(0, 400)}`; }
    plugin.pen.finish();
    window.matchMedia = savedMatch;
    cases.push(c);
  };
  const made = [];          // drawings the harness made, removed at the end
  const drawingsNow = () => app.vault.getFiles().filter(f => /\.excalidraw\.md$/.test(f.path)).map(f => f.path);

  const FLOW_EXPECTED = ['circle:S', 'text:S', 'path:L_S_B_0', 'path:L_S_B_0', 'rect:L_S_B_0', 'text:L_S_B_0', 'rect:B', 'text:B',
    'path:L_B_Q_0', 'path:L_B_Q_0', 'polygon:Q', 'text:Q', 'path:L_Q_R_0', 'path:L_Q_R_0', 'rect:L_Q_R_0', 'text:L_Q_R_0', 'rect:R', 'text:R',
    'path:L_Q_D_0', 'path:L_Q_D_0', 'rect:L_Q_D_0', 'text:L_Q_D_0', 'rect:D', 'text:D', 'circle:E', 'text:E', 'path:L_E_B_0', 'path:L_E_B_0', 'rect:L_E_B_0', 'text:L_E_B_0'];

  await run('the pen draws a Mermaid flowchart it writes (demo: "draw a flowchart"): unseen until the pen comes, piece by piece from the first node, whole after, one undo', async () => {
    useDemo();
    const v = await open('Flow', '# Flow\n\nA paragraph about the Lagrange points, for the pen to write after.\n');
    const cm = v.editor.cm, before = cm.state.doc.toString();
    const find = () => Array.from(cm.contentDOM.querySelectorAll('.mermaid > svg'));
    const t0 = Date.now();
    const log = await watch(find, async l => { l.watchEarly = true; await send('Draw a flowchart'); await settle(); });
    info.push(`flowchart: drawn in ${((Date.now() - t0) / 1000).toFixed(1)} s at speed 3, ${log.frames} frames watched`);
    const bad = [];
    const svg = find()[0];
    if (!svg) return 'no Mermaid diagram in the note';
    if (!cm.state.doc.toString().includes(I.DEMO_MERMAID)) bad.push('the note does not hold the demo’s Mermaid block');
    if (!log.pen) bad.push('the pen was never seen');
    if (!log.drawing || !log.partial) bad.push('the diagram was never seen part drawn');
    if (log.early) bad.push('the diagram was seen whole before the pen drew it');
    if (log.order.join(',') !== FLOW_EXPECTED.join(',')) bad.push(`drawn in the order ${log.order.join(' ')}`);
    bad.push(...whole(svg));
    v.editor.undo();
    await sleep(400);
    if (cm.state.doc.toString() !== before) bad.push('one undo does not take the diagram back out');
    return bad.join('; ');
  });

  await run('a reply that brings a Mermaid diagram into the chat draws it in ink, in the same order; the list of edits shows it whole', async () => {
    useServer();
    await open('Chat ink', '# Chat ink\n\nWords.\n');
    const md = I.DEMO_MERMAID;
    await queue([`Here is the flow:\n\n${md}\n\nThat is it.`, `I add it to the note.\n\n\`\`\`lagrange-edits\n${JSON.stringify([{ append: md }])}\n\`\`\``]);
    const find = () => Array.from(chat().logEl.querySelectorAll('.lagrange-turn--reply .lagrange-turn-body .mermaid > svg'));
    const log = await watch(find, async () => { await send('Show me the flow'); await settle(); await sleep(2200); });
    const bad = [];
    const svg = find()[0];
    if (!svg) return 'no diagram in the reply';
    if (!svg.hasAttribute('data-lagrange-inked')) bad.push('the diagram was not inked');
    if (!log.partial) bad.push('the diagram was never seen part drawn');
    if (log.order.join(',') !== FLOW_EXPECTED.join(',')) bad.push(`inked in the order ${log.order.join(' ')}`);
    bad.push(...whole(svg));
    // the second reply edits the note: its edit list holds the diagram, which is not inked
    await send('Put it in the note');
    await settle();
    await sleep(1500);
    const listed = chat().logEl.querySelector('.lagrange-turn--reply:last-of-type .lagrange-edit-md .mermaid > svg');
    if (!listed) bad.push('the list of edits does not show the diagram');
    else if (listed.hasAttribute('data-lagrange-inked')) bad.push('the diagram in the list of edits was inked');
    const reqs = await requests();
    const sys = JSON.stringify(reqs[0] || '');
    if (!/```mermaid/.test(sys) || !/Obsidian draws itself, with no plugin/.test(sys)) bad.push('the model was not told about Mermaid');
    return bad.join('; ');
  });

  await run('"Draw the diagram again": the pen draws the Mermaid diagram nearest the cursor in the same order; Escape shows it whole at once', async () => {
    const v = await open('Again', `# Again\n\nWords before.\n\n${I.DEMO_MERMAID}\n\nWords after.\n`);
    const cm = v.editor.cm;
    await until(() => cm.contentDOM.querySelector('.mermaid > svg'), 4000);
    const find = () => Array.from(cm.contentDOM.querySelectorAll('.mermaid > svg'));
    const log = await watch(find, async () => { await plugin.redrawDiagram(v); });
    const bad = [];
    const svg = find()[0];
    if (!log.pen) bad.push('the pen was never seen');
    if (!log.partial) bad.push('never part drawn');
    if (log.order.join(',') !== FLOW_EXPECTED.join(',')) bad.push(`drawn in the order ${log.order.join(' ')}`);
    bad.push(...whole(svg));
    // again, stopped by Escape a moment in
    const p = plugin.redrawDiagram(v);
    await until(() => svg.hasAttribute('data-lagrange-drawing'), 3000);
    await sleep(500);
    const midway = partsOf(svg).filter(n => !shown(n)).length;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await p;
    await sleep(150);
    if (!midway) bad.push('nothing was unseen a moment into the second drawing');
    bad.push(...whole(svg).map(w => `after Escape: ${w}`));
    const pen = document.querySelector('.lagrange-pen');
    if (pen && pen.style.display !== 'none') bad.push('the pen is still out after Escape');
    return bad.join('; ');
  });

  await run('"Draw the diagram again" draws an Excalidraw drawing element by element, in the drawing’s own order, and a TikZ figure', async () => {
    if (!has('obsidian-excalidraw-plugin') || !window.ExcalidrawAutomate) return 'Excalidraw is not on in this vault';
    const ea = window.ExcalidrawAutomate;
    ea.reset();
    ea.addRect(0, 0, 140, 60); ea.addText(30, 18, 'First');
    ea.addArrow([[140, 30], [240, 30]]);
    ea.addEllipse(240, 0, 120, 60); ea.addText(270, 18, 'Second');
    const name = `Harness order ${Date.now() % 100000}`;
    made.push(await ea.create({ filename: name, foldername: DIR, onNewPane: false, silent: true }));
    const tikz = has('obsidian-tikzjax') ? '\n\n```tikz\n\\begin{document}\n\\begin{tikzpicture}\n\\draw (0,0) -- (2,0) -- (1,1.5) -- cycle;\n\\node at (1,0.5) {T};\n\\end{tikzpicture}\n\\end{document}\n```' : '';
    const v = await open('Sketch again', `# Sketch again\n\nWords.\n\n![[${name}.excalidraw]]${tikz}\n\nWords after.\n`);
    const cm = v.editor.cm;
    await until(() => cm.contentDOM.querySelector('.excalidraw-embedded-img svg, svg.excalidraw-svg'), 8000);
    await sleep(800);
    const sk = () => Array.from(cm.contentDOM.querySelectorAll('.excalidraw-embedded-img svg, svg.excalidraw-svg'));
    const svg = sk()[0];
    if (!svg) return 'the drawing is not shown in the note';
    const dom = partsOf(svg).filter(n => { const r = n.getBoundingClientRect(); return (r.width > 0.3 || r.height > 0.3) && !(n.parentElement === svg && n.tagName.toLowerCase() === 'rect'); });
    cm.dispatch({ selection: { anchor: cm.state.doc.toString().indexOf('Words.') } });
    const seen = [];
    const log = await watch(sk, async () => {
      const p = plugin.redrawDiagram(v);
      const firstSeen = new Set();
      while (true) {
        const done = await Promise.race([p.then(() => true), sleep(20).then(() => false)]);
        for (const n of dom) if (shown(n) && svg.hasAttribute('data-lagrange-drawing') && !firstSeen.has(n)) { firstSeen.add(n); seen.push(dom.indexOf(n)); }
        if (done) break;
      }
    });
    const bad = [];
    if (!log.partial) bad.push('the drawing was never seen part drawn');
    const sorted = seen.slice().sort((a, b) => a - b);
    if (seen.join(',') !== sorted.join(',')) bad.push(`its elements were drawn out of their order: ${seen.join(' ')}`);
    if (seen.length < dom.length - 1) bad.push(`only ${seen.length} of ${dom.length} parts were seen being drawn`);
    bad.push(...whole(svg));
    const bg = svg.querySelector(':scope > rect');
    if (bg && !shown(bg)) bad.push('the drawing’s paper was hidden');
    if (tikz) {
      const t = () => Array.from(cm.contentDOM.querySelectorAll('.block-language-tikz svg'));
      await until(() => t().length, 15000);
      if (!t().length) bad.push('the TikZ figure was not drawn by TikZJax');
      else {
        cm.dispatch({ selection: { anchor: cm.state.doc.toString().indexOf('Words after') } });
        t()[0].scrollIntoView({ block: 'center' });
        await sleep(400);
        const tl = await watch(t, async () => { await plugin.redrawDiagram(v); });
        if (!tl.partial) bad.push('the TikZ figure was never seen part drawn');
        bad.push(...whole(t()[0]).map(w => `TikZ: ${w}`));
      }
    } else info.push('TikZJax is off: the TikZ part of the redraw case was not run');
    return bad.join('; ');
  });

  await run('"Turn this Mermaid diagram into an Excalidraw drawing": a hand-drawn drawing of it, its embed put in by the pen, one undo brings the block back', async () => {
    if (!has('obsidian-excalidraw-plugin') || !window.ExcalidrawAutomate) return 'Excalidraw is not on in this vault';
    useDemo();
    const text = `# Convert\n\nWords before.\n\n${I.DEMO_MERMAID}\n\nWords after.\n`;
    const v = await open('Convert', text);
    const cm = v.editor.cm;
    await until(() => cm.contentDOM.querySelector('.mermaid > svg'), 4000);
    cm.dispatch({ selection: { anchor: text.indexOf('Words after') } });
    const was = new Set(drawingsNow());
    const sk = () => Array.from(cm.contentDOM.querySelectorAll('.excalidraw-embedded-img svg, svg.excalidraw-svg'));
    const log = await watch(sk, async () => { await plugin.mermaidToSketch(v); await sleep(600); });
    const bad = [];
    const fresh = drawingsNow().filter(p => !was.has(p));
    made.push(...fresh);
    if (fresh.length !== 1) return `${fresh.length} drawings were made`;
    const doc = cm.state.doc.toString();
    const name = fresh[0].split('/').pop().replace(/\.excalidraw\.md$/, '');
    if (!doc.includes(`![[${name}.excalidraw]]`)) bad.push('the note does not embed the drawing');
    if (doc.includes('```mermaid')) bad.push('the Mermaid block is still in the note');
    if (!log.drawing || !log.pen) bad.push('the pen did not draw the drawing');
    const scene = await window.ExcalidrawAutomate.getSceneFromFile(app.vault.getAbstractFileByPath(fresh[0]));
    const els = scene.elements.filter(e => !e.isDeleted);
    const count = t => els.filter(e => e.type === t).length;
    const words = els.filter(e => e.type === 'text').map(e => e.text).join(' | ');
    info.push(`drawing: ${els.length} elements: ${['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'text'].map(t => `${count(t)} ${t}`).join(', ')}`);
    if (count('rectangle') < 3) bad.push(`${count('rectangle')} rectangles (3 boxes and 3 label boxes expected)`);
    if (count('diamond') !== 1) bad.push(`${count('diamond')} diamonds`);
    if (count('ellipse') !== 2) bad.push(`${count('ellipse')} ellipses`);
    if (count('arrow') !== 5) bad.push(`${count('arrow')} arrows`);
    for (const w of ['Sun', 'Earth', 'Small body', 'It rests at L1', 'It drifts away', 'pull', 'yes', 'no']) if (!words.split(' | ').includes(w)) bad.push(`no text “${w}”`);
    // each word is inside the box it labels: "Small body" within node B's rectangle
    const sb = els.find(e => e.type === 'text' && e.text === 'Small body');
    const box = sb && els.find(e => e.type === 'rectangle' && sb.x >= e.x - 2 && sb.y >= e.y - 2 && sb.x + sb.width <= e.x + e.width + 2 && sb.y + sb.height <= e.y + e.height + 2);
    if (!box) bad.push('“Small body” does not sit inside a box');
    v.editor.undo();
    await sleep(400);
    if (cm.state.doc.toString() !== text) bad.push('one undo does not bring the Mermaid block back');
    return bad.join('; ');
  });

  await run('demo: "draw a sketch" makes a hand-drawn drawing from Mermaid, embeds it and the pen draws it', async () => {
    if (!has('obsidian-excalidraw-plugin') || !window.ExcalidrawAutomate) return 'Excalidraw is not on in this vault';
    useDemo();
    const v = await open('Demo sketch', '# Demo sketch\n\nWords.\n');
    const cm = v.editor.cm;
    const was = new Set(drawingsNow());
    const sk = () => Array.from(cm.contentDOM.querySelectorAll('.excalidraw-embedded-img svg, svg.excalidraw-svg'));
    const log = await watch(sk, async () => { await send('Draw a sketch'); await settle(); });
    const fresh = drawingsNow().filter(p => !was.has(p));
    made.push(...fresh);
    const bad = [];
    if (fresh.length !== 1 || !/Balance at L1/.test(fresh[0] || '')) bad.push(`drawings made: ${fresh.join(', ') || 'none'}`);
    if (!/!\[\[Balance at L1[^\]]*\.excalidraw\]\]/.test(cm.state.doc.toString())) bad.push('the note does not embed it');
    if (!log.drawing) bad.push('the pen did not draw it');
    const notes = Array.from(chat().logEl.querySelectorAll('.lagrange-turn-note')).map(n => n.textContent);
    if (!notes.some(t => /made the drawing “Balance at L1/.test(t))) bad.push('the chat does not say the drawing was made');
    const sv = sk()[0];
    if (sv) bad.push(...whole(sv));
    return bad.join('; ');
  });

  await run('a Mermaid block Obsidian cannot read: the pen does not wait for it, and the chat says so', async () => {
    useServer();
    const v = await open('Broken', '# Broken\n\nWords.\n');
    const cm = v.editor.cm;
    await queue([`Here.\n\n\`\`\`lagrange-edits\n${JSON.stringify([{ append: '```mermaid\nflowchart LR\n  A[ --> ]] B(((\n```' }])}\n\`\`\``]);
    const t0 = Date.now();
    await send('Add a broken diagram');
    await settle();
    const took = Date.now() - t0;
    await sleep(2500);
    const bad = [];
    const notes = Array.from(chat().logEl.querySelectorAll('.lagrange-turn-note')).map(n => n.textContent);
    info.push(`a broken Mermaid block: the request took ${(took / 1000).toFixed(1)} s`);
    if (took > 5500) bad.push(`the request took ${(took / 1000).toFixed(1)} s (the pen waited for the diagram)`);
    if (!notes.some(t => /could not read a Mermaid diagram/.test(t))) bad.push('the chat does not say Obsidian could not read the diagram');
    if (!cm.state.doc.toString().includes('A[ --> ]]')) bad.push('the block is not in the note');
    return bad.join('; ');
  });

  await run('with reduced motion nothing moves: the redraw and the chat’s ink leave the diagram as it is', async () => {
    window.matchMedia = q => (/prefers-reduced-motion/.test(q) ? { matches: true, addEventListener() {}, removeEventListener() {} } : savedMatch.call(window, q));
    const v = await open('Still', `# Still\n\n${I.DEMO_MERMAID}\n\nWords after.\n`);
    const cm = v.editor.cm;
    await until(() => cm.contentDOM.querySelector('.mermaid > svg'), 4000);
    const find = () => Array.from(cm.contentDOM.querySelectorAll('.mermaid > svg'));
    const log = await watch(find, async () => { await plugin.redrawDiagram(v); await sleep(300); });
    const bad = [];
    if (log.drawing || log.pen) bad.push('the pen drew with reduced motion');
    useServer();
    await queue([`Flow:\n\n${I.DEMO_MERMAID}`]);
    const c = () => Array.from(chat().logEl.querySelectorAll('.lagrange-turn--reply .mermaid > svg'));
    const cl = await watch(c, async () => { await send('flow please'); await settle(); await sleep(800); });
    if (cl.drawing) bad.push('the chat inked a diagram with reduced motion');
    if (c()[0]) bad.push(...whole(c()[0]));
    return bad.join('; ');
  });

  // ---- clean up ----
  Object.assign(plugin.settings, saved);
  plugin.session = savedSession;
  window.matchMedia = savedMatch;
  try { chat().clear(); } catch (e) { /* the chat is gone */ }
  for (const p of made) { try { const f = app.vault.getAbstractFileByPath(p); if (f) await app.vault.delete(f); } catch (e) { /* kept */ } }
  try { const d = app.vault.getAbstractFileByPath(DIR); if (d && !opt.keep) await app.vault.delete(d, true); } catch (e) { /* kept */ }
  const failed = cases.filter(c => !c.ok).length;
  console.table(cases);
  return JSON.stringify({ ok: !failed, failed, cases, info });
})();
