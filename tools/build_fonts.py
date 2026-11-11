#!/usr/bin/env python3
# Builds the fonts Scriptorium Setup draws its own window with (installer/fonts/*.ttf), from the same pinned Google
# Fonts variable fonts the installer downloads (URLs and SHA-256 in installer/ScriptoriumSetup.cs).
#
# GDI+ (System.Drawing) and GDI need static TrueType fonts, so each face is a static instance (fontTools
# varLib.instancer) at one weight, subset to Latin and the punctuation the window uses, with layout tables dropped
# (GDI+ applies no OpenType features). Two features are baked into the character map instead: old-style figures for the
# text faces, and the semibold face's small capitals at U+F761-U+F77A (the old Adobe convention), so the window can set
# small capitals. Each face gets a private family name (the window loads them privately; a distinct name means they
# can never be mistaken for the EB Garamond and Cormorant Garamond the installer installs). The fonts keep their
# copyright and license names; the license is SIL OFL 1.1 (installer/fonts/OFL-*.txt).
#
# Usage: python3 tools/build_fonts.py          (needs fontTools 4.40 or later; downloads about 2.8 MB)
# The output is deterministic and committed, so building the installer does not need Python or fontTools.
#
# Copyright (C) 2026 William Liaw
#
# This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
# License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
# version.
#
# This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
# warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License along with this program. If not, see
# <https://www.gnu.org/licenses/>.

import hashlib
import io
import sys
import urllib.request
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "installer" / "fonts"
SETUP_CS = ROOT / "installer" / "ScriptoriumSetup.cs"

BASE = "https://raw.githubusercontent.com/google/fonts/5bb28733cec313b63fbd415b574b5ae35c8aa8b8/ofl/"
SOURCES = {  # the pinned variable fonts; the same URLs and hashes as in ScriptoriumSetup.cs
    "eb": (BASE + "ebgaramond/EBGaramond%5Bwght%5D.ttf",
           "ef9512f92f6d579e5dc75af59a5a4b1b8b47d2eda89e00b954d44520e5369027"),
    "eb-italic": (BASE + "ebgaramond/EBGaramond-Italic%5Bwght%5D.ttf",
                  "bba2c4499c93c9612b90b9825d32b07da52fce2fe57562a1eb6b833553f93c4e"),
    "cormorant": (BASE + "cormorantgaramond/CormorantGaramond%5Bwght%5D.ttf",
                  "b20b7d9626dd956b2c5e558692ad328b1f19e3275e2782db4fa07670d83f35e0"),
}

SMALL_CAPS_PUA = 0xF761  # U+F761..U+F77A: small capitals a..z
FACES = [
    # output file, source, weight, family, style, old-style figures, small capitals in the PUA
    ("SetupText-Regular.ttf", "eb", 400, "ScrSetup EB Garamond", "Regular", True, False),
    ("SetupText-Italic.ttf", "eb-italic", 400, "ScrSetup EB Garamond", "Italic", True, False),
    ("SetupText-SemiBold.ttf", "eb", 600, "ScrSetup EB Garamond SemiBold", "Regular", True, True),
    ("SetupDisplay-SemiBold.ttf", "cormorant", 600, "ScrSetup Cormorant SemiBold", "Regular", False, False),
]

# Latin-1, general punctuation (dashes, curly quotes, ellipsis, bullet), arrows, and the fleuron.
UNICODES = (list(range(0x20, 0x7F)) + list(range(0xA0, 0x100)) + list(range(0x2010, 0x2028)) +
            [0x2039, 0x203A, 0x2190, 0x2191, 0x2192, 0x2193, 0x2122, 0x2766])


def fetch(url, sha):
    with urllib.request.urlopen(url, timeout=120) as r:
        data = r.read()
    got = hashlib.sha256(data).hexdigest()
    if got != sha:
        sys.exit(f"SHA-256 mismatch for {url}: {got}")
    return data


def feature_map(font, tag):
    """Single substitutions of one GSUB feature: {glyph: replacement}."""
    gsub = font["GSUB"].table
    mapping = {}
    for rec in gsub.FeatureList.FeatureRecord:
        if rec.FeatureTag != tag:
            continue
        for index in rec.Feature.LookupListIndex:
            lookup = gsub.LookupList.Lookup[index]
            for sub in lookup.SubTable:
                if lookup.LookupType == 7:
                    sub = sub.ExtSubTable
                if hasattr(sub, "mapping"):
                    for k, v in sub.mapping.items():
                        mapping.setdefault(k, v)
    return mapping


def build(out_name, source, weight, family, style, oldstyle, small_caps, data):
    font = TTFont(io.BytesIO(data), recalcTimestamp=False)
    font = instancer.instantiateVariableFont(font, {"wght": weight}, updateFontNames=False)
    glyphs = set(font.getGlyphOrder())

    # Bake features into the character map.
    for table in font["cmap"].tables:
        if not table.isUnicode():
            continue
        cmap = table.cmap
        if oldstyle:
            for d, name in enumerate(["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]):
                if name + ".osf" in glyphs and (0x30 + d) in cmap:
                    cmap[0x30 + d] = name + ".osf"
        if small_caps:
            smcp = feature_map(font, "smcp")
            for i in range(26):
                lower = cmap.get(ord("a") + i)
                if lower in smcp:
                    cmap[SMALL_CAPS_PUA + i] = smcp[lower]

    options = Options()
    options.layout_features = []
    options.drop_tables += ["GSUB", "GPOS", "GDEF", "STAT", "DSIG", "meta"]
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    options.name_languages = [0x409]
    options.notdef_outline = True
    options.recalc_timestamp = False
    unicodes = UNICODES + ([SMALL_CAPS_PUA + i for i in range(26)] if small_caps else [])
    subsetter = Subsetter(options)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)

    # Private names. The copyright (0), version (5) and license (13, 14) stay as they are.
    name = font["name"]
    full = family if style == "Regular" else f"{family} {style}"
    ps = (family + ("-" + style if style != "Regular" else "")).replace(" ", "")
    for nid in (1, 2, 3, 4, 6, 16, 17):
        name.removeNames(nameID=nid)
    for nid, value in ((1, family), (2, style), (3, f"Scriptorium Setup: {full}"), (4, full), (6, ps)):
        name.setName(value, nid, 3, 1, 0x409)
        name.setName(value, nid, 1, 0, 0)
    italic = style == "Italic"
    os2 = font["OS/2"]
    os2.usWeightClass = weight
    os2.fsSelection = (os2.fsSelection & ~0b1100001) | (0b1 if italic else 0b1000000)  # ITALIC or REGULAR
    os2.fsSelection &= ~(1 << 8)  # WWS: not needed
    font["head"].macStyle = 0b10 if italic else 0
    font["post"].italicAngle = font["post"].italicAngle if italic else 0

    out = OUT / out_name
    font.save(out)
    return out


def main():
    setup = SETUP_CS.read_text(encoding="utf-8")
    for url, sha in SOURCES.values():
        if sha not in setup:
            sys.exit(f"{sha} is not pinned in {SETUP_CS}; keep the sources in step with the installer")
    data = {key: fetch(url, sha) for key, (url, sha) in SOURCES.items()}
    OUT.mkdir(parents=True, exist_ok=True)
    for face in FACES:
        out = build(*face, data[face[1]])
        digest = hashlib.sha256(out.read_bytes()).hexdigest()
        print(f"{out.relative_to(ROOT)}  {out.stat().st_size:7d} bytes  {digest}")


if __name__ == "__main__":
    main()
