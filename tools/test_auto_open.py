#!/usr/bin/env python3
# Tests how the installers add a new vault to Obsidian's vault list (obsidian.json) and turn Obsidian's command line
# interface on and off again, for "Open the vault in Obsidian and turn on its plugins". The same cases run against each
# installer's own editor of the file:
#   - Scriptorium Setup:         Scriptorium-Setup.exe --register-only <obsidian.json> <vault> [--cli]
#   - Install-Scriptorium-Linux.sh: its python3 editor (obsidian_json), taken from the script
#   - Install-Scriptorium-macOS.command: its JavaScript editor (edit(), run by osascript on a Mac), taken from the script and
#     run with Node.js, with the file reading and writing that its run() does with Foundation
#   - Install-Scriptorium-Windows.cmd: its C# class ScriptoriumObsidian (JavaScriptSerializer), taken from the script and
#     compiled the way the script does (PowerShell's Add-Type) on Windows, or with Mono's csc elsewhere
# (Talking to Obsidian is not tested here; it needs a running Obsidian.) Nothing here starts Obsidian or touches
# Obsidian's real settings: every obsidian.json is a temporary file.
#
# Usage: python3 tools/test_auto_open.py dist/Scriptorium-Setup.exe
#        python3 tools/test_auto_open.py --scripts-only        (only the macOS and Linux scripts' editors)
# On Windows the exe runs directly and the .cmd's class is compiled by Windows PowerShell; the macOS and Linux editors
# are not tested there. Elsewhere the exe runs under Mono (MONO=<prefix>, or mono and csc on PATH), and the JavaScript
# editor needs node on PATH (else it is skipped).
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
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LINUX = ROOT / "installers" / "Install-Scriptorium-Linux.sh"
MACOS = ROOT / "installers" / "Install-Scriptorium-macOS.command"
WINDOWS = ROOT / "installers" / "Install-Scriptorium-Windows.cmd"

failures = []


def check(ok, what):
    print(("PASS  " if ok else "FAIL  ") + what)
    if not ok:
        failures.append(what)


def between(path, start, end):
    text = path.read_text(encoding="utf-8")
    m = re.search(re.escape(start) + r"\n(.*?)\n" + re.escape(end) + r"\n", text, re.S)
    if not m:
        sys.exit(f"cannot find the obsidian.json editor in {path}")
    return m.group(1) + "\n"


# Each editor: register(file, vault, turn_on) -> (ok, id, prior) and, for the scripts, restore(file, prior) -> ok.
# prior is "on" if the interface was on, else "cli" as it was: "absent" or its JSON.
class Exe:
    name = "Scriptorium-Setup.exe"
    restores = False   # it puts "cli" back through Obsidian (tested live), or in the file only after a failure

    def __init__(self, exe):
        if os.name == "nt":
            self.cmd = [str(exe)]
        else:
            mono = os.environ.get("MONO")
            self.cmd = [os.path.join(mono, "bin", "mono") if mono else "mono", str(exe)]

    def register(self, file, vault, turn_on):
        r = subprocess.run(self.cmd + ["--register-only", str(file), vault] + (["--cli"] if turn_on else []),
                           capture_output=True, text=True, timeout=120)
        m = re.fullmatch(r"([0-9a-f]{16}) (added|listed) cli-(on|off)\s*", r.stdout)
        if r.returncode != 0 or not m:
            return False, None, None
        return True, m.group(1), m.group(3)


class LinuxPython:
    name = "Install-Scriptorium-Linux.sh (python3)"
    restores = True

    def __init__(self):
        self.code = between(LINUX, "  python3 -I - \"$@\" <<'PY'", "PY")

    def _run(self, *args):
        return subprocess.run([sys.executable, "-I", "-", *args], input=self.code, capture_output=True, text=True, timeout=60)

    def register(self, file, vault, turn_on):
        r = self._run("register", str(file), vault, "yes" if turn_on else "no")
        lines = r.stdout.splitlines()
        if r.returncode != 0 or len(lines) != 2:
            return False, None, None
        return True, lines[0], lines[1]

    def restore(self, file, prior):
        return self._run("restore", str(file), prior).returncode == 0


class MacJavaScript:
    name = "Install-Scriptorium-macOS.command (JavaScript)"
    restores = True
    # What run() does with Foundation (read the file if it exists, edit, write it if changed, print the result), in Node.
    DRIVER = r"""
const fs = require('fs');
const argv = process.argv.slice(1), file = argv[1];   // node -e <code> -- <args>
const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const r = edit(text, argv, Date.now(), () => { let id = ''; for (let i = 0; i < 16; i++) id += Math.floor(Math.random() * 16).toString(16); return id; });
if (r.text !== null) fs.writeFileSync(file, r.text);
process.stdout.write(r.out);
"""

    def __init__(self):
        self.code = between(MACOS, "cat > \"$work_dir/obsidian-json.js\" <<'JS'", "JS") + self.DRIVER

    def _run(self, *args):
        return subprocess.run(["node", "-e", self.code, "--", *args], capture_output=True, text=True, timeout=60)

    def register(self, file, vault, turn_on):
        r = self._run("register", str(file), vault, "yes" if turn_on else "no")
        lines = r.stdout.splitlines()
        if r.returncode != 0 or len(lines) != 2:
            return False, None, None
        return True, lines[0], lines[1]

    def restore(self, file, prior):
        return self._run("restore", str(file), prior).returncode == 0


class WindowsCSharp:
    name = "Install-Scriptorium-Windows.cmd (C#, JavaScriptSerializer)"
    restores = True
    DRIVER = r"""
public static class Driver {
    public static int Main(string[] a) {
        try {
            if (a[0] == "register") System.Console.Write(ScriptoriumObsidian.Register(a[1], a[2], a[3] == "yes"));
            else ScriptoriumObsidian.Restore(a[1], a[2]);
            return 0;
        } catch (System.Exception e) { System.Console.Error.WriteLine(e.Message); return 1; }
    }
}
"""

    def __init__(self, work):
        self.source = work / "ScriptoriumObsidian.cs"
        self.source.write_text(between(WINDOWS, "    $obsidianSource = @'", "'@"), encoding="utf-8")
        if os.name == "nt":
            return
        mono = os.environ.get("MONO")
        csc = os.path.join(mono, "bin", "csc") if mono else shutil.which("csc")
        self.mono = os.path.join(mono, "bin", "mono") if mono else "mono"
        driver = work / "Driver.cs"
        driver.write_text(self.DRIVER, encoding="utf-8")
        self.exe = work / "cmd-editor.exe"
        r = subprocess.run([csc, "-nologo", "-r:System.Web.Extensions.dll", "-r:System.Core.dll", f"-out:{self.exe}",
                            str(self.source), str(driver)], capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit("cannot compile the .cmd's C# class:\n" + r.stdout + r.stderr)

    def _run(self, *args):
        if os.name == "nt":
            # The script's own steps: load JavaScriptSerializer's assembly, then Add-Type with the same references.
            ps = ("$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Web.Extensions; "
                  "$refs = @([System.Uri].Assembly.Location, [System.IO.Pipes.NamedPipeClientStream].Assembly.Location, "
                  "[System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location); "
                  "Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:CS_SOURCE)) -ReferencedAssemblies $refs; "
                  "$a = $env:CS_ARGS -split \"`t\"; "
                  "if ($a[0] -eq 'register') { [Console]::Out.Write([ScriptoriumObsidian]::Register($a[1], $a[2], $a[3] -eq 'yes')) } "
                  "else { [ScriptoriumObsidian]::Restore($a[1], $a[2]) }")
            env = dict(os.environ, CS_SOURCE=str(self.source), CS_ARGS="\t".join(args))
            return subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], env=env,
                                  capture_output=True, text=True, timeout=120)
        return subprocess.run([self.mono, str(self.exe), *args], capture_output=True, text=True, timeout=60)

    def register(self, file, vault, turn_on):
        r = self._run("register", str(file), vault, "yes" if turn_on else "no")
        lines = r.stdout.splitlines()
        if r.returncode != 0 or len(lines) != 2:
            return False, None, None
        return True, lines[0], lines[1]

    def restore(self, file, prior):
        return self._run("restore", str(file), prior).returncode == 0


def load(file):
    return json.loads(Path(file).read_text(encoding="utf-8-sig"))


def run_cases(ed, work):
    print(f"\n== {ed.name} ==")
    vault = str(work / "Documents" / "Scriptorium")
    other = str(work / "Notes")
    file = work / "obsidian.json"

    def fresh(content):
        if file.exists():
            file.unlink()
        if content is not None:
            file.write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")

    # 1. No obsidian.json yet (Obsidian never started).
    fresh(None)
    ok, vid, prior = ed.register(file, vault, True)
    conf = load(file) if file.exists() else {}
    check(ok and re.fullmatch(r"[0-9a-f]{16}", vid or "") is not None, "no file: a new 16-hex id")
    check(conf.get("vaults", {}).get(vid, {}).get("path") == vault and isinstance(conf["vaults"][vid].get("ts"), int),
          "no file: the vault is listed with its path and a time stamp")
    check(conf.get("cli") is True and prior in ("absent", "off"), "no file: the interface is turned on; it was off")
    if ed.restores:
        check(ok and ed.restore(file, prior) and "cli" not in load(file) and vid in load(file)["vaults"], "restore: \"cli\" removed again")

    # 2. Other vaults and settings are kept; the vault is added after them; Obsidian's compact format.
    before = {"vaults": {"0123456789abcdef": {"path": other, "ts": 1700000000000, "open": True}},
              "updateDisabled": True, "frame": "native", "adblock": ["https://example.org/list.txt"], "icon": None}
    fresh(before)
    ok, vid, prior = ed.register(file, vault, True)
    raw = file.read_text(encoding="utf-8")
    conf = json.loads(raw)
    check(ok and vid != "0123456789abcdef", "other vaults: a new id")
    check(list(conf["vaults"]) == ["0123456789abcdef", vid] and conf["vaults"]["0123456789abcdef"] == before["vaults"]["0123456789abcdef"],
          "other vaults: kept as they were, in order, the new one after them")
    check(all(conf[k] == before[k] for k in ("updateDisabled", "frame", "adblock", "icon")), "other settings kept")
    check(conf.get("cli") is True, "other vaults: the interface is turned on")
    check("\n" not in raw and ": " not in raw, "written compactly, as Obsidian writes it")

    # 3. The folder is already listed (even with a trailing slash): its id is reused, nothing duplicated.
    fresh({"vaults": {"fedcba9876543210": {"path": vault + "/", "ts": 5, "open": True}}})
    ok, vid, prior = ed.register(file, vault, True)
    conf = load(file)
    check(ok and vid == "fedcba9876543210", "already listed: its id is reused")
    check(conf["vaults"] == {"fedcba9876543210": {"path": vault + "/", "ts": 5, "open": True}}, "already listed: the entry is untouched")

    # 4. The interface was on already: left on, reported as on; nothing to write when the vault is listed too.
    fresh({"vaults": {"fedcba9876543210": {"path": vault, "ts": 5}}, "cli": True})
    mtime = file.stat().st_mtime_ns
    text = file.read_text(encoding="utf-8")
    ok, vid, prior = ed.register(file, vault, True)
    check(ok and prior == "on" and load(file).get("cli") is True, "\"cli\": true: reported on, left on")
    check(file.read_text(encoding="utf-8") == text, "\"cli\": true and listed: the file is not rewritten")

    # 5. "cli": false is turned on, and put back to false.
    fresh({"vaults": {}, "cli": False})
    ok, vid, prior = ed.register(file, vault, True)
    check(ok and load(file).get("cli") is True and prior in ("false", "off"), "\"cli\": false: turned on, reported off")
    if ed.restores:
        check(ok and ed.restore(file, prior) and load(file).get("cli") is False, "restore: back to false")

    # 6. Without a CLI (Obsidian before 1.12) the interface is not touched.
    fresh({"vaults": {}})
    ok, vid, prior = ed.register(file, vault, False)
    check(ok and "cli" not in load(file) and vid in load(file)["vaults"], "no CLI: the vault is listed, \"cli\" untouched")

    # 7. Restore does nothing once "cli" is no longer true (someone changed it meanwhile).
    if ed.restores:
        fresh({"vaults": {}, "cli": "custom"})
        text = file.read_text(encoding="utf-8")
        check(ed.restore(file, "absent") and file.read_text(encoding="utf-8") == text, "restore: leaves a \"cli\" it did not set")

    # 8. A byte-order mark, and a path with spaces, quotes and accents.
    odd = str(work / "Mes documents" / ("Écritoire l'1" if os.name == "nt" else 'Écritoire "1"'))   # no " on Windows
    file.write_bytes(b"\xef\xbb\xbf" + json.dumps({"vaults": {}}).encode("utf-8"))
    ok, vid, prior = ed.register(file, odd, True)
    check(ok and load(file)["vaults"][vid]["path"] == odd, "BOM, spaces, quotes and accents in the path")

    # 9. A file that is not a JSON object, or whose vault list is not one, is left alone and the editor fails.
    for content, what in (("[1, 2]", "a JSON array"), ("{\"vaults\": {", "invalid JSON"), ('{"vaults": [1]}', "a list for vaults")):
        fresh(content)
        ok, vid, prior = ed.register(file, vault, True)
        check(not ok and file.read_text(encoding="utf-8") == content, f"{what}: refused, the file unchanged")


# ---- Is Obsidian installed? ----
# Each script installs Obsidian unless it finds one. What a removed Obsidian leaves behind (a link handler whose program
# is gone, an app in the Trash, a registry key) must not count as one, or the script installs nothing and then has
# nothing to open. The part of each script that decides is taken from the script and run against a made-up machine.
def section(path, start, end):
    text = path.read_text(encoding="utf-8")
    m = re.search(re.escape(start) + r"\r?\n(.*?)" + re.escape(end), text, re.S)
    if not m:
        sys.exit(f"cannot find {start!r} in {path}")
    return m.group(1).replace("\r\n", "\n")


def make_program(path, text="#!/bin/sh\nexit 0\n"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(0o755)


def find_obsidian_linux(work):
    print("\nInstall-Scriptorium-Linux.sh: is Obsidian installed?")
    code = section(LINUX, "# ---- Finding Obsidian ----", "# ---- End of finding Obsidian ----")
    script = "set -euo pipefail\n" + code + "\nif find_obsidian; then printf 'found %s\\n' \"${launcher[*]}\"; else echo none; fi\n"
    count = [0]

    def machine(**has):
        count[0] += 1
        home = work / f"linux{count[0]}"
        tools = home / "bin"
        tools.mkdir(parents=True)
        # xdg-mime answers with the handler in "handler"; flatpak knows Obsidian only if "flatpak" is set
        make_program(tools / "xdg-open")
        make_program(tools / "xdg-mime", "#!/bin/sh\nprintf '%s\\n' \"${FAKE_HANDLER:-}\"\n")
        if "flatpak" in has:
            make_program(tools / "flatpak", "#!/bin/sh\n" + ("exit 0\n" if has["flatpak"] else "exit 1\n"))
        return home, tools

    def find(home, tools, handler=""):
        env = {"HOME": str(home), "PATH": f"{tools}:/usr/bin:/bin", "FAKE_HANDLER": handler,
               "XDG_DATA_HOME": str(home / ".local" / "share"), "XDG_DATA_DIRS": str(home / "usr-share")}
        r = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True, timeout=60)
        return r.stdout.strip() if r.returncode == 0 else f"error {r.returncode}: {r.stderr.strip()}"

    def entry(home, exec_line, where=".local/share"):
        d = home / where / "applications"
        d.mkdir(parents=True, exist_ok=True)
        (d / "obsidian.desktop").write_text(f"[Desktop Entry]\nName=Obsidian\nExec={exec_line}\nType=Application\nMimeType=x-scheme-handler/obsidian;\n")

    if shutil.which("obsidian"):
        print("      (an obsidian command is on PATH here: these cases are not run)")
        return
    home, tools = machine()
    check(find(home, tools) == "none", "nothing there: not installed")
    check(find(home, tools, "obsidian.desktop") == "none", "a handler for obsidian:// links is named, but its .desktop entry is gone: not installed")
    entry(home, f"{home}/Applications/Obsidian.AppImage %u")
    check(find(home, tools, "obsidian.desktop") == "none", "the handler's .desktop entry is there, the AppImage it starts is not: not installed")
    make_program(home / "opt" / "Obsidian Folder" / "obsidian")
    entry(home, f'env FOO=1 "{home}/opt/Obsidian Folder/obsidian" --flag %u')
    check(find(home, tools, "obsidian.desktop") == "found xdg-open", "the handler's program exists (env, quotation marks, a space in the path): installed")
    entry(home, "no-such-obsidian-program %u")
    check(find(home, tools, "obsidian.desktop") == "none", "the handler starts a command that is not on PATH: not installed")
    home, tools = machine()
    entry(home, "xdg-open %u", "usr-share")
    check(find(home, tools, "obsidian.desktop") == "found xdg-open", "a system-wide .desktop entry whose command is on PATH: installed")

    home, tools = machine()
    (home / "Applications").mkdir()
    (home / "Applications" / "Obsidian.AppImage").write_text("")
    (home / "Applications" / "Obsidian.AppImage").chmod(0o755)
    check(find(home, tools) == "none", "an empty Obsidian.AppImage: not installed")
    make_program(home / "Applications" / "Obsidian.AppImage")
    check(find(home, tools) == f"found {home}/Applications/Obsidian.AppImage", "an Obsidian.AppImage that can run: installed")
    (home / "Applications" / "Obsidian.AppImage").chmod(0o644)
    check(find(home, tools) == "none", "an Obsidian.AppImage that cannot run: not installed")

    home, tools = machine(flatpak=False)
    check(find(home, tools) == "none", "flatpak is there but has no Obsidian: not installed")
    home, tools = machine(flatpak=True)
    check(find(home, tools) == "found flatpak run md.obsidian.Obsidian", "Obsidian from flatpak: installed")

    home, tools = machine()
    make_program(tools / "obsidian", "#!/bin/sh\necho 'unable to find Obsidian'\n")
    check(find(home, tools) == "none", "only Obsidian's command line client is on PATH: not installed")
    make_program(tools / "obsidian")
    check(find(home, tools) == "found obsidian", "an obsidian command that is the program: installed")


def find_obsidian_macos(work):
    print("\nInstall-Scriptorium-macOS.command: is Obsidian installed?")
    code = section(MACOS, "# ---- Finding Obsidian ----", "# ---- End of finding Obsidian ----")
    script = "set -euo pipefail\n" + code + "\nif found=\"$(find_obsidian_app)\"; then printf 'found %s\\n' \"$found\"; else echo none; fi\n"
    count = [0]

    def machine():
        count[0] += 1
        home = work / f"mac{count[0]}"
        make_program(home / "bin" / "osascript", "#!/bin/sh\nprintf '%s\\n' \"${FAKE_BUNDLE:-}\"\n")   # what macOS says md.obsidian is
        (home / "SystemApplications").mkdir()
        return home

    def app(path, working=True):
        (path / "Contents" / "MacOS").mkdir(parents=True)
        if working:
            make_program(path / "Contents" / "MacOS" / "Obsidian")
        return path

    def find(home, bundle=""):
        env = {"HOME": str(home), "PATH": f"{home / 'bin'}:/usr/bin:/bin", "FAKE_BUNDLE": str(bundle),
               "OBSIDIAN_APPLICATIONS": str(home / "SystemApplications")}
        r = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True, timeout=60)
        return r.stdout.strip() if r.returncode == 0 else f"error {r.returncode}: {r.stderr.strip()}"

    home = machine()
    check(find(home) == "none", "nothing there: not installed")
    check(find(home, home / "Somewhere" / "Obsidian.app") == "none", "macOS names an Obsidian.app that is gone: not installed")
    trashed = app(home / ".Trash" / "Obsidian.app")
    check(find(home, trashed) == "none", "macOS names the Obsidian.app in the Trash: not installed")
    husk = app(home / "Applications" / "Obsidian.app", working=False)
    check(find(home, husk) == "none", "an Obsidian.app folder with no program in it: not installed")
    good = app(home / "SystemApplications" / "Obsidian.app")
    check(find(home, trashed) == f"found {good}", "the one in the Trash is passed over for the one in Applications")
    home = machine()
    mine = app(home / "Applications" / "Obsidian.app")
    check(find(home) == f"found {mine}", "Obsidian.app in the user's Applications: installed")
    home = machine()
    elsewhere = app(home / "Tools" / "Obsidian.app")
    check(find(home, elsewhere) == f"found {elsewhere}", "macOS names a working Obsidian.app elsewhere: installed")


# Windows only (it needs PowerShell and the registry): the script's Find-Obsidian, against the real machine when it has
# no Obsidian (as a CI runner has none), with the obsidian:// link registered as an uninstalled Obsidian leaves it.
def find_obsidian_windows(work):
    print("\nInstall-Scriptorium-Windows.cmd: is Obsidian installed?")
    import winreg
    code = "function Find-Obsidian {\n" + section(WINDOWS, "    function Find-Obsidian {", "    $exe = Find-Obsidian\r\n    if (!$exe) {")
    check("Test-Path -LiteralPath $protocol" not in WINDOWS.read_text(encoding="utf-8"), "the script no longer takes the registry key alone for an installed Obsidian")

    def find():
        ps = code + "\n$found = Find-Obsidian\nif ($found) { Write-Output \"found $found\" } else { Write-Output 'none' }\n"
        r = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], capture_output=True, text=True, timeout=120)
        for line in (r.stdout + r.stderr).splitlines():
            print("      | " + line)
        return r.stdout.strip()

    key = r"Software\Classes\obsidian\shell\open\command"
    if find() != "none":
        print("      (Obsidian is installed on this machine: the registry cases are not run)")
        return
    try:
        winreg.OpenKey(winreg.HKEY_CURRENT_USER, key).Close()
        print("      (this user already has an obsidian:// link: the registry cases are not run)")
        return
    except OSError:
        pass
    program = work / "Registered" / "Obsidian.exe"
    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key) as k:
            winreg.SetValueEx(k, "", 0, winreg.REG_SZ, f'"{program}" "%1"')
        check(find() == "none", "the obsidian:// link is registered, Obsidian.exe is gone: not installed")
        program.parent.mkdir(parents=True)
        program.write_bytes(b"MZ program")
        check(find() == f"found {program}", "the link's program exists: installed")
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key) as k:
            winreg.SetValueEx(k, "", 0, winreg.REG_SZ, f"{program} %1")
        check(find() == f"found {program}", "the same, written without quotation marks")
    finally:
        for sub in (key, r"Software\Classes\obsidian\shell\open", r"Software\Classes\obsidian\shell", r"Software\Classes\obsidian"):
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, sub)
            except OSError:
                pass


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: test_auto_open.py Scriptorium-Setup.exe | --scripts-only")
    editors = []
    keep = tempfile.TemporaryDirectory(prefix="scriptorium-cmd-editor-")
    if sys.argv[1] != "--scripts-only":
        editors.append(Exe(Path(sys.argv[1]).resolve()))
        if os.name == "nt" or os.environ.get("MONO") or shutil.which("csc"):
            editors.append(WindowsCSharp(Path(keep.name)))
        else:
            print("neither Windows PowerShell nor Mono's csc: the Windows script's editor is not tested")
    if os.name != "nt":
        editors.append(LinuxPython())
        if shutil.which("node"):
            editors.append(MacJavaScript())
        else:
            print("node is not on PATH: the macOS installer's editor is not tested")
    for ed in editors:
        with tempfile.TemporaryDirectory(prefix="scriptorium-auto-open-") as tmp:
            # realpath: on Windows runners TEMP is an 8.3 short path (C:\Users\RUNNER~1\...), which .NET Framework's
            # Path.GetFullPath expands to the long name; compare against the long form, as Obsidian would see the folder.
            run_cases(ed, Path(os.path.realpath(tmp)))
    with tempfile.TemporaryDirectory(prefix="scriptorium-find-obsidian-") as tmp:
        if os.name == "nt":
            find_obsidian_windows(Path(os.path.realpath(tmp)))
        else:
            find_obsidian_linux(Path(tmp))
            find_obsidian_macos(Path(tmp))
    print(f"\n{'All auto-open checks passed.' if not failures else f'{len(failures)} check(s) FAILED:'}")
    for f in failures:
        print("  " + f)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
