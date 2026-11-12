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
    print(f"\n{'All auto-open checks passed.' if not failures else f'{len(failures)} check(s) FAILED:'}")
    for f in failures:
        print("  " + f)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
