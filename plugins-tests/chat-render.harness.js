// What Lagrange's chat shows, checked in a real Obsidian: a reply with code, mathematics, a table, a Mermaid diagram
// and a TikZ figure is set as a note would set it and stays inside the panel; a TikZ figure that TikZJax has never
// compiled is drawn in the chat (TikZJax 0.5.2 leaves such a figure on its spinner for ever when it meets it twice:
// see renderApart in the plugin); a figure with an error in it gives way to its source and a line that says so, and
// so does one that never comes; an edit that writes a broken figure into the note is said in the chat and does not
// keep the pen waiting; the writer's own message is rendered; a picture at a web address in a reply is not fetched;
// a pasted picture and a pasted text file become chips, show in the sent message and reach the server (the picture
// as an image part, the file as its text).
//
// The list of edits under a reply ("2 edits made", and the tasks Proofread and Revise) is checked too: each edit's
// words are set as Markdown (a code block with its colours and its language, inline code, inline and displayed
// mathematics, a TikZ figure, a list), not as their source; an edit of plain words keeps its white space, and one
// that only changes Markdown marks shows them; a long edit shows its beginning and a button that says how many more
// lines there are, and the rest (a figure in it too) is only rendered when asked for; what was taken out is told
// from what was put in; nothing an edit holds is fetched or run; and while a reply streams, a code block that is
// still open shows as code, never as half a fence; the inline mathematics of a paragraph that is still coming is
// typeset as each formula closes, and no frame shows a formula's source, a paragraph twice or a raw $$; money,
// dollars in code and escaped dollars are left as they are; and what stands when the reply is complete is what the
// whole reply rendered at once would be. The first of these cases is the one from the demo, as it was
// reported: "Add an equation" and "Add some code", whose edits 0.6.1 listed as raw LaTeX and a raw, cut code block.
//
// And the loader's plates ("Lagrange is thinking"): requests in a row show the three plates in turn, the first by
// chance, through a server and in demo mode alike; a request answered in several replies shows one plate; a plate
// chosen in the settings stays; each plate is drawn inside the panel and moves.
//
// This cannot run under Node (it needs Obsidian's renderer and the plugins), so it is not part of `node --test`.
// To run it:
//   1. start the mock server:  node plugins-tests/mock-chat-server.mjs 48914
//   2. open a Scriptorium vault in Obsidian with Lagrange on, and TikZJax on for the figure cases (they fail, saying
//      so, where it is off), with a note open;
//   3. paste this file into the developer console, or evaluate it with Runtime.evaluate (awaitPromise: true).
// It answers with a JSON string {ok, failed, cases: [{name, ok, why}], info: [what was measured]} and prints a table. Options, set first:
// window.chatRenderOptions = {server: 'http://127.0.0.1:48914', only: 'text in a case name'}. It sets Lagrange to
// the server for the run and puts the settings back afterwards; it clears the chat, and leaves the note as it was.
// (The model is named "llava-mock" so that Lagrange takes it for one that reads pictures.) Only the mock server is spoken
// to: no model, nothing on the web.
//
// Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).
(async () => {
  const opt = window.chatRenderOptions || {};
  const server = String(opt.server || 'http://127.0.0.1:48914').replace(/\/+$/, '');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const plugin = app.plugins.plugins.lagrange;
  const I = plugin.constructor.internals;
  const cases = [], info = [];
  const has = id => app.plugins.enabledPlugins.has(id) && Boolean(app.plugins.plugins[id]);

  // ---- the panel ----
  const saved = Object.assign({}, plugin.settings), savedSession = plugin.session;
  Object.assign(plugin.settings, { provider: 'openai', openaiBaseUrl: `${server}/v1`, openaiModel: 'llava-mock', openaiApiKey: '', agenticEdits: true, showPen: true, penSpeed: 3 });
  plugin.session = { noFallback: false, noEffort: {}, noPictures: {} };
  document.querySelectorAll('.modal-container').forEach(m => m.remove());
  app.workspace.rightSplit.expand();
  await plugin.activateView(false);
  await sleep(300);
  const view = () => app.workspace.getLeavesOfType('lagrange-chat')[0].view;
  const queue = async replies => {
    const r = await fetch(`${server}/__queue`, { method: 'POST', body: JSON.stringify(replies.map(t => (typeof t === 'string' ? { text: t, chunk: 40, delay: 4, first: 150 } : t))) });
    if (!r.ok) throw new Error(`the mock server did not take the replies (${r.status})`);
  };
  const requests = async () => (await fetch(`${server}/__requests`)).json();
  const send = async text => {
    const v = view();
    v.inputEl.value = text;
    await v.send();
    for (let i = 0; i < 600 && (v.pending || plugin.editing); i++) await sleep(50);
  };
  const body = () => Array.from(view().logEl.querySelectorAll('.lagrange-turn--reply .lagrange-turn-body')).pop();
  const figure = () => { const b = body(); return b ? b.querySelector('.block-language-tikz') : null; };
  const until = async (fn, ms) => { for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (fn()) return true; await sleep(100); } return Boolean(fn()); };
  const asides = () => Array.from(view().logEl.querySelectorAll('.lagrange-aside, .lagrange-turn-note')).map(n => n.textContent);
  // what sticks out of the panel, not counting what scrolls inside a box of its own
  const overflow = () => {
    const v = view(), log = v.logEl, root = v.contentEl.getBoundingClientRect(), out = [];
    const scrolls = el => { for (let e = el.parentElement; e && e !== log; e = e.parentElement) if (/auto|scroll|hidden/.test(getComputedStyle(e).overflowX)) return true; return false; };
    for (const el of log.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height && (r.right > root.right + 0.5 || r.left < root.left - 0.5) && !scrolls(el)) out.push(el.tagName.toLowerCase());
    }
    return out;
  };
  const paste = async files => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    view().inputEl.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(700);
  };
  const png = async () => {
    const c = document.createElement('canvas');
    c.width = 240; c.height = 150;
    const g = c.getContext('2d');
    g.fillStyle = '#f4ecd8'; g.fillRect(0, 0, 240, 150); g.fillStyle = '#7b2d26'; g.fillRect(30, 30, 90, 60);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    return new File([blob], 'picture.png', { type: 'image/png' });
  };
  // a figure TikZJax has not met before (it keeps what it has compiled, by its source)
  const stamp = String(Date.now() % 100000);
  const tikz = (inside, preamble) => `\`\`\`tikz\n${preamble || ''}\\begin{document}\n\\begin{tikzpicture}\n${inside}\n\\end{tikzpicture}\n\\end{document}\n\`\`\``;
  const fresh = n => tikz(`\\draw[thick] (0,0) circle (1.${stamp}${n});\n\\foreach \\a in {0,30,...,330} \\draw (\\a:1.5) -- (\\a:1.7);\n\\draw (0,0) -- (1.5,0) node[midway,below] {$r$};`);

  const run = async (name, fn) => {
    if (opt.only && !name.includes(opt.only)) return;
    const c = { name, ok: false, why: '' };
    try {
      view().clear();
      const why = await fn();
      c.ok = !why;
      c.why = why || '';
    } catch (e) { c.why = `threw: ${String((e && e.stack) || e).slice(0, 300)}`; }
    cases.push(c);
  };
  const needTikz = () => (has('obsidian-tikzjax') ? '' : 'the TikZJax plugin is not on in this vault');

  // ---- a streaming reply, frame by frame ----
  const unstyledFrames = [];             // for each watched reply that had any: the frames in which a formula of the open prose stood without its styles
  const styled = () => { const n = unstyledFrames.splice(0).reduce((a, b) => a + b, 0); return n ? [`a formula stood in the open prose without its styles for ${n} frame${n === 1 ? '' : 's'}`] : []; };
  // The blocks of a reply as they stand in an element, in one string (the parts a streamed reply was set in are
  // taken as one).
  const blocksOf = el => {
    const parts = Array.from(el.querySelectorAll('.lagrange-turn-part'));
    const kids = parts.length ? parts.flatMap(p => Array.from(p.children)) : Array.from((el.children.length === 1 && el.firstElementChild.tagName === 'DIV' && !el.firstElementChild.className ? el.firstElementChild : el).children);
    return kids.map(k => k.outerHTML).join('\n');
  };
  // The same Markdown rendered at once, as a reply that did not stream is: -> its blocks, as blocksOf gives them.
  const wholeOf = async md => {
    const box = view().logEl.createDiv({ cls: 'lagrange-turn-body markdown-rendered' });
    box.style.cssText = 'position:absolute;left:0;right:0;top:0;visibility:hidden';
    await view().renderChat(md, box, '', view());
    await sleep(400);
    const html = blocksOf(box);
    box.remove();
    return html;
  };
  const firstDiff = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return `at ${i}: streamed ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 60))}, at once ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 60))}`; };
  // Watches the last reply at every frame while fn runs: each(body, open, prose) is called with the reply's body,
  // what is still open in it (or null) and the open prose in two forms: {text: its words without what is typeset or
  // in a code span, all: innerText, math: how many formulas are typeset in it, code: how many code spans}.
  const frames = async (each, fn) => {
    let watching = true, n = 0, unstyled = 0;
    const watch = () => {
      if (!watching) return;
      const b = body();
      if (b) {
        n++;
        const open = b.querySelector('.lagrange-turn-open'), box = open ? open.querySelector('.lagrange-open-text') : null;
        let text = '';
        if (box) for (const k of box.childNodes) if (k.nodeType === 3) text += k.nodeValue; else text += '\u0001';
        // (a letter of a formula whose style MathJax has not made yet has no box: it shows as nothing, or as a stray mark)
        if (box) for (const c of box.querySelectorAll('mjx-c')) if (getComputedStyle(c).padding === '0px') { unstyled++; break; }
        each(b, open, { text, all: box ? box.innerText : '', math: box ? box.querySelectorAll('mjx-container').length : 0, code: box ? box.querySelectorAll('code').length : 0, box });
      }
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
    try { await fn(); await sleep(600); } finally { watching = false; }
    if (unstyled) unstyledFrames.push(unstyled);
    return n;
  };

  // ---- the cases ----
  await run('a reply with code, mathematics, a table, Mermaid and TikZ is set as a note would set it, inside the panel', async () => {
    const off = needTikz(); if (off) return off;
    await queue(['A little of everything, with `inline code`.\n\n```python\ndef f(m1, m2, r):\n    # a deliberately long line, so that the code has to scroll sideways inside the narrow panel and not stick out of it\n    return r * (m2 / (3 * m1)) ** (1 / 3)\n```\n\n' +
      'Inline $e^{i\\pi} + 1 = 0$ and a wide display:\n\n$$\n\\mathcal{L} = \\frac{1}{2} m \\left( \\dot{x}^2 + \\dot{y}^2 + \\dot{z}^2 \\right) - \\frac{G M_1 m}{\\sqrt{(x + \\mu)^2 + y^2 + z^2}} - \\frac{G M_2 m}{\\sqrt{(x - 1 + \\mu)^2 + y^2 + z^2}}\n$$\n\n' +
      '| Point | Stability | Used by |\n|---|---|---|\n| L1 | unstable | SOHO |\n| L2 | unstable | JWST |\n\n```mermaid\ngraph LR\n  Sun --> L1 --> Earth --> L2\n```\n\n' + fresh(1) + '\n\nThat is all.']);
    await send('Show me $x^2$ and everything.');
    const b = body(), bad = [];
    await until(() => figure() && I.tikzState(figure()) !== 'waiting' && b.querySelector('.mermaid svg'), 20000);
    await sleep(300);
    if (!b.querySelector('button.copy-code-button')) bad.push('no copy button on the code');
    if (!b.querySelector('pre code .token')) bad.push('the code is not coloured');
    if (!b.querySelector('mjx-container:not([display="true"])')) bad.push('no inline mathematics');
    if (!b.querySelector('mjx-container[display="true"]')) bad.push('no displayed mathematics');
    if (!b.querySelector('table')) bad.push('no table');
    if (!b.querySelector('.mermaid svg')) bad.push('the Mermaid diagram is not drawn');
    if (!figure() || I.tikzState(figure()) !== 'drawn' || figure().classList.contains('lagrange-figure-source')) bad.push('the TikZ figure is not drawn');
    if (/```|\$\$/.test(b.innerText)) bad.push('raw Markdown is left in the reply');
    const user = view().logEl.querySelector('.lagrange-turn--user .lagrange-turn-text');
    if (!user || !user.querySelector('mjx-container')) bad.push('the writer’s own message is not rendered');
    const out = overflow();
    if (out.length) bad.push(`sticks out of the panel: ${out.slice(0, 5).join(', ')}`);
    return bad.join('; ');
  });

  await run('a TikZ figure that TikZJax has never compiled is drawn in the chat, three replies in a row', async () => {
    const off = needTikz(); if (off) return off;
    await queue([`One.\n\n${fresh(2)}`, `Two.\n\n${fresh(3)}`, `Three.\n\n${tikz(`\\node[draw] (a) {A${stamp}};\n\\node[draw,right=of a] (b) {B};\n\\draw[-{Stealth}] (a) -- (b);`, '\\usetikzlibrary{arrows.meta,positioning}\n')}`]);
    const bad = [];
    for (const q of ['one', 'two', 'three']) {
      await send(q);
      await until(() => figure() && I.tikzState(figure()) !== 'waiting', 15000);
      const f = figure();
      if (!f || I.tikzState(f) !== 'drawn' || f.classList.contains('lagrange-figure-source')) bad.push(`${q}: ${f ? (f.classList.contains('lagrange-figure-source') ? 'its source is shown' : `the figure is ${I.tikzState(f)}`) : 'no figure'}`);
    }
    return bad.join('; ');
  });

  await run('a TikZ figure with an error in it gives way to its source, and one that never comes does after its time', async () => {
    const off = needTikz(); if (off) return off;
    await queue([`A wrong one.\n\n${tikz(`\\drwa (0,0) -- (1,1.${stamp});`)}`]);
    await send('one');
    await until(() => figure() && figure().classList.contains('lagrange-figure-source'), 15000);
    const f = figure(), bad = [];
    if (!f || !f.classList.contains('lagrange-figure-source')) bad.push(`the figure with an error is ${f ? I.tikzState(f) : 'not there'}, not its source`);
    else {
      if (!/could not draw this figure/.test(f.querySelector('small').textContent)) bad.push('no line that says why');
      const shown = Array.from(f.querySelectorAll('pre code')).map(c => c.textContent);
      if (!shown.some(t => /\\drwa \(0,0\)/.test(t))) bad.push('the source is not shown');
      // (with Scriptorium's "Repair TikZJax rendering" on, what TeX said is there too)
      const repair = app.plugins.plugins.scriptorium && app.plugins.plugins.scriptorium.tikzRepair;
      if (repair && !shown.some(t => /Undefined control sequence/.test(t))) bad.push('what TeX said is not shown');
    }
    // a block that stays on TikZJax's spinner (made here: TikZJax itself is not kept waiting)
    const late = body().createDiv({ cls: 'block-language-tikz' });
    late.innerHTML = '<svg><circle><animate></animate></circle></svg>';
    if (I.tikzState(late) !== 'waiting') bad.push('a spinner is not taken as waiting');
    await view().watchFigures([{ block: late, source: '\\begin{document} late' }], 1200);
    if (!late.classList.contains('lagrange-figure-source') || !/has not drawn this figure/.test(late.textContent) || !/late/.test(late.querySelector('pre code').textContent)) bad.push('a figure that never comes does not give way to its source');
    const out = overflow();
    if (out.length) bad.push(`sticks out of the panel: ${out.slice(0, 5).join(', ')}`);
    return bad.join('; ');
  });

  await run('an edit that writes a broken TikZ figure into the note: the pen does not wait for it, and the chat says so', async () => {
    const off = needTikz(); if (off) return off;
    const md = app.workspace.getLeavesOfType('markdown')[0];
    if (!md || !md.view.file) return 'no note is open';
    const file = md.view.file, before = await app.vault.read(file);
    await md.setViewState({ type: 'markdown', state: { file: file.path, mode: 'source', source: false }, active: true });
    await sleep(400);
    try {
      await queue([`Added.\n\n\`\`\`lagrange-edits\n${JSON.stringify([{ append: `\n\n${tikz(`\\drwa (0,0) -- (2,1.${stamp});`)}\n` }])}\n\`\`\``]);
      const t0 = Date.now();
      await send('Add a figure.');
      const took = Date.now() - t0, bad = [];
      if (took > 9000) bad.push(`the turn took ${took} ms (the pen waited for a figure that will never come)`);
      if (!(await until(() => asides().some(a => /TikZJax could not draw a figure Lagrange wrote in the note/.test(a)), 12000))) bad.push('the chat does not say that the figure in the note failed');
      return bad.join('; ');
    } finally {
      for (let i = 0; i < 100 && plugin.editing; i++) await sleep(50);
      await app.vault.modify(file, before);
      await sleep(300);
    }
  });

  await run('a picture at a web address in a reply is a link and is not fetched; block HTML that would load something is shown as text', async () => {
    await queue(['On the web: ![tracker](https://example.invalid/pixel.png?note=secret)\n\n<iframe src="https://example.invalid/frame"></iframe>\n\nEnd.']);
    await send('one');
    await sleep(500);
    const b = body(), bad = [];
    if (Array.from(b.querySelectorAll('img, iframe, video, object, embed')).some(e => /^https?:/i.test(e.getAttribute('src') || e.getAttribute('data') || ''))) bad.push('something in the reply loads from the web');
    if (!Array.from(b.querySelectorAll('a')).some(a => /example\.invalid\/pixel\.png/.test(a.getAttribute('href') || ''))) bad.push('the picture is not shown as a link');
    if (performance.getEntriesByType('resource').some(e => /example\.invalid/.test(e.name))) bad.push('a request was made to the address');
    return bad.join('; ');
  });

  await run('a pasted picture and a pasted text file: chips, the sent message, and what reaches the server', async () => {
    await queue(['Received, thank you.']);
    await paste([await png(), new File(['# Notes\n\nA line of the attached file.\n'], 'notes.md', { type: 'text/markdown' })]);
    const v = view(), bad = [];
    const chips = Array.from(v.trayEl.querySelectorAll('.lagrange-chip .lagrange-chip-name')).map(n => n.textContent);
    if (chips.join(',') !== 'picture.png,notes.md') bad.push(`chips: ${chips.join(',') || 'none'}`);
    if (overflow().length) bad.push('the chips stick out of the panel');
    await send('What did I attach?');
    await sleep(400);
    if (v.trayEl.querySelectorAll('.lagrange-chip').length) bad.push('the chips are still in the tray after sending');
    const img = v.logEl.querySelector('.lagrange-turn--user img');
    if (!img || !img.naturalWidth) bad.push('the picture does not show in the sent message');
    if (!/Received, thank you/.test(body().innerText)) bad.push('no reply');
    const reqs = await requests();
    const last = reqs.length ? reqs[reqs.length - 1].messages.filter(m => m.role === 'user').pop() : null;
    const parts = last && Array.isArray(last.content) ? last.content : [];
    if (reqs.length !== 1) bad.push(`${reqs.length} requests were made`);
    if (!parts.some(p => p.type === 'image_url' && /^data:image\/png;base64,/.test((p.image_url || {}).url || ''))) bad.push('the picture did not reach the server as an image part');
    const text = parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
    if (!/A line of the attached file\./.test(text)) bad.push('the text of the file did not reach the server');
    if (!/What did I attach\?/.test(text)) bad.push('the message itself did not reach the server');
    if (overflow().length) bad.push('the sent message sticks out of the panel');
    return bad.join('; ');
  });

  // ---- the list of edits ----
  // The note open for editing, holding `text` for the case and put back as it was afterwards.
  const withNote = async (text, fn) => {
    const md = app.workspace.getLeavesOfType('markdown')[0];
    if (!md || !md.view.file) return 'no note is open';
    const file = md.view.file, before = await app.vault.read(file), state = md.getViewState();
    await app.vault.modify(file, text);
    await md.setViewState({ type: 'markdown', state: { file: file.path, mode: 'source', source: false }, active: true });
    await sleep(500);
    const pen = plugin.settings.showPen;
    plugin.settings.showPen = false;                // (the pen has its own harness; here the edits are made at once)
    try { return await fn(md, file); } finally {
      for (let i = 0; i < 200 && (plugin.editing || view().pending); i++) await sleep(50);
      plugin.settings.showPen = pen;
      await app.vault.modify(file, before);
      await md.setViewState(state);
      await sleep(300);
    }
  };
  const edits = ops => `\`\`\`lagrange-edits\n${JSON.stringify(ops)}\n\`\`\``;
  const items = () => Array.from(view().logEl.querySelectorAll('.lagrange-edits > li'));
  const settled = async () => { await until(() => !view().logEl.querySelector('.lagrange-edits .is-loading') && !Array.from(view().logEl.querySelectorAll('.lagrange-edits .block-language-tikz')).some(b => I.tikzState(b) === 'waiting'), 20000); await sleep(500); };
  const raw = el => /```|~~~|\$\$|\\frac|\\begin\{/.test(el.innerText);
  const mono = el => /mono|courier|consolas|menlo/i.test(getComputedStyle(el).fontFamily);
  const struck = el => /line-through/.test(getComputedStyle(el).textDecorationLine);
  const NOTE = ['###### Edit cases', '', 'The energy is conserved along the orbit.', '', 'Call the helper to get the radius.', '', 'This sentence will be removed entirely.', '', 'Old block:', '', '```js', 'const a = 1;', 'const b = 2;', '```', '', 'It has  a doubled space and *starred* emphasis.', '', 'End.', ''].join('\n');

  await run('the edits of the demo, as reported: "Add an equation" lists a typeset equation, "Add some code" a whole code block', async () => withNote('###### A note on the five points\n\nLagrange found five places where a small body can rest between two great ones.\n', async () => {
    // (the demo's own replies, word for word, sent through the mock server)
    const note = { title: 'On Balance', text: 'A note.\n' }, bad = [];
    await queue([I.demoChatReply('Add an equation', note, true, false, { tikz: true }), I.demoChatReply('Add some code', note, true, false, { tikz: true })]);
    await send('Add an equation');
    await send('Add some code');
    await settled();
    const li = items();
    if (li.length !== 2) return `${li.length} edits are listed, not 2`;
    const [eq, code] = li;
    if (!eq.closest('ol.lagrange-edits') || !/^\+/.test(eq.querySelector('.lagrange-edit-mark').textContent)) bad.push('the equation edit has lost its number or its +');
    if (!eq.querySelector('mjx-container[display="true"]')) bad.push('the equation is not typeset');
    if (raw(eq)) bad.push(`the equation edit shows its source: ${eq.innerText.slice(0, 80)}`);
    if (!/The Euler–Lagrange equation:/.test(eq.innerText)) bad.push('the words before the equation are gone');
    const pre = code.querySelector('pre'), block = pre && pre.querySelector('code');
    if (!block) bad.push('the code edit has no code block');
    else {
      if (!/language-python/.test(block.className) || !block.querySelector('.token')) bad.push('the code is not coloured as Python');
      if (pre.getAttribute('data-lang') !== 'Python') bad.push(`the code block's label is ${pre.getAttribute('data-lang')}`);
      if (block.textContent.trim() !== 'def hill_radius(m1, m2, r):\n    # where a small body between two masses can rest\n    return r * (m2 / (3 * m1)) ** (1 / 3)') bad.push(`the code is not whole: ${JSON.stringify(block.textContent)}`);
      if (!mono(block)) bad.push(`the code is set in ${getComputedStyle(block).fontFamily.slice(0, 40)}`);
      if (parseFloat(getComputedStyle(block).fontSize) < 11) bad.push(`the code is set at ${getComputedStyle(block).fontSize}`);
      if (getComputedStyle(pre).textAlign === 'justify') bad.push('the code is justified');
      if (pre.scrollWidth > pre.clientWidth + 1 && !/auto|scroll/.test(getComputedStyle(pre).overflowX)) bad.push('the code neither wraps nor scrolls');
    }
    const inline = Array.from(code.querySelectorAll('code')).find(c => !c.closest('pre'));
    if (!inline || inline.textContent !== 'hill_radius(m1, m2, r)') bad.push('the inline code is not set as code');
    if (raw(code) || / … /.test(code.innerText) || /`/.test(code.innerText)) bad.push(`the code edit shows its source or is cut: ${code.innerText.slice(0, 120)}`);
    if (code.querySelector('.lagrange-edit-more:not(.is-hidden)')) bad.push('a short edit has a "more" button');
    const out = overflow();
    if (out.length) bad.push(`sticks out of the panel: ${out.slice(0, 5).join(', ')}`);
    return bad.join('; ');
  }));

  await run('an edit list: inline mathematics and inline code stay in the line; what was taken out is struck; a reason is rendered', async () => withNote(NOTE, async () => {
    await queue(['Two edits.\n\n' + edits([
      { find: 'The energy is conserved along the orbit.', replace: 'The energy $E = T + V$ is conserved along the orbit.', reason: 'name it, as in $E = T + V$' },
      { find: 'Call the helper to get the radius.', replace: 'Call `hill_radius()` to get the **radius**.', reason: 'say which helper: `hill_radius`' }])]);
    await send('Make them.');
    await settled();
    const li = items(), bad = [];
    if (li.length !== 2) return `${li.length} edits are listed, not 2`;
    for (const [i, want] of [[0, 'mjx-container'], [1, 'code']]) {
      const ins = li[i].querySelector('ins.lagrange-ins'), del = li[i].querySelector('del.lagrange-del'), line = li[i].querySelector('.lagrange-edit-line');
      if (!ins || !del) { bad.push(`edit ${i + 1} has no old and new side`); continue; }
      if (!ins.querySelector(want)) bad.push(`edit ${i + 1}: no ${want} in what was put in`);
      if (ins.querySelector('mjx-container[display="true"]')) bad.push('inline mathematics is displayed');
      if (line.classList.contains('is-stacked') || getComputedStyle(ins).display !== 'inline') bad.push(`edit ${i + 1} is not in one line`);
      if (!struck(del)) bad.push(`edit ${i + 1}: what was taken out is not struck`);
      if (struck(ins)) bad.push(`edit ${i + 1}: what was put in is struck`);
      if (!/→/.test(line.textContent)) bad.push(`edit ${i + 1} has no arrow`);
      if (!li[i].querySelector(`.lagrange-reason ${want}`)) bad.push(`edit ${i + 1}: the reason is not rendered`);
      if (/[`$]|\*\*/.test(li[i].innerText)) bad.push(`edit ${i + 1} shows Markdown marks: ${li[i].innerText.slice(0, 80)}`);
    }
    if (!li[1].querySelector('ins strong')) bad.push('emphasis is not set');
    const out = overflow();
    if (out.length) bad.push(`sticks out of the panel: ${out.slice(0, 5).join(', ')}`);
    return bad.join('; ');
  }));

  await run('an edit list: displayed mathematics over several lines, wide, scrolls inside the panel', async () => withNote(NOTE, async () => {
    await queue(['One.\n\n' + edits([{ append: 'In full:\n\n$$\n\\mathcal{L} = \\frac{1}{2} m \\left( \\dot{x}^2 + \\dot{y}^2 + \\dot{z}^2 \\right) - \\frac{G M_1 m}{\\sqrt{(x + \\mu)^2 + y^2 + z^2}} - \\frac{G M_2 m}{\\sqrt{(x - 1 + \\mu)^2 + y^2 + z^2}}\n$$' }])]);
    await send('Add it.');
    await settled();
    const li = items(), bad = [];
    if (li.length !== 1) return `${li.length} edits are listed, not 1`;
    if (!li[0].querySelector('mjx-container[display="true"]')) bad.push('the formula is not typeset');
    if (raw(li[0])) bad.push('the formula shows its source');
    const out = overflow();
    if (out.length) bad.push(`sticks out of the panel: ${out.slice(0, 5).join(', ')}`);
    return bad.join('; ');
  }));

  await run('an edit list: a TikZ figure in an edit is drawn in the list, once', async () => withNote(NOTE, async () => {
    const off = needTikz(); if (off) return off;
    const fig = fresh(7);
    await queue(['A figure.\n\n' + edits([{ append: `The picture:\n\n${fig}` }])]);
    await send('Draw it.');
    const block = () => items()[0] && items()[0].querySelector('.block-language-tikz');
    await until(() => block() && I.tikzState(block()) !== 'waiting', 20000);
    await sleep(400);
    const bad = [];
    if (!block() || I.tikzState(block()) !== 'drawn' || block().classList.contains('lagrange-figure-source')) bad.push(`the figure in the list is ${block() ? I.tikzState(block()) : 'not there'}`);
    if (items()[0] && items()[0].querySelectorAll('.block-language-tikz').length !== 1) bad.push('the figure is in the list more than once');
    if (items()[0] && raw(items()[0])) bad.push('the figure shows its source');
    const out = overflow();
    if (out.length) bad.push(`sticks out of the panel: ${out.slice(0, 5).join(', ')}`);
    return bad.join('; ');
  }));

  await run('an edit list: a long edit shows its beginning and "N more lines"; the rest, a figure too, is rendered only when asked for', async () => withNote(NOTE, async () => {
    const listing = '```python\n' + Array.from({ length: 40 }, (_, i) => `def step_${i}(state, dt):  # a line long enough to need room in the narrow panel\n    return state + ${i} * dt`).join('\n') + '\n```';
    const text = `A long listing:\n\n${listing}\n\nAnd the picture:\n\n${has('obsidian-tikzjax') ? fresh(8) : '(no figure)'}`;
    await queue(['Long.\n\n' + edits([{ append: text }])]);
    await send('Add it.');
    await settled();
    const li = items()[0], bad = [];
    if (!li) return 'no edit is listed';
    const short = li.querySelector('.lagrange-edit-short'), more = li.querySelector('button.lagrange-edit-more');
    if (!short || !more) return 'the long edit has no beginning or no button';
    const total = text.split('\n').length, shownLines = total - Number((/^(\d+) more lines$/.exec(more.textContent) || [])[1]);
    if (!/^\d+ more lines$/.test(more.textContent) || !(shownLines >= 5 && shownLines <= I.EDIT_LINES)) bad.push(`the button reads “${more.textContent}” (of ${total} lines)`);
    if (!short.querySelector('pre code .token')) bad.push('the beginning of the code is not rendered as code');
    if (raw(short)) bad.push('the beginning shows a fence');
    if (short.getBoundingClientRect().height > parseFloat(getComputedStyle(short).maxHeight) + 1 || !(parseFloat(getComputedStyle(short).maxHeight) < view().logEl.clientHeight)) bad.push(`the beginning is ${Math.round(short.getBoundingClientRect().height)} px tall`);
    if (li.querySelector('.block-language-tikz') || li.querySelector('.lagrange-edit-full')) bad.push('the rest was rendered before it was asked for');
    const h0 = li.getBoundingClientRect().height;
    more.click();
    await sleep(300);
    const fig = () => li.querySelector('.lagrange-edit-full .block-language-tikz');
    if (has('obsidian-tikzjax')) await until(() => fig() && I.tikzState(fig()) !== 'waiting', 20000);
    await sleep(500);
    const full = li.querySelector('.lagrange-edit-full');
    if (!full || getComputedStyle(short).display !== 'none' || more.textContent !== 'Show less' || more.getAttribute('aria-expanded') !== 'true') bad.push('the button does not open the whole edit');
    else {
      if (!/step_39/.test(full.innerText) || !/And the picture/.test(full.innerText)) bad.push('the whole edit is not all there');
      if (li.getBoundingClientRect().height <= h0) bad.push('the whole edit is no taller than its beginning');
      if (has('obsidian-tikzjax') && (!fig() || I.tikzState(fig()) !== 'drawn')) bad.push(`the figure in the whole edit is ${fig() ? I.tikzState(fig()) : 'not there'}`);
    }
    const out = overflow();
    if (out.length) bad.push(`open, it sticks out of the panel: ${out.slice(0, 5).join(', ')}`);
    more.click(); await sleep(200); more.click(); await sleep(200); more.click(); await sleep(300);
    if (getComputedStyle(short).display === 'none' || !/more lines$/.test(more.textContent)) bad.push('the button does not close it again');
    if (li.querySelectorAll('.lagrange-edit-full').length !== 1 || li.querySelectorAll('.block-language-tikz').length !== (has('obsidian-tikzjax') ? 1 : 0)) bad.push('opening it again rendered it again');
    return bad.join('; ');
  }));

  await run('an edit list: a long paragraph is clipped and opens with "Show more"', async () => withNote(NOTE, async () => {
    const para = 'A paragraph that has been rewritten at some length, with the formula $r \\approx R (M_2 / 3 M_1)^{1/3}$ in its middle. ' + 'It goes on for a good many more words than the list can hold. '.repeat(12);
    await queue(['Longer.\n\n' + edits([{ find: 'The energy is conserved along the orbit.', replace: para.trim() }])]);
    await send('Rewrite it.');
    await settled();
    const li = items()[0], bad = [];
    if (!li) return 'no edit is listed';
    const short = li.querySelector('ins .lagrange-edit-short'), more = li.querySelector('ins button.lagrange-edit-more');
    if (!short || !more) return 'the long paragraph is not set as a block with a button';
    if (!short.classList.contains('is-clipped') || more.classList.contains('is-hidden') || more.textContent !== 'Show more') bad.push(`clipped: ${short.classList.contains('is-clipped')}, button “${more.textContent}”${more.classList.contains('is-hidden') ? ' (hidden)' : ''}`);
    if (short.getBoundingClientRect().height > 12 * parseFloat(getComputedStyle(li).fontSize)) bad.push(`the paragraph is not clipped (${Math.round(short.getBoundingClientRect().height)} px)`);
    if (!short.querySelector('mjx-container')) bad.push('its formula is not typeset');
    const old = li.querySelector('del.is-block');
    if (!old || !/−/.test(li.querySelector('.is-old .lagrange-edit-mark').textContent) || !/\+/.test(li.querySelector('.is-new .lagrange-edit-mark').textContent)) bad.push('the two sides do not stand under − and +');
    else if (old.querySelector('button.lagrange-edit-more:not(.is-hidden)')) bad.push('the short side taken out has a button');
    more.click(); await sleep(300);
    if (!li.querySelector('.lagrange-edit-full') || more.textContent !== 'Show less') bad.push('"Show more" does not open it');
    const out = overflow();
    if (out.length) bad.push(`sticks out of the panel: ${out.slice(0, 5).join(', ')}`);
    return bad.join('; ');
  }));

  await run('an edit list: a deletion in a line and a deletion of a block are told from what is put in', async () => withNote(NOTE, async () => {
    await queue(['Gone.\n\n' + edits([{ find: 'This sentence will be removed entirely.', replace: '' }, { find: 'Old block:\n\n```js\nconst a = 1;\nconst b = 2;\n```', replace: '' }])]);
    await send('Remove them.');
    await settled();
    const li = items(), bad = [];
    if (li.length !== 2) return `${li.length} edits are listed, not 2`;
    for (const [i, l] of li.entries()) {
      if (!l.classList.contains('is-delete')) bad.push(`edit ${i + 1} is not marked as a deletion`);
      if (!/−/.test((l.querySelector('.lagrange-edit-mark') || {}).textContent || '')) bad.push(`edit ${i + 1} has no −`);
      if (l.querySelector('ins.lagrange-ins')) bad.push(`edit ${i + 1} shows something put in`);
      if (!/deleted/.test(l.innerText)) bad.push(`edit ${i + 1} does not say “deleted”`);
    }
    const lineDel = li[0].querySelector('del'), blockDel = li[1].querySelector('del.is-block');
    if (!lineDel || !struck(lineDel)) bad.push('the sentence taken out is not struck');
    if (!blockDel) bad.push('the block taken out is not set as a block');
    else {
      if (!blockDel.querySelector('pre code')) bad.push('the code taken out is not set as code');
      if (parseFloat(getComputedStyle(blockDel).borderInlineStartWidth) < 1) bad.push('the block taken out has no rule down its side');
      const ink = getComputedStyle(view().logEl.querySelector('.lagrange-turn-body')).color;
      if (getComputedStyle(blockDel).color === ink) bad.push('the block taken out is in the ink of what is kept');
      if (raw(blockDel)) bad.push('the block taken out shows a fence');
    }
    return bad.join('; ');
  }));

  await run('an edit list: a mixed edit (prose, code, a list with mathematics, a quotation) stands as old under −, new under +', async () => withNote(NOTE, async () => {
    await queue(['Mixed.\n\n' + edits([{ find: 'Old block:\n\n```js\nconst a = 1;\nconst b = 2;\n```', replace: 'New block:\n\n```js\nconst a = 1;\nconst b = 3;   // corrected\n```\n\n- first, with $a < b$\n- second, with `b`\n\n> and a quotation', reason: 'the value of b' }])]);
    await send('Change it.');
    await settled();
    const li = items()[0], bad = [];
    if (!li) return 'no edit is listed';
    const old = li.querySelector('.is-old del.is-block'), fresh2 = li.querySelector('.is-new ins.is-block');
    if (!old || !fresh2) return 'the edit does not stand as two blocks';
    if (old.getBoundingClientRect().bottom > fresh2.getBoundingClientRect().top + 1) bad.push('the new block is not under the old one');
    if (!/const b = 2;/.test(old.querySelector('pre code').textContent)) bad.push('the old code is not there');
    for (const sel of ['pre code .token', 'ul li mjx-container', 'ul li code', 'blockquote']) if (!fresh2.querySelector(sel)) bad.push(`no ${sel} in what was put in`);
    if (fresh2.querySelector('pre').getAttribute('data-lang') !== 'JavaScript') bad.push('the code has no language');
    if (raw(li) || /^\s*[-*>] /m.test(fresh2.innerText)) bad.push('Markdown marks show');
    if (!/the value of b/.test(li.querySelector('.lagrange-reason').textContent)) bad.push('the reason is gone');
    li.querySelectorAll('button.lagrange-edit-more:not(.is-hidden)').forEach(b => b.click());
    await sleep(400);
    const out = overflow();
    if (out.length) bad.push(`sticks out of the panel: ${out.slice(0, 5).join(', ')}`);
    return bad.join('; ');
  }));

  await run('an edit list: plain words keep their white space; an edit to the marks alone shows the marks; a skipped edit is listed too', async () => withNote(NOTE, async () => {
    await queue(['Small ones.\n\n' + edits([{ find: 'It has  a doubled', replace: 'It has a doubled', reason: 'doubled space' }, { find: '*starred*', replace: '_starred_' }, { find: 'This text is not in the note.', replace: 'So `this` is skipped.' }])]);
    await send('Tidy.');
    await settled();
    const li = items(), bad = [];
    if (li.length !== 3) return `${li.length} edits are listed, not 3`;
    if (li[0].querySelector('del').textContent !== 'It has  a doubled' || !/pre/.test(getComputedStyle(li[0].querySelector('del')).whiteSpace)) bad.push('the doubled space is not shown');
    if (li[1].querySelector('del').textContent !== '*starred*' || li[1].querySelector('ins').textContent !== '_starred_') bad.push(`the marks are not shown: ${li[1].innerText}`);
    if (!li[2].closest('.lagrange-edits.is-skipped') || !/skipped: not found in the note/.test(li[2].innerText) || !li[2].querySelector('ins code')) bad.push(`the skipped edit: ${li[2].innerText.slice(0, 80)}`);
    return bad.join('; ');
  }));

  await run('an edit list: nothing an edit holds is fetched or run (a picture on the web, a frame, a block a plugin would act on)', async () => withNote(NOTE, async (md, file) => {
    const host = `edit-${stamp}.example.invalid`;
    // (the edit is skipped, so the note never holds it: whatever is asked of that address is asked by the chat)
    await queue(['Unsafe.\n\n' + edits([{ find: 'This text is not in the note.', replace: `Look: ![tracker](https://${host}/pixel.png?note=secret)\n\n<iframe src="https://${host}/frame"></iframe>\n\n<img src="https://${host}/img.png">\n\n\`\`\`dataviewjs\nwindow.__lagrangeRan = true\n\`\`\`` }])]);
    await send('Do it.');
    await settled();
    await sleep(800);
    const li = items()[0], bad = [];
    if (!li) return 'the skipped edit is not listed';
    li.querySelectorAll('button.lagrange-edit-more:not(.is-hidden)').forEach(b => b.click());
    await sleep(800);
    if (Array.from(li.querySelectorAll('img, iframe, video, object, embed, script')).some(e => /^(https?:)?\/\//i.test(e.getAttribute('src') || e.getAttribute('data') || ''))) bad.push('something in the list loads from the web');
    if (!Array.from(li.querySelectorAll('a')).some(a => (a.getAttribute('href') || '').includes(`${host}/pixel.png`))) bad.push('the picture is not shown as a link');
    if (performance.getEntriesByType('resource').some(e => e.name.includes(host))) bad.push('a request was made to the address');
    if (window.__lagrangeRan) bad.push('a block was run');
    if ((await app.vault.read(file)) !== NOTE) bad.push('the note was changed');
    return bad.join('; ');
  }));

  await run('the tasks: Proofread and Revise list their edits rendered, as a reply does', async () => withNote(NOTE, async md => {
    const bad = [], idle = async () => { for (let i = 0; i < 400 && plugin.editing; i++) await sleep(50); await settled(); };
    await queue([JSON.stringify([{ find: 'Call the helper to get the radius.', replace: 'Call `hill_radius()` to get the radius $r$.', reason: 'which helper' }])]);
    await plugin.proofread(md.view);
    await idle();
    const proof = Array.from(view().logEl.querySelectorAll('.lagrange-turn--task')).pop();
    const pi = proof && proof.querySelector('.lagrange-edits > li');
    if (!pi || !pi.querySelector('ins code') || !pi.querySelector('ins mjx-container') || /[`$]/.test(pi.innerText)) bad.push(`Proofread: ${pi ? pi.innerText.slice(0, 80) : 'no edit listed'}`);
    const text = md.view.editor.getValue(), passage = 'The energy is conserved along the orbit.', from = text.indexOf(passage);
    await queue(['The energy,\n\n$$E = T + V$$\n\nis conserved along the orbit.']);
    await plugin.revise(md.view, from, from + passage.length, passage, 'show the formula');
    await idle();
    const rev = Array.from(view().logEl.querySelectorAll('.lagrange-turn--task')).pop();
    const ri = rev && rev !== proof && rev.querySelector('.lagrange-edits > li');
    if (!ri || !ri.querySelector('ins.is-block mjx-container[display="true"]') || !ri.querySelector('del.is-block') || raw(ri)) bad.push(`Revise: ${ri ? ri.innerText.slice(0, 80) : 'no edit listed'}`);
    const out = overflow();
    if (out.length) bad.push(`sticks out of the panel: ${out.slice(0, 5).join(', ')}`);
    return bad.join('; ');
  }));

  await run('while a reply streams, a code block that is open shows as code, a formula and a figure as one line: never half a fence, and no block goes and comes back', async () => {
    const text = '*Here is the function*, with **bold** words, `inline` code and $x^2$ in a first paragraph: for a small $M_2$, its distance $r$ from the smaller mass is long enough to be seen as it comes.\n\n```python\ndef hill_radius(m1, m2, r):\n    # where a small body between two masses can rest\n    return r * (m2 / (3 * m1)) ** (1 / 3)\n```\n\nAnd the formula:\n\n$$\nr \\approx R \\left( \\frac{M_2}{3 M_1} \\right)^{1/3}\n$$\n\nThat is all there is to it, with $\\alpha$ last.';
    await queue([{ text, chunk: 3, delay: 25, first: 150 }]);   // (slowly enough that each open block is on screen for some frames)
    const seen = { twice: 0, marks: '', fence: '', openCode: 0, label: 0, mathLine: 0, rawMath: '', rawInline: '', openMath: 0, early: 0, late: '', codeSpan: 0, gap: 0, frames: 0 };
    let hadCode = false;
    seen.frames = await frames((b, open, p) => {
      const shown = open ? open.innerText : '';
      if (/(^|\n)\s*(`{1,3}|~{1,3})\w*\s*$/.test(shown) || /```/.test(shown)) seen.fence = shown.slice(-60);
      if (/\$\$|\\frac|\\approx/.test(shown)) seen.rawMath = shown.slice(-60);
      const prose = p.all;                                  // (not the open code: ** is Python's)
      if (/\*\*|`/.test(prose)) seen.marks = prose.slice(-60);
      // (no formula's source in the open prose, closed or still open: no dollar at all in this reply's prose)
      if (/\$|x\^2|M_2|\\alpha/.test(p.text)) seen.rawInline = p.text.slice(-60);
      if (/\$[^$\n]+\$/.test(b.innerText)) seen.rawInline = seen.rawInline || 'in the reply: ' + /\$[^$\n]+\$/.exec(b.innerText)[0];
      // (a formula is typeset as soon as it has closed: before the words after it, not when the paragraph is whole)
      if (p.math) seen.openMath++;
      if (p.math && /first paragraph/.test(p.all) && !/long enough/.test(p.all)) seen.early++;
      for (const [word, n] of [['first paragraph', 1], ['its distance', 2], ['from the smaller', 3]]) if (p.all.includes(word) && p.math < n) seen.late = `${JSON.stringify(word)} was shown with ${p.math} formula${p.math === 1 ? '' : 's'} typeset before it, not ${n}`;
      if (p.code) seen.codeSpan++;
      // (a paragraph is shown once: as it came, or set, never both)
      const words = b.innerText;
      if (words.split('Here is the').length > 2 || words.split('And the formula').length > 2 || words.split('That is all').length > 2) seen.twice++;
      if (/(^|\s)[*_](?=\S)/.test(prose.split('\n')[0])) seen.marks = prose.slice(0, 60);
      const oc = open && open.querySelector('pre.lagrange-open-code');
      if (oc) { seen.openCode++; if (oc.getAttribute('data-lang') === 'Python') seen.label++; }
      if (open && /Setting an equation/.test(shown)) seen.mathLine++;
      const anyCode = Boolean(b.querySelector('pre'));
      if (hadCode && !anyCode) seen.gap++;
      hadCode = hadCode || anyCode;
    }, () => send('Show me.'));
    const b = body(), bad = styled();
    if (seen.frames < 20) bad.push(`only ${seen.frames} frames were watched`);
    if (seen.fence) bad.push(`half a fence was shown: ${JSON.stringify(seen.fence)}`);
    if (seen.marks) bad.push(`marks of emphasis or code were shown: ${JSON.stringify(seen.marks)}`);
    if (seen.rawMath) bad.push(`the formula's source was shown: ${JSON.stringify(seen.rawMath)}`);
    if (seen.rawInline) bad.push(`an inline formula's source was shown: ${JSON.stringify(seen.rawInline)}`);
    if (!seen.early) bad.push(`no inline formula was typeset while its paragraph was still coming (${seen.openMath} frames with one in the open prose)`);
    if (seen.late) bad.push(seen.late);
    if (!seen.codeSpan) bad.push('the code span that had closed was never shown as code in the open prose');
    if (!seen.openCode) bad.push('the open code block was never shown as code');
    else if (seen.label < seen.openCode) bad.push('the open code block had no language');
    if (!seen.mathLine) bad.push('the open formula was never said');
    if (seen.twice) bad.push(`a paragraph stood in the reply twice for ${seen.twice} frame${seen.twice === 1 ? '' : 's'} (as it came, and set)`);
    if (seen.gap) bad.push(`the code block was gone for ${seen.gap} frame${seen.gap === 1 ? '' : 's'} between streaming and rendering`);
    if (!b.querySelector('pre[data-lang="Python"] code .token') || !b.querySelector('mjx-container[display="true"]')) bad.push('the finished reply is not rendered');
    if (b.querySelectorAll('mjx-container:not([display="true"])').length !== 4) bad.push(`the finished reply has ${b.querySelectorAll('mjx-container:not([display="true"])').length} inline formulas, not 4`);
    if (b.querySelector('.lagrange-turn-open, .lagrange-open-code, .lagrange-open-note, .lagrange-open-text')) bad.push('what was open is still there at the end');
    if (raw(b)) bad.push('raw Markdown is left in the reply');
    const streamed = blocksOf(b), whole = await wholeOf(text);
    if (streamed !== whole) bad.push(`the reply as it stands is not the reply rendered at once: ${firstDiff(streamed, whole)}`);
    info.push(`streaming case: ${seen.frames} frames, ${seen.openMath} with a formula typeset in the open prose, ${seen.early} of them before its paragraph was whole`);
    return bad.join('; ');
  });

  await run('while a paragraph streams, each inline formula is typeset as it closes; money, dollars in code and escaped dollars are never taken for one', async () => {
    const text = 'The fee is $5 for the lot and $7 more, with \\$3 escaped.\n\n' +
      'Call `cost($x$, $y$)` and then ``a ` $z$`` in code, plainly.\n\n' +
      'Then $a^2 + b^2 = c^2$ holds, with ($\\alpha$) for the angle and $\\frac{\\beth}{\\gimel}$, too; so says the book.\n\n' +
      'So:\n$$\ns = \\sum_{k} k\n$$\nwhere $k$ runs.\n\n' +
      '- an item with $e^{i\\pi} = -1$ in it\n- and one with **bold $\\beta$ words** at the very end';
    await queue([{ text, chunk: 2, delay: 16, first: 150 }]);
    const seen = { src: '', dollar: '', late: '', twice: 0, raw2: '', max: 0, money: 0, code: 0 };
    const n = await frames((b, open, p) => {
      // (the words of the open prose, without what is typeset and what is in a code span)
      if (/a\^2|c\^2|\\alpha|\\frac|\\beth|\\gimel|\\beta|\\sum|e\^\{|\\pi/.test(p.text)) seen.src = p.text.slice(-70);
      // (a dollar in the prose is money, the escaped one, or code of a span that is still open: never a formula's)
      const left = p.text.replace(/\$5|\$7|\$3/g, '').replace(/cost\(\$?x?\$?,? ?\$?y?\$?\)?/, '').replace(/a  ?\$?z?\$?/, '');
      if (/\$/.test(left)) seen.dollar = p.text.slice(-70);
      if (/\$5 for/.test(p.text)) seen.money++;
      if (p.code) seen.code++;
      seen.max = Math.max(seen.max, p.math);
      for (const [word, k] of [['holds', 1], ['for the angle', 2], ['too', 3]]) if (p.all.includes(word) && p.all.includes('Then') && p.math < k) seen.late = `${JSON.stringify(word)} was shown with ${p.math} typeset, not ${k}`;
      const words = b.innerText;
      for (const w of ['The fee is', 'Call', 'Then', 'So:', 'where', 'an item']) if (words.split(w).length > 2) seen.twice++;
      const all = open ? open.innerText : '';
      if (/\$\$|\\sum/.test(all)) seen.raw2 = all.slice(-60);
    }, () => send('Show me.'));
    const b = body(), bad = styled();
    if (n < 40) bad.push(`only ${n} frames were watched`);
    if (seen.src) bad.push(`a formula's source was shown: ${JSON.stringify(seen.src)}`);
    if (seen.dollar) bad.push(`a dollar that is neither money nor code was shown: ${JSON.stringify(seen.dollar)}`);
    if (seen.late) bad.push(seen.late);
    if (seen.max < 3) bad.push(`at most ${seen.max} formulas were typeset in the open prose at once, not 3`);
    if (!seen.money) bad.push('the money was not shown as it came');
    if (!seen.code) bad.push('no closed code span was shown as code in the open prose');
    if (seen.twice) bad.push(`a paragraph stood twice for ${seen.twice} frame${seen.twice === 1 ? '' : 's'}`);
    if (seen.raw2) bad.push(`a displayed formula's source was shown: ${JSON.stringify(seen.raw2)}`);
    const t = b.innerText;
    for (const w of ['$5 for the lot and $7 more, with $3 escaped.', 'cost($x$, $y$)', 'a ` $z$']) if (!t.includes(w)) bad.push(`the finished reply lacks ${JSON.stringify(w)}`);
    if (b.querySelectorAll('mjx-container').length !== 7 || b.querySelectorAll('mjx-container[display="true"]').length !== 1) bad.push(`the finished reply has ${b.querySelectorAll('mjx-container').length} formulas (${b.querySelectorAll('mjx-container[display="true"]').length} displayed), not 7 (1)`);
    if (b.querySelector('.lagrange-turn-open, .lagrange-open-text')) bad.push('what was open is still there at the end');
    const streamed = blocksOf(b), whole = await wholeOf(text);
    if (streamed !== whole) bad.push(`the reply as it stands is not the reply rendered at once: ${firstDiff(streamed, whole)}`);
    return bad.join('; ');
  });

  await run('the open prose is what Obsidian will set: for each of the hard cases, the same formulas, code spans and words as the rendered paragraph', async () => {
    const hard = ['a $x$ b', 'cost $5 and $10 more', 'cost $5 and$ 10', 'a $ x$ b', 'a $x $ b', 'a $x$1 b', 'a $x$, b', 'a ($x$) b', 'a $x$$y$ b', 'a \\$x$ b $y$', 'a $x\\$y$ b',
      'a `$x$` b $y$', 'a ``$x` $y$`` b', 'a \\(x\\) b', 'a \\[x\\] b', 'a $x\ny$ b', 'a $$x$$ b', 'a $x$$ b', 'a $1$2$ b', 'a $x$y$z$ b', 'it is 5$ and 6$ so',
      'a $x_1$ and *b $y$ c* and **d $z$**', 'a [l $x$](http://e.org) b', 'a $<b>x</b>$ c', 'a $x<y$ and $y>x$ c', 'a $`x`$ b', 'a `c` $x` y$ `d` b', 'a 2$x$ b', 'a $\\$$ b',
      'a $x\\\\$ b', 'a \\\\$x$ b', 'costs $5, or $6.', 'a $x$ `c $y$` $z$ b', 'a %%c $x$ d%% $y$ b', 'a ==$x$== and ~~$y$~~ b', 'a $x \\text{ if $y$ }$ b', 'a $\\frac{a}{b}$. Next'];
    const read = el => {
      const c = el.cloneNode(true);
      for (const m of Array.from(c.querySelectorAll('.math'))) m.replaceWith(`⟦${m.classList.contains('math-block') ? 'D' : 'M'}:${(m.querySelector('mjx-math') || m).getAttribute('data-latex') || m.textContent}⟧`);
      for (const k of Array.from(c.querySelectorAll('code'))) k.replaceWith(`⟨${k.textContent}⟩`);
      return c.textContent.replace(/\s+/g, ' ').trim();
    };
    const bad = [];
    await wholeOf('$x$');                                     // (MathJax is there)
    for (const md of hard) {
      const set = createDiv(), open = view().logEl.createDiv({ cls: 'lagrange-turn-open' });
      await view().renderChat(md, set, '', view());
      // (with a code block open under it: the paragraph is whole, nothing in it is waited for)
      view().showOpen(open, md + '\n\n```js\nx');
      await sleep(250);                                       // (a formula comes in when MathJax has its styles ready)
      const a = open.querySelector('.lagrange-open-text') ? read(open.querySelector('.lagrange-open-text')) : '', b = read(set);
      open.remove();
      if (a !== b) bad.push(`${JSON.stringify(md)}: open ${JSON.stringify(a)}, set ${JSON.stringify(b)}`);
    }
    return bad.slice(0, 6).join('; ');
  });

  await run('a very long paragraph streams without being set again at every step: a formula is typeset once and its element stays', async () => {
    const one = k => `With $x_{${k}}$ and \`c${k}\` and **bold** words it holds for every $n \\ge ${k}$, as was said. `;
    let para = '';
    for (let k = 1; k <= 150; k++) para += one(k);          // about 12 000 characters, 300 formulas
    const open = view().logEl.createDiv({ cls: 'lagrange-turn-open' });
    await wholeOf('$x$');
    // (every call of showOpen is timed, those it makes again itself when a formula's styles are ready too)
    const showOpen = view().showOpen;
    let total = 0, worst = 0, calls = 0, first = null, moved = 0, steps = 0;
    view().showOpen = function (...args) { const t0 = performance.now(); try { return showOpen.apply(this, args); } finally { const dt = performance.now() - t0; total += dt; worst = Math.max(worst, dt); calls++; } };
    let math = 0, codes = 0, naiveTotal = 0, naiveCalls = 0;
    try {
      for (let i = 40; i < para.length + 40; i += 40) {
        view().showOpen(open, para.slice(0, i));
        steps++;
        await sleep(0);
        const m = open.querySelector('.math');
        if (!first) first = m; else if (m !== first) moved++;
      }
      await sleep(200);
      math = open.querySelectorAll('mjx-container').length; codes = open.querySelectorAll('code').length;
      // the same steps with everything put in again each time, as a measure (what the tail did before, with the mathematics added)
      const mine = { total, calls, worst };
      for (let i = 40; i < para.length + 40; i += 400) {
        const fresh = view().logEl.createDiv({ cls: 'lagrange-turn-open' });
        view().showOpen(fresh, para.slice(0, i));
        await sleep(30);
        fresh.remove();
      }
      naiveTotal = total - mine.total; naiveCalls = Math.ceil(para.length / 400);
      total = mine.total; calls = mine.calls; worst = mine.worst;
    } finally { view().showOpen = showOpen; }
    open.remove();
    info.push(`long paragraph: ${para.length} characters, ${math} formulas, ${steps} steps of 40 characters, ${calls} calls: ${total.toFixed(0)} ms in all (${(total / steps).toFixed(2)} ms a step, worst call ${worst.toFixed(1)} ms); with everything set again at each step it would be about ${(naiveTotal / naiveCalls * steps).toFixed(0)} ms (measured at every tenth step: ${(naiveTotal / naiveCalls).toFixed(1)} ms a step on average)`);
    const bad = [];
    if (math !== 300 || codes !== 150) bad.push(`${math} formulas and ${codes} code spans at the end, not 300 and 150`);
    if (moved) bad.push(`the first formula's element was replaced at ${moved} steps`);
    if (total / steps > 12) bad.push(`a step took ${(total / steps).toFixed(1)} ms on average (${total.toFixed(0)} ms in all)`);
    // and through the chat itself, fast: the reply ends as the whole
    const text = para + '\n\nThe end.';
    await queue([{ text, chunk: 60, delay: 2, first: 100 }]);
    let most = 0;
    await frames((b, o, p) => { most = Math.max(most, p.math); if (/\$|x_\{|\\ge/.test(p.text)) bad.push(`a formula's source was shown: ${JSON.stringify(p.text.slice(-50))}`); }, () => send('A long one.'));
    bad.push(...styled());
    if (most < 20) bad.push(`only ${most} formulas were typeset in the open prose while it streamed`);
    const streamed = blocksOf(body()), whole = await wholeOf(text);
    if (streamed !== whole) bad.push(`the reply as it stands is not the reply rendered at once: ${firstDiff(streamed, whole)}`);
    return Array.from(new Set(bad)).slice(0, 4).join('; ');
  });

  await run('in demo mode too: the explanation\'s inline mathematics is typeset while its paragraph is still coming', async () => {
    const was = plugin.settings.provider;
    plugin.settings.provider = 'demo';
    try {
      const seen = { early: 0, src: '', twice: 0, raw2: '' };
      const n = await frames((b, open, p) => {
        if (p.math && !/Hill radius/.test(p.all)) seen.early++;
        if (/\$|M_2/.test(p.text)) seen.src = p.text.slice(-60);
        if (b.innerText.split('A small body between').length > 2) seen.twice++;
        if (/\$\$|\\frac|\\approx/.test(open ? open.innerText : '')) seen.raw2 = open.innerText.slice(-60);
      }, () => send('Explain the first point'));
      const b = body(), bad = styled();
      if (!seen.early) bad.push(`no formula was typeset before the paragraph was whole (${n} frames)`);
      if (seen.src) bad.push(`a formula's source was shown: ${JSON.stringify(seen.src)}`);
      if (seen.twice) bad.push(`the paragraph stood twice for ${seen.twice} frames`);
      if (seen.raw2) bad.push(`the displayed formula's source was shown: ${JSON.stringify(seen.raw2)}`);
      if (b.querySelectorAll('mjx-container:not([display="true"])').length < 2 || !b.querySelector('mjx-container[display="true"]')) bad.push('the finished reply is not typeset');
      if (b.querySelector('.lagrange-turn-open')) bad.push('what was open is still there at the end');
      return bad.join('; ');
    } finally { plugin.settings.provider = was; }
  });

  // ---- the loader's plates ----
  // The plates the loaders of one request showed (data-plate), in the order they came in.
  const platesOf = async (ask, replies) => {
    const seen = [], met = new Set();      // (each loader once, however its parts come into the log)
    const mo = new MutationObserver(() => { for (const l of view().logEl.querySelectorAll('.lagrange-loader')) if (!met.has(l)) { met.add(l); seen.push(l.getAttribute('data-plate')); } });
    mo.observe(view().logEl, { childList: true, subtree: true });
    try { if (replies) await queue(replies); await ask(); await sleep(150); } finally { mo.disconnect(); }
    return seen;
  };
  const NAMES = I.PLATE_NAMES, after = name => NAMES[(NAMES.indexOf(name) + 1) % NAMES.length];

  await run('the loader: nine requests in a row show the three plates in turn, three times round, through a server as in the demo', async () => {
    const theme = plugin.settings.loaderTheme, bad = [];
    plugin.settings.loaderTheme = 'cycle';
    try {
      const seen = [];
      for (let i = 0; i < 9; i++) seen.push((await platesOf(() => send(`Question ${i + 1}`), [{ text: 'A short answer.', first: 200 }])).join('+') || 'none');
      if (!NAMES.includes(seen[0])) bad.push(`the first request showed ${seen[0]}`);
      const want = seen.map((_, i) => NAMES[(NAMES.indexOf(seen[0]) + i) % NAMES.length]);
      if (seen.join(',') !== want.join(',')) bad.push(`the plates were ${seen.join(', ')}, not ${want.join(', ')}`);
      if (new Set(seen).size !== 3) bad.push(`only ${Array.from(new Set(seen)).join(', ')} were seen`);
      // the demo (no server): the same turn goes on
      const provider = plugin.settings.provider;
      plugin.settings.provider = 'demo';
      const demo = [];
      for (const q of ['What is this note about?', 'And how long is it?', 'What does it open with?']) demo.push((await platesOf(() => send(q))).join('+') || 'none');
      plugin.settings.provider = provider;
      const wantDemo = [after(seen[8]), after(after(seen[8])), seen[8]];
      if (demo.join(',') !== wantDemo.join(',')) bad.push(`in demo mode the plates were ${demo.join(', ')}, not ${wantDemo.join(', ')}`);
      // where the turn begins can be told (as the recording of the demo does), and the turn goes on from there
      I.loaderTurn.last = 'alchemy';
      const told = (await platesOf(() => send('From here'), [{ text: 'Yes.', first: 200 }])).join('+');
      if (told !== 'orbit') bad.push(`after alchemy came ${told}`);
      // a plate chosen in the settings is that plate every time, and takes no turn
      plugin.settings.loaderTheme = 'clockwork';
      const chosen = [];
      for (let i = 0; i < 2; i++) chosen.push((await platesOf(() => send(`Chosen ${i}`), [{ text: 'Yes.', first: 200 }])).join('+'));
      if (chosen.join(',') !== 'clockwork,clockwork') bad.push(`with Clockwork chosen the plates were ${chosen.join(', ')}`);
      plugin.settings.loaderTheme = 'cycle';
      const back = (await platesOf(() => send('In turn again'), [{ text: 'Yes.', first: 200 }])).join('+');
      if (back !== 'clockwork') bad.push(`in turn again, after orbit came ${back}`);
    } finally { plugin.settings.loaderTheme = theme; }
    return bad.join('; ');
  });

  await run('the loader: a request answered in two replies (a look at the page in between) shows one plate, and a task takes the next', async () => {
    const theme = plugin.settings.loaderTheme, look = plugin.settings.lookAtPage, bad = [];
    const md = app.workspace.getLeavesOfType('markdown')[0];
    if (!md || !md.view.file) return 'no note is open';
    Object.assign(plugin.settings, { loaderTheme: 'cycle', lookAtPage: true });
    try {
      I.loaderTurn.last = 'orbit';
      const two = await platesOf(() => send('How does the page look?'), ['Let me look.\n\n```lagrange-look\n{"target": "note"}\n```', 'It looks well.']);
      if (two.length !== 2) bad.push(`the request showed ${two.length} loaders (${two.join(', ')}), so it did not look at the page`);
      if (two.some(p => p !== 'clockwork')) bad.push(`the request showed ${two.join(', ')}, not clockwork throughout`);
      const next = (await platesOf(() => send('And now?'), [{ text: 'Yes.', first: 200 }])).join('+');
      if (next !== 'alchemy') bad.push(`the request after it showed ${next}, not alchemy`);
      const task = await platesOf(async () => { await plugin.proofread(md.view); for (let i = 0; i < 400 && plugin.editing; i++) await sleep(50); }, ['[]']);
      if (task.join('+') !== 'orbit') bad.push(`Proofread showed ${task.join(', ') || 'no plate'}, not orbit`);
    } finally { Object.assign(plugin.settings, { loaderTheme: theme, lookAtPage: look }); }
    return bad.join('; ');
  });

  await run('the loader: each of the three plates is drawn, inside the panel, and moves', async () => {
    const bad = [], root = view().contentEl.getBoundingClientRect(), still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const name of NAMES) {
      const slot = view().logEl.createDiv({ cls: 'lagrange-loader-slot' });
      const loader = plugin.constructor.mountLoader(slot, name);
      await sleep(400);
      const el = slot.querySelector('.lagrange-loader'), svg = el && el.querySelector('svg.lagrange-plate');
      if (!svg) { bad.push(`${name}: no plate`); loader.stop(); slot.remove(); continue; }
      const r = svg.getBoundingClientRect(), cs = getComputedStyle(svg), before = svg.innerHTML;
      await sleep(600);
      if (el.getAttribute('data-plate') !== name || !el.classList.contains(`lagrange-loader--${name}`)) bad.push(`${name}: it is marked ${el.getAttribute('data-plate')}`);
      if (r.width < 120 || r.height < 90) bad.push(`${name}: the plate is ${Math.round(r.width)}×${Math.round(r.height)} px`);
      if (r.left < root.left - 0.5 || r.right > root.right + 0.5) bad.push(`${name}: the plate sticks out of the panel`);
      if (cs.display === 'none' || cs.visibility !== 'visible' || Number(cs.opacity) < 0.5) bad.push(`${name}: the plate is hidden`);
      if (svg.querySelectorAll('path, circle, line, rect, ellipse, polygon, polyline, text').length < 10) bad.push(`${name}: the plate is all but empty`);
      if (!still && svg.innerHTML === before) bad.push(`${name}: the plate does not move`);
      if (!/^Lagrange is /.test(el.querySelector('.lagrange-loader-caption').textContent)) bad.push(`${name}: no caption`);
      loader.stop();
      if (slot.querySelector('.lagrange-loader')) bad.push(`${name}: the plate stays after it is stopped`);
      slot.remove();
    }
    return bad.join('; ');
  });

  // ---- afterwards ----
  view().clear();
  Object.assign(plugin.settings, saved);
  plugin.session = savedSession;
  await plugin.saveSettings();
  const failed = cases.filter(c => !c.ok).length;
  console.table(cases);
  return JSON.stringify({ ok: !failed, failed, cases, info });
})()
