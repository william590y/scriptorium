// The subtitle (a "###### " line) in Live Preview, checked in a real Obsidian: it has the short rule Reading view
// draws under it, and stands where Reading view has it (its text, the rule, and the paragraph after the blank line),
// in normal and in Fancy mode; Source mode has no rule; with the cursor on the subtitle's line the rule stays and
// nothing below moves, also while the line is typed in; and a note without a subtitle is laid out exactly as it is
// with the rule's styles taken away (which is how 1.4.0 lays it out), line by line.
//
// This cannot run under Node (it needs Obsidian's editor and its layout), so it is not part of `node --test`.
// To run it: open a Scriptorium vault in Obsidian (the Scriptorium plugin and the manuscript snippet on, a note
// open), and paste this file into the developer console, or evaluate it with Runtime.evaluate (awaitPromise: true).
// It makes two notes ("Subtitle check.md", "Subtitle check, none.md") and deletes them afterwards; Fancy mode is put
// back as it was. It answers with a JSON text {ok, failed, cases: [{name, ok, why, ...numbers}]} and prints a table.
// Options: window.subtitleLiveOptions = {only: 'text in a case name', keepNotes: true}.
//
// Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).
(async () => {
  const options = window.subtitleLiveOptions || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const scriptorium = app.plugins.plugins.scriptorium;
  const fancyWas = Boolean(scriptorium.settings.fancyMode);
  const cases = [];
  const fx = v => Math.round(v * 100) / 100;
  const WITH = '###### A note on the five points\n\nLagrange found five places where a small body can rest between two great ones. He called the result a curiosity, and for a century it was one, until an asteroid turned up.\n\nThe first three lie on the line through the two masses.\n';
  const NONE = 'Lagrange found five places where a small body can rest between two great ones. He called the result a curiosity, and for a century it was one.\n\n## A chapter\n\nThe first three lie on the line through the two masses.\n\n> A quotation, set as one.\n\n- one\n- two\n';
  const put = async (path, text) => { const f = app.vault.getAbstractFileByPath(path); if (f) { await app.vault.modify(f, text); return f; } return app.vault.create(path, text); };
  const fileWith = await put('Subtitle check.md', WITH), fileNone = await put('Subtitle check, none.md', NONE);
  const leaf = app.workspace.getLeavesOfType('markdown')[0] || app.workspace.getLeaf(true);
  const open = async (file, mode) => {
    await leaf.openFile(file, { state: mode === 'reading' ? { mode: 'preview' } : { mode: 'source', source: mode === 'source' } });
    await sleep(900);
    if (mode !== 'reading') { const cm = leaf.view.editor.cm; cm.dispatch({ selection: { anchor: cm.state.doc.length } }); await sleep(500); }
  };
  const rectOf = node => { const r = document.createRange(); r.selectNodeContents(node); return r.getBoundingClientRect(); };
  const firstText = el => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.trim() && !n.parentElement.closest('.cm-formatting')) return n; return null; };
  const firstChar = el => { const n = firstText(el), r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 1); return r.getBoundingClientRect(); };
  const root = () => leaf.view.containerEl.querySelector(leaf.view.getMode() === 'preview' ? '.markdown-reading-view' : '.markdown-source-view');
  const subEl = () => root().querySelector(leaf.view.getMode() === 'preview' ? 'h6' : '.cm-line.HyperMD-header-6');
  const paraEl = () => (leaf.view.getMode() === 'preview' ? root().querySelector('.el-p p') : Array.from(root().querySelectorAll('.cm-content > .cm-line')).find(l => /^Lagrange found/.test(l.textContent)));
  // the subtitle, its rule and the paragraph after it, measured from the note's title
  const measure = () => {
    const title = rectOf(firstText(root().querySelector('.inline-title')));
    const sub = subEl(), s = rectOf(firstText(sub)), box = sub.getBoundingClientRect(), cs = getComputedStyle(sub), after = getComputedStyle(sub, '::after');
    const rule = after.content !== 'none' && after.display !== 'none' && parseFloat(after.borderTopWidth) > 0;
    // (the paragraph by its own box: its first letter may be a drop cap in one view and not in the other)
    const p = paraEl().getBoundingClientRect();
    return { centre: fx((s.left + s.right) / 2 - (title.left + title.right) / 2), top: fx(s.top - title.bottom), rule,
      ruleTop: rule ? fx(box.bottom - (parseFloat(cs.paddingBottom) || 0) - parseFloat(after.borderTopWidth) - title.bottom) : null,
      ruleWidth: rule ? parseFloat(after.width) : null, ruleColour: rule ? after.borderTopColor : null,
      para: fx(p.top - title.bottom), paraLeft: fx(p.left - title.left), box: fx(box.height) };
  };
  // every line of the editor: its classes, where it stands and how tall it is, and where its text is
  const fingerprint = () => Array.from(root().querySelectorAll('.cm-content > .cm-line')).map(l => {
    const b = l.getBoundingClientRect(), base = root().querySelector('.cm-content').getBoundingClientRect(), t = firstText(l), r = t ? rectOf(t) : null;
    return [l.className, fx(b.top - base.top), fx(b.height), r ? fx(r.left - base.left) : '', r ? fx(r.width) : '', r ? fx(r.top - base.top) : ''].join(' ');
  }).join('\n');
  // the rule's styles taken away: the editor's subtitle as 1.4.0 has it
  const without = on => {
    let st = document.getElementById('subtitle-check-without');
    if (on && !st) {
      st = document.head.createEl('style', { attr: { id: 'subtitle-check-without' } });
      st.textContent = 'body.theme-light .markdown-source-view.mod-cm6.is-live-preview .cm-line.HyperMD-header-6.HyperMD-header-6, body.theme-dark .markdown-source-view.mod-cm6.is-live-preview .cm-line.HyperMD-header-6.HyperMD-header-6 { padding-bottom: 1.2em !important; }' +
        ' body .markdown-source-view.mod-cm6.is-live-preview .cm-line.HyperMD-header-6.HyperMD-header-6::after { content: none !important; display: none !important; }';
    } else if (!on && st) st.remove();
  };
  const run = async (name, fn) => {
    if (options.only && !name.includes(options.only)) return;
    const c = { name, ok: false, why: '' };
    try { const why = await fn(c); c.ok = !why; c.why = why || ''; } catch (e) { c.why = `threw: ${String((e && e.stack) || e).slice(0, 300)}`; }
    cases.push(c);
  };
  const setFancy = async on => { if (Boolean(scriptorium.settings.fancyMode) !== on) { await scriptorium.updateSettings({ fancyMode: on }); await sleep(900); } };

  try {
    for (const fancy of [false, true]) {
      const mode = fancy ? 'Fancy mode' : 'normal mode';
      await setFancy(fancy);
      await run(`${mode}: the subtitle has its rule in Live Preview and stands where Reading view has it`, async c => {
        await open(fileWith, 'reading'); const r = measure();
        await open(fileWith, 'live'); const l = measure();
        Object.assign(c, { centre: fx(l.centre - r.centre), top: fx(l.top - r.top), ruleTop: l.rule && r.rule ? fx(l.ruleTop - r.ruleTop) : 'none', para: fx(l.para - r.para), paraLeft: fx(l.paraLeft - r.paraLeft) });
        const bad = [];
        if (!r.rule) bad.push('Reading view draws no rule (the check itself is wrong)');
        if (!l.rule) bad.push('no rule under the subtitle in Live Preview');
        else {
          if (l.ruleWidth !== r.ruleWidth) bad.push(`the rule is ${l.ruleWidth} px wide, ${r.ruleWidth} px in Reading view`);
          if (l.ruleColour !== r.ruleColour) bad.push('the rule has another colour');
          if (Math.abs(l.ruleTop - r.ruleTop) > 1.5) bad.push(`the rule is ${fx(l.ruleTop - r.ruleTop)} px lower than in Reading view`);
        }
        if (Math.abs(l.centre - r.centre) > 0.5) bad.push(`the subtitle is ${fx(l.centre - r.centre)} px to the right of where Reading view has it`);
        if (Math.abs(l.top - r.top) > 1.5) bad.push(`the subtitle is ${fx(l.top - r.top)} px lower under the title than in Reading view`);
        if (Math.abs(l.para - r.para) > 0.5) bad.push(`the paragraph after it is ${fx(l.para - r.para)} px lower than in Reading view`);
        if (Math.abs(l.paraLeft - r.paraLeft) > 0.5) bad.push('the paragraph after it begins elsewhere');
        return bad.join('; ');
      });
      await run(`${mode}: Source mode has no rule`, async () => {
        await open(fileWith, 'source');
        const after = getComputedStyle(subEl(), '::after');
        return after.content !== 'none' && parseFloat(after.borderTopWidth) > 0 ? 'a rule is drawn in Source mode' : '';
      });
      await run(`${mode}: with the cursor on the subtitle the rule stays and nothing below moves, also while typing`, async c => {
        await open(fileWith, 'live');
        const cm = leaf.view.editor.cm, before = measure(), text0 = cm.state.doc.toString();
        // (Live Preview shows a line's marks only in an editor that has the focus: the window is given it)
        try { const w = require('@electron/remote').getCurrentWindow(); w.focus(); w.webContents.focus(); await sleep(300); } catch (e) { /* not on desktop */ }
        cm.focus(); cm.dispatch({ selection: { anchor: 12 } }); await sleep(700);
        const on = measure(), marks = Boolean(subEl().querySelector('.cm-formatting-header'));
        const bad = [];
        if (!marks) bad.push('the ###### marks did not show (the cursor is not on the line: the check did not run)');
        if (!on.rule) bad.push('the rule goes while the cursor is on the line');
        if (on.para !== before.para || on.box !== before.box) bad.push(`the paragraph below moved by ${fx(on.para - before.para)} px when the cursor came`);
        if (on.ruleTop !== before.ruleTop) bad.push(`the rule moved by ${fx(on.ruleTop - before.ruleTop)} px when the cursor came`);
        let moved = 0;
        for (const ch of 'abc') { cm.dispatch({ changes: { from: cm.state.selection.main.head, insert: ch }, selection: { anchor: cm.state.selection.main.head + 1 }, userEvent: 'input.type' }); await sleep(120); const m = measure(); moved = Math.max(moved, Math.abs(m.para - before.para), Math.abs(m.ruleTop - before.ruleTop)); }
        if (moved) bad.push(`typing in the subtitle moved what is below it by ${fx(moved)} px`);
        Object.assign(c, { marksShift: fx(on.centre - before.centre), moved: fx(moved) });
        cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: text0 }, selection: { anchor: text0.length } }); await sleep(400);
        const back = measure();
        if (back.para !== before.para || back.centre !== before.centre) bad.push('the subtitle is not where it was when the cursor has left');
        return bad.join('; ');
      });
      await run(`${mode}: a note without a subtitle is laid out as without the rule’s styles, line by line`, async c => {
        await open(fileNone, 'live');
        const now = fingerprint(); without(true); await sleep(500);
        const then = fingerprint(); without(false); await sleep(300);
        c.lines = now.split('\n').length;
        if (now !== then) return 'the layout of a note without a subtitle changed';
        // and the comparison does see the rule where there is one
        await open(fileWith, 'live');
        const a = fingerprint(); without(true); await sleep(500);
        const b = fingerprint(); without(false); await sleep(300);
        return a === b ? 'taking the rule’s styles away changes nothing in a note with a subtitle (the comparison is blind)' : '';
      });
    }
  } finally {
    without(false);
    await setFancy(fancyWas);
    const other = app.vault.getMarkdownFiles().find(f => f !== fileWith && f !== fileNone);
    if (other && !options.keepNotes) { await leaf.openFile(other); await sleep(300); }
    if (!options.keepNotes) { for (const f of [fileWith, fileNone]) { try { await app.vault.delete(f); } catch (e) { /* gone */ } } }
  }
  const failed = cases.filter(c => !c.ok).length;
  console.table(cases);
  return JSON.stringify({ ok: !failed, failed, cases });
})()
