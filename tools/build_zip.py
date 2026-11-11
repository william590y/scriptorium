#!/usr/bin/env python3
# Builds dist/Scriptorium.zip from vault/ deterministically: entries sorted by path, one fixed timestamp, fixed
# permissions and no directory entries, so the same vault/ always gives the same bytes (with the same zlib).
#
# Usage: python3 tools/build_zip.py [output]       (default output: dist/Scriptorium.zip)
# The timestamp honours SOURCE_DATE_EPOCH (https://reproducible-builds.org/docs/source-date-epoch/) when it is set.
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
import json
import os
import sys
import time
import zipfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VAULT = ROOT / "vault"
DEFAULT_OUT = ROOT / "dist" / "Scriptorium.zip"
DEFAULT_DATE = (2026, 11, 11, 0, 0, 0)  # used when SOURCE_DATE_EPOCH is not set
NEVER_SHIP = {".DS_Store", "Thumbs.db", "desktop.ini"}


def fixed_date():
    epoch = os.environ.get("SOURCE_DATE_EPOCH")
    if not epoch:
        return DEFAULT_DATE
    t = time.gmtime(max(int(epoch), 315532800))  # zip dates start in 1980
    return (t.tm_year, t.tm_mon, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec - t.tm_sec % 2)


def vault_files():
    files = []
    for dirpath, dirnames, filenames in os.walk(VAULT, followlinks=False):
        for d in dirnames:
            if (Path(dirpath) / d).is_symlink():
                sys.exit(f"refusing to package a symbolic link: {Path(dirpath) / d}")
        for name in filenames:
            path = Path(dirpath) / name
            if name in NEVER_SHIP:
                continue
            if path.is_symlink() or not path.is_file():
                sys.exit(f"refusing to package a non-regular file: {path}")
            files.append(path.relative_to(VAULT).as_posix())
    return sorted(files)


def check_no_api_keys(files):
    # Lagrange keeps its API keys in its data.json: the packaged one must hold the defaults, with every key empty, so a
    # key typed into the development vault can never ship.
    rel = ".obsidian/plugins/lagrange/data.json"
    if rel not in files:
        return
    try:
        settings = json.loads((VAULT / rel).read_text(encoding="utf-8"))
    except ValueError:
        sys.exit(f"vault/{rel} is not valid JSON")
    filled = sorted(k for k, v in settings.items() if "key" in k.lower() and v)
    if filled:
        sys.exit(f"vault/{rel} holds an API key ({', '.join(filled)}): empty it before packaging")


def main():
    out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_OUT
    files = vault_files()
    if "longform" in {Path(f).parts[2] for f in files if f.startswith(".obsidian/plugins/")}:
        sys.exit("vault/.obsidian/plugins/longform must not be packaged (Longform is downloaded at install time)")
    if ".obsidian/appearance.json" not in files:
        sys.exit("vault/.obsidian/appearance.json is missing")
    check_no_api_keys(files)
    date = fixed_date()
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    with zipfile.ZipFile(tmp, "w") as z:
        for rel in files:
            info = zipfile.ZipInfo(rel, date_time=date)
            info.create_system = 3  # Unix, so the permission bits below are meaningful everywhere
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, (VAULT / rel).read_bytes(), compresslevel=9)
    os.replace(tmp, out)
    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    print(f"{out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}: {len(files)} files, "
          f"{out.stat().st_size} bytes, zlib {zlib.ZLIB_RUNTIME_VERSION}")
    print(f"sha256 {digest}")


if __name__ == "__main__":
    main()
