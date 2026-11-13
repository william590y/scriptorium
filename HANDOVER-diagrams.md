# Hand-over: branch `diagrams` (from main 1.3.1)

Written by the agent that built it, for whoever integrates. Delete this file before the pull request is merged.

## What is on the branch (all pushed, small commits)
1. **The pen draws diagrams** (`lagrange/main.js`, section 5: `figureKinds`, `withoutFigures`, `figureOrder`, `awaitFigures`,
   `drawFigure`, `restoreFigure`; `styles.css`: `.lagrange-pen-figures`). In Live Preview an edit that brings a ```tikz block
   (TikZJax) or an `![[x.excalidraw]]` embed is not typed: the `<svg>` the note draws is kept unseen from birth, then drawn
   part by part in its own order (stroke-dashoffset under the nib), labels last; a figure the note redraws under the pen is
   picked up again; a key or click shows it whole at once. Source mode types the source as before.
2. **Prompts and detection** (`diagramStyle`, `sketchSpec`, plugin `diagramPlugins()`, `makeDiagrams()`): the model is told
   the TikZJax syntax and a `{"sketch": {name, elements}}` edit item; the plugin makes the Excalidraw file through
   `ExcalidrawAutomate` and embeds it. A missing plugin: the prompt says so, and a figure that comes anyway is left out
   with a plain note in the chat.
3. **The look** waits for TikZJax and names "TikZ figure" / "Excalidraw drawing" in its words.
4. **Snippet**: figures centred, Excalidraw's white ground removed, dark paper inverts its black lines.
5. **Also here, now owned by other branches** (the same commits are pushed as starting points):
   - `chat-render`: the chat renders completed blocks once while a reply streams (`splitStable`), the writer's messages
     are rendered, CSS keeps code/figures inside the panel; the loader's plates come in turn (`nextPlate`, setting `cycle`).
     No harness case for the rendered chat yet; the loader has one.
   - `install-diagram-plugins`: `Setup-Scriptorium-Vault.py`, the macOS and Linux installers, the Windows `.cmd`
     (PowerShell block, never run: no PowerShell here) and Scriptorium's "Set up another vault" install TikZJax 0.5.2 (MIT)
     and Excalidraw 2.29.2 (AGPL-3.0) from their own releases, pinned by SHA-256. `tools/test_diagram_plugins.py` and a
     test in `scriptorium.test.js` cover fresh / already installed / failed download. **Not done: the Windows Setup
     (`installer/ScriptoriumSetup.cs`) and the update route.**

## Not done
- The demo recording (rendered chat reply, a diagram drawn by the pen, the subtitle under the title).
- Drop caps in Live Preview (branch `livepreview-dropcaps`, not started here).
- README text for diagrams.
- Excalidraw in dark theme and TikZ/Excalidraw inside a look were only checked by their DOM, not looked at.

## Verified so far
- Node: `node --test plugins-tests/scriptorium.test.js plugins-tests/lagrange.test.js plugins-tests/rclone-sync.test.js` passes.
- `python3 tools/test_diagram_plugins.py`, `tools/test_setup_vault.py`, `tools/test_auto_open.py --scripts-only` pass.
- Real Obsidian 1.15.0: a TikZ figure and an Excalidraw drawing are drawn in place, no early flash, parts in order
  (contact sheets: `/share/ellis/wjl86/blog_work/pen3_scratch/clips/figt/contact.png`, `.../clips/fige/contact.png`).
- The full harness with the new cases (diagrams, loader): see `/share/ellis/wjl86/blog_work/pen3_scratch/job/harness.out`.

## How to run the harness
See `/share/ellis/wjl86/blog_work/pen3_scratch/README_HARNESS.md`. Obsidian runs only inside a Slurm job
(`sbatch -p gpu,default_partition -c 4 --mem=16G`); `job/h2.sbatch` there is a working example (restart, `syncall.sh`,
`harness.sh`). The test vault needs the two plugins in `.obsidian/plugins/` (download the release assets) and listed in
`community-plugins.json`; the harness's diagram cases fail, saying so, where they are missing.
