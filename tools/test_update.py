#!/usr/bin/env python3
# Tests Scriptorium Setup's in-place update of an existing vault (Scriptorium-Setup.exe --update-only <vault>), and which
# existing folders it installs into (--extract-only <folder>: a new or empty folder, nothing else).
#
# Usage: python3 tools/test_update.py dist/Scriptorium-Setup.exe
# On Windows the exe runs directly; elsewhere it runs under Mono (MONO=<prefix>, or mono on PATH). It needs no network:
# --update-only updates from the package embedded in the exe, without Longform.
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

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "vault"
OBS = ".obsidian"

# Scriptorium's own files: an update must make each of these equal to the package.
MANAGED = [f"{OBS}/snippets/manuscript.css", "README.md", f"{OBS}/plugins/lagrange/LagrangeHand-OFL.txt"] + [
    f"{OBS}/plugins/{p}/{f}" for p in ("scriptorium", "manuscriptum", "typewriter-mode", "lagrange")
    for f in ("main.js", "manifest.json", "styles.css", "LICENSE")
] + sorted(p.relative_to(PACKAGE).as_posix() for p in (PACKAGE / OBS / "themes" / "Typewriter").iterdir())

failures = []


def check(ok, what):
    print(("PASS  " if ok else "FAIL  ") + what)
    if not ok:
        failures.append(what)


def run(exe, *args):
    if os.name == "nt":
        cmd = [str(exe), *args]
    else:
        mono = os.environ.get("MONO")
        cmd = [os.path.join(mono, "bin", "mono") if mono else "mono", str(exe), *args]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    for line in (r.stdout + r.stderr).splitlines():
        print("      | " + line)
    return r


def snapshot(vault, skip_backups=True):
    files = {}
    for p in sorted(vault.rglob("*")):
        rel = p.relative_to(vault).as_posix()
        if p.is_file() and not (skip_backups and rel.startswith(f"{OBS}/scriptorium-backup-")):
            files[rel] = p.read_bytes()
    return files


def backups(vault):
    return sorted(p for p in (vault / OBS).iterdir() if p.name.startswith("scriptorium-backup-"))


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def fresh(exe, work, name):
    vault = work / name / "vault"
    r = run(exe, "--extract-only", str(vault))
    if r.returncode != 0:
        sys.exit(f"--extract-only failed ({r.returncode})")
    return vault


def package_version():
    return json.loads((PACKAGE / OBS / "plugins" / "scriptorium" / "manifest.json").read_text(encoding="utf-8"))["version"]


def test_update(exe, work):
    print("\n== An edited vault is updated: Scriptorium's files replaced, the user's kept, settings merged ==")
    vault = fresh(exe, work, "update")
    (vault / "Lorem Ipsum.md").write_text("My own words, written over the sample.\n", encoding="utf-8")
    (vault / "My note.md").write_text("A note of my own.\n", encoding="utf-8")
    (vault / OBS / "snippets" / "mine.css").write_text("/* my snippet */\n", encoding="utf-8")
    write_json(vault / OBS / "plugins" / "scriptorium" / "data.json", {"fancy": True, "mine": 1})
    write_json(vault / OBS / "workspace.json", {"main": {"id": "mine"}})
    write_json(vault / OBS / "appearance.json",
               {"theme": "moonstone", "cssTheme": "Typewriter", "enabledCssSnippets": ["mine"], "accentColor": "#123456"})
    write_json(vault / OBS / "community-plugins.json", ["longform", "manuscriptum", "scriptorium", "calendar"])
    with open(vault / OBS / "snippets" / "manuscript.css", "a", encoding="utf-8") as f:
        f.write("\n/* an old edit */\n")
    manifest = vault / OBS / "plugins" / "scriptorium" / "manifest.json"
    m = json.loads(manifest.read_text(encoding="utf-8"))
    m["version"] = "1.0.2"
    write_json(manifest, m)
    (vault / "README.md").write_text("An old README.\n", encoding="utf-8")
    (vault / OBS / "themes" / "Typewriter" / "LICENSE").unlink()
    before = snapshot(vault)

    r = run(exe, "--update-only", str(vault))
    check(r.returncode == 0, "--update-only exits 0")
    check(f"(from 1.0.2 to {package_version()})" in r.stdout, "it reports the versions it updated from and to")
    after = snapshot(vault)

    for rel in ("Lorem Ipsum.md", "My note.md", f"{OBS}/snippets/mine.css", f"{OBS}/plugins/scriptorium/data.json",
                f"{OBS}/workspace.json"):
        check(after.get(rel) == before[rel], f"kept unchanged: {rel}")
    for rel in MANAGED:
        check(after.get(rel) == (PACKAGE / rel).read_bytes(), f"equal to the package: {rel}")
    check(all(rel in after for rel in before), "nothing was deleted")

    appearance = json.loads(after[f"{OBS}/appearance.json"])
    check(appearance.get("enabledCssSnippets") == ["mine", "manuscript"], "manuscript re-enabled, the user's snippet kept")
    check(appearance.get("theme") == "moonstone" and appearance.get("accentColor") == "#123456",
          "the rest of appearance.json kept")
    plugins = json.loads(after[f"{OBS}/community-plugins.json"])
    check(plugins == ["longform", "manuscriptum", "scriptorium", "calendar", "typewriter-mode", "lagrange"],
          "the missing plugins added, the list's order and the user's plugin kept")

    found = backups(vault)
    check(len(found) == 1, "one backup folder in .obsidian")
    if found:
        saved = snapshot(found[0], skip_backups=False)
        replaced = {f"{OBS}/snippets/manuscript.css", f"{OBS}/plugins/scriptorium/manifest.json", "README.md",
                    f"{OBS}/appearance.json", f"{OBS}/community-plugins.json"}
        check(set(saved) == replaced, "the backup holds exactly the replaced files")
        check(all(saved[rel] == before[rel] for rel in replaced & set(saved)), "the backup holds them as they were")

    print("\n== Updating again changes nothing ==")
    r = run(exe, "--update-only", str(vault))
    check(r.returncode == 0, "--update-only exits 0 the second time")
    check(snapshot(vault) == after, "the vault is unchanged")
    check(len(backups(vault)) == 1, "no new backup folder")


def test_unreadable_json(exe, work):
    print("\n== Settings files that are not valid JSON are left as they are ==")
    vault = fresh(exe, work, "badjson")
    (vault / OBS / "community-plugins.json").write_text("[not json", encoding="utf-8")
    (vault / OBS / "appearance.json").write_text("{oops", encoding="utf-8")
    before = snapshot(vault)
    r = run(exe, "--update-only", str(vault))
    check(r.returncode == 0, "--update-only exits 0")
    after = snapshot(vault)
    check(after == before, "the vault is unchanged (everything else was already up to date)")
    check("community-plugins.json as it was" in r.stdout and "appearance.json as it was" in r.stdout,
          "it logs that it left them as they were")


def test_not_a_vault(exe, work):
    print("\n== A folder that is not a Scriptorium vault is refused ==")
    folder = work / "notvault"
    folder.mkdir()
    (folder / "note.md").write_bytes(b"Someone else's notes.\n")
    r = run(exe, "--update-only", str(folder))
    check(r.returncode != 0, "--update-only fails")
    check(snapshot(folder) == {"note.md": b"Someone else's notes.\n"}, "the folder is unchanged")


def test_install_targets(exe, work):
    print("\n== Install fills an empty folder, and refuses any other folder ==")
    empty = work / "empty"
    empty.mkdir()
    r = run(exe, "--extract-only", str(empty))
    check(r.returncode == 0, "an empty folder is filled")
    check(snapshot(empty) == {p.relative_to(PACKAGE).as_posix(): p.read_bytes() for p in PACKAGE.rglob("*") if p.is_file()},
          "it holds exactly the package")
    other = work / "other"
    other.mkdir()
    (other / "note.md").write_bytes(b"Someone else's notes.\n")
    r = run(exe, "--extract-only", str(other))
    check(r.returncode != 0, "a folder with files in it is refused")
    check(snapshot(other) == {"note.md": b"Someone else's notes.\n"}, "and left unchanged")


def test_rollback(exe, work):
    print("\n== A failure half-way puts every file back ==")
    vault = fresh(exe, work, "rollback")
    with open(vault / OBS / "snippets" / "manuscript.css", "a", encoding="utf-8") as f:
        f.write("\n/* an old edit */\n")
    (vault / OBS / "themes" / "Typewriter" / "LICENSE").unlink()
    readme = vault / "README.md"
    readme.write_text("An old README, read-only.\n", encoding="utf-8")
    readme.chmod(stat.S_IREAD)   # written last (after .obsidian/...), and it cannot be: the update must undo itself
    before = snapshot(vault)
    try:
        r = run(exe, "--update-only", str(vault))
        check(r.returncode != 0, "--update-only fails")
        check(snapshot(vault) == before, "every file is as it was (replaced ones restored, new ones removed)")
        check(not backups(vault), "no backup folder is left behind")
        check(not (vault / OBS / "themes" / "Typewriter" / "LICENSE").exists(), "the file it had added is gone again")
    finally:
        readme.chmod(stat.S_IREAD | stat.S_IWRITE)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__ or "usage: test_update.py <Scriptorium-Setup.exe>")
    exe = Path(sys.argv[1]).resolve()
    work = Path(tempfile.mkdtemp(prefix="scriptorium-update-test-"))
    try:
        test_update(exe, work)
        test_unreadable_json(exe, work)
        test_not_a_vault(exe, work)
        test_install_targets(exe, work)
        test_rollback(exe, work)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print()
    if failures:
        print(f"{len(failures)} check(s) failed:")
        for f in failures:
            print("  " + f)
        sys.exit(1)
    print("All update checks passed.")


if __name__ == "__main__":
    main()
