// Lagrange's autocorrect (1.5.0), checked in a real Obsidian: off unless turned on; with this computer's spelling
// dictionary (Electron's, as Obsidian's spell-check uses it) the pen corrects slips of typing a moment after they are
// typed, while the writer goes on typing (every key lands, in order, at the cursor; the cursor and the view do not
// move); the word being typed is left alone until it is finished; nothing in code, mathematics, front matter,
// links, tags or web addresses is touched, nor a name or a word the note uses again and again; one Undo takes back
// a run of corrections and only it, and a correction taken back is not made again; with the model (a mock server)
// only slips of typing in the words just typed are made, and the request says what it asks; in demo mode the
// demo's little dictionary is used; without the pen the corrections are made at once; typing through the
// browser's own input (as a keyboard does) is watched too; a request from the chat while the pen corrects gets its
// edits made after the correction is set down.
//
// This cannot run under Node (it needs Obsidian, CodeMirror and Electron's spelling dictionary), so it is not part
// of `node --test`. To run it:
//   1. start the mock server:  node plugins-tests/mock-chat-server.mjs 48914
//   2. open a Scriptorium vault in Obsidian with Lagrange on;
//   3. paste this file into the developer console, or evaluate it with Runtime.evaluate (awaitPromise: true).
// It answers with a JSON string {ok, failed, cases: [{name, ok, why}], info} and prints a table. Options, set
// first: window.autocorrectOptions = {server: 'http://127.0.0.1:48914', only: 'text in a case name'}. Typing is
// done as CodeMirror's own input does it (transactions marked input.type), and once through the browser
// (document.execCommand('insertText')). The settings are put back afterwards; the notes it writes are in a folder
// "Lagrange autocorrect harness", removed at the end.
//
// Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).
(async () => {
  const opt = window.autocorrectOptions || {};
  const server = String(opt.server || 'http://127.0.0.1:48914').replace(/\/+$/, '');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const plugin = app.plugins.plugins.lagrange;
  const I = plugin.constructor.internals;
  const cases = [], info = [];
  const DIR = 'Lagrange autocorrect harness';
  const saved = Object.assign({}, plugin.settings), savedSession = plugin.session;
  document.querySelectorAll('.modal-container').forEach(m => m.remove());
  if (!app.vault.getAbstractFileByPath(DIR)) await app.vault.createFolder(DIR);
  const queue = async replies => {
    const r = await fetch(`${server}/__queue`, { method: 'POST', body: JSON.stringify(replies.map(t => (typeof t === 'string' ? { text: t, chunk: 80, delay: 2, first: 150 } : t))) });
    if (!r.ok) throw new Error(`the mock server did not take the replies (${r.status})`);
  };
  const requests = async () => (await fetch(`${server}/__requests`)).json();
  const base = { agenticEdits: true, showPen: true, penSpeed: 1, editWhileWriting: false, severalPens: false, provider: 'demo' };
  const open = async (name, text, at, source) => {
    const path = `${DIR}/${name}.md`;
    let f = app.vault.getAbstractFileByPath(path);
    if (f) await app.vault.modify(f, text); else f = await app.vault.create(path, text);
    const leaf = app.workspace.getLeavesOfType('markdown')[0] || app.workspace.getLeaf(false);
    await leaf.openFile(f, { state: { mode: 'source', source: Boolean(source) } });
    app.workspace.setActiveLeaf(leaf, { focus: true });
    await sleep(600);
    const v = leaf.view, cm = v.editor.cm;
    cm.dispatch({ selection: { anchor: at == null ? cm.state.doc.length : at } });
    await sleep(200);
    return v;
  };
  // typing as CodeMirror's input does: one character at a time at the cursor
  const type = async (cm, s, gap) => {
    for (const ch of s) {
      cm.dispatch(cm.state.replaceSelection(ch), { userEvent: 'input.type', scrollIntoView: true });
      await sleep(gap == null ? 55 : gap);
    }
  };
  let penSeen = false, penTimer = null;
  const watchPen = () => { penSeen = false; penTimer = setInterval(() => { const p = document.querySelector('.lagrange-pen'); if (p && p.style.display !== 'none' && p.getBoundingClientRect().width > 0) penSeen = true; }, 25); };
  const unwatchPen = () => { clearInterval(penTimer); penTimer = null; };
  const quiet = async (cm, ms) => { await sleep(ms || 2600); for (let i = 0; i < 200 && (plugin.autocorrect.running); i++) await sleep(50); await sleep(300); };
  const run = async (name, fn) => {
    if (opt.only && !name.includes(opt.only)) return;
    const c = { name, ok: false, why: '' };
    try {
      plugin.autocorrect.stop();
      plugin.autocorrect.declined.clear();
      Object.assign(plugin.settings, base);
      const why = await fn();
      c.ok = !why;
      c.why = why || '';
    } catch (e) { c.why = `threw: ${String((e && e.stack) || e).slice(0, 400)}`; }
    unwatchPen();
    plugin.pen.finish();
    plugin.settings.autocorrect = 'off';
    cases.push(c);
  };
  const dict = (() => { try { return require('electron').webFrame; } catch (e) { return null; } })();
  info.push(`this computer's dictionary: ${dict ? `teh misspelled ${dict.isWordMisspelled('teh')}, suggestions ${JSON.stringify(dict.getWordSuggestions('teh'))}` : 'none'}`);

  await run('off unless turned on: typing slips changes nothing, and a vault with no setting has it off', async () => {
    if (I.sanitizeSettings({}).autocorrect !== 'off' || I.sanitizeSettings({ autocorrect: 'everything' }).autocorrect !== 'off') return 'the default is not off';
    plugin.settings.autocorrect = 'off';
    const v = await open('Off', '# Off\n\n');
    const cm = v.editor.cm;
    await type(cm, 'I recieve teh letter ');
    await quiet(cm);
    return cm.state.doc.toString().endsWith('I recieve teh letter ') ? '' : `the note changed: ${JSON.stringify(cm.state.doc.toString())}`;
  });

  await run('the dictionary: the pen corrects the slips a moment after they are typed; the cursor and the view stay', async () => {
    plugin.settings.autocorrect = 'dictionary';
    const filler = Array.from({ length: 40 }, (_, i) => `Line ${i} of filler, so that the note scrolls.`).join('\n\n');
    const v = await open('Dictionary', `# Dictionary\n\n${filler}\n\n`);
    const cm = v.editor.cm;
    await type(cm, 'I recieve teh letter ');
    const top = cm.scrollDOM.scrollTop;
    watchPen();
    await quiet(cm);
    unwatchPen();
    const bad = [];
    const doc = cm.state.doc.toString();
    if (!doc.endsWith('I receive the letter ')) bad.push(`the note ends ${JSON.stringify(doc.slice(-40))}`);
    if (cm.state.selection.main.head !== doc.length) bad.push('the cursor moved');
    if (Math.abs(cm.scrollDOM.scrollTop - top) > 2) bad.push(`the view scrolled by ${cm.scrollDOM.scrollTop - top}px`);
    if (!penSeen) bad.push('the pen was not seen');
    return bad.join('; ');
  });

  await run('typing on while the pen corrects: every key lands in order at the cursor, and the correction is still made', async () => {
    plugin.settings.autocorrect = 'dictionary';
    const v = await open('Typing on', '# Typing on\n\n');
    const cm = v.editor.cm;
    await type(cm, 'Thier dog barked ');
    // wait for the pen to set out, then go on typing while it works
    for (let i = 0; i < 80 && !plugin.autocorrect.running; i++) await sleep(50);
    const during = Boolean(plugin.autocorrect.running);
    await type(cm, 'and the cat ran off quickly.', 40);
    await quiet(cm);
    const bad = [];
    const doc = cm.state.doc.toString();
    if (!during) bad.push('the pen was not at work while typing went on');
    if (!doc.endsWith('Their dog barked and the cat ran off quickly.')) bad.push(`the note ends ${JSON.stringify(doc.slice(-60))}`);
    if (cm.state.selection.main.head !== doc.length) bad.push('the cursor is not after the last key');
    return bad.join('; ');
  });

  await run('one undo takes back a run of corrections and only it; a correction taken back is not made again', async () => {
    plugin.settings.autocorrect = 'dictionary';
    const v = await open('Undo', '# Undo\n\n');
    const cm = v.editor.cm;
    await type(cm, 'We recieve teh post ');
    await quiet(cm);
    const after = cm.state.doc.toString();
    await type(cm, 'daily.');
    await sleep(1600);
    const bad = [];
    if (!after.endsWith('receive the post ')) bad.push(`not corrected: ${JSON.stringify(after.slice(-30))}`);
    v.editor.undo();        // the typing of "daily." (one step of typing)
    await sleep(200);
    if (cm.state.doc.toString() !== after) bad.push(`the first undo did not take back only the typing after the run: ${JSON.stringify(cm.state.doc.toString().slice(-40))}`);
    v.editor.undo();        // the run of corrections
    await sleep(200);
    const undone = cm.state.doc.toString();
    if (!undone.endsWith('recieve teh post ')) bad.push(`the second undo did not take back the corrections: ${JSON.stringify(undone.slice(-40))}`);
    if (!undone.includes('# Undo\n\nWe ')) bad.push('the undo took more than the corrections');
    await quiet(cm, 2600);
    if (!cm.state.doc.toString().endsWith('recieve teh post ')) bad.push('a correction taken back was made again');
    await type(cm, 'Then teh end ');
    await quiet(cm);
    if (!cm.state.doc.toString().endsWith('Then teh end ')) bad.push('the same slip typed again was corrected after the writer had taken it back');
    return bad.join('; ');
  });

  await run('the word being typed is left alone until it is finished', async () => {
    plugin.settings.autocorrect = 'dictionary';
    const v = await open('Unfinished', '# Unfinished\n\n');
    const cm = v.editor.cm;
    await type(cm, 'We recie');
    await quiet(cm, 2400);
    const bad = [];
    if (!cm.state.doc.toString().endsWith('We recie')) bad.push('the unfinished word was changed');
    await type(cm, 'ved it ');
    await quiet(cm);
    if (!cm.state.doc.toString().endsWith('We received it ')) bad.push(`once finished it was not corrected: ${JSON.stringify(cm.state.doc.toString().slice(-30))}`);
    return bad.join('; ');
  });

  await run('never in code, mathematics, front matter, links, tags or web addresses; nor names and the writer’s own terms', async () => {
    plugin.settings.autocorrect = 'dictionary';
    const text = '---\ntitle: x\n---\n\n# Places\n\n```\n\n```\n\nInline `` and $$ and [[]] and #\n\nhttps://example.com/\n\nWe met  at noon.\n\nThe  and the  and the \n';
    // (in Source mode: Live Preview shows the front matter as Properties, which the writer edits in boxes of their own)
    const v = await open('Places', text, null, true);
    const cm = v.editor.cm;
    const at = (needle, k) => { const d = cm.state.doc.toString(); let i = -1; for (let n = 0; n <= (k || 0); n++) i = d.indexOf(needle, i + 1); return i; };
    const put = async (pos, s) => { cm.dispatch({ selection: { anchor: pos } }); await type(cm, s, 30); };
    await put(at('title: x') + 8, ' teh recieve wiht');              // front matter
    await put(at('```\n') + 4, 'teh recieve wiht ');                 // code block
    await put(at('Inline `') + 8, 'teh recieve');                    // inline code (before its closing tick)
    await put(at(' and $') + 6, 'teh + recieve');                    // mathematics
    await put(at('[[') + 2, 'teh recieve');                          // a wikilink
    await put(at(' #') + 2, 'tehtag ');                              // a tag
    await put(at('https://example.com/') + 20, 'teh/recieve ');      // a web address
    await put(at('We met ') + 7, 'Zanthrope');                       // a name, inside a sentence
    await put(at('The ') + 4, 'florbish');                           // a term of the writer's own, three times
    await put(at('the  and') + 4, 'florbish');
    await put(at('the \n') + 4, 'florbish ');
    await quiet(cm, 3200);
    const doc = cm.state.doc.toString();
    const bad = [];
    for (const piece of ['title: x teh recieve wiht', '```\nteh recieve wiht \n```', '`teh recieve`', '$teh + recieve$', '[[teh recieve]]', '#tehtag', 'https://example.com/teh/recieve', 'met Zanthrope at', 'The florbish and the florbish and the florbish']) {
      if (!doc.includes(piece)) bad.push(`changed: ${piece}`);
    }
    if (bad.length) info.push(`the note of the places case: ${JSON.stringify(doc.slice(0, 400))}`);
    return bad.join('; ');
  });

  await run('through the browser’s own input (as a keyboard types): watched and corrected the same way', async () => {
    plugin.settings.autocorrect = 'dictionary';
    const v = await open('Keyboard', '# Keyboard\n\n');
    const cm = v.editor.cm;
    cm.focus();
    await sleep(100);
    for (const ch of 'A wierd day ') { document.execCommand('insertText', false, ch); await sleep(50); }
    await quiet(cm);
    const doc = cm.state.doc.toString();
    if (doc === '# Keyboard\n\n') return 'the browser’s input did not reach the note (the editor did not have the keyboard)';
    return doc.endsWith('A weird day ') ? '' : `the note ends ${JSON.stringify(doc.slice(-30))}`;
  });

  await run('without the pen the corrections are made at once, still one undo step, and the view does not move', async () => {
    Object.assign(plugin.settings, { autocorrect: 'dictionary', showPen: false });
    const v = await open('No pen', '# No pen\n\n');
    const cm = v.editor.cm;
    watchPen();
    await type(cm, 'I beleive adn hope ');
    await quiet(cm);
    unwatchPen();
    const bad = [];
    if (!cm.state.doc.toString().endsWith('I believe and hope ')) bad.push(`the note ends ${JSON.stringify(cm.state.doc.toString().slice(-30))}`);
    if (penSeen) bad.push('the pen was seen');
    v.editor.undo();
    await sleep(200);
    if (!cm.state.doc.toString().endsWith('I beleive adn hope ')) bad.push('one undo did not take both back');
    return bad.join('; ');
  });

  await run('with the model: only slips of typing in the words just typed are made; the request says what it asks', async () => {
    Object.assign(plugin.settings, { autocorrect: 'model', provider: 'openai', openaiBaseUrl: `${server}/v1`, openaiModel: 'mock', openaiApiKey: '' });
    plugin.session = { noFallback: false, noEffort: {}, noPictures: {} };
    await queue([JSON.stringify([{ find: 'form', replace: 'from' }, { find: 'station', replace: 'terminal' }, { find: 'Earlier', replace: 'Before' }])]);
    const v = await open('Model', '# Model\n\nEarlier text stays.\n\n');
    const cm = v.editor.cm;
    await type(cm, 'I came form the station ');
    await quiet(cm, 3500);
    const bad = [];
    const doc = cm.state.doc.toString();
    if (!doc.endsWith('I came from the station ')) bad.push(`the note ends ${JSON.stringify(doc.slice(-40))}`);
    if (!doc.includes('Earlier text stays.')) bad.push('a word that was not asked about was changed');
    const reqs = await requests();
    const body = JSON.stringify(reqs[0] || {});
    if (!reqs.length) bad.push('no request reached the server');
    else {
      if (!body.includes('the autocorrect of Lagrange')) bad.push('the request does not carry the autocorrect instructions');
      if (!/The words just typed: I?,? ?came, form, the, station|The words just typed: came, form, the, station/.test(body)) bad.push(`the words asked about: ${(/The words just typed: [^"\\]*/.exec(body) || [''])[0]}`);
      if (!body.includes('I came form the station')) bad.push('the passage was not sent');
    }
    if (reqs.length > 1) bad.push(`${reqs.length} requests for one pause`);
    return bad.join('; ');
  });

  await run('in demo mode with the model: the demo’s little dictionary', async () => {
    Object.assign(plugin.settings, { autocorrect: 'model', provider: 'demo' });
    const v = await open('Demo', '# Demo\n\n');
    const cm = v.editor.cm;
    await type(cm, 'It is truely neccessary ');
    await quiet(cm, 3200);
    const doc = cm.state.doc.toString();
    return doc.endsWith('It is truly necessary ') ? '' : `the note ends ${JSON.stringify(doc.slice(-40))}`;
  });

  await run('a request from the chat while the pen corrects: the correction is set down at once and the chat’s edit follows', async () => {
    Object.assign(plugin.settings, { autocorrect: 'dictionary', provider: 'openai', openaiBaseUrl: `${server}/v1`, openaiModel: 'mock', openaiApiKey: '' });
    await plugin.activateView(false);
    const chat = app.workspace.getLeavesOfType('lagrange-chat')[0].view;
    chat.clear();
    await queue([`Done.\n\n\`\`\`lagrange-edits\n${JSON.stringify([{ append: 'A line from the chat.' }])}\n\`\`\``]);
    const v = await open('Both', '# Both\n\n');
    const cm = v.editor.cm;
    await type(cm, 'The goverment said so ');
    for (let i = 0; i < 80 && !plugin.autocorrect.running; i++) await sleep(50);
    const during = Boolean(plugin.autocorrect.running);
    chat.inputEl.value = 'Add a line';
    await chat.send();
    for (let i = 0; i < 400 && (chat.pending || plugin.editing); i++) await sleep(50);
    await sleep(500);
    const doc = cm.state.doc.toString();
    const bad = [];
    if (!during) info.push('the chat case: the pen had already finished when the chat asked (timing)');
    if (!doc.includes('The government said so')) bad.push('the correction was lost');
    if (!doc.includes('A line from the chat.')) bad.push('the chat’s edit was not made');
    chat.clear();
    return bad.join('; ');
  });

  // ---- clean up ----
  Object.assign(plugin.settings, saved);
  plugin.session = savedSession;
  plugin.autocorrect.stop();
  plugin.autocorrect.declined.clear();
  try { const d = app.vault.getAbstractFileByPath(DIR); if (d && !opt.keep) await app.vault.delete(d, true); } catch (e) { /* kept */ }
  const failed = cases.filter(c => !c.ok).length;
  console.table(cases);
  return JSON.stringify({ ok: !failed, failed, cases, info });
})();
