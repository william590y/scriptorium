#!/usr/bin/env python3
# Tests how the installers add the TikZJax and Excalidraw plugins to a vault (installers/Setup-Scriptorium-Vault.py's
# install_diagram_plugins, which the other installers follow): a fresh vault, a vault that already has a plugin, and
# a download that fails. No network: the releases are stood in for by bytes made here.
#
#     python3 tools/test_diagram_plugins.py                              (the scripts)
#     python3 tools/test_diagram_plugins.py dist/Scriptorium-Setup.exe   (and Scriptorium Setup: a new vault, an update
#                                                                         and a set-up; under Mono where it is not Windows)
# The Windows script installer's PowerShell is run where there is a PowerShell (Windows; pwsh elsewhere). For it and for
# Scriptorium Setup the releases are served from this computer (http://127.0.0.1), so their real download code runs.
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

# 5. the Windows script installer pins the same files
cmd = (ROOT / "installers" / "Install-Scriptorium-Windows.cmd").read_text(encoding="utf-8")
for digest in ("cbae1ad4362d44173e56ba512f01e65de1f7cc69a4bf4733bc5711a2de101f41", "09fbbb05aeffc32bc65365d8526fc2222ee971417dcd4afddeb989498a5e1de1", "d9a7f741ec8fdcbe5e0145152c799238cee8df5a14ddc7dc9feb3bb835ce068d",
               "49dfc5667a7730dbc124cdfc2a4a8e89188100636493a39d6493bf5696a55541", "8e82828fd9125615e8a361d0f15553e548cac2ee7a303e55387378a53b925fd9", "6c7a9914f83305d09f9957248897ff2f25cf2c2d4b46b2d9ab42f3c7ee1d29f0"):
    check(cmd.count(digest) == 1, f"Install-Scriptorium-Windows.cmd pins {digest[:8]}")
check("$diagramMissing += $plugin.Name" in cmd and "Not installed (the download failed)" in cmd, "Install-Scriptorium-Windows.cmd: a failed download is caught and named, and does not stop the installer")


# ---- A stand-in for GitHub, on this computer: http://127.0.0.1:<port>/<plugin id>/<file> ----
import functools
import http.server
import threading


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(folder):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(folder)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


NAMES = ("main.js", "manifest.json", "styles.css")
served = Path(tempfile.mkdtemp(prefix="scriptorium-diagrams-served-"))
stand_in = {}   # (plugin id, file) -> bytes
for p in (tikz, excalidraw):
    (served / p["id"]).mkdir()
    for name in NAMES:
        data = (json.dumps({"id": p["id"], "version": p["version"]}) if name == "manifest.json" else f"stand-in {p['id']} {name}").encode()
        (served / p["id"] / name).write_bytes(data)
        stand_in[p["id"], name] = data
server, base = serve(served)
closed = "http://127.0.0.1:9"   # nothing listens here: as good as no network


def snapshot(vault):
    return {q.relative_to(vault).as_posix(): q.read_bytes() for q in sorted(vault.rglob("*")) if q.is_file()}


def plugin_files(vault, p):
    return {n: (vault / ".obsidian" / "plugins" / p["id"] / n).read_bytes() for n in NAMES if (vault / ".obsidian" / "plugins" / p["id"] / n).is_file()}


def have_already(vault):
    """A newer Excalidraw and an older TikZJax, each with settings of its own."""
    ex, tz = vault / ".obsidian" / "plugins" / excalidraw["id"], vault / ".obsidian" / "plugins" / tikz["id"]
    for folder, pid, version, settings in ((ex, excalidraw["id"], "99.0.0", '{"theirs": true}'), (tz, tikz["id"], "0.1.0", '{"invertColorsInDarkMode": false}')):
        folder.mkdir(parents=True)
        (folder / "manifest.json").write_text(json.dumps({"id": pid, "version": version}), encoding="utf-8")
        (folder / "main.js").write_text(f"// the writer's {version}", encoding="utf-8")
        (folder / "data.json").write_text(settings, encoding="utf-8")


# 6. the Windows script installer's PowerShell, run for real: Windows PowerShell on Windows (pwsh elsewhere, if there is one)
shell = "powershell.exe" if os.name == "nt" else shutil.which("pwsh")
if not shell:
    print("SKIP  Install-Scriptorium-Windows.cmd: no PowerShell here, so its diagram plugin part was not run")
else:
    name = "Install-Scriptorium-Windows.cmd"
    download = "function Get-ScriptoriumDownload" + cmd.split("function Get-ScriptoriumDownload", 1)[1].split("Write-Host 'Scriptorium - Obsidian configuration installer'", 1)[0]
    adding = cmd.split("# ---- adding the diagram plugins ----", 1)[1].split("# ---- end of the diagram plugins ----", 1)[0]
    check("$diagramPlugins = @(" in cmd.split("# ---- The diagram plugins ----", 1)[1].split("# ---- adding the diagram plugins ----", 1)[0], f"{name}: the pins come before the part that adds the plugins")

    def run_cmd_part(label, plugins):
        """plugins: [(id, name, base address, {file: sha256})]. Returns (the staged vault, the process)."""
        work = Path(tempfile.mkdtemp(prefix="scriptorium-diagrams-ps-"))
        (work / "vault" / ".obsidian").mkdir(parents=True)
        (work / "vault" / ".obsidian" / "community-plugins.json").write_bytes((ROOT / "vault" / ".obsidian" / "community-plugins.json").read_bytes())
        (work / "temp").mkdir()
        quote = lambda text: "'" + str(text).replace("'", "''") + "'"
        table = ",\n".join("@{ Id = %s; Name = %s; Base = %s; Files = @{ %s } }" % (quote(i), quote(n), quote(b), "; ".join(f"{quote(f)} = {quote(h)}" for f, h in files.items()))
                           for i, n, b, files in plugins)
        script = work / "part.ps1"
        script.write_text("$ErrorActionPreference = 'Stop'\n" + download + f"\n$tempPath = {quote(work / 'temp')}\n$staging = {quote(work / 'vault')}\n"
                          "$diagramMissing = @()\n$diagramPlugins = @(\n" + table + "\n)\n" + adding + "\nWrite-Host ('MISSING:' + ($diagramMissing -join ','))\n", encoding="utf-8-sig")
        r = subprocess.run([shell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script)], capture_output=True, text=True, timeout=300)
        for line in (r.stdout + r.stderr).splitlines():
            print("      | " + line)
        return work / "vault", r

    hashes = lambda p: {n: hashlib.sha256(stand_in[p["id"], n]).hexdigest() for n in NAMES}
    template = json.loads((ROOT / "vault" / ".obsidian" / "community-plugins.json").read_text(encoding="utf-8"))
    v, r = run_cmd_part("fresh", [(p["id"], p["name"], f"{base}/{p['id']}/", hashes(p)) for p in (tikz, excalidraw)])
    check(r.returncode == 0 and "MISSING:" in r.stdout and "MISSING:TikZJax" not in r.stdout and "MISSING:Excalidraw" not in r.stdout, f"{name}: a new vault: both plugins are downloaded")
    check(all(plugin_files(v, p) == {n: stand_in[p["id"], n] for n in NAMES} for p in (tikz, excalidraw)), f"{name}: a new vault: the three files of each are in .obsidian/plugins/<id>, as downloaded")
    try:
        listed = json.loads((v / ".obsidian" / "community-plugins.json").read_text(encoding="utf-8-sig"))
    except ValueError:
        listed = None
    check(listed == template + [tikz["id"], excalidraw["id"]], f"{name}: a new vault: both are turned on, after the vault's own plugins ({listed})")
    check(not (v / ".obsidian" / "community-plugins.json").read_bytes().startswith(b"\xef\xbb\xbf"), f"{name}: the plugin list is written without a byte order mark")
    wrong = dict(hashes(excalidraw), **{"main.js": "0" * 64})
    v, r = run_cmd_part("failures", [(tikz["id"], tikz["name"], f"{base}/gone/", hashes(tikz)), (excalidraw["id"], excalidraw["name"], f"{base}/{excalidraw['id']}/", wrong)])
    check(r.returncode == 0 and "MISSING:TikZJax,Excalidraw" in r.stdout, f"{name}: a file that is not there and a file that does not match: the installer goes on, and names both plugins")
    check(not (v / ".obsidian" / "plugins").exists() and json.loads((v / ".obsidian" / "community-plugins.json").read_text(encoding="utf-8-sig")) == template, f"{name}: nothing of them is put in the vault, and they are not turned on")
    v, r = run_cmd_part("offline", [(tikz["id"], tikz["name"], f"{closed}/{tikz['id']}/", hashes(tikz)), (excalidraw["id"], excalidraw["name"], f"{base}/{excalidraw['id']}/", hashes(excalidraw))])
    check(r.returncode == 0 and "MISSING:TikZJax" in r.stdout and plugin_files(v, excalidraw) and not (v / ".obsidian" / "plugins" / tikz["id"]).exists(),
          f"{name}: no connection for one plugin: the other is still installed")

# 7. Scriptorium Setup (the Windows installer): a new vault (--install-only), an update (--update-only) and a set-up
#    (--setup-only), each with --plugin-pins naming the stand-in releases
exe = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None
if not exe:
    print("SKIP  Scriptorium-Setup.exe was not given, so the Windows installer was not run")
else:
    if os.name == "nt":
        prefix = [str(exe)]
    else:
        mono = os.environ.get("MONO")
        prefix = [os.path.join(mono, "bin", "mono") if mono else "mono", str(exe)]
    work = Path(tempfile.mkdtemp(prefix="scriptorium-diagrams-exe-"))

    def pins(file, address=None, wrong=()):
        """A --plugin-pins file. address(plugin) -> where its files are; wrong: (plugin id, file) pairs given a wrong SHA-256."""
        lines = []
        for p in (tikz, excalidraw):
            for n in NAMES:
                digest = "0" * 64 if (p["id"], n) in wrong else hashlib.sha256(stand_in[p["id"], n]).hexdigest()
                lines.append(f"{p['id']}|{p['name']}|{p['version']}|{n}|{digest}|{(address(p) if address else base + '/' + p['id'])}/{n}")
        (work / file).write_text("# stand-ins\n" + "\n".join(lines) + "\n", encoding="utf-8")
        return str(work / file)

    good = pins("good.txt")
    broken = pins("broken.txt", lambda p: f"{base}/gone" if p is tikz else f"{base}/{p['id']}", wrong={(excalidraw["id"], "main.js")})
    offline_pins = pins("offline.txt", lambda p: f"{closed}/{p['id']}")

    def run_exe(*args, off=False):
        env = dict(os.environ, SCRIPTORIUM_NO_FONTS="1")
        env.pop("SCRIPTORIUM_NO_DIAGRAM_PLUGINS", None)
        if off:
            env["SCRIPTORIUM_NO_DIAGRAM_PLUGINS"] = "1"
        r = subprocess.run(prefix + list(args), capture_output=True, text=True, timeout=600, env=env)
        for line in (r.stdout + r.stderr).splitlines():
            print("      | " + line)
        return r

    def listed(vault):
        return json.loads((vault / ".obsidian" / "community-plugins.json").read_text(encoding="utf-8"))

    def new_vault(name):          # a Scriptorium vault without the diagram plugins
        vault = work / name
        if run_exe("--extract-only", str(vault)).returncode != 0:
            sys.exit("--extract-only failed")
        return vault

    def notes(name):              # a folder of notes that is not a vault yet
        vault = work / name
        vault.mkdir()
        (vault / "Essay.md").write_text("An essay.\n", encoding="utf-8")
        return vault

    routes = [("a new vault (--install-only)", "--install-only", lambda n: work / n),
              ("an update (--update-only)", "--update-only", new_vault),
              ("a set-up (--setup-only)", "--setup-only", notes)]
    for label, option, make in routes:
        name = f"Scriptorium-Setup.exe, {label}"
        tag = option.strip("-").replace("-", "")
        # fresh
        vault = make(f"{tag}-fresh")
        r = run_exe(option, str(vault), "--plugin-pins", good)
        check(r.returncode == 0 and "Installed TikZJax" in r.stdout and "Installed Excalidraw" in r.stdout, f"{name}: no plugins yet: it exits 0 and says it installed both")
        check(all(plugin_files(vault, p) == {n: stand_in[p["id"], n] for n in NAMES} for p in (tikz, excalidraw)), f"{name}: the three files of each are in .obsidian/plugins/<id>, as downloaded")
        on_now = listed(vault)
        check(on_now[-2:] == [tikz["id"], excalidraw["id"]] and "scriptorium" in on_now and len(set(on_now)) == len(on_now), f"{name}: both are turned on, after Scriptorium's own ({on_now})")
        check(not list(vault.rglob("*.scriptorium-tmp")) and not any((vault / ".obsidian" / "plugins" / p["id"] / "data.json").exists() for p in (tikz, excalidraw)), f"{name}: no temporary file is left, and no settings are written for them")
        check((vault / ".obsidian" / "plugins" / "scriptorium" / "manifest.json").is_file(), f"{name}: Scriptorium itself is in the vault")
        if option != "--install-only":
            before = snapshot(vault)
            r = run_exe(option, str(vault), "--plugin-pins", offline_pins)   # (nothing may be downloaded now)
            check(r.returncode == 0 and snapshot(vault) == before and "NOT" not in r.stdout, f"{name}: run again, nothing is downloaded and nothing changes")
            # already there: a newer one and an older one
            vault = make(f"{tag}-already")
            have_already(vault)
            (vault / ".obsidian").mkdir(exist_ok=True)
            if not (vault / ".obsidian" / "community-plugins.json").exists():
                (vault / ".obsidian" / "community-plugins.json").write_text(json.dumps([excalidraw["id"]]), encoding="utf-8")
            r = run_exe(option, str(vault), "--plugin-pins", good)
            ex, tz = vault / ".obsidian" / "plugins" / excalidraw["id"], vault / ".obsidian" / "plugins" / tikz["id"]
            check(r.returncode == 0 and "Updated TikZJax from 0.1.0" in r.stdout and "Excalidraw 99.0.0 is already in this vault" in r.stdout, f"{name}: an older TikZJax is updated and a newer Excalidraw is kept, and it says so")
            check((ex / "main.js").read_text(encoding="utf-8") == "// the writer's 99.0.0" and json.loads((ex / "manifest.json").read_text(encoding="utf-8"))["version"] == "99.0.0" and not (ex / "styles.css").exists(), f"{name}: the newer version is not overwritten")
            check(plugin_files(vault, tikz) == {n: stand_in[tikz["id"], n] for n in NAMES}, f"{name}: the older version is replaced by the pinned one")
            check((ex / "data.json").read_text(encoding="utf-8") == '{"theirs": true}' and (tz / "data.json").read_text(encoding="utf-8") == '{"invertColorsInDarkMode": false}', f"{name}: neither plugin's settings are touched")
            on_now = listed(vault)
            check(on_now.count(tikz["id"]) == 1 and on_now.count(excalidraw["id"]) == 1, f"{name}: each is listed once ({on_now})")
            # an older one whose update cannot be downloaded stays as it is
            vault = make(f"{tag}-already-offline")
            have_already(vault)
            tz = vault / ".obsidian" / "plugins" / tikz["id"]
            r = run_exe(option, str(vault), "--plugin-pins", offline_pins)
            check(r.returncode == 0 and "TikZJax was NOT updated" in r.stdout and (tz / "main.js").read_text(encoding="utf-8") == "// the writer's 0.1.0" and not (tz / "styles.css").exists(), f"{name}: an older plugin whose update cannot be downloaded stays whole, and it says so")
        # failures: a file that is not there (404) and a file that does not match; then no connection at all
        for what, file in (("a missing file and a wrong SHA-256", broken), ("no connection", offline_pins)):
            vault = make(f"{tag}-{Path(file).stem}")
            r = run_exe(option, str(vault), "--plugin-pins", file)
            out = r.stdout + r.stderr
            check(r.returncode == 0, f"{name}: {what}: Setup still exits 0")
            check((vault / ".obsidian" / "plugins" / "scriptorium" / "manifest.json").is_file() and (vault / ".obsidian" / "snippets" / "manuscript.css").is_file(), f"{name}: {what}: Scriptorium is installed all the same")
            check(not any((vault / ".obsidian" / "plugins" / p["id"]).exists() for p in (tikz, excalidraw)), f"{name}: {what}: nothing of either plugin is written")
            check(not any(p["id"] in listed(vault) for p in (tikz, excalidraw)), f"{name}: {what}: they are not turned on")
            check(all(f"{p['name']} was NOT installed" in out for p in (tikz, excalidraw)) and "Community plugins > Browse" in out, f"{name}: {what}: it names each plugin and says how to add it by hand")
    # the switch the other tests use
    vault = new_vault("off")
    r = run_exe("--update-only", str(vault), "--plugin-pins", good, off=True)
    check(r.returncode == 0 and not (vault / ".obsidian" / "plugins" / tikz["id"]).exists(), "Scriptorium-Setup.exe: with SCRIPTORIUM_NO_DIAGRAM_PLUGINS set, nothing is downloaded")
    # the plan shown before a set-up names the downloads
    vault = notes("plan")
    r = run_exe("--setup-plan", str(vault), "--plugin-pins", good)
    check(r.returncode == 0 and "TikZJax 0.5.2, from its own release on GitHub" in r.stdout and "Excalidraw" in r.stdout and not (vault / ".obsidian").exists(), "Scriptorium-Setup.exe: the set-up plan names the two downloads, and changes nothing")

server.shutdown()
print("All diagram plugin checks passed." if not failed else f"{len(failed)} check(s) FAILED")
sys.exit(1 if failed else 0)
