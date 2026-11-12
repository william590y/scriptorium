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

### Kanzlei Initialen and Deutsche Zierschrift (sets of drop caps)

- Path: `vault/.obsidian/plugins/scriptorium/dropcaps/kanzlei/` and `dropcaps/de-zs/`: one TrueType font for each
  letter, A to Z (26 files, 0.2 MB each set), unchanged
- Source: gwern.net's published files, <https://gwern.net/static/font/dropcap/kanzlei/> and
  <https://gwern.net/static/font/dropcap/de-zs/> (the same files as
  <https://github.com/gwern/gwern.net/tree/master/font/dropcap>; see <https://gwern.net/dropcap#kanzlei> and
  <https://gwern.net/dropcap#de-zs>)
- Designer and foundry: digitised by Dieter Steffmann (Typographer Mediengestaltung, Kreuztal), 2002; Deutsche
  Zierschrift after Rudolf Koch's type of 1919-1921
- Terms: no licence text comes with either font. The fonts' own license field says "have fun and enjoy" (Kanzlei
  Initialen) and "Have fun and enjoy" (Deutsche Zierschrift); Dieter Steffmann, on his site
  (<http://www.steffmann.de/wordpress/>): "You may use all fonts for free, including commercial use." (12 February
  2015) and "You may use all fonts for free." (28 August 2024), after "The fonts are free for private use only." (16
  December 2012); DaFont lists Deutsche Zierschrift as "100% Free" (<https://www.dafont.com/deutsche-zierschrif.font>).
  None of these uses the word "redistribution". Every statement found, with its date and address, is in
  [`licenses/SteffmannInitials-terms.txt`](licenses/SteffmannInitials-terms.txt).
- Bundled at the repository owner’s direction (2026-11-12).

### Dropcat, Gene Wolfe and Ninit (sets of drop caps, a selection)

- Path: `vault/.obsidian/plugins/scriptorium/dropcaps/dropcat/` (B C G I Q T), `dropcaps/gene-wolfe/` (F T V) and
  `dropcaps/ninit/` (A B C): one light-theme and one dark-theme PNG for each letter. `dropcaps/gwern.json` is
  Scriptorium's own list of the images gwern.net has (names and sizes), for the download below.
- Source: <https://gwern.net/static/font/dropcap/dropcat/>, `…/gene-wolfe/` and `…/ninit/`
  (<https://github.com/gwern/gwern.net/tree/master/font/dropcap>), made by Gwern Branwen with Midjourney and DALL·E 3
  in 2023 and edited by hand. Dropcat and Gene Wolfe: variant 1 of each letter at gwern.net's `small-2x` size,
  unchanged. Ninit: `A-floral-light-1`, `B-mechanical-light-1`, `C-floral-light-1`, `A-circuit-dark-1`,
  `B-mechanical-dark-1` and `C-machine-dark-1`, scaled down to 376 pixels high and reduced to 96 colours with Pillow.
- License: CC0 1.0 (public domain dedication): [`licenses/CC0-1.0.txt`](licenses/CC0-1.0.txt). gwern.net says so at
  <https://gwern.net/dropcap>: "The **dropcat** dropcap font set is a set of light (42) & dark (32) raster image (PNG)
  dropcaps (CC-0 licensed)"; "The Gene Wolfe dropcap font set is a set of light (93) & dark (72) SVG dropcaps […]
  (CC-0 licensed)"; and, of all of them, "We release all our dropcap images, code/scripts, & editor under FLOSS
  licenses". Ninit, which is unfinished, has no statement of its own: it is covered by that sentence and by the site's
  licence, <https://gwern.net/about#license>: "This site is licensed under the Creative Commons public domain (CC-0)
  license."

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

## Not included: downloaded at install time, or when the writer asks

Scriptorium Setup downloads these from their official sources, each pinned by SHA-256, only when the matching option
is ticked. They are not part of this repository, the zip or the installer (apart from the window's font subsets above).

### More drop caps from gwern.net (only when the writer asks, in Obsidian)

- The command **Scriptorium: Download more drop caps from gwern.net** fetches the other images of Dropcat (74 images,
  2.6 MB), Gene Wolfe (30 images, 0.9 MB, or all 165, 35 MB) or Ninit (58 images, 25 MB) from
  <https://gwern.net/static/font/dropcap/> into the writer's vault (`Scriptorium/Drop caps/`). They are not part of this
  repository, the zip or the installer.
- License: CC0 1.0, as above.

### Cheshire Initials (named, never included or downloaded)

- gwern.net's eighth kind of initial. By House of Lime, 2001 ("©House of Lime 2001, scanned graphics" in the font;
  "©House of Lime 2001 - 2009, all rights reserved" on the foundry's archived page,
  <https://web.archive.org/web/20130122020421fw_/http://www.houseoflime.com/fonts.html>).
- Terms: offered at <https://www.1001fonts.com/cheshire-initials-font.html> under the 1001Fonts Free For Commercial Use
  License (<https://www.1001fonts.com/licenses/ffc.html>), which says: "5. Distribution: While the given typeface may
  freely be copied and passed along to other individuals for private use as its original downloadable zip-file, it may
  not be sold or published without written permission by its respective author." and "6. Embedding: the given typeface
  may be embedded into an application such as a web- or mobile app, independant of the number of the application
  users, as long as the application does not distribute the given typeface, such as offering it as a download."
  DaFont lists it as "Free for personal use" (<https://www.dafont.com/cheshire-initials.font>). These terms forbid
  publishing the font, so Scriptorium does not include it: the list of drop caps names it, says where to download it,
  and takes the writer's own copy as a set (**Scriptorium: Add a set of drop caps**).

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
