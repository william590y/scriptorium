#!/usr/bin/env python3
# Sets up Scriptorium in any Obsidian vault: a vault you already write in, a new vault Obsidian has just made, or a
# folder of notes that has never been opened in Obsidian. Windows, macOS and Linux; needs Python 3.8 or later, and
# nothing else.
#
#   python3 Setup-Scriptorium-Vault.py /path/to/vault            shows what it would change, and asks before doing it
#   python3 Setup-Scriptorium-Vault.py /path/to/vault --dry-run  only shows what it would change
#   python3 Setup-Scriptorium-Vault.py /path/to/vault --yes      does it without asking
#   ... --package <Scriptorium.zip or a vault folder>            takes Scriptorium from there instead of downloading it
#
# What it does, and does not do (Scriptorium Setup on Windows follows the same rules: "Set up Scriptorium in this
# vault"; so does the command "Scriptorium: Set up another vault" inside Obsidian):
#   - It never touches a note or any file outside the vault's .obsidian folder, and it deletes nothing.
#   - Scriptorium's own files are written into .obsidian: the manuscript snippet, the Typewriter theme, and the
#     Scriptorium, Lagrange, Manuscriptum and Typewriter Mode plugins. A file of that name that differs is replaced.
#   - Your settings are merged, not overwritten: your community plugins stay on and Scriptorium's are added to the
#     list; your snippets stay on and "manuscript" is added; the theme becomes Typewriter; Scriptorium's text size is
#     set only if you have not chosen one (in app.json, or in appearance.json, where Obsidian now keeps it). A plugin's own settings (data.json) are written only if it has none. Your
#     hotkeys, workspace and every other setting are left alone.
#   - Before anything is changed, the whole .obsidian folder as it was is copied to
#     .obsidian/scriptorium-backup-<date>-<time>/.obsidian. If anything fails half-way, every file is put back.
#   - Run again, it changes nothing (and makes no second backup).
# Close the vault in Obsidian first: Obsidian rewrites some of these files while the vault is open. Afterwards open
# the vault and, when Obsidian asks, choose "Trust author and enable plugins".
#
# Without --package it uses the vault/ folder of a Scriptorium checkout if this file is in one, and otherwise
# downloads Scriptorium.zip from williamliaw.com and checks its SHA-256 against the one pinned below.
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

import argparse
import datetime
import hashlib
import io
import json
import os
import re
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

PACKAGE_URL = "https://williamliaw.com/assets/downloads/Scriptorium.zip"
PACKAGE_SHA256 = "d6410e6ce88d497aca0b69d6cb7c1d9d8aa8ba78bbf173c90dc2e42fb9287091"   # the same pin as the installers'

OBS = ".obsidian"
BACKUP_PREFIX = "scriptorium-backup-"
BUNDLED_PLUGINS = ("scriptorium", "manuscriptum", "typewriter-mode", "lagrange")
PLUGIN_CODE = ("main.js", "manifest.json", "styles.css", "LICENSE")

# How each file of the package is treated. Anything not named here is not part of setting up a vault: the sample
# note and the README (the vault's notes are its owner's), and workspace.json and graph.json (which describe the
# sample vault's windows).
REPLACE = {f"{OBS}/snippets/manuscript.css", f"{OBS}/plugins/lagrange/LagrangeHand-OFL.txt"} | {
    f"{OBS}/plugins/{p}/{f}" for p in BUNDLED_PLUGINS for f in PLUGIN_CODE}
# the Typewriter theme, and the sets of drop caps that come with the Scriptorium plugin
REPLACE_UNDER = (f"{OBS}/themes/Typewriter/", f"{OBS}/plugins/scriptorium/dropcaps/")
ADD_IF_MISSING = {f"{OBS}/core-plugins.json"} | {f"{OBS}/plugins/{p}/data.json" for p in BUNDLED_PLUGINS}
PLUGINS_JSON = f"{OBS}/community-plugins.json"
APPEARANCE_JSON = f"{OBS}/appearance.json"
APP_JSON = f"{OBS}/app.json"


class SetupError(Exception):
    pass


def load_package(source):
    """The package's files, {relative path with forward slashes: bytes}, from a zip or from a vault folder."""
    files = {}
    if isinstance(source, (bytes, bytearray)) or Path(source).is_file():
        data = source if isinstance(source, (bytes, bytearray)) else Path(source).read_bytes()
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for info in z.infolist():
                if not info.is_dir():
                    files[info.filename.replace("\\", "/")] = z.read(info)
    else:
        root = Path(source)
        for p in sorted(root.rglob("*")):
            rel = p.relative_to(root).as_posix()
            if p.is_file() and not p.is_symlink() and BACKUP_PREFIX not in rel:
                files[rel] = p.read_bytes()
    if f"{OBS}/plugins/scriptorium/manifest.json" not in files or f"{OBS}/snippets/manuscript.css" not in files:
        raise SetupError("That is not a Scriptorium package: it has no Scriptorium plugin or no manuscript snippet.")
    return files


def download_package():
    # The site turns away Python's default User-Agent (403), so the request names this script instead.
    request = urllib.request.Request(PACKAGE_URL, headers={"User-Agent": "Setup-Scriptorium-Vault/1.2"})
    try:
        with urllib.request.urlopen(request, timeout=120) as r:   # https only: the URL is fixed above
            data = r.read()
    except OSError as e:   # URLError and HTTPError are OSErrors
        raise SetupError(f"Scriptorium could not be downloaded from {PACKAGE_URL} ({e}); nothing was changed. "
                         "Download Scriptorium.zip yourself and pass it with --package.") from e
    digest = hashlib.sha256(data).hexdigest()
    if digest != PACKAGE_SHA256:
        raise SetupError(f"The download does not match its pinned SHA-256 (got {digest}); nothing was changed.")
    return data


# The two community plugins that draw diagrams (Lagrange writes TikZ figures and Excalidraw drawings). They are not
# part of Scriptorium: each is downloaded from its own GitHub release, at a pinned version, and every file is checked
# against its SHA-256 before anything is written. TikZJax is MIT-licensed; the Excalidraw plugin is AGPL-3.0.
DIAGRAM_PLUGINS = [
    {"id": "obsidian-tikzjax", "name": "TikZJax", "version": "0.5.2",
     "base": "https://github.com/artisticat1/obsidian-tikzjax/releases/download/0.5.2/",
     "files": {"main.js": "cbae1ad4362d44173e56ba512f01e65de1f7cc69a4bf4733bc5711a2de101f41",
               "manifest.json": "09fbbb05aeffc32bc65365d8526fc2222ee971417dcd4afddeb989498a5e1de1",
               "styles.css": "d9a7f741ec8fdcbe5e0145152c799238cee8df5a14ddc7dc9feb3bb835ce068d"}},
    {"id": "obsidian-excalidraw-plugin", "name": "Excalidraw", "version": "2.29.2",
     "base": "https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/download/2.29.2/",
     "files": {"main.js": "49dfc5667a7730dbc124cdfc2a4a8e89188100636493a39d6493bf5696a55541",
               "manifest.json": "8e82828fd9125615e8a361d0f15553e548cac2ee7a303e55387378a53b925fd9",
               "styles.css": "6c7a9914f83305d09f9957248897ff2f25cf2c2d4b46b2d9ab42f3c7ee1d29f0"}},
]


def version_key(text):
    key = [int(n) for n in re.findall(r"\d+", str(text))[:4]]
    return key + [0] * (4 - len(key))   # 0.5 is 0.5.0


def fetch_url(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Setup-Scriptorium-Vault/1.3"})
    with urllib.request.urlopen(request, timeout=180) as r:   # https only: the addresses are fixed above
        return r.read()


def install_diagram_plugins(vault, fetch=fetch_url, log=print):
    """Adds the diagram plugins to the vault and turns them on. A plugin the vault already has at the pinned version
    or a newer one is left exactly as it is (its files and its settings); one that cannot be downloaded or does not
    match its checksum is not installed, the rest of the set-up stands, and the log says how to add it by hand.
    Returns {id: 'installed' | 'updated' | 'kept' | 'failed'}."""
    result = {}
    plugins = vault / OBS / "plugins"
    for p in DIAGRAM_PLUGINS:
        folder = plugins / p["id"]
        had = None
        try:
            had = json.loads((folder / "manifest.json").read_text(encoding="utf-8")).get("version")
        except (OSError, ValueError):
            had = None
        if had is not None and version_key(had) >= version_key(p["version"]) and (folder / "main.js").is_file():
            result[p["id"]] = "kept"
            log(f"{p['name']} {had} is already in this vault: left as it is.")
        else:
            try:
                files = {}
                for name, digest in p["files"].items():
                    data = fetch(p["base"] + name)
                    if hashlib.sha256(data).hexdigest() != digest:
                        raise OSError(f"{name} does not match its pinned SHA-256")
                    files[name] = data
                folder.mkdir(parents=True, exist_ok=True)
                for name, data in files.items():       # (its settings, data.json, are never touched)
                    tmp = folder / (name + ".scriptorium-tmp")
                    tmp.write_bytes(data)
                    os.replace(tmp, folder / name)
                result[p["id"]] = "updated" if had is not None else "installed"
                log(f"{p['name']} {p['version']} {'updated' if had is not None else 'installed'} (from its own release on GitHub).")
            except (OSError, ValueError) as e:
                result[p["id"]] = "failed"
                log(f"{p['name']} was NOT installed ({e}). Scriptorium itself is set up. To add it: in Obsidian, "
                    f"Settings → Community plugins → Browse, search for “{p['name']}”, Install, then Enable.")
                continue
        # turned on, next to the plugins the vault already has on (a list that is not a JSON list is left as it is)
        listing = vault / OBS / "community-plugins.json"
        on = []
        if listing.exists():
            try:
                on = json.loads(listing.read_text(encoding="utf-8-sig"))
            except (OSError, ValueError):
                on = None
            if not isinstance(on, list):
                log(f"Left community-plugins.json as it was (it is not a valid JSON list): turn {p['name']} on in "
                    "Settings → Community plugins.")
                continue
        if p["id"] not in on:
            on.append(p["id"])
            listing.parent.mkdir(parents=True, exist_ok=True)
            listing.write_text(json.dumps(on, indent=2) + "\n", encoding="utf-8")
    return result


def write_json(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def read_json(data, kind):
    """The parsed JSON if it is of the given type, else None."""
    try:
        value = json.loads(data.decode("utf-8-sig"))
    except (ValueError, UnicodeDecodeError):
        return None
    return value if isinstance(value, kind) else None


def merge_plugins(theirs, ours, present):
    """The vault's community plugin list plus Scriptorium's that are missing: (bytes or None, note)."""
    name = "community-plugins.json"
    wanted = [p for p in (read_json(ours, list) or []) if isinstance(p, str) and p in present]
    current = read_json(theirs, list)
    if current is None:
        return None, f"Left {name} as it was: it is not a valid JSON list."
    added = [p for p in wanted if p not in current]
    if not added:
        return None, None
    return write_json(current + added), f"turn on the community plugin{'s' if len(added) > 1 else ''} {', '.join(added)}"


def merge_appearance(theirs):
    """appearance.json with the manuscript snippet on and the Typewriter theme: (bytes or None, note)."""
    name = "appearance.json"
    a = read_json(theirs, dict)
    if a is None:
        return None, f"Left {name} as it was: it is not a valid JSON object."
    snippets = a.get("enabledCssSnippets", [])
    if not isinstance(snippets, list):
        return None, f"Left {name} as it was: its enabledCssSnippets is not a list."
    notes = []
    if "manuscript" not in snippets:
        a["enabledCssSnippets"] = snippets + ["manuscript"]
        notes.append("turn on the manuscript snippet")
    if a.get("cssTheme") != "Typewriter":
        was = a.get("cssTheme")
        a["cssTheme"] = "Typewriter"
        notes.append(f"change the theme from {was or 'the default'} to Typewriter")
    if not notes:
        return None, None
    return write_json(a), " and ".join(notes)


def merge_app(theirs, ours):
    """app.json with Scriptorium's settings added where the vault has none of its own: (bytes or None, note)."""
    name = "app.json"
    a, o = read_json(theirs, dict), read_json(ours, dict) or {}
    if a is None:
        return None, f"Left {name} as it was: it is not a valid JSON object."
    added = [k for k in o if k not in a]
    kept = [k for k in o if k in a and a[k] != o[k]]
    note = "; ".join(f"kept your {k} ({json.dumps(a[k])}; Scriptorium's is {json.dumps(o[k])})" for k in kept) or None
    if not added:
        return None, note
    for k in added:
        a[k] = o[k]
    what = "set " + ", ".join(f"{k} to {json.dumps(o[k])}" for k in added)
    return write_json(a), what + (f"; {note}" if note else "")


def plan(package, vault):
    """What setting up `vault` from `package` would change: (changes, notes).
    Each change is {rel, content, replaces, note}; notes are lines about files left as they were."""
    vault = Path(vault)
    changes, notes = [], []

    def existing(rel):
        p = vault / rel
        return p.read_bytes() if p.is_file() else None

    # The plugins that will be in the vault afterwards: Scriptorium's, and whatever is installed already.
    present = set(BUNDLED_PLUGINS)
    if (vault / OBS / "plugins").is_dir():
        present |= {p.name for p in (vault / OBS / "plugins").iterdir() if p.is_dir()}
    for rel in sorted(package):
        content = package[rel]
        merged = rel in (PLUGINS_JSON, APPEARANCE_JSON, APP_JSON)
        if not (rel in REPLACE or rel.startswith(REPLACE_UNDER) or rel in ADD_IF_MISSING or merged):
            continue
        now = existing(rel)
        if rel == APP_JSON:
            # Obsidian keeps some of app.json's settings (the text size) in appearance.json once it has opened the
            # vault: a setting the vault has there is the vault's own, and is not set again here.
            appearance = read_json(existing(APPEARANCE_JSON) or b"", dict) or {}
            ours = read_json(content, dict) or {}
            theirs = {k: appearance[k] for k in ours if k in appearance}
            if theirs:
                notes += [f"kept your {k} ({json.dumps(v)}; Scriptorium's is {json.dumps(ours[k])})"
                          for k, v in theirs.items() if v != ours[k] and not (now and k in (read_json(now, dict) or {}))]
                ours = {k: v for k, v in ours.items() if k not in theirs}
                if not ours:
                    continue
                content = write_json(ours)
        if now is None:
            if rel == PLUGINS_JSON:      # only the plugins that will be there (Longform is not bundled)
                content = write_json([p for p in (read_json(content, list) or []) if p in present])
            changes.append({"rel": rel, "content": content, "replaces": False, "note": None})
        elif rel in ADD_IF_MISSING:
            continue
        elif merged:
            if rel == PLUGINS_JSON:
                new, note = merge_plugins(now, content, present)
            elif rel == APPEARANCE_JSON:
                new, note = merge_appearance(now)
            else:
                new, note = merge_app(now, content)
            if new is not None:
                changes.append({"rel": rel, "content": new, "replaces": True, "note": note})
            elif note:
                notes.append(note)
        elif now != content:
            changes.append({"rel": rel, "content": content, "replaces": True, "note": None})
    return changes, notes


def describe(changes, notes):
    """The plan in words, one line each."""
    lines = []
    for c in changes:
        name = c["rel"]
        if c["note"]:
            lines.append(f"  merge    {name}: {c['note']}")
        else:
            lines.append(f"  {'replace ' if c['replaces'] else 'add     '} {name}")
    lines += [f"  note     {n}" for n in notes]
    return lines


def backup_folder(vault, now=None):
    stamp = BACKUP_PREFIX + (now or datetime.datetime.now()).strftime("%Y%m%d-%H%M%S")
    folder = vault / OBS / stamp
    n = 2
    while folder.exists():
        folder = vault / OBS / f"{stamp}-{n}"
        n += 1
    return folder


def apply(vault, changes, log=print):
    """Backs up .obsidian as it is, then makes the changes; on a failure puts every file back. Returns the backup folder
    (None if there was no .obsidian to back up or nothing to change)."""
    vault = Path(vault)
    if not changes:
        return None
    config = vault / OBS
    backup = None
    if config.is_dir() and any(config.iterdir()):
        backup = backup_folder(vault)
        try:
            shutil.copytree(config, backup / OBS, symlinks=True,
                            ignore=lambda d, names: [n for n in names if n.startswith(BACKUP_PREFIX)])
        except Exception as e:
            shutil.rmtree(backup, ignore_errors=True)
            raise SetupError(f"The vault's .obsidian folder could not be backed up, so nothing was changed: {e}") from e
        log(f"Backed up .obsidian as it was in {backup}")
    written, made = [], []
    try:
        for c in changes:
            target = vault / c["rel"]
            missing = [d for d in reversed(target.parents) if not d.exists()]
            for d in missing:
                d.mkdir()
                made.append(d)
            written.append(c)
            temp = target.with_name(target.name + ".scriptorium-tmp")
            temp.write_bytes(c["content"])
            os.replace(temp, target)
    except Exception as e:
        restored = True
        for c in reversed(written):
            target = vault / c["rel"]
            try:
                temp = target.with_name(target.name + ".scriptorium-tmp")
                if temp.exists():
                    temp.unlink()
                if c["replaces"]:
                    shutil.copyfile(backup / c["rel"], target)
                elif target.is_file():
                    target.unlink()
            except Exception:
                restored = False
        for d in reversed(made):
            try:
                d.rmdir()
            except OSError:
                pass
        if restored and backup is not None:
            shutil.rmtree(backup, ignore_errors=True)
        raise SetupError(("The setup failed and was undone: " if restored
                          else f"The setup failed, and some files could not be put back; the originals are in {backup}: ") + str(e)) from e
    return backup


def find_package(explicit):
    if explicit:
        return load_package(explicit)
    checkout = Path(__file__).resolve().parent.parent / "vault"
    if (checkout / OBS / "plugins" / "scriptorium" / "manifest.json").is_file():
        return load_package(checkout)
    print(f"Downloading {PACKAGE_URL} ...")
    return load_package(download_package())


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):   # a console that cannot show a character shows "?" instead of failing
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(description="Set up Scriptorium in an Obsidian vault, keeping its notes and settings.")
    parser.add_argument("vault", help="the vault's folder (it must exist)")
    parser.add_argument("--dry-run", action="store_true", help="show what would change, and change nothing")
    parser.add_argument("--yes", action="store_true", help="do not ask before changing the vault")
    parser.add_argument("--package", help="a Scriptorium.zip, or a Scriptorium vault folder, to take the files from")
    parser.add_argument("--no-diagram-plugins", action="store_true", help="do not download the TikZJax and Excalidraw plugins")
    parser.add_argument("--plugins-from", help=argparse.SUPPRESS)   # for the tests: a folder that stands in for the releases
    args = parser.parse_args(argv)
    try:
        vault = Path(args.vault).expanduser().resolve()
        if not vault.is_dir():
            raise SetupError(f"No such folder: {vault}. Make the vault in Obsidian first (or make the folder), then run this again.")
        if BACKUP_PREFIX in vault.as_posix() or vault.name == OBS:
            raise SetupError(f"That is a folder inside a vault's settings, not a vault: {vault}")
        package = find_package(args.package)
        version = (read_json(package[f"{OBS}/plugins/scriptorium/manifest.json"], dict) or {}).get("version", "?")
        changes, notes = plan(package, vault)
        print(f"Scriptorium {version} in {vault}")
        def diagrams():
            # (SCRIPTORIUM_NO_DIAGRAM_PLUGINS: the tests of everything else, which must not need the network)
            if args.no_diagram_plugins or os.environ.get("SCRIPTORIUM_NO_DIAGRAM_PLUGINS"):
                return
            if args.dry_run:
                for p in DIAGRAM_PLUGINS:
                    folder = vault / OBS / "plugins" / p["id"]
                    try:
                        had = json.loads((folder / "manifest.json").read_text(encoding="utf-8")).get("version")
                    except (OSError, ValueError, AttributeError):
                        had = None
                    if not (had is not None and version_key(had) >= version_key(p["version"]) and (folder / "main.js").is_file()):
                        print(f"  download {OBS}/plugins/{p['id']}: {p['name']} {p['version']}, from its own release on GitHub"
                              + (f" (in place of your {had})" if had is not None else ""))
                return
            fetch = fetch_url
            if args.plugins_from:      # <folder>/<plugin id>/<file>
                def fetch(url):
                    plugin = next(p for p in DIAGRAM_PLUGINS if url.startswith(p["base"]))
                    return (Path(args.plugins_from) / plugin["id"] / url[len(plugin["base"]):]).read_bytes()
            install_diagram_plugins(vault, fetch)

        if not changes:
            for line in describe([], notes):
                print(line)
            print("Scriptorium is already set up here: nothing to change.")
            diagrams()
            return 0
        replaced = sum(1 for c in changes if c["replaces"])
        print(f"{'Would change' if args.dry_run else 'Changes'}: {len(changes) - replaced} file(s) to add, {replaced} to replace or merge.")
        for line in describe(changes, notes):
            print(line)
        print("Your notes are not touched, and nothing is deleted." +
              (" The .obsidian folder as it is now is copied to .obsidian/scriptorium-backup-<time> first."
               if (vault / OBS).is_dir() else ""))
        if args.dry_run:
            diagrams()
            return 0
        if not args.yes:
            if not sys.stdin.isatty():
                raise SetupError("Not asked to go ahead (run it in a terminal, or with --yes); nothing was changed.")
            if input("Go ahead? [y/N] ").strip().lower() not in ("y", "yes"):
                print("Nothing was changed.")
                return 0
        backup = apply(vault, changes)
        diagrams()
        print(f"Done: added {len(changes) - replaced} file(s), replaced or merged {replaced}." +
              (f" To undo, put back the files from {backup}." if backup else ""))
        print("Open the vault in Obsidian and, when it asks, choose “Trust author and enable plugins”. "
              "If the vault was open, reload it (Ctrl/Cmd+P, “Reload app without saving”).")
        return 0
    except SetupError as e:
        print(f"FAILED: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
