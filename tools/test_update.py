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
] + sorted(p.relative_to(PACKAGE).as_posix() for p in (PACKAGE / OBS / "themes" / "Typewriter").iterdir()) + sorted(
    p.relative_to(PACKAGE).as_posix() for p in (PACKAGE / OBS / "plugins" / "scriptorium" / "dropcaps").rglob("*") if p.is_file())

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
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=300, env=dict(os.environ, SCRIPTORIUM_NO_FONTS="1", SCRIPTORIUM_NO_DIAGRAM_PLUGINS="1"))   # the fonts and the diagram plugins have tests of their own (test_fonts.py, test_diagram_plugins.py)
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


# Whether Obsidian counts as installed (Scriptorium-Setup.exe --find-obsidian <what the registry says obsidian:// links
# run> <folders programs are installed in>...). Obsidian's uninstaller leaves the link in the registry; 1.2.0 took the
# link alone to mean "Obsidian is already installed", so after an uninstall Setup installed no Obsidian.
def test_find_obsidian(exe, work):
    print("\nIs Obsidian installed? Only if its program is on the disk")
    base, other, gone = work / "find" / "LocalAppData", work / "find" / "Program Files", work / "find" / "Elsewhere" / "Obsidian.exe"
    base.mkdir(parents=True)
    other.mkdir()

    def find(command, *dirs):
        r = run(exe, "--find-obsidian", command, *[str(d) for d in dirs])
        return r.returncode, r.stdout.strip()

    code, out = find("", base, other)
    check(code == 1 and out == "not installed", "nothing there: not installed")
    for command, what in ((f'"{gone}" "%1"', "in quotation marks"), (f"{gone} %1", "without quotation marks"), (f'"{gone}"', "with no argument")):
        code, out = find(command, base, other)
        check(code == 1 and out.startswith("not installed: the obsidian:// link is left over") and str(gone) in out,
              f"the obsidian:// link is registered ({what}) but its program is gone: not installed")
    code, out = find('"C:\\Windows\\notepad" "%1"', base, other)
    check(code == 1 and out.startswith("not installed"), "a link that names no .exe: not installed")
    code, out = find("", work / "find" / "no such folder", "")
    check(code == 1, "folders that do not exist, and an empty one: not installed")

    gone.parent.mkdir()
    gone.write_bytes(b"MZ program")
    for command in (f'"{gone}" "%1"', f"{gone} %1"):
        code, out = find(command, base, other)
        check(code == 0 and out == f"installed: {gone}", f"the link's program is there ({'quoted' if command[0] == chr(34) else 'unquoted'}): installed, elsewhere")
    gone.write_bytes(b"")
    code, out = find(f'"{gone}" "%1"', base, other)
    check(code == 1, "the link's program is an empty file: not installed")

    for rel in (("Programs", "Obsidian"), ("Obsidian",)):
        home = (other if len(rel) == 1 else base).joinpath(*rel)
        home.mkdir(parents=True)
        (home / "Obsidian.exe").write_bytes(b"")
        code, out = find("", base, other)
        check(code == 1, f"an empty Obsidian.exe in {'/'.join(rel)}: not installed")
        (home / "Obsidian.exe").write_bytes(b"MZ program")
        code, out = find(f'"{gone}" "%1"', base, other)
        check(code == 0 and out == f"installed: {home / 'Obsidian.exe'}", f"Obsidian.exe in {'/'.join(rel)}: installed (whatever the link says)")
        shutil.rmtree(home)
    code, out = find("", base, other)
    check(code == 1, "and once that folder is removed again: not installed")

    if os.name == "nt":
        test_find_obsidian_registry(exe, work)


# Windows only: the real registry. With no Obsidian on the machine (as on a CI runner), the link is registered for
# this user as an uninstalled Obsidian leaves it, and then with a program behind it.
def test_find_obsidian_registry(exe, work):
    import winreg
    r = run(exe, "--find-obsidian")
    if r.returncode == 0:
        print("      (Obsidian is installed on this machine: the registry cases are not run)")
        return
    key = r"Software\Classes\obsidian\shell\open\command"
    try:
        winreg.OpenKey(winreg.HKEY_CURRENT_USER, key).Close()
        print("      (this user already has an obsidian:// link: the registry cases are not run)")
        return
    except OSError:
        pass
    program = work / "find" / "Registered" / "Obsidian.exe"
    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key) as k:
            winreg.SetValueEx(k, "", 0, winreg.REG_SZ, f'"{program}" "%1"')
        r = run(exe, "--find-obsidian")
        check(r.returncode == 1 and "left over" in r.stdout and str(program) in r.stdout,
              "registry: the obsidian:// link is there, Obsidian.exe is not: Setup offers to install Obsidian")
        program.parent.mkdir(parents=True)
        program.write_bytes(b"MZ program")
        r = run(exe, "--find-obsidian")
        check(r.returncode == 0 and r.stdout.strip() == f"installed: {program}", "registry: the link's program exists: installed")
    finally:
        for sub in (key, r"Software\Classes\obsidian\shell\open", r"Software\Classes\obsidian\shell", r"Software\Classes\obsidian"):
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, sub)
            except OSError:
                pass
    r = run(exe, "--find-obsidian")
    check(r.returncode == 1 and r.stdout.strip() == "not installed", "registry: no link, no program: not installed")


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
        test_find_obsidian(exe, work)
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
