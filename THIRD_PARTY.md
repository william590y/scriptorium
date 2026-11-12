# Third-party components

Scriptorium's own files (the Scriptorium and Lagrange plugins apart from the font embedded in Lagrange's `styles.css`,
the `manuscript` snippet apart from the embedded Yinit, Goudy Initialen and Scriptorium Mono fonts, the installers, the
build tools and the tests) are licensed under the GNU General Public License, version 3 or later (see
[LICENSE](LICENSE)). The components below keep their own licenses.

## Included in `vault/` (and so in `Scriptorium.zip` and `Scriptorium-Setup.exe`)

### La Belle Aurore (embedded in Lagrange's styles as "Lagrange Hand")

- Path: `vault/.obsidian/plugins/lagrange/styles.css` (a base64 WOFF2, 20 kB): the handwriting of Lagrange's pen and of
  the captions under its loading plates. Nothing is fetched at run time.
- Source: `LaBelleAurore.ttf` (version 1.001, SHA-256
  `ed67462999e05f0cdac92f686374661e4d68c56fdcd7d05725c6df7b41eabd2a`) from
  <https://github.com/google/fonts/tree/main/ofl/labelleaurore>
- Modified: a Latin subset (Basic Latin, Latin-1, Latin Extended-A and common punctuation) made with fontTools
  `pyftsubset`, hinting removed, as WOFF2; the outlines and the name table are unchanged. The font has no Reserved Font
  Name.
- Copyright (c) 2010, Kimberly Geswein (kimberlygeswein.com)
- License: SIL Open Font License 1.1: `vault/.obsidian/plugins/lagrange/LagrangeHand-OFL.txt`

### Typewriter theme 2.3.4

- Path: `vault/.obsidian/themes/Typewriter/`
- Source: <https://github.com/crashmoney/obsidian-typewriter>
- Author: crashmoney
- License: GNU General Public License, version 3: `vault/.obsidian/themes/Typewriter/LICENSE`

### Manuscriptum 1.0.2

- Path: `vault/.obsidian/plugins/manuscriptum/`
- Source: <https://github.com/sgranade/manuscriptum> (release 1.0.2)
- Author: Stephen Granade
- License: MIT, Copyright (c) 2025 Stephen Granade: `vault/.obsidian/plugins/manuscriptum/LICENSE`

### Typewriter Mode 1.6.1

- Path: `vault/.obsidian/plugins/typewriter-mode/`
- Source: <https://github.com/davisriedel/obsidian-typewriter-mode> (release 1.6.1)
- Author: Davis Riedel
- License: MIT, Copyright (c) 2023-2026 Davis Riedel: `vault/.obsidian/plugins/typewriter-mode/LICENSE`
  (upstream `LICENSE.md`)

### Scriptorium Mono (IBM Plex Mono, renamed)

- Path: embedded (WOFF2: regular, italic, bold, bold italic; Latin subset) in `vault/.obsidian/snippets/manuscript.css`
  as the font "Scriptorium Mono"
- Source: IBM Plex Mono from <https://github.com/google/fonts/tree/main/ofl/ibmplexmono> (upstream
  <https://github.com/IBM/plex>), subset with fontTools `pyftsubset`
- Copyright © 2017 IBM Corp., with Reserved Font Name "Plex". This subset is a Modified Version under the OFL, so it is
  renamed "Scriptorium Mono" in its name table and in the CSS.
- License: SIL Open Font License 1.1: [`licenses/ScriptoriumMono-OFL.txt`](licenses/ScriptoriumMono-OFL.txt)

### Yinit decorative initials

- Path: embedded (WOFF2, letters A-Z) in `vault/.obsidian/snippets/manuscript.css` as the font "Scriptorium Yinit"
- Source: `Yinit.otf` from the CTAN package yinit-otf (<https://ctan.org/pkg/yinit-otf>), an OpenType conversion of
  Yannis Haralambous' METAFONT yinit, converted to WOFF2
- License: public domain ("The copyright is (C) Yannis Haralambous, 1994, Public Domain.")

### Goudy Initialen decorative initials

- Path: embedded (WOFF2, letters A-Z) in `vault/.obsidian/snippets/manuscript.css` as the font "Scriptorium Goudy"; used
  when **Settings → Scriptorium → Drop cap** is Goudy Initialen
- Source: `GoudyIn.pfb` from the CTAN package initials (<https://ctan.org/pkg/initials>), floriated initials after
  Frederic W. Goudy (Lanston Goudy Initials No. 296), digitised by Dieter Steffmann (Typographer Mediengestaltung, 2000)
- Modified: converted from Type 1 to OpenType (CFF) and WOFF2 with fontTools, letters A-Z only, outlines unchanged; the
  name table records the conversion. The same file is used on williamliaw.com
  (`assets/fonts/GoudyInitialen-Scriptorium.woff2`, SHA-256 `5b8b60f1b595f7537154186ada9045df7153a1cf62fb1f1e98a2986aacbfdd06`).
  The unmodified original is on CTAN.
- License: LaTeX Project Public License ("The author gave his permission, that these fonts can be redistributed and/or
  modified under the terms of the LaTeX Project Public License", the package's README, which names no version; the
  current version, 1.3c, is included): [`licenses/GoudyInitialen-LPPL.txt`](licenses/GoudyInitialen-LPPL.txt)

## Included in `installer/fonts/` (and so in `Scriptorium-Setup.exe`)

### EB Garamond and Cormorant Garamond (subsets for the installer's window)

- Path: `installer/fonts/SetupText-Regular.ttf`, `SetupText-Italic.ttf`, `SetupText-SemiBold.ttf` (EB Garamond) and
  `SetupDisplay-SemiBold.ttf` (Cormorant Garamond)
- Source: the variable fonts `EBGaramond[wght].ttf`, `EBGaramond-Italic[wght].ttf` and `CormorantGaramond[wght].ttf`
  from Google Fonts' repository, <https://github.com/google/fonts> (commit `5bb28733cec313b63fbd415b574b5ae35c8aa8b8`),
  the same files, pinned by the same SHA-256, that Scriptorium Setup downloads
- Modified by `tools/build_fonts.py`: static instances (weights 400 and 600) made with fontTools, subset to Latin and
  punctuation, old-style figures and small capitals moved into the character map, OpenType layout tables removed, and
  renamed to private family names (`ScrSetup EB Garamond`, `ScrSetup EB Garamond SemiBold`, `ScrSetup Cormorant
  SemiBold`). The copyright and license name records are kept.
- Use: Scriptorium Setup loads them privately to draw its own window; they are never installed on the system.
- Copyright 2017 The EB Garamond Project Authors (https://github.com/octaviopardo/EBGaramond12); Copyright 2015 The
  Cormorant Project Authors (github.com/CatharsisFonts/Cormorant)
- License: SIL Open Font License 1.1: `installer/fonts/OFL-EBGaramond.txt`, `installer/fonts/OFL-CormorantGaramond.txt`

## Not included: downloaded at install time

Scriptorium Setup downloads these from their official sources, each pinned by SHA-256, only when the matching option
is ticked. They are not part of this repository, the zip or the installer (apart from the window's font subsets above).

### Longform 2.1.0

- Source: <https://github.com/kevboh/longform/releases/tag/2.1.0> (`main.js`, `manifest.json`, `styles.css`)
- Author: Kevin Barrett
- License: its own license, in its repository. Longform is enabled in `vault/.obsidian/community-plugins.json`; if it
  is not installed, install it from **Settings → Community plugins** in Obsidian.

### Obsidian 1.15.0

- Source: <https://github.com/obsidianmd/obsidian-releases/releases/tag/v1.15.0>
- License: Obsidian's own terms (<https://obsidian.md/license>)

### EB Garamond and Cormorant Garamond

- Source: Google Fonts' repository, <https://github.com/google/fonts> (commit `5bb28733cec313b63fbd415b574b5ae35c8aa8b8`,
  `ofl/ebgaramond/` and `ofl/cormorantgaramond/`)
- License: SIL Open Font License 1.1
