#!/usr/bin/env bash
# Builds dist/Scriptorium-Setup.exe (Windows, .NET Framework 4.8) with Mono's csc on Linux or macOS.
# The exe embeds dist/Scriptorium.zip, which this script rebuilds from vault/ first (tools/build_zip.py), and the fonts it
# draws its window with (installer/fonts/*.ttf, made by tools/build_fonts.py and committed).
# The release build is made on Windows by .github/workflows/build.yml with the same compiler switches.
#
# Usage: tools/build_exe.sh                     (uses the csc on PATH and the Mono installation it belongs to)
#        MONO=/path/to/mono/prefix tools/build_exe.sh
# Check: mono dist/Scriptorium-Setup.exe --extract-only /tmp/scriptorium-test/vault
# Look:  Scriptorium-Setup.exe --render screenshots   (Windows: saves PNGs of the window in its states; installs nothing)
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
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "${MONO:-}" ]; then
  CSC="$MONO/bin/csc"
else
  CSC="$(command -v csc || true)"
  [ -n "$CSC" ] || { echo "csc not found: install Mono or set MONO to its prefix" >&2; exit 1; }
  MONO="$(cd "$(dirname "$CSC")/.." && pwd)"
fi
API="$MONO/lib/mono/4.8-api"
[ -f "$API/mscorlib.dll" ] || { echo "no .NET Framework 4.8 reference assemblies in $API" >&2; exit 1; }

python3 tools/build_zip.py dist/Scriptorium.zip

OUT=dist/Scriptorium-Setup.exe
"$CSC" -nologo -noconfig -nostdlib -target:winexe -platform:anycpu -optimize+ -deterministic -codepage:65001 -warn:4 \
  -r:"$API/mscorlib.dll" -r:"$API/System.dll" -r:"$API/System.Core.dll" -r:"$API/System.Drawing.dll" \
  -r:"$API/System.Windows.Forms.dll" -r:"$API/System.IO.Compression.dll" -r:"$API/System.IO.Compression.FileSystem.dll" \
  -win32icon:installer/scriptorium.ico -win32manifest:installer/app.manifest \
  -resource:dist/Scriptorium.zip,Scriptorium.zip \
  -resource:installer/fonts/SetupText-Regular.ttf,SetupText-Regular.ttf \
  -resource:installer/fonts/SetupText-Italic.ttf,SetupText-Italic.ttf \
  -resource:installer/fonts/SetupText-SemiBold.ttf,SetupText-SemiBold.ttf \
  -resource:installer/fonts/SetupDisplay-SemiBold.ttf,SetupDisplay-SemiBold.ttf \
  -out:"$OUT" installer/ScriptoriumSetup.cs
ls -l "$OUT"
if command -v sha256sum >/dev/null; then sha256sum "$OUT"; else shasum -a 256 "$OUT"; fi
