#!/usr/bin/env python3
# Tests setting up Scriptorium in a vault that is not a Scriptorium vault yet: a vault with notes, plugins and settings
# of its own, and a bare folder of notes. Three programs do it by the same rules, and are tested by the same checks:
#   - installers/Setup-Scriptorium-Vault.py (any system), always;
#   - Scriptorium-Setup.exe --setup-plan / --setup-only <vault> (Windows), when the exe is given;
#   - the Scriptorium plugin's command "Set up another vault", through plugins-tests/setup-vault-cli.js, when node is
#     on PATH.
#
# Usage: python3 tools/test_setup_vault.py                              (the script only)
#        python3 tools/test_setup_vault.py dist/Scriptorium-Setup.exe   (the script and the exe)
# On Windows the exe runs directly; elsewhere it runs under Mono (MONO=<prefix>, or mono on PATH). It needs no network:
# the script takes the package from vault/, the exe from the package embedded in it.
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
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "vault"
SCRIPT = ROOT / "installers" / "Setup-Scriptorium-Vault.py"
OBS = ".obsidian"
BUNDLED = ("scriptorium", "manuscriptum", "typewriter-mode", "lagrange")

# Scriptorium's own files: setting up must make each of these equal to the package.
MANAGED = [f"{OBS}/snippets/manuscript.css", f"{OBS}/plugins/lagrange/LagrangeHand-OFL.txt"] + [
    f"{OBS}/plugins/{p}/{f}" for p in BUNDLED for f in ("main.js", "manifest.json", "styles.css", "LICENSE")
] + sorted(p.relative_to(PACKAGE).as_posix() for p in (PACKAGE / OBS / "themes" / "Typewriter").iterdir()) + sorted(
    p.relative_to(PACKAGE).as_posix() for p in (PACKAGE / OBS / "plugins" / "scriptorium" / "dropcaps").rglob("*") if p.is_file())
# Written only where the vault has none of its own.
DEFAULTS = [f"{OBS}/core-plugins.json"] + [f"{OBS}/plugins/{p}/data.json" for p in BUNDLED
                                           if (PACKAGE / OBS / "plugins" / p / "data.json").exists()]
# Never part of setting up a vault that has notes.
LEFT_OUT = ["Lorem Ipsum.md", "README.md", f"{OBS}/workspace.json", f"{OBS}/graph.json"]

failures = []


def check(ok, what):
    print(("PASS  " if ok else "FAIL  ") + what)
    if not ok:
        failures.append(what)


class Tool:
    """One of the two programs: plan(vault) shows what would change, setup(vault) does it."""

    def __init__(self, name, plan, setup):
        self.name, self._plan, self._setup = name, plan, setup
        self.env = {}   # more of the environment, for one test

    def _run(self, cmd):
        # The children write UTF-8 (the script and Node do when asked; the exe's few non-ASCII characters may not
        # survive a Windows console code page, which is fine: the checks look at ASCII text and at the files).
        env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8", SCRIPTORIUM_NO_FONTS="1", SCRIPTORIUM_NO_DIAGRAM_PLUGINS="1", **self.env)   # the fonts and the diagram plugins have tests of their own (test_fonts.py, test_diagram_plugins.py)
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300, encoding="utf-8", errors="replace", env=env)
        for line in (r.stdout + r.stderr).splitlines():
            print("      | " + line)
        return r

    def plan(self, vault):
        return self._run(self._plan + [str(vault)])

    def setup(self, vault):
        return self._run(self._setup + [str(vault)])


def tools(exe):
    py = [sys.executable, str(SCRIPT)]
    found = [Tool("Setup-Scriptorium-Vault.py", py + ["--dry-run"], py + ["--yes", "--no-diagram-plugins"])]   # (the diagram plugins are downloaded: tools/test_diagram_plugins.py tests that without the network)
    if exe:
        if os.name == "nt":
            run = [str(exe)]
        else:
            mono = os.environ.get("MONO")
            run = [os.path.join(mono, "bin", "mono") if mono else "mono", str(exe)]
        # The exe takes the option first, then the vault.
        t = Tool("Scriptorium-Setup.exe", run + ["--setup-plan"], run + ["--setup-only"])
        found.append(t)
    node = shutil.which("node")
    if node:   # the Scriptorium plugin's own "Set up another vault", copying from vault/
        cli = [node, str(ROOT / "plugins-tests" / "setup-vault-cli.js")]
        found.append(Tool("the plugin's Set up another vault", cli + ["--dry-run"], cli + ["--yes"]))
    else:
        print("node was not found: the plugin's command is not tested here (plugins-tests/ tests it under Node)")
    return found


def snapshot(vault, skip_backups=True):
    files = {}
    for p in sorted(vault.rglob("*")):
        rel = p.relative_to(vault).as_posix()
        if p.is_file() and not (skip_backups and rel.startswith(f"{OBS}/scriptorium-backup-")):
            files[rel] = p.read_bytes()
    return files


def backups(vault):
    return sorted(p for p in (vault / OBS).iterdir() if p.name.startswith("scriptorium-backup-")) if (vault / OBS).is_dir() else []


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def package(rel):
    return (PACKAGE / rel).read_bytes()


def my_vault(work, name):
    """A vault someone already writes in: notes, a plugin and a snippet of their own, their own settings and hotkeys."""
    vault = work / name
    (vault / "Journal").mkdir(parents=True)
    (vault / "Novel.md").write_text("# Chapter one\n\nIt was a dark and stormy night.\n", encoding="utf-8")
    (vault / "Journal" / "2026-11-12.md").write_text("Wrote 500 words.\n", encoding="utf-8")
    (vault / "README.md").write_text("My own README.\n", encoding="utf-8")
    (vault / "cover.png").write_bytes(bytes(range(256)))
    write_json(vault / OBS / "plugins" / "calendar" / "data.json", {"weekStart": "monday"})
    (vault / OBS / "plugins" / "calendar" / "main.js").write_text("/* calendar */\n", encoding="utf-8")
    write_json(vault / OBS / "plugins" / "calendar" / "manifest.json", {"id": "calendar", "version": "1.5.10"})
    (vault / OBS / "snippets").mkdir()
    (vault / OBS / "snippets" / "mine.css").write_text("/* my snippet */\n", encoding="utf-8")
    write_json(vault / OBS / "community-plugins.json", ["calendar"])
    write_json(vault / OBS / "appearance.json",
               {"theme": "moonstone", "cssTheme": "Minimal", "enabledCssSnippets": ["mine"], "accentColor": "#123456"})
    write_json(vault / OBS / "app.json", {"baseFontSize": 16, "spellcheck": True})
    write_json(vault / OBS / "hotkeys.json", {"editor:toggle-bold": [{"modifiers": ["Mod"], "key": "B"}]})
    write_json(vault / OBS / "workspace.json", {"main": {"id": "mine"}})
    write_json(vault / OBS / "core-plugins.json", {"file-explorer": True, "graph": False})
    return vault


def test_my_vault(tool, work):
    print(f"\n== {tool.name}: a vault with notes and settings of its own ==")
    vault = my_vault(work, "mine")
    before = snapshot(vault)

    r = tool.plan(vault)
    check(r.returncode == 0, "the plan exits 0")
    check(snapshot(vault, skip_backups=False) == before, "showing the plan changes nothing")
    out = r.stdout
    check("community-plugins.json" in out and "manuscriptum, typewriter-mode, scriptorium, lagrange" in out,
          "the plan says which community plugins it turns on")
    check("appearance.json" in out and "from Minimal to Typewriter" in out and "manuscript snippet" in out,
          "the plan says what it changes in appearance.json")
    check(f"add      {OBS}/plugins/lagrange/main.js" in out and f"add      {OBS}/snippets/manuscript.css" in out,
          "the plan lists the files it adds")
    check("kept your baseFontSize" in out, "the plan says it keeps the vault's own text size")
    check(not any(name in out for name in ("Novel.md", "Journal", "hotkeys.json", "Lorem Ipsum", "workspace.json", "calendar/")),
          "the plan names no note, no hotkeys, no workspace and none of the vault's own plugins")

    r = tool.setup(vault)
    check(r.returncode == 0, "setting up exits 0")
    after = snapshot(vault)
    for rel in before:
        if rel not in (f"{OBS}/community-plugins.json", f"{OBS}/appearance.json"):
            check(after.get(rel) == before[rel], f"kept unchanged: {rel}")
    for rel in MANAGED:
        check(after.get(rel) == package(rel), f"equal to the package: {rel}")
    for rel in DEFAULTS:
        if rel not in before:
            check(after.get(rel) == package(rel), f"added, as in the package: {rel}")
    for rel in LEFT_OUT:
        check(after.get(rel) == before.get(rel), f"not brought from the package: {rel}")
    check(set(after) - set(before) == (set(MANAGED) | set(DEFAULTS)) - set(before), "nothing else was added")

    plugins = json.loads(after[f"{OBS}/community-plugins.json"])
    check(plugins == ["calendar", "manuscriptum", "typewriter-mode", "scriptorium", "lagrange"],
          "the vault's plugin stays on, Scriptorium's four are added, Longform (not installed) is not")
    appearance = json.loads(after[f"{OBS}/appearance.json"])
    check(appearance.get("enabledCssSnippets") == ["mine", "manuscript"], "the vault's snippet stays on, manuscript is added")
    check(appearance.get("cssTheme") == "Typewriter", "the theme is Typewriter")
    check(appearance.get("theme") == "moonstone" and appearance.get("accentColor") == "#123456", "the rest of appearance.json kept")

    found = backups(vault)
    check(len(found) == 1, "one backup folder in .obsidian")
    if found:
        saved = snapshot(found[0], skip_backups=False)
        config = {rel: data for rel, data in before.items() if rel.startswith(OBS + "/")}
        check(saved == config, "the backup is the whole .obsidian folder as it was")

    print(f"\n== {tool.name}: setting up again changes nothing ==")
    r = tool.setup(vault)
    check(r.returncode == 0, "setting up exits 0 the second time")
    check("nothing" in (r.stdout + r.stderr).lower(), "it says there was nothing to change")
    check(snapshot(vault) == after, "the vault is unchanged")
    check(len(backups(vault)) == 1, "no second backup folder")
    r = tool.plan(vault)
    check(r.returncode == 0 and "add      " not in r.stdout and "replace  " not in r.stdout and "merge    " not in r.stdout,
          "the plan is empty")

    print(f"\n== {tool.name}: an old copy of one of Scriptorium's files is replaced, and backed up ==")
    target = vault / OBS / "snippets" / "manuscript.css"
    target.write_bytes(b"/* an old manuscript.css */\n")
    r = tool.setup(vault)
    check(r.returncode == 0, "setting up exits 0")
    check(target.read_bytes() == package(f"{OBS}/snippets/manuscript.css"), "the snippet is the package's again")
    found = backups(vault)
    check(len(found) == 2, "a second backup folder")
    if len(found) == 2:
        check((found[1] / OBS / "snippets" / "manuscript.css").read_bytes() == b"/* an old manuscript.css */\n",
              "which holds the old snippet")
        check(not any(p.name.startswith("scriptorium-backup-") for p in (found[1] / OBS).iterdir()),
              "and not the earlier backup")


def test_bare_folder(tool, work):
    print(f"\n== {tool.name}: a folder of notes that has never been a vault ==")
    vault = work / "bare"
    vault.mkdir()
    (vault / "Essay.md").write_text("An essay.\n", encoding="utf-8")
    before = snapshot(vault)
    r = tool.setup(vault)
    check(r.returncode == 0, "setting up exits 0")
    after = snapshot(vault)
    check(after.get("Essay.md") == before["Essay.md"], "the note is unchanged")
    for rel in MANAGED + DEFAULTS:
        check(after.get(rel) == package(rel), f"as in the package: {rel}")
    check(json.loads(after[f"{OBS}/community-plugins.json"]) == ["manuscriptum", "typewriter-mode", "scriptorium", "lagrange"],
          "Scriptorium's four plugins are on (Longform is not installed, so it is not listed)")
    appearance = json.loads(after[f"{OBS}/appearance.json"])
    check(appearance.get("cssTheme") == "Typewriter" and appearance.get("enabledCssSnippets") == ["manuscript"],
          "the theme and the snippet are on")
    check(json.loads(after[f"{OBS}/app.json"]).get("baseFontSize") == 22, "Scriptorium's text size is set")
    check(all(rel not in after for rel in LEFT_OUT), "no sample note, README, workspace or graph settings")
    check(not backups(vault), "no backup folder: there was no .obsidian to back up")
    r = tool.setup(vault)
    check(r.returncode == 0 and snapshot(vault) == after and not backups(vault), "setting up again changes nothing")


def test_text_size_in_appearance(tool, work):
    print(f"\n== {tool.name}: a text size Obsidian keeps in appearance.json is the vault's own ==")
    # Obsidian moves baseFontSize from app.json to appearance.json when it opens a vault.
    vault = work / "moved"
    (vault / OBS).mkdir(parents=True)
    (vault / "note.md").write_text("A note.\n", encoding="utf-8")
    write_json(vault / OBS / "appearance.json", {"baseFontSize": 18})
    r = tool.setup(vault)
    check(r.returncode == 0, "setting up exits 0")
    check("kept your baseFontSize (18" in r.stdout, "it says it kept the vault's text size")
    check(not (vault / OBS / "app.json").exists(), "no app.json is written just to set the text size again")
    check(json.loads((vault / OBS / "appearance.json").read_text(encoding="utf-8")).get("baseFontSize") == 18, "the text size is still 18")
    opened = work / "opened"   # a vault set up, then opened: Obsidian has emptied app.json into appearance.json
    (opened / OBS).mkdir(parents=True)
    tool.setup(opened)
    write_json(opened / OBS / "app.json", {})
    appearance = json.loads((opened / OBS / "appearance.json").read_text(encoding="utf-8"))
    appearance["baseFontSize"] = 22
    write_json(opened / OBS / "appearance.json", appearance)
    before = snapshot(opened)
    r = tool.setup(opened)
    check(r.returncode == 0 and snapshot(opened) == before and not backups(opened), "a vault Obsidian has opened since is left as it is")


def test_unreadable_json(tool, work):
    print(f"\n== {tool.name}: settings files that are not valid JSON are left as they are ==")
    vault = work / "badjson"
    (vault / OBS).mkdir(parents=True)
    (vault / "note.md").write_text("A note.\n", encoding="utf-8")
    (vault / OBS / "community-plugins.json").write_text("[not json", encoding="utf-8")
    (vault / OBS / "appearance.json").write_text("{oops", encoding="utf-8")
    (vault / OBS / "app.json").write_text("[]", encoding="utf-8")
    r = tool.setup(vault)
    check(r.returncode == 0, "setting up exits 0")
    after = snapshot(vault)
    check(after[f"{OBS}/community-plugins.json"] == b"[not json" and after[f"{OBS}/appearance.json"] == b"{oops"
          and after[f"{OBS}/app.json"] == b"[]", "the three files are unchanged")
    out = r.stdout
    check("community-plugins.json as it was" in out and "appearance.json as it was" in out and "app.json as it was" in out,
          "it says that it left them as they were")
    check(after.get(f"{OBS}/plugins/scriptorium/main.js") == package(f"{OBS}/plugins/scriptorium/main.js"),
          "Scriptorium's files are there all the same")


def test_rollback(tool, work):
    print(f"\n== {tool.name}: a failure half-way puts every file back ==")
    vault = my_vault(work, "rollback")
    # A folder where one of Scriptorium's files has to go: that file cannot be written, and it comes after others.
    (vault / OBS / "themes" / "Typewriter" / "theme.css").mkdir(parents=True)
    (vault / OBS / "themes" / "Typewriter" / "theme.css" / "keep.txt").write_text("mine\n", encoding="utf-8")
    before = snapshot(vault)
    r = tool.setup(vault)
    check(r.returncode != 0, "setting up fails")
    check(snapshot(vault) == before, "every file is as it was (merged ones restored, added ones removed)")
    check(not backups(vault), "no backup folder is left behind")
    check(not (vault / OBS / "plugins" / "scriptorium").exists(), "the folders it had made are gone again")


def test_refusals(tool, work):
    print(f"\n== {tool.name}: what is not a vault folder is refused ==")
    r = tool.setup(work / "missing")
    check(r.returncode != 0 and not (work / "missing").exists(), "a folder that does not exist: refused, and not created")
    inside = my_vault(work, "inside") / OBS
    before = snapshot(inside.parent)
    r = tool.setup(inside)
    check(r.returncode != 0 and snapshot(inside.parent) == before, "a vault's .obsidian folder itself: refused, unchanged")


SYNC_CLI = ROOT / "plugins-tests" / "sync-state-cli.js"
SYNC_KEPT = "The sync of this vault with Google Drive is kept as it is"
SYNC_FILES = (".scriptorium-sync", f"{OBS}/plugins/scriptorium/data.json", f"{OBS}/plugins/scriptorium/drive-sync.json")


def sync_cli(node, mode, vault, user):
    r = subprocess.run([node, str(SYNC_CLI), mode, str(vault), str(user)], capture_output=True, text=True, timeout=120,
                       encoding="utf-8", errors="replace")
    for line in (r.stdout + r.stderr).splitlines():
        print("      | " + line)
    return r.returncode == 0


def test_sync_kept(tool, work):
    """A vault that syncs with Google Drive is set up, and a Scriptorium vault of 1.2.3 that syncs is updated by
    setting it up again: the sync's files, in the vault and in Scriptorium's own folder outside it, are the same bytes
    afterwards, and the plugin's own code finds the sync set up, with a plain sync next (plugins-tests/sync-state-cli.js)."""
    node = shutil.which("node")
    if not node:
        print(f"\nnode was not found: {tool.name} is not tested on a vault that syncs")
        return
    # Scriptorium's own folder, where the plugin would look for it on this system (see syncUserDir in the plugin).
    user = work / "user data" / ("Scriptorium" if os.name == "nt" else "scriptorium")
    tool.env = {"SCRIPTORIUM_USER_DIR": str(user), "XDG_DATA_HOME": str(user.parent)}
    try:
        print(f"\n== {tool.name}: a vault that syncs with Google Drive is set up, and the sync is as it was ==")
        vault = my_vault(work, "synced")   # (its Scriptorium files were taken out; its settings and its sync stayed)
        check(sync_cli(node, "make", vault, user), "the vault's sync is set up (a pretend sign-in, a Drive folder, a record of the last sync)")
        before, outside = snapshot(vault), snapshot(user, skip_backups=False)
        r = tool.plan(vault)
        check(r.returncode == 0 and SYNC_KEPT in r.stdout, "the plan says that the sync is kept")
        check(snapshot(vault) == before and snapshot(user, skip_backups=False) == outside, "the plan changes nothing")
        r = tool.setup(vault)
        after = snapshot(vault)
        check(r.returncode == 0 and all(after.get(rel) == package(rel) for rel in MANAGED), "it is set up")
        check(SYNC_KEPT in r.stdout, "it says that the sync is kept")
        for rel in SYNC_FILES:
            check(after.get(rel) == before[rel], f"kept byte for byte: {rel}")
        check(snapshot(user, skip_backups=False) == outside, "Scriptorium's own folder outside the vault is byte for byte as it was")
        check(sync_cli(node, "check", vault, user), "the plugin finds the sync set up, and the next sync is a plain one")
        r = tool.setup(vault)
        check(r.returncode == 0 and snapshot(vault) == after and len(backups(vault)) == 1, "run again, it changes nothing")
        check(snapshot(user, skip_backups=False) == outside and sync_cli(node, "check", vault, user), "and the sync is still set up")

        print(f"\n== {tool.name}: a Scriptorium vault of 1.2.3 that syncs is updated, and the sync is as it was ==")
        vault = work / "synced-1.2.3"
        shutil.copytree(PACKAGE, vault)
        manifest = vault / OBS / "plugins" / "scriptorium" / "manifest.json"
        m = json.loads(manifest.read_text(encoding="utf-8"))
        m["version"] = "1.2.3"
        write_json(manifest, m)
        with open(vault / OBS / "plugins" / "scriptorium" / "main.js", "a", encoding="utf-8") as f:
            f.write("\n/* the code of an older version */\n")
        shutil.rmtree(user)
        check(sync_cli(node, "make", vault, user), "the vault's sync is set up")
        before, outside = snapshot(vault), snapshot(user, skip_backups=False)
        r = tool.setup(vault)
        after = snapshot(vault)
        check(r.returncode == 0 and all(after.get(rel) == package(rel) for rel in MANAGED), "Scriptorium's files are the new ones")
        check(SYNC_KEPT in r.stdout, "it says that the sync is kept")
        for rel in SYNC_FILES:
            check(after.get(rel) == before[rel], f"kept byte for byte: {rel}")
        check(all(after.get(rel) == data for rel, data in before.items() if rel not in MANAGED), "and so is every other file of the vault")
        check(snapshot(user, skip_backups=False) == outside, "Scriptorium's own folder outside the vault is byte for byte as it was")
        check(sync_cli(node, "check", vault, user), "the plugin finds the sync set up, and the next sync is a plain one")

        print(f"\n== {tool.name}: a vault that does not sync is told nothing about a sync ==")
        r = tool.setup(my_vault(work, "not-synced"))
        check(r.returncode == 0 and SYNC_KEPT not in r.stdout, "no word about a sync")
    finally:
        tool.env = {}


def test_installers_refuse(work):
    """The three script installers make new vaults only: given a vault that is there, they stop before anything is
    downloaded or written, and say how such a vault is updated."""
    print("\n== The script installers leave a vault that is there alone ==")
    installers = ROOT / "installers"
    cmd = (installers / "Install-Scriptorium-Windows.cmd").read_text(encoding="utf-8")
    refusal = cmd.find("Folder already exists")
    check(0 <= refusal < cmd.find("$tempPath =") and "sync with Google Drive" in cmd[refusal:cmd.find("$tempPath =")],
          "Install-Scriptorium-Windows.cmd: it stops before its first file is written, and says that an update keeps the sync (read, not run)")
    bash, node = shutil.which("bash"), shutil.which("node")
    if os.name == "nt" or not bash:
        print("no bash here: the macOS and Linux scripts are not run")
        return
    vault = work / "refused" / "vault"
    shutil.copytree(PACKAGE, vault)
    user = work / "refused" / "home" / ".local" / "share" / "scriptorium"
    if node:
        sync_cli(node, "make", vault, user)
    before = snapshot(work / "refused", skip_backups=False)
    for name in ("Install-Scriptorium-Linux.sh", "Install-Scriptorium-macOS.command"):
        r = subprocess.run([bash, str(installers / name)], input=f"{vault}\n", capture_output=True, text=True, timeout=120,
                           env=dict(os.environ, HOME=str(work / "refused" / "home"), XDG_DATA_HOME=str(user.parent)))
        for line in (r.stdout + r.stderr).splitlines():
            print("      | " + line)
        check(r.returncode == 1 and "nothing was changed" in r.stdout, f"{name}: refuses the folder")
        check("Setup-Scriptorium-Vault.py" in r.stdout and "sync with Google Drive" in r.stdout, f"{name}: says how to update it, and that the sync is kept then")
        check(snapshot(work / "refused", skip_backups=False) == before, f"{name}: the vault and Scriptorium's own folder are byte for byte as they were")


def test_script_download(work):
    print("\n== Setup-Scriptorium-Vault.py: the download names itself, and a failed download is said plainly ==")
    import importlib.util
    spec = importlib.util.spec_from_file_location("setup_vault", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    seen = {}

    class Reply:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b"not the package"

    def opener(request, timeout=None):
        seen["agent"] = request.get_header("User-agent")
        seen["url"] = request.full_url
        if seen.get("fail"):
            raise mod.urllib.request.HTTPError(request.full_url, 403, "Forbidden", {}, None)
        return Reply()

    real = mod.urllib.request.urlopen
    mod.urllib.request.urlopen = opener
    try:
        try:
            mod.download_package()
            check(False, "a download that does not match the pinned SHA-256 is refused")
        except mod.SetupError as e:
            check("SHA-256" in str(e), "a download that does not match the pinned SHA-256 is refused")
        check(seen.get("agent", "").startswith("Setup-Scriptorium-Vault/"), "the request names the script (the site refuses Python's default User-Agent)")
        check(seen.get("url", "").startswith("https://williamliaw.com/"), "it asks williamliaw.com, over https")
        seen["fail"] = True
        try:
            mod.download_package()
            check(False, "an HTTP error is a plain message, not a traceback")
        except mod.SetupError as e:
            check("--package" in str(e) and "403" in str(e), "an HTTP error is a plain message that says what to do")
    finally:
        mod.urllib.request.urlopen = real


def test_same_result(found, work):
    print("\n== Every program leaves the same vault ==")
    vaults = []
    for i, tool in enumerate(found):
        vault = my_vault(work / f"same{i}", "vault")
        tool.setup(vault)
        vaults.append(snapshot(vault))
    a = vaults[0]
    for tool, b in zip(found[1:], vaults[1:]):
        check(set(a) == set(b), f"{found[0].name} and {tool.name}: the same files")
        differ = [rel for rel in sorted(set(a) & set(b))
                  if not (json.loads(a[rel]) == json.loads(b[rel]) if rel.endswith(".json") and a[rel] != b[rel] else a[rel] == b[rel])]
        check(not differ, f"{found[0].name} and {tool.name}: the same content (JSON compared as values)" +
              (f"; differ: {differ}" if differ else ""))


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # a Windows console code page cannot print everything
    except (AttributeError, ValueError):
        pass
    if len(sys.argv) > 2:
        sys.exit("usage: test_setup_vault.py [Scriptorium-Setup.exe]")
    exe = Path(sys.argv[1]).resolve() if len(sys.argv) == 2 else None
    found = tools(exe)
    work = Path(tempfile.mkdtemp(prefix="scriptorium-setup-test-"))
    try:
        for tool in found:
            sub = work / tool.name.replace(".", "-")
            sub.mkdir()
            test_my_vault(tool, sub)
            test_bare_folder(tool, sub)
            test_text_size_in_appearance(tool, sub)
            test_unreadable_json(tool, sub)
            test_rollback(tool, sub)
            test_refusals(tool, sub)
            test_sync_kept(tool, sub)
        test_installers_refuse(work)
        test_script_download(work)
        if len(found) > 1:
            test_same_result(found, work)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print()
    if failures:
        print(f"{len(failures)} check(s) failed:")
        for f in failures:
            print("  " + f)
        sys.exit(1)
    print("All vault setup checks passed.")


if __name__ == "__main__":
    main()
