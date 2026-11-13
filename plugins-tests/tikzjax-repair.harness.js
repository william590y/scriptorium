// Scriptorium's "Repair TikZJax rendering", checked in a real Obsidian with the TikZJax plugin (0.5.2) on. No
// Lagrange is involved: every figure is rendered by Obsidian's own renderer, as any plugin's panel would render it.
//
//   - a figure TikZJax has never compiled, rendered into an element that is already on the page, is drawn (without
//     the repair its spinner turns for ever: checked too, with the setting off);
//   - a figure with an error in it shows what TeX said, in place of TikZJax's broken picture;
//   - notes are as they were: a figure in Reading view and in Live Preview is drawn, the same figure a second time
//     comes from TikZJax's own store (TeX is not run again) and is the same figure;
//   - TikZJax turned off and on again, and Scriptorium turned off and on again, in either order: figures are drawn;
//   - the setting off: nothing of the repair is in the page, and TikZJax is as it comes (a spinner for ever in a
//     panel, a broken picture for an error); on again, at once, without a restart;
//   - last, because TikZJax itself cannot be brought back from it without restarting Obsidian: something is made to
//     throw inside TikZJax after TeX has run, which stops its queue for good; the figure it was at, and a figure
//     asked for afterwards, are drawn all the same.
//
// This cannot run under Node. To run it: open a Scriptorium vault in Obsidian with the TikZJax plugin on, and paste
// this file into the developer console, or evaluate it with Runtime.evaluate (awaitPromise: true). It answers with
// a JSON text {ok, failed, cases: [{name, ok, why}]} and prints a table. Options: window.tikzRepairOptions = {only:
// 'text in a case name', noThrow: true (leave the last case out, so that TikZJax's queue stays alive)}. It makes a
// note "TikZJax repair check.md" and deletes it; the setting is put back as it was. After the last case, restart
// Obsidian before trusting TikZJax without the repair again.
//
// Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).
(async () => {
  const options = window.tikzRepairOptions || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const plugin = app.plugins.plugins.scriptorium;
  const obsidian = plugin.constructor.obsidian;     // (Obsidian's renderer, as the plugin has it)
  const was = plugin.settings.tikzRepair;
  const cases = [];
  const stamp = String(Date.now() % 1000000);
  let n = 0;
  // a figure TikZJax has not met (it keeps what it has compiled, by its source)
  const fresh = () => `\`\`\`tikz\n\\begin{document}\n\\begin{tikzpicture}\n\\draw (0,0) circle (1.${stamp}${++n});\n\\draw (0,0) -- (1,0) node[right] {$x$};\n\\end{tikzpicture}\n\\end{document}\n\`\`\``;
  const wrong = () => `\`\`\`tikz\n\\begin{document}\n\\begin{tikzpicture}\n\\drwa (0,0) -- (1,1.${stamp}${++n});\n\\end{tikzpicture}\n\\end{document}\n\`\`\``;
  const state = el => { const b = el.querySelector('.block-language-tikz'); if (!b) return 'none';
    if (b.querySelector('script[type="text/tikz"]')) return 'script'; if (b.querySelector('svg > circle > animate')) return 'spinner';
    if (b.querySelector('.scriptorium-tikz-error')) return 'said'; if (b.querySelector('img')) return 'broken'; return b.querySelector('svg') ? 'drawn' : 'empty'; };
  const settled = async (el, ms) => { for (const t0 = Date.now(); Date.now() - t0 < ms;) { const s = state(el); if (s === 'drawn' || s === 'said' || s === 'broken') return s; await sleep(100); } return state(el); };
  const host = document.body.appendChild(document.createElement('div'));
  host.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px;overflow:auto;opacity:0.01;pointer-events:none;z-index:-1';
  const component = new obsidian.Component();
  component.load();
  // Obsidian's renderer into an element that is already on the page: a panel
  const panel = async md => { const el = host.appendChild(document.createElement('div')); await obsidian.MarkdownRenderer.render(app, md, el, '', component); return el; };
  // as a note is rendered: an element made whole and put into the page once (TikZJax meets its figure once)
  const whole = async md => { const el = document.createElement('div'); await obsidian.MarkdownRenderer.render(app, md, el, '', component); host.appendChild(el); return el; };
  const repair = () => plugin.tikzRepair;
  const setting = async on => { if (Boolean(plugin.settings.tikzRepair) !== on) { await plugin.updateSettings({ tikzRepair: on }); await sleep(200); } };
  const hooked = () => Boolean(Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'loader')) || !/\[native code\]/.test(Function.prototype.toString.call(Worker.prototype.postMessage));
  const run = async (name, fn) => {
    if (options.only && !name.includes(options.only)) return;
    const c = { name, ok: false, why: '' };
    try { const why = await fn(c); c.ok = !why; c.why = why || ''; } catch (e) { c.why = `threw: ${String((e && e.stack) || e).slice(0, 300)}`; }
    cases.push(c);
  };
  const tikzjax = () => app.plugins.plugins['obsidian-tikzjax'];
  const leaf = app.workspace.getLeavesOfType('markdown')[0] || app.workspace.getLeaf(true);

  try {
    if (!tikzjax()) { cases.push({ name: 'TikZJax is on in this vault', ok: false, why: 'the TikZJax plugin is not on: nothing was checked' }); throw new Error('stop'); }
    const version = app.plugins.manifests['obsidian-tikzjax'].version;
    await setting(true);

    await run('the repair stands with the setting on and TikZJax 0.5.2', async () => (version !== '0.5.2' ? `TikZJax is ${version}: the repair leaves it alone, and this check has nothing to check` : !repair() ? 'the repair is not in the page' : !hooked() ? 'nothing of the repair is in the page' : ''));

    await run('a figure never compiled, rendered into a panel that is on the page, is drawn', async c => {
      const bad = [];
      for (let i = 0; i < 3; i++) { const el = await panel(`Words.\n\n${fresh()}`); const s = await settled(el, 15000); if (s !== 'drawn') bad.push(`figure ${i + 1} is ${s}`); }
      c.twice = repair().stats.twice;
      if (!repair().stats.twice) bad.push('TikZJax did not meet a figure twice (the fault did not occur: the check is blind)');
      return bad.join('; ');
    });

    await run('a figure with an error in it shows what TeX said', async c => {
      const el = await panel(wrong()), s = await settled(el, 15000);
      const box = el.querySelector('.scriptorium-tikz-error');
      c.said = box ? box.querySelector('pre').textContent.slice(0, 60).replace(/\n/g, ' / ') : '';
      if (s !== 'said') return `the figure is ${s}`;
      if (!/Undefined control sequence/.test(box.textContent) || !/\\drwa/.test(box.textContent)) return `TeX's words are not shown: “${box.textContent.slice(0, 120)}”`;
      if (document.querySelector('img[src*="invalid.site"]')) return 'a broken picture is left on the page';
      // and the queue is alive after it
      const after = await panel(fresh());
      return (await settled(after, 15000)) === 'drawn' ? '' : 'a figure after the error is not drawn';
    });

    await run('notes are as they were: drawn in Reading view and in Live Preview, and the second time from TikZJax’s own store', async c => {
      const md = `A figure in a note.\n\n${fresh()}\n\nAfter it.\n`;
      let f = app.vault.getAbstractFileByPath('TikZJax repair check.md');
      if (f) await app.vault.modify(f, md); else f = await app.vault.create('TikZJax repair check.md', md);
      const bad = [], runs0 = repair().stats.runs;
      await leaf.openFile(f, { state: { mode: 'preview' } });
      const reading = leaf.view.containerEl.querySelector('.markdown-reading-view');
      if ((await settled(reading, 15000)) !== 'drawn') bad.push(`Reading view: ${state(reading)}`);
      const first = (reading.querySelector('.block-language-tikz svg') || {}).outerHTML || '';
      const runs1 = repair().stats.runs;
      if (runs1 !== runs0 + 1) bad.push(`TeX ran ${runs1 - runs0} times for one figure`);
      await leaf.openFile(f, { state: { mode: 'source', source: false } });
      await sleep(600);
      leaf.view.editor.cm.dispatch({ selection: { anchor: 0 } });
      const live = leaf.view.containerEl.querySelector('.markdown-source-view');
      if ((await settled(live, 15000)) !== 'drawn') bad.push(`Live Preview: ${state(live)}`);
      const second = (live.querySelector('.block-language-tikz svg') || {}).outerHTML || '';
      if (repair().stats.runs !== runs1) bad.push('the same figure was compiled again (TikZJax’s store was not used)');
      if (first && second && first !== second) bad.push('the figure from the store is not the same figure');
      c.rescued = repair().stats.rescued;
      if (repair().stats.rescued) bad.push('the repair drew a figure itself, which a note should never need');
      const other = app.vault.getMarkdownFiles().find(x => x !== f);
      if (other) await leaf.openFile(other);
      await app.vault.delete(f);
      return bad.join('; ');
    });

    await run('TikZJax turned off and on again, then Scriptorium turned off and on again: figures are drawn', async () => {
      const bad = [];
      await app.plugins.disablePlugin('obsidian-tikzjax'); await sleep(400);
      await app.plugins.enablePlugin('obsidian-tikzjax'); await sleep(1200);
      if ((await settled(await panel(fresh()), 15000)) !== 'drawn') bad.push('after TikZJax was turned off and on: not drawn');
      await app.plugins.disablePlugin('scriptorium'); await sleep(300);
      if (hooked()) bad.push('with Scriptorium off, something of the repair is still in the page');
      await app.plugins.enablePlugin('scriptorium'); await sleep(1000);
      if (!app.plugins.plugins.scriptorium.tikzRepair) bad.push('after Scriptorium was turned on again the repair is not in the page');
      if ((await settled(await panel(fresh()), 15000)) !== 'drawn') bad.push('after Scriptorium was turned off and on: not drawn');
      if ((await settled(await panel(wrong()), 15000)) !== 'said') bad.push('after Scriptorium was turned off and on: an error does not show what TeX said');
      return bad.join('; ');
    });

    const scriptorium = () => app.plugins.plugins.scriptorium;
    await run('the setting off: nothing of the repair is in the page and TikZJax is as it comes; on again at once', async () => {
      const bad = [];
      await scriptorium().updateSettings({ tikzRepair: false }); await sleep(300);
      if (scriptorium().tikzRepair || hooked()) bad.push('off, something of the repair is still in the page');
      const stuck = await panel(fresh()); await sleep(5000);
      if (state(stuck) !== 'spinner') bad.push(`off, a new figure in a panel is ${state(stuck)} (TikZJax as it comes leaves its spinner)`);
      const err = await whole(wrong());
      if ((await settled(err, 15000)) !== 'broken') bad.push(`off, a figure with an error is ${state(err)} (TikZJax as it comes shows a broken picture)`);
      err.remove();
      await scriptorium().updateSettings({ tikzRepair: true }); await sleep(300);
      if (!scriptorium().tikzRepair) bad.push('on again, the repair is not in the page');
      if ((await settled(await panel(fresh()), 15000)) !== 'drawn') bad.push('on again, a new figure in a panel is not drawn');
      return bad.join('; ');
    });

    if (!options.noThrow) await run('something throws inside TikZJax after TeX has run: that figure and the next are drawn all the same', async c => {
      // TikZJax makes the figure's <svg> from TeX's answer with createContextualFragment: once, it is given nothing
      const real = Range.prototype.createContextualFragment;
      let thrown = 0;
      Range.prototype.createContextualFragment = function (html) {
        if (!thrown && /^<svg[^>]*>/.test(String(html)) && !/<animate/.test(String(html))) { thrown++; return real.call(this, ''); }
        return real.apply(this, arguments);
      };
      const bad = [], rescued0 = scriptorium().tikzRepair.stats.rescued;
      let first, second;
      try {
        first = await whole(fresh());
        for (let i = 0; i < 100 && !thrown; i++) await sleep(100);
      } finally { Range.prototype.createContextualFragment = real; }
      if (!thrown) return 'nothing was made to throw (the check did not run)';
      second = await panel(fresh());
      const s2 = await settled(second, 20000);
      if (s2 !== 'drawn') bad.push(`the figure asked for afterwards is ${s2}`);
      const s1 = await settled(first, 20000);
      if (s1 !== 'drawn') bad.push(`the figure TikZJax was at when it threw is ${s1}`);
      c.rescued = scriptorium().tikzRepair.stats.rescued - rescued0;
      if (!c.rescued) bad.push('the repair drew nothing itself (TikZJax’s queue was not stopped: the check is blind)');
      const third = await panel(fresh());
      if ((await settled(third, 20000)) !== 'drawn') bad.push('a third figure is not drawn');
      if ((await settled(await panel(wrong()), 20000)) !== 'said') bad.push('an error after it does not show what TeX said');
      return bad.join('; ');
    });
  } catch (e) {
    if (String(e && e.message) !== 'stop') cases.push({ name: 'the check itself', ok: false, why: String((e && e.stack) || e).slice(0, 300) });
  } finally {
    host.remove();
    component.unload();
    try { await app.plugins.plugins.scriptorium.updateSettings({ tikzRepair: was }); } catch (e) { /* the plugin is off */ }
  }
  const failed = cases.filter(c => !c.ok).length;
  console.table(cases);
  return JSON.stringify({ ok: !failed, failed, cases });
})()
