// Runs the Scriptorium plugin's "Set up another vault" from the command line, with the repository's vault/ as the
// vault it copies from, so tools/test_setup_vault.py can put it through the same checks as the installer and the
// script. Not packaged, and not for users (they have the command in Obsidian, the installer and the script).
//
//   node plugins-tests/setup-vault-cli.js --dry-run <vault>     shows what would change
//   node plugins-tests/setup-vault-cli.js --yes <vault>         does it
//
// Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'obsidian') {
    class Stub {}
    return { Plugin: Stub, PluginSettingTab: Stub, Setting: Stub, MarkdownView: Stub, MarkdownRenderer: Stub, Component: Stub, Scope: Stub, Modal: Stub, Notice: Stub, Platform: {} };
  }
  return realLoad.call(this, request, ...rest);
};
const S = require(path.join(__dirname, '..', 'vault', '.obsidian', 'plugins', 'scriptorium', 'main.js'));
Module._load = realLoad;

const [mode, target] = process.argv.slice(2);
if (!['--dry-run', '--yes'].includes(mode) || !target) {
  console.error('usage: setup-vault-cli.js --dry-run|--yes <vault>');
  process.exit(2);
}
try {
  const dir = S.setupFolder(path, path.resolve(target));
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`No such folder: ${target}`);
  if (dir.split(/[\\/]/).includes('.obsidian')) throw new Error(`That is a folder inside a vault's settings, not a vault: ${dir}`);
  const plan = S.planVaultSetup(fs, path, S.setupPackage(fs, path, path.join(__dirname, '..', 'vault')), dir);
  if (!plan.changes.length) {
    for (const line of S.describeVaultSetup(plan)) console.log(line);
    console.log('Scriptorium is already set up here: nothing to change.');
    process.exit(0);
  }
  const replaced = plan.changes.filter(c => c.replaces).length;
  console.log(`${mode === '--dry-run' ? 'Would change' : 'Changes'}: ${plan.changes.length - replaced} file(s) to add, ${replaced} to replace or merge.`);
  for (const line of S.describeVaultSetup(plan)) console.log(line);
  if (mode === '--yes') {
    const backup = S.applyVaultSetup(fs, path, dir, plan);
    console.log(`Done.${backup ? ` Backed up .obsidian as it was in ${backup}` : ''}`);
  }
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
}
