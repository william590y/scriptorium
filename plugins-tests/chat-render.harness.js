// What Lagrange's chat shows, checked in a real Obsidian: a reply with code, mathematics, a table, a Mermaid diagram
// and a TikZ figure is set as a note would set it and stays inside the panel; a TikZ figure that TikZJax has never
// compiled is drawn in the chat (TikZJax 0.5.2 leaves such a figure on its spinner for ever when it meets it twice:
// see renderApart in the plugin); a figure with an error in it gives way to its source and a line that says so, and
// so does one that never comes; an edit that writes a broken figure into the note is said in the chat and does not
// keep the pen waiting; the writer's own message is rendered; a picture at a web address in a reply is not fetched;
// a pasted picture and a pasted text file become chips, show in the sent message and reach the server (the picture
// as an image part, the file as its text).
//
// This cannot run under Node (it needs Obsidian's renderer and the plugins), so it is not part of `node --test`.
// To run it:
//   1. start the mock server:  node plugins-tests/mock-chat-server.mjs 48914
//   2. open a Scriptorium vault in Obsidian with Lagrange on, and TikZJax on for the figure cases (they fail, saying
//      so, where it is off), with a note open;
//   3. paste this file into the developer console, or evaluate it with Runtime.evaluate (awaitPromise: true).
// It answers with a JSON string {ok, failed, cases: [{name, ok, why}]} and prints a table. Options, set first:
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
  const cases = [];
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

  // ---- afterwards ----
  view().clear();
  Object.assign(plugin.settings, saved);
  plugin.session = savedSession;
  await plugin.saveSettings();
  const failed = cases.filter(c => !c.ok).length;
  console.table(cases);
  return JSON.stringify({ ok: !failed, failed, cases });
})()
