# Third-party components

Scriptorium's own files (the Scriptorium and Lagrange plugins, the `manuscript` snippet apart from the embedded Yinit
font, the installers and the build tools) are licensed under the GNU General Public License, version 3 or later (see
[LICENSE](LICENSE)). The components below keep their own licenses.

## Included in `vault/` (and so in `Scriptorium.zip` and `Scriptorium-Setup.exe`)

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

### Yinit decorative initials

- Path: embedded (WOFF2, letters A-Z) in `vault/.obsidian/snippets/manuscript.css` as the font "Scriptorium Yinit"
- Source: `Yinit.otf` from the CTAN package yinit-otf (<https://ctan.org/pkg/yinit-otf>), an OpenType conversion of
  Yannis Haralambous' METAFONT yinit, converted to WOFF2
- License: public domain ("The copyright is (C) Yannis Haralambous, 1994, Public Domain.")

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
