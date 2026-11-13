#!/usr/bin/env python3
# Tests how the installers add the TikZJax and Excalidraw plugins to a vault (installers/Setup-Scriptorium-Vault.py's
# install_diagram_plugins, which the other installers follow): a fresh vault, a vault that already has a plugin, and
# a download that fails. No network: the releases are stood in for by bytes made here.
#
#     python3 tools/test_diagram_plugins.py
#
# Copyright (C) 2026 William Liaw. GNU General Public License, version 3 or later (see LICENSE).
import hashlib
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("setup_vault", ROOT / "installers" / "Setup-Scriptorium-Vault.py")
S = importlib.util.module_from_spec(spec)
sys.dont_write_bytecode = True
spec.loader.exec_module(S)

failed = []


def check(ok, what):
    print(("PASS  " if ok else "FAIL  ") + what)
    if not ok:
        failed.append(what)


# the pinned list is well formed, and names two plugins by their own release addresses
check([p["id"] for p in S.DIAGRAM_PLUGINS] == ["obsidian-tikzjax", "obsidian-excalidraw-plugin"], "TikZJax and Excalidraw are the two plugins")
for p in S.DIAGRAM_PLUGINS:
    check(p["base"].startswith("https://github.com/") and f"/releases/download/{p['version']}/" in p["base"], f"{p['name']} comes from its own GitHub release, at its pinned version")
    check(sorted(p["files"]) == ["main.js", "manifest.json", "styles.css"] and all(len(h) == 64 for h in p["files"].values()), f"{p['name']}: three files, each with a SHA-256")

# stand-ins for the releases
content = {}
for p in S.DIAGRAM_PLUGINS:
    files = {"main.js": f"// {p['id']}".encode(), "styles.css": b"/* css */",
             "manifest.json": json.dumps({"id": p["id"], "version": p["version"]}).encode()}
    p["files"] = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
    for name, data in files.items():
        content[p["base"] + name] = data
fetch = content.__getitem__
tikz, excalidraw = S.DIAGRAM_PLUGINS


def vault_with(plugins_on):
    v = Path(tempfile.mkdtemp(prefix="scriptorium-diagrams-"))
    (v / ".obsidian").mkdir()
    (v / ".obsidian" / "community-plugins.json").write_text(json.dumps(plugins_on), encoding="utf-8")
    return v


def on(v):
    return json.loads((v / ".obsidian" / "community-plugins.json").read_text(encoding="utf-8"))


log = []
# 1. a fresh vault: both are installed and turned on, after the plugins that were on
v = vault_with(["scriptorium", "lagrange"])
r = S.install_diagram_plugins(v, fetch, log.append)
check(r == {tikz["id"]: "installed", excalidraw["id"]: "installed"}, "fresh vault: both plugins are installed")
check(all((v / ".obsidian" / "plugins" / p["id"] / n).read_bytes() == content[p["base"] + n] for p in S.DIAGRAM_PLUGINS for n in p["files"]), "fresh vault: the three files of each are written as downloaded")
check(on(v) == ["scriptorium", "lagrange", tikz["id"], excalidraw["id"]], "fresh vault: both are turned on, and what was on stays on")
check(not list(v.rglob("*.scriptorium-tmp")), "fresh vault: no temporary file is left")
r = S.install_diagram_plugins(v, fetch, log.append)
check(set(r.values()) == {"kept"}, "run again: nothing is downloaded or written twice")

# 2. a vault that already has them: a newer version and its settings are left alone; an older one is brought up
v = vault_with(["calendar", excalidraw["id"]])
ex = v / ".obsidian" / "plugins" / excalidraw["id"]
ex.mkdir(parents=True)
(ex / "manifest.json").write_text(json.dumps({"id": excalidraw["id"], "version": "99.0.0"}), encoding="utf-8")
(ex / "main.js").write_text("// the writer's newer copy", encoding="utf-8")
(ex / "data.json").write_text('{"theirs": true}', encoding="utf-8")
tz = v / ".obsidian" / "plugins" / tikz["id"]
tz.mkdir(parents=True)
(tz / "manifest.json").write_text(json.dumps({"id": tikz["id"], "version": "0.1.0"}), encoding="utf-8")
(tz / "main.js").write_text("// old", encoding="utf-8")
(tz / "data.json").write_text('{"invertColorsInDarkMode": false}', encoding="utf-8")
r = S.install_diagram_plugins(v, fetch, log.append)
check(r == {tikz["id"]: "updated", excalidraw["id"]: "kept"}, "already installed: an older TikZJax is updated, a newer Excalidraw is kept")
check((ex / "main.js").read_text(encoding="utf-8") == "// the writer's newer copy" and json.loads((ex / "manifest.json").read_text(encoding="utf-8"))["version"] == "99.0.0", "already installed: the newer version is not overwritten")
check((ex / "data.json").read_text(encoding="utf-8") == '{"theirs": true}' and (tz / "data.json").read_text(encoding="utf-8") == '{"invertColorsInDarkMode": false}', "already installed: neither plugin's settings are touched")
check(on(v) == ["calendar", excalidraw["id"], tikz["id"]], "already installed: listed once each")

# 3. a download that fails: Scriptorium's set-up stands, the plugin is not installed or turned on, and the log says how to add it
def offline(url):
    if tikz["base"] in url:
        raise OSError("no network")
    return content[url]


log.clear()
v = vault_with(["scriptorium"])
r = S.install_diagram_plugins(v, offline, log.append)
check(r == {tikz["id"]: "failed", excalidraw["id"]: "installed"}, "download fails: that plugin fails, the other is installed")
check(not (v / ".obsidian" / "plugins" / tikz["id"]).exists() and on(v) == ["scriptorium", excalidraw["id"]], "download fails: nothing of the failed plugin is written, and it is not turned on")
check(any("TikZJax was NOT installed" in line and "Community plugins" in line for line in log), "download fails: the log names the plugin and says how to add it")


def tampered(url):
    return b"something else" if url.endswith("excalidraw-plugin/releases/download/%s/main.js" % excalidraw["version"]) else content[url]


v = vault_with([])
r = S.install_diagram_plugins(v, tampered, log.append)
check(r[excalidraw["id"]] == "failed" and not (v / ".obsidian" / "plugins" / excalidraw["id"]).exists(), "a file that does not match its SHA-256 is refused, and none of that plugin's files is written")

# 4. the macOS and Linux script installers: the same, in a new vault, with a stand-in for curl
import os
import shutil
import subprocess

bash = shutil.which("bash")
for script in ("Install-Scriptorium-Linux.sh", "Install-Scriptorium-macOS.command"):
    text = (ROOT / "installers" / script).read_text(encoding="utf-8")
    start, end = text.find("# ---- The diagram plugins ----"), text.find("# ---- end of the diagram plugin functions ----")
    check(start > 0 and end > start, f"{script}: has the diagram plugin functions")
    for p in ("obsidian-tikzjax TikZJax 0.5.2 artisticat1/obsidian-tikzjax", "obsidian-excalidraw-plugin Excalidraw 2.29.2 zsviczian/obsidian-excalidraw-plugin"):
        check(f"diagram_plugin {p}" in text, f"{script}: installs {p.split()[1]} at its pinned version")
    check(text.count("cbae1ad4362d44173e56ba512f01e65de1f7cc69a4bf4733bc5711a2de101f41") == 1 and text.count("49dfc5667a7730dbc124cdfc2a4a8e89188100636493a39d6493bf5696a55541") == 1, f"{script}: pins the same files as Setup-Scriptorium-Vault.py")
    if not bash or os.name == "nt":
        continue
    work = Path(tempfile.mkdtemp(prefix="scriptorium-diagrams-sh-"))
    (work / "vault" / ".obsidian").mkdir(parents=True)
    (work / "vault" / ".obsidian" / "community-plugins.json").write_text('[\n  "scriptorium",\n  "lagrange"\n]\n', encoding="utf-8")
    (work / "bin").mkdir()
    (work / "served" / "good").mkdir(parents=True)
    for name in ("main.js", "manifest.json", "styles.css"):
        (work / "served" / "good" / name).write_text(f"stand-in {name}", encoding="utf-8")
    # the stand-in curl: serves the files of repositories named "good/…", and fails for any other
    (work / "bin" / "curl").write_text('#!/bin/bash\nurl=""; out=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; https://*) url="$1";; esac; shift; done\n'
                                       'case "$url" in */good/*) cp "' + str(work / "served" / "good") + '/${url##*/}" "$out";; *) exit 22;; esac\n', encoding="utf-8")
    os.chmod(work / "bin" / "curl", 0o755)
    h = {n: hashlib.sha256(f"stand-in {n}".encode()).hexdigest() for n in ("main.js", "manifest.json", "styles.css")}
    calls = (f'diagram_plugin plug-a "Plugin A" 1.0 good/a main.js {h["main.js"]} manifest.json {h["manifest.json"]} styles.css {h["styles.css"]}\n'
             f'diagram_plugin plug-b "Plugin B" 1.0 gone/b main.js {h["main.js"]} manifest.json {h["manifest.json"]} styles.css {h["styles.css"]}\n'
             f'diagram_plugin plug-c "Plugin C" 1.0 good/c main.js {h["main.js"]} manifest.json {"0" * 64} styles.css {h["styles.css"]}\n'
             'printf "missing:%s\\n" "$diagram_missing"\n')
    run = subprocess.run([bash, "-c", f'set -euo pipefail\nwork_dir="{work}"\nPATH="{work / "bin"}:$PATH"\n' + text[start:end] + calls], capture_output=True, text=True)
    plugins = work / "vault" / ".obsidian" / "plugins"
    check(run.returncode == 0 and "missing: Plugin B Plugin C" in run.stdout, f"{script}: a failed download and a wrong checksum do not stop the installer, and are named ({run.stderr.strip()[:120]})")
    check((plugins / "plug-a" / "main.js").is_file() and not (plugins / "plug-b").exists() and not (plugins / "plug-c").exists(), f"{script}: only the plugin that was downloaded whole is put in the vault")
    check(json.loads((work / "vault" / ".obsidian" / "community-plugins.json").read_text(encoding="utf-8")) == ["scriptorium", "lagrange", "plug-a"], f"{script}: it is turned on, after Scriptorium's own")

# 5. the Windows script installer pins the same files (it is run on Windows by tools/test_auto_open.py)
cmd = (ROOT / "installers" / "Install-Scriptorium-Windows.cmd").read_text(encoding="utf-8")
for digest in ("cbae1ad4362d44173e56ba512f01e65de1f7cc69a4bf4733bc5711a2de101f41", "09fbbb05aeffc32bc65365d8526fc2222ee971417dcd4afddeb989498a5e1de1", "d9a7f741ec8fdcbe5e0145152c799238cee8df5a14ddc7dc9feb3bb835ce068d",
               "49dfc5667a7730dbc124cdfc2a4a8e89188100636493a39d6493bf5696a55541", "8e82828fd9125615e8a361d0f15553e548cac2ee7a303e55387378a53b925fd9", "6c7a9914f83305d09f9957248897ff2f25cf2c2d4b46b2d9ab42f3c7ee1d29f0"):
    check(cmd.count(digest) == 1, f"Install-Scriptorium-Windows.cmd pins {digest[:8]}")
check("$diagramMissing += $plugin.Name" in cmd and "Not installed (the download failed)" in cmd, "Install-Scriptorium-Windows.cmd: a failed download is caught and named, and does not stop the installer")

print("All diagram plugin checks passed." if not failed else f"{len(failed)} check(s) FAILED")
sys.exit(1 if failed else 0)
