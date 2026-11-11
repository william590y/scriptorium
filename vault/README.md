# Scriptorium — Obsidian configuration

A fancy and sophisticated obsidian configuration for the typographically inclined

## Fancy mode

Fancy mode is disabled by default. Switch it under **Settings → Scriptorium → Fancy mode**, click the feather icon, click **Fancy mode: on/off** in the status bar, or run **Scriptorium: Toggle fancy mode** in the command palette. Your choice is saved per vault.

- On: italic quotations without a border and justified opening paragraphs.
- Off: centered small-cap section headings, bordered quotations, and left-aligned opening paragraphs.

Both modes use 22 px text and the same 1.45 line spacing. Chapter openings use ornamental Yinit initials (Yannis Haralambous, public domain) unless you choose another drop cap below; the initials are embedded in the manuscript snippet, so they need no installation. Both styles are included in the manuscript snippet. The bundled Scriptorium plugin supplies the switch. Enable community plugins when opening this vault; if they remain disabled, the compact style is used.

## Drop caps, marginalia and image focus

Under **Settings → Scriptorium**:

- **Drop cap:** Yinit (ornamental, the default), Goudy Initialen (floriated), a plain Cormorant Garamond capital, or none.
- **Marginalia:** in Reading view, footnotes are set in the right margin beside their references, as on gwern.net, when the pane is wide enough (a window about 1,200 pixels wide with the sidebars closed); otherwise they stay at the foot of the note. Hovering a reference lights its note. **Scriptorium: Toggle marginalia** in the command palette turns them on and off.
- **Image focus:** click an image to see it on its own, fitted to the window, with its caption. ← and → step through the note's images, the mouse wheel zooms and dragging pans; Esc, a click outside the image or the × button closes it.

Callouts are set as quiet admonitions, after gwern.net: a tinted slip with a broad band and a printer's mark, darker for the more urgent kinds.

## Open the demonstration

1. Install Obsidian from https://obsidian.md/download.
2. Extract this ZIP to a folder. Keep the hidden `.obsidian` folder inside it.
3. For the intended typography, install EB Garamond and Cormorant Garamond from Google Fonts, then restart Obsidian. Georgia is the fallback.
4. In Obsidian, choose **Open folder as vault** and select the extracted folder.
5. Open **Lorem Ipsum** and switch to **Reading view** to see the Yinit drop caps, subtitle rule, quotations, and ornamental scene breaks.

The Typewriter theme and manuscript CSS snippet are enabled in the configuration. Scriptorium, Manuscriptum, and Typewriter Mode are bundled community plugins. Longform is enabled in the configuration but not bundled: Scriptorium Setup downloads it from its official release, or install it from **Settings → Community plugins**. Review the plugins before choosing to enable community plugins in Obsidian.

## Writing conventions

- The filename supplies the title.
- `###### Subtitle` creates a centered italic subtitle.
- `## Chapter heading` creates a centered small-cap chapter heading.
- `### Section heading` creates a smaller section heading.
- `> Quotation` creates an italic quotation.
- `---` creates an ornamental scene break.
- `[^1]` with `[^1]: The note.` creates a footnote, set in the margin in Reading view when there is room.
- `> [!margin]` followed by `> Text` creates an unnumbered marginal note beside the paragraph that follows it.
- `> [!note]`, `> [!tip]`, `> [!warning]`, `> [!danger]` and the other callouts create admonitions.
- `![[image.png|A caption]]` (or `![A caption](image.png "A title")`) gives an image the caption shown when it is in focus.
- Images are centred. Put `left`, `right` or `center` before the size to place one: `![[image.png|left|300]]`, `![[image.png|right|240]]`, `![[image.png|center]]` (or `![left|300](image.png)`). Left and right images float in Reading view, so text wraps around them.
- Links are set in rubric ink with a hand-drawn pen underline, as on williamliaw.com.

For an existing vault, back up its `.obsidian` folder before replacing it with this one. This replaces vault settings and plugin configuration.

This bundle includes the user's configuration with the Typewriter theme, manuscript snippet, and the Manuscriptum and Typewriter Mode plugins, each with its license file. Those third-party components remain the work of their respective authors. The saved workspace has been reset to the included sample note.

Scriptorium itself is free software under the GNU General Public License, version 3 or later; its source is at https://github.com/william590y/scriptorium.
