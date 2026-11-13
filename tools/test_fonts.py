#!/usr/bin/env python3
# Tests that the installers check and repair the four font faces one by one (EB Garamond and Cormorant Garamond, each
# upright and italic), and never call a family "installed" when only its italic is there.
#
# Usage: python3 tools/test_fonts.py [dist/Scriptorium-Setup.exe]
#   - Scriptorium-Setup.exe (if given; under Mono off Windows): --check-fonts and --repair-fonts against a pretend
#     Windows kept in a folder (--font-root): nothing installed, all four fine, only the italic registered, a registry
#     value without its file, a damaged file, a file in use, a font Windows has not loaded, the user's own copies, and
#     the headless set-up. On Windows, the same against Windows itself: all four faces are installed for this user, the
#     upright's registration is taken away (the fault a user met), and the check, the repair, the set-up and the .cmd
#     script's font part must each see it and put it right. What it installed is removed again at the end.
#   - Install-Scriptorium-Linux.sh and Install-Scriptorium-macOS.command: their font part (between # FONTS_START and
#     # FONTS_END) run by itself in a home folder of its own, with fontconfig as it is on Linux and, off macOS, a
#     pretend system_profiler.
# The four font files are downloaded once from the pinned addresses (or taken from SCRIPTORIUM_TEST_FONTS) and checked
# against the pinned SHA-256; the installers under test never download anything.
#
# Copyright (C) 2026 William Liaw. Licensed under the GNU General Public License, version 3 or later (see LICENSE).

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://raw.githubusercontent.com/google/fonts/5bb28733cec313b63fbd415b574b5ae35c8aa8b8/ofl/"
FACES = [  # name, file, address, SHA-256, the registry value of 1.2.3 and earlier
    ("EB Garamond upright", "EBGaramond-Scriptorium.ttf", "ebgaramond/EBGaramond%5Bwght%5D.ttf",
     "ef9512f92f6d579e5dc75af59a5a4b1b8b47d2eda89e00b954d44520e5369027", "EB Garamond Regular (TrueType)"),
    ("EB Garamond italic", "EBGaramond-Italic-Scriptorium.ttf", "ebgaramond/EBGaramond-Italic%5Bwght%5D.ttf",
     "bba2c4499c93c9612b90b9825d32b07da52fce2fe57562a1eb6b833553f93c4e", "EB Garamond Italic (TrueType)"),
    ("Cormorant Garamond upright", "CormorantGaramond-Scriptorium.ttf", "cormorantgaramond/CormorantGaramond%5Bwght%5D.ttf",
     "b20b7d9626dd956b2c5e558692ad328b1f19e3275e2782db4fa07670d83f35e0", "Cormorant Garamond Regular (TrueType)"),
    ("Cormorant Garamond italic", "CormorantGaramond-Italic-Scriptorium.ttf", "cormorantgaramond/CormorantGaramond-Italic%5Bwght%5D.ttf",
     "0f48ea6abb2084537854f7174c470991a463b13036309e3b50a81511611c530d", "Cormorant Garamond Italic (TrueType)"),
]
EB_UP, EB_IT, CO_UP, CO_IT = (f[1] for f in FACES)
NEW_NAME = {f[1]: "Scriptorium " + f[4] for f in FACES}
OLD_NAME = {f[1]: f[4] for f in FACES}
WINDOWS = os.name == "nt"

failures = []


def check(ok, what):
    print(("PASS  " if ok else "FAIL  ") + what)
    if not ok:
        failures.append(what)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def fonts():
    """The four pinned font files, in one folder."""
    given = os.environ.get("SCRIPTORIUM_TEST_FONTS")
    cache = Path(given) if given else Path(tempfile.gettempdir()) / "scriptorium-test-fonts"
    cache.mkdir(parents=True, exist_ok=True)
    for name, file, address, digest, _ in FACES:
        target = cache / file
        if not target.exists() or sha(target) != digest:
            with urllib.request.urlopen(BASE + address, timeout=120) as r:
                target.write_bytes(r.read())
        if sha(target) != digest:
            raise SystemExit(f"{file}: not the pinned font")
    return cache


def run_exe(exe, *args, env=None):
    if WINDOWS:
        cmd = [str(exe), *args]
    else:
        mono = os.environ.get("MONO")
        cmd = [os.path.join(mono, "bin", "mono") if mono else "mono", str(exe), *args]
    env = dict(os.environ if env is None else env, SCRIPTORIUM_NO_DIAGRAM_PLUGINS="1")   # they have a test of their own (test_diagram_plugins.py)
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600, env=env)
    for line in (r.stdout + r.stderr).splitlines():
        print("      | " + line)
    return r


# ---------- Scriptorium-Setup.exe against a pretend Windows ----------

class Pretend:
    """A pretend Windows for the fonts, as --font-root reads it."""

    def __init__(self, work, source, name):
        self.root = work / name
        self.dir = self.root / "Fonts"
        self.dir.mkdir(parents=True)
        self.source = source

    def put(self, file, damaged=False):
        target = self.dir / file
        if damaged:
            target.write_bytes(b"this is not a font at all" * 100)
        else:
            shutil.copyfile(self.source / file, target)
        return target

    def register(self, name, path, hive="HKCU"):
        with open(self.root / "registry.txt", "a", encoding="utf-8") as f:
            f.write(f"{hive}|{name}|{path}\n")

    def install(self, file, legacy=True):
        self.register((OLD_NAME if legacy else NEW_NAME)[file], self.put(file))

    def lines(self, name):
        p = self.root / name
        return [l for l in p.read_text(encoding="utf-8").splitlines() if l.strip()] if p.exists() else []

    def registry(self):
        return {l.split("|", 2)[1]: l.split("|", 2)[2] for l in self.lines("registry.txt") if l.startswith("HKCU|")}


def exe_tests(exe, source, work):
    def go(p, command):
        return run_exe(exe, command, "--font-root", str(p.root), "--font-source", str(source))

    print("\nScriptorium-Setup.exe: nothing installed")
    p = Pretend(work, source, "none")
    r = go(p, "--check-fonts")
    check(r.returncode == 1 and r.stdout.count("not installed") == 4, "all four faces are reported as not installed, exit code 1")
    r = go(p, "--repair-fonts")
    check(r.returncode == 0 and r.stdout.count("ok      ") == 4, "the repair installs all four")
    check([sha(p.dir / f[1]) for f in FACES] == [f[3] for f in FACES], "the four files are the pinned ones")
    check(list(p.registry()) == [NEW_NAME[f[1]] for f in FACES], "each face has a registry value of its own, upright before italic")
    check(len(p.lines("announced.txt")) == 1, "running programs are told once (WM_FONTCHANGE)")
    check(go(p, "--check-fonts").returncode == 0, "and the check then finds all four in order")
    r = go(p, "--repair-fonts")
    check(r.returncode == 0 and len(p.lines("announced.txt")) == 1 and "Installed" not in r.stdout and "Repaired" not in r.stdout, "a second repair changes nothing")

    print("\nScriptorium-Setup.exe: both Cormorant Garamond files on disk, only the italic registered (the fault a user met)")
    p = Pretend(work, source, "italic-only")
    p.install(EB_UP); p.install(EB_IT); p.put(CO_UP); p.install(CO_IT)
    r = go(p, "--check-fonts")
    check(r.returncode == 1, "the check does not call the family installed")
    check("REPAIR  Cormorant Garamond upright: its file is there, but it is not registered with Windows" in r.stdout, "it says which face, and what is wrong with it")
    check(r.stdout.count("ok      ") == 3, "the other three faces are in order")
    r = go(p, "--repair-fonts")
    check(r.returncode == 0 and "Repaired Cormorant Garamond upright" in r.stdout, "the repair registers the upright face")
    check(r.stdout.count("Repaired") == 1 and "Installed" not in r.stdout, "and touches nothing else")
    reg = p.registry()
    check(reg.get(NEW_NAME[CO_UP]) == str(p.dir / CO_UP) and OLD_NAME[CO_IT] in reg, "under Scriptorium's own value name; the italic's value is left as it was")

    print("\nScriptorium-Setup.exe: only the italic file and its registration (the upright was never installed)")
    p = Pretend(work, source, "italic-alone")
    p.install(EB_UP); p.install(EB_IT); p.install(CO_IT)
    r = go(p, "--check-fonts")
    check(r.returncode == 1 and "REPAIR  Cormorant Garamond upright: not installed" in r.stdout, "the missing upright is found")
    check(go(p, "--repair-fonts").returncode == 0 and sha(p.dir / CO_UP) == FACES[2][3], "and installed")

    print("\nScriptorium-Setup.exe: a registry value whose file is gone")
    p = Pretend(work, source, "file-gone")
    for f in (EB_UP, EB_IT, CO_UP, CO_IT):
        p.install(f, legacy=False)
    (p.dir / CO_UP).unlink()
    r = go(p, "--check-fonts")
    check(r.returncode == 1 and "Cormorant Garamond upright: registered with Windows, but its file is gone" in r.stdout, "the check sees that the file is gone")
    r = go(p, "--repair-fonts")
    check(r.returncode == 0 and (p.dir / CO_UP).exists(), "the repair puts the file back")

    print("\nScriptorium-Setup.exe: a damaged file")
    p = Pretend(work, source, "damaged")
    for f in (EB_UP, EB_IT, CO_UP, CO_IT):
        p.install(f, legacy=False)
    p.put(EB_UP, damaged=True)
    r = go(p, "--check-fonts")
    check(r.returncode == 1 and "EB Garamond upright: its file is damaged, or is another font" in r.stdout, "the check sees it")
    r = go(p, "--repair-fonts")
    check(r.returncode == 0 and sha(p.dir / EB_UP) == FACES[0][3], "the repair replaces it with the pinned file")

    print("\nScriptorium-Setup.exe: the upright's file is in use and cannot be replaced")
    p = Pretend(work, source, "in-use")
    p.install(EB_UP); p.install(EB_IT); p.install(CO_IT); p.install(CO_UP); p.put(CO_UP, damaged=True)
    (p.root / "fail.txt").write_text(f"copy {CO_UP}\n", encoding="utf-8")
    r = go(p, "--repair-fonts")
    check(r.returncode == 1, "the repair says it failed (exit code 1)")
    check("Close Obsidian" in r.stdout and "run Scriptorium Setup again" in r.stdout, "and says to close Obsidian and run Setup again")
    check("Fonts NOT put right: Cormorant Garamond upright" in r.stdout, "naming the face")

    print("\nScriptorium-Setup.exe: nothing installed, and the upright of one family cannot be installed")
    p = Pretend(work, source, "upright-fails")
    (p.root / "fail.txt").write_text(f"load {CO_UP}\n", encoding="utf-8")
    r = go(p, "--repair-fonts")
    check(r.returncode == 1, "the repair says it failed")
    check(not (p.dir / CO_IT).exists() and NEW_NAME[CO_IT] not in p.registry(), "the italic of that family is NOT installed or registered: never an italic alone")
    check("Cormorant Garamond italic: left as it was, because the upright face could not be installed" in r.stdout, "and it says why")
    check((p.dir / EB_IT).exists() and NEW_NAME[EB_IT] in p.registry(), "the other family is installed whole")

    print("\nScriptorium-Setup.exe: registered and on disk, but Windows has not loaded it")
    p = Pretend(work, source, "unlisted")
    for f in (EB_UP, EB_IT, CO_UP, CO_IT):
        p.install(f, legacy=False)
    (p.root / "unlisted.txt").write_text(CO_UP + "\n", encoding="utf-8")
    r = go(p, "--check-fonts")
    check(r.returncode == 1 and "Cormorant Garamond upright: registered, but Windows does not list it" in r.stdout, "a family that lists only an italic style needs repair, whatever the registry says")
    r = go(p, "--repair-fonts")
    check(r.returncode == 0 and str(p.dir / CO_UP) in p.lines("loaded.txt"), "the repair loads it")

    print("\nScriptorium-Setup.exe: the user's own copies, under other file names, installed for the whole machine")
    p = Pretend(work, source, "own")
    for f, own in ((EB_UP, "EBGaramond-VariableFont_wght.ttf"), (EB_IT, "EBGaramond-Italic-VariableFont_wght.ttf"),
                   (CO_UP, "CormorantGaramond-VariableFont_wght.ttf"), (CO_IT, "CormorantGaramond-Italic-VariableFont_wght.ttf")):
        target = p.root / "WindowsFonts" / own
        target.parent.mkdir(exist_ok=True)
        shutil.copyfile(source / f, target)
        p.register(OLD_NAME[f], target, hive="HKLM")
    r = go(p, "--check-fonts")
    check(r.returncode == 0 and not any(p.dir.iterdir()), "they count: nothing is installed beside them")

    print("\nScriptorium-Setup.exe: an older Scriptorium's value for the same file is replaced when the face is repaired")
    p = Pretend(work, source, "legacy")
    for f in (EB_UP, EB_IT, CO_UP, CO_IT):
        p.install(f)
    p.put(CO_UP, damaged=True)
    r = go(p, "--repair-fonts")
    reg = p.registry()
    check(r.returncode == 0 and NEW_NAME[CO_UP] in reg and OLD_NAME[CO_UP] not in reg and OLD_NAME[CO_IT] in reg, "the repaired face is under the new name only; faces in order are not touched")

    print("\nScriptorium-Setup.exe: the headless set-up repairs the fonts too")
    p = Pretend(work, source, "setup")
    p.install(EB_UP); p.install(EB_IT); p.put(CO_UP); p.install(CO_IT)
    vault = work / "a vault"
    vault.mkdir()
    (vault / "Note.md").write_text("A note.\n", encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if k != "SCRIPTORIUM_NO_FONTS"}
    r = run_exe(exe, "--setup-only", str(vault), "--font-root", str(p.root), "--font-source", str(source), env=env)
    check(r.returncode == 0 and "Repaired Cormorant Garamond upright" in r.stdout and "Fonts put right: Cormorant Garamond upright." in r.stdout, "--setup-only sees the half-registered family and puts it right")
    check(go(p, "--check-fonts").returncode == 0, "all four are in order afterwards")
    r = run_exe(exe, "--update-only", str(vault), "--font-root", str(p.root), "--font-source", str(source), env=env)
    check(r.returncode == 0 and "Fonts" not in r.stdout, "--update-only checks them as well, and says nothing when they are in order")


# ---------- Windows itself ----------

FONT_KEY = r"Software\Microsoft\Windows NT\CurrentVersion\Fonts"


def windows_tests(exe, source, work):
    import ctypes
    import winreg
    font_dir = Path(os.environ["LOCALAPPDATA"]) / "Microsoft" / "Windows" / "Fonts"
    gdi = ctypes.windll.gdi32

    def values():
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, FONT_KEY) as k:
            out, i = {}, 0
            while True:
                try:
                    name, value, _ = winreg.EnumValue(k, i)
                except OSError:
                    return out
                out[name] = value
                i += 1

    def delete_value(name):
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, FONT_KEY) as k:
            try:
                winreg.DeleteValue(k, name)
            except OSError:
                pass

    def unload(path):
        for _ in range(20):
            if not gdi.RemoveFontResourceExW(str(path), 0, 0):
                break

    def cleanup():
        for _, file, _, _, old in FACES:
            for name in (old, "Scriptorium " + old):
                if values().get(name, "").lower() == str(font_dir / file).lower():
                    delete_value(name)
            unload(font_dir / file)
            try:
                (font_dir / file).unlink()
            except OSError:
                pass

    def go(command):
        return run_exe(exe, command, "--font-source", str(source))

    before = values()
    if any((font_dir / f[1]).exists() for f in FACES) or any("garamond" in n.lower() for n in before):
        print("\nWindows itself: skipped, because this computer has these fonts already and the test would change them")
        return
    try:
        print("\nWindows itself: nothing installed")
        r = go("--check-fonts")
        check(r.returncode == 1 and r.stdout.count("not installed") == 4, "all four faces are reported as not installed")
        r = go("--repair-fonts")
        check(r.returncode == 0 and r.stdout.count("ok      ") == 4, "the repair installs all four, and Windows then lists each family with an upright and an italic face")
        check(all(values().get("Scriptorium " + f[4], "").lower() == str(font_dir / f[1]).lower() for f in FACES), "each face is registered for this user under a value of its own")
        check(go("--check-fonts").returncode == 0, "a new process finds all four in order")

        print("\nWindows itself: the upright's registration is gone, its file is still there (the fault a user met)")
        delete_value("Scriptorium " + FACES[2][4])
        r = go("--check-fonts")
        check(r.returncode == 1 and "REPAIR  Cormorant Garamond upright: its file is there, but it is not registered with Windows" in r.stdout, "the check finds the unregistered upright face")
        check(r.stdout.count("ok      ") == 3, "and only that one")
        vault = work / "windows vault"
        vault.mkdir()
        (vault / "Note.md").write_text("A note.\n", encoding="utf-8")
        env = {k: v for k, v in os.environ.items() if k != "SCRIPTORIUM_NO_FONTS"}
        r = run_exe(exe, "--setup-only", str(vault), "--font-source", str(source), env=env)
        check(r.returncode == 0 and "Repaired Cormorant Garamond upright" in r.stdout, "setting up a vault repairs it")
        check(go("--check-fonts").returncode == 0, "all four are in order again")

        print("\nWindows itself: the same fault, and a registry value whose file is gone, put right by Install-Scriptorium-Windows.cmd's font part")
        delete_value("Scriptorium " + FACES[2][4])
        unload(font_dir / EB_IT)
        try:
            (font_dir / EB_IT).unlink()
            gone = True
        except OSError as e:
            print(f"      (the EB Garamond italic file could not be deleted: {e}; that half of the test is skipped)")
            gone = False
        r = go("--check-fonts")
        check(r.returncode == 1 and (not gone or "EB Garamond italic: registered with Windows, but its file is gone" in r.stdout), "the check sees both faults")
        text = (ROOT / "installers" / "Install-Scriptorium-Windows.cmd").read_text(encoding="utf-8")
        part = text.split("# FONTS_START", 1)[1].split("# FONTS_END", 1)[0]
        script = work / "fonts-part.ps1"
        script.write_text("$ErrorActionPreference = 'Stop'\n"
                          f"$tempPath = '{work / 'ps-temp'}'\nNew-Item -ItemType Directory -Path $tempPath -Force | Out-Null\n"
                          f"function Get-ScriptoriumDownload($Uri, $OutFile) {{ Copy-Item -LiteralPath (Join-Path '{source}' (Split-Path $OutFile -Leaf)) -Destination $OutFile }}\n"
                          + part + "\nWrite-Host \"IN ORDER: $fontsInOrder\"\n", encoding="utf-8-sig")
        r = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script)], capture_output=True, text=True, timeout=600)
        for line in (r.stdout + r.stderr).splitlines():
            print("      | " + line)
        check(r.returncode == 0 and "IN ORDER: True" in r.stdout, "the script's font part ends with all four faces in order")
        check("Repaired Cormorant Garamond upright (it was: not registered)" in r.stdout, "it registered the upright face")
        check(not gone or "Repaired EB Garamond italic (it was: file gone)" in r.stdout, "and put the missing file back")
        check(go("--check-fonts").returncode == 0, "Scriptorium-Setup.exe agrees: all four in order")
        r = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script)], capture_output=True, text=True, timeout=600)
        check("IN ORDER: True" in r.stdout and "Repaired" not in r.stdout and "Installed" not in r.stdout, "run again, the script's font part changes nothing")
    finally:
        cleanup()
        left = [n for n in values() if n not in before]
        check(not left and not any((font_dir / f[1]).exists() for f in FACES), "the test removed what it installed" + (f" (left: {left})" if left else ""))


# ---------- the script installers' font part ----------

def script_part(path):
    text = path.read_text(encoding="utf-8")
    return text.split("# FONTS_START", 1)[1].split("# FONTS_END", 1)[0]


def run_part(part, home, source, fail="", prelude=""):
    """Runs a script installer's font part in a home of its own; curl is a function that copies from `source`."""
    work = home / "work"
    work.mkdir(exist_ok=True)
    script = f"""set -euo pipefail
work_dir='{work}'
curl() {{
  local out="${{@: -1}}" name
  name="$(basename "$out")"
  case " $FONT_FAIL " in *" $name "*) return 22 ;; esac
  cp '{source}'/"$name" "$out"
}}
{prelude}
{part}
for font_face in "${{font_faces[@]}}"; do
  IFS='|' read -r font_family font_style font_file font_url font_sha <<< "$font_face"
  printf 'STATE %s %s: %s\\n' "$font_family" "$font_style" "$(font_state "$font_family" "$font_style" "$font_file" "$font_sha")"
done
printf 'LINE %s\\n' "$fonts_line"
"""
    env = dict(os.environ, HOME=str(home), XDG_DATA_HOME=str(home / "data"), XDG_CACHE_HOME=str(home / "cache"), XDG_CONFIG_HOME=str(home / "config"), FONT_FAIL=fail)
    r = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=600, env=env)
    for line in (r.stdout + r.stderr).splitlines():
        print("      | " + line)
    return r


def script_tests(source, work, name, path, font_dir, prelude="", listed=True):
    part = script_part(path)
    n = [0]

    def home():
        n[0] += 1
        h = work / f"{name}-home-{n[0]}"
        h.mkdir()
        return h

    def cache(h):
        if shutil.which("fc-cache") and name == "linux":
            subprocess.run(["fc-cache", "-f", str(font_dir(h))], env=dict(os.environ, HOME=str(h), XDG_DATA_HOME=str(h / "data"), XDG_CACHE_HOME=str(h / "cache")), capture_output=True)

    print(f"\n{path.name}: nothing installed")
    h = home()
    r = run_part(part, h, source, prelude=prelude)
    check(r.returncode == 0 and r.stdout.count("Installed ") == 4 and r.stdout.count(": ok") == 4, "all four faces are installed, and each is then in order")
    check([sha(font_dir(h) / f[1]) for f in FACES] == [f[3] for f in FACES], "the four files are the pinned ones")
    check("LINE Fonts are ready." in r.stdout, "it says the fonts are ready")
    r = run_part(part, h, source, prelude=prelude)
    check(r.returncode == 0 and "Installed" not in r.stdout and "Repaired" not in r.stdout and r.stdout.count(": ok") == 4, "run again, it changes nothing")

    print(f"\n{path.name}: only the italic of Cormorant Garamond is installed (the fault a user met)")
    (font_dir(h) / CO_UP).unlink()
    cache(h)
    r = run_part(part, h, source, prelude=prelude)
    check(r.returncode == 0 and "Installed Cormorant Garamond upright" in r.stdout and r.stdout.count("Installed ") == 1, "the family is not taken for installed: its upright face is installed, and nothing else")
    check(r.stdout.count(": ok") == 4, "all four are in order afterwards")

    print(f"\n{path.name}: a damaged file")
    (font_dir(h) / EB_IT).write_bytes(b"not a font" * 500)
    cache(h)
    r = run_part(part, h, source, prelude=prelude)
    check(r.returncode == 0 and "Repaired EB Garamond italic" in r.stdout and sha(font_dir(h) / EB_IT) == FACES[1][3], "it is replaced with the pinned file")

    print(f"\n{path.name}: the upright of one family cannot be downloaded")
    h = home()
    r = run_part(part, h, source, fail=CO_UP, prelude=prelude)
    check(r.returncode == 0, "the installer goes on (the vault is still installed)")
    check(not (font_dir(h) / CO_IT).exists(), "the italic of that family is NOT installed: never an italic alone")
    check("FONT NOT PUT RIGHT: Cormorant Garamond upright" in r.stdout and "Cormorant Garamond italic: left as it was, because the upright face could not be installed" in r.stdout, "it says which faces, and why")
    check((font_dir(h) / EB_UP).exists() and (font_dir(h) / EB_IT).exists(), "the other family is installed whole")
    check("LINE Some fonts could not be put right" in r.stdout, "and the closing words do not say the fonts are ready")
    r = run_part(part, h, source, prelude=prelude)
    check(r.stdout.count(": ok") == 4 and r.stdout.count("Installed ") == 2, "the next run installs the two that are missing")
    return part


def main():
    exe = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None
    source = fonts()
    work = Path(tempfile.mkdtemp(prefix="scriptorium-fonts-test-")).resolve()   # on Windows the temporary folder may be given by its short name
    try:
        if exe:
            exe_tests(exe, source, work)
            if WINDOWS:
                windows_tests(exe, source, work)
        if not WINDOWS:
            mac = sys.platform == "darwin"
            if shutil.which("fc-list") and not mac:
                part = script_tests(source, work, "linux", ROOT / "installers" / "Install-Scriptorium-Linux.sh", lambda h: h / "data" / "fonts" / "scriptorium")
                print("\nInstall-Scriptorium-Linux.sh: your own copies of the fonts, somewhere else")
                h = work / "linux-own"
                own = h / "data" / "fonts" / "mine"
                own.mkdir(parents=True)
                for f in (EB_UP, EB_IT, CO_UP, CO_IT):
                    shutil.copyfile(source / f, own / f.replace("-Scriptorium", "-VariableFont"))
                r = run_part(part, h, source)
                check(r.stdout.count(": ok") == 4 and "Installed" not in r.stdout and not (h / "data" / "fonts" / "scriptorium").exists(), "they count: nothing is installed beside them")
            else:
                print("\nInstall-Scriptorium-Linux.sh: skipped (no fontconfig here, or this is macOS)")
            # Off macOS, system_profiler is a function that lists what the test says is installed besides Scriptorium's files.
            pretend = "" if mac else "system_profiler() { cat \"$HOME/profiler.txt\" 2>/dev/null || true; }"
            part = script_tests(source, work, "macos", ROOT / "installers" / "Install-Scriptorium-macOS.command", lambda h: h / "Library" / "Fonts", prelude=pretend)
            if not mac:
                print("\nInstall-Scriptorium-macOS.command: your own copies, as system_profiler lists them")
                h = work / "macos-own"
                h.mkdir()
                listing = "".join(f"        {face}:\n          Full Name: {family} {style}\n          Family: {family}\n          Style: {style}\n"
                                  for face, family, style in (("EBGaramond-Regular", "EB Garamond", "Regular"), ("EBGaramond-Italic", "EB Garamond", "Italic"),
                                                              ("CormorantGaramond-Light", "Cormorant Garamond", "Light"), ("CormorantGaramond-LightItalic", "Cormorant Garamond", "Light Italic")))
                (h / "profiler.txt").write_text(listing, encoding="utf-8")
                r = run_part(part, h, source, prelude=pretend)
                check(r.stdout.count(": ok") == 4 and "Installed" not in r.stdout, "they count: nothing is installed")
                print("\nInstall-Scriptorium-macOS.command: your own copy of the italic only")
                h = work / "macos-own-italic"
                h.mkdir()
                (h / "profiler.txt").write_text("          Family: Cormorant Garamond\n          Style: Italic\n          Family: EB Garamond\n          Style: Regular\n          Family: EB Garamond\n          Style: Italic\n", encoding="utf-8")
                r = run_part(part, h, source, prelude=pretend)
                check(r.stdout.count("Installed ") == 1 and "Installed Cormorant Garamond upright" in r.stdout and r.stdout.count(": ok") == 4, "the family is not taken for installed: the upright face is installed")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print()
    if failures:
        print(f"{len(failures)} check(s) FAILED:")
        for f in failures:
            print("  " + f)
        return 1
    print("All font checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
