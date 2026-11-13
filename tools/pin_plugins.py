#!/usr/bin/env python3
# The pins of the diagram plugins (TikZJax and Excalidraw), kept in one place: installers/diagram-plugins.json.
# Each installer is a single file that must work alone, so each carries a copy of the versions and SHA-256 hashes;
# this tool keeps the copies equal to that file.
#
#   python3 tools/pin_plugins.py                        checks that every installer has exactly the pins of the file
#                                                       (no network; CI runs this)
#   python3 tools/pin_plugins.py --online               also downloads each pinned file from the plugin's GitHub release
#                                                       and checks its SHA-256, and says if a newer release exists
#   python3 tools/pin_plugins.py --bump <id> <version>  pins another release: downloads its files, and rewrites the
#                                                       file and every installer's copy
# After a bump: read the plugin's licence again, update THIRD_PARTY.md and the README's table, run the tests, and (at
# the next release) the site's copies of the script installers.
# Downloads are only hashed: they are kept in memory, never written into the repository and never run.
#
# Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).
import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PINS = ROOT / "installers" / "diagram-plugins.json"
# Every file that carries a copy of the pins.
COPIES = ["installers/Setup-Scriptorium-Vault.py", "installers/Install-Scriptorium-Linux.sh", "installers/Install-Scriptorium-macOS.command",
          "installers/Install-Scriptorium-Windows.cmd", "installer/ScriptoriumSetup.cs", "vault/.obsidian/plugins/scriptorium/main.js"]
# The documents that name the pinned versions (checked, not rewritten).
DOCUMENTS = ["THIRD_PARTY.md", "README.md"]
VERSION = re.compile(r"(?<![\w.])\d+\.\d+(?:\.\d+)*(?![\w.])")


def pin_lines(text, plugin):
    """The lines of an installer that are about this plugin: they name its repository, or its id in quotes."""
    marks = (plugin["repository"], f'"{plugin["id"]}"', f"'{plugin['id']}'")
    return [(i, line) for i, line in enumerate(text.split("\n")) if any(m in line for m in marks)]


def problems_in(rel, text, plugin):
    found = []
    for name, digest in plugin["files"].items():
        if text.count(digest) != 1:
            found.append(f"{rel}: the SHA-256 of {plugin['name']}'s {name} is there {text.count(digest)} times, not once")
    lines = pin_lines(text, plugin)
    versions = {v for _, line in lines for v in VERSION.findall(line)}
    if not lines or plugin["version"] not in versions:
        found.append(f"{rel}: does not pin {plugin['name']} {plugin['version']}")
    elif versions != {plugin["version"]}:
        found.append(f"{rel}: names {plugin['name']} at {', '.join(sorted(versions - {plugin['version']}))} as well as {plugin['version']}")
    return found


def check(plugins):
    found = []
    for rel in COPIES:
        text = (ROOT / rel).read_text(encoding="utf-8")
        for plugin in plugins:
            found += problems_in(rel, text, plugin)
    for rel in DOCUMENTS:
        text = (ROOT / rel).read_text(encoding="utf-8")
        for plugin in plugins:
            if f"{plugin['name']} {plugin['version']}" not in text and f"{plugin['name']}]({'https://github.com/' + plugin['repository']}) {plugin['version']}" not in text:
                found.append(f"{rel}: does not name {plugin['name']} {plugin['version']}")
    return found


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "scriptorium-pin-plugins"})
    with urllib.request.urlopen(request, timeout=180) as r:
        return r.read()


def release_hashes(plugin, version):
    base = f"https://github.com/{plugin['repository']}/releases/download/{version}/"
    return {name: hashlib.sha256(fetch(base + name)).hexdigest() for name in plugin["files"]}


def online(plugins):
    found = []
    for plugin in plugins:
        got = release_hashes(plugin, plugin["version"])
        for name, digest in plugin["files"].items():
            ok = got[name] == digest
            print(f"{'ok      ' if ok else 'DIFFERS '} {plugin['name']} {plugin['version']} {name}  {got[name]}")
            if not ok:
                found.append(f"{plugin['name']} {plugin['version']}: {name} on GitHub is not the file that is pinned")
        try:
            latest = json.loads(fetch(f"https://api.github.com/repos/{plugin['repository']}/releases/latest"))["tag_name"]
            print(f"         {plugin['name']}: the latest release is {latest}" + ("" if latest == plugin["version"] else f" (pinned: {plugin['version']})"))
        except (OSError, ValueError, KeyError) as e:
            print(f"         {plugin['name']}: the latest release could not be read ({e})")
    return found


def bump(data, plugin_id, version):
    plugin = next((p for p in data["plugins"] if p["id"] == plugin_id), None)
    if plugin is None:
        sys.exit(f"no such plugin in {PINS.name}: {plugin_id} (it has {', '.join(p['id'] for p in data['plugins'])})")
    if not VERSION.fullmatch(version):
        sys.exit(f"not a version: {version}")
    new = release_hashes(plugin, version)
    manifest = json.loads(fetch(f"https://github.com/{plugin['repository']}/releases/download/{version}/manifest.json"))
    if manifest.get("id") != plugin_id or manifest.get("version") != version:
        sys.exit(f"that release's manifest.json says {manifest.get('id')} {manifest.get('version')}, not {plugin_id} {version}")
    for rel in COPIES:
        path = ROOT / rel
        text = path.read_text(encoding="utf-8")
        for name, digest in plugin["files"].items():
            text = text.replace(digest, new[name])
        lines = text.split("\n")
        for i, line in pin_lines(text, plugin):
            lines[i] = VERSION.sub(lambda m: version if m.group(0) == plugin["version"] else m.group(0), line)
        path.write_bytes("\n".join(lines).encode("utf-8"))
    print(f"{plugin['name']}: {plugin['version']} -> {version}")
    plugin["version"], plugin["files"] = version, new
    PINS.write_bytes((json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))


def main():
    data = json.loads(PINS.read_text(encoding="utf-8"))
    args = sys.argv[1:]
    if args[:1] == ["--bump"] and len(args) == 3:
        before = [f for f in check(data["plugins"]) if not f.startswith(tuple(DOCUMENTS))]
        if before:
            sys.exit("the installers do not agree with the file as it is; put that right first:\n  " + "\n  ".join(before))
        bump(data, args[1], args[2])
    elif args not in ([], ["--online"]):
        sys.exit(__doc__ or "usage: pin_plugins.py [--online | --bump <id> <version>]")
    found = check(data["plugins"])
    if args == ["--online"]:
        found += online(data["plugins"])
    for line in found:
        print("FAIL  " + line)
    if not found:
        print(f"The pins agree: {', '.join(p['name'] + ' ' + p['version'] for p in data['plugins'])} in {len(COPIES)} installers.")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
