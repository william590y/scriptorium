// Scriptorium Setup: a small Windows installer with a window, doing what Install-Scriptorium-Windows.cmd does.
//
// It creates a NEW vault folder from the Scriptorium configuration (embedded in this .exe, so it always matches the
// installer's version), installs Obsidian for the current user if it is missing, and installs EB Garamond and Cormorant
// Garamond for the current user if they are missing. The Longform plugin is not bundled: if the user ticks it, it is
// downloaded from its author's official release into the new vault. The two community plugins that Lagrange's diagrams
// need, TikZJax and Excalidraw, are not bundled either: a new vault, an updated one and one that is set up each get them
// from the plugins' own releases (see DiagramPlugins). Every download is pinned by SHA-256. An existing
// folder is never changed, except a Scriptorium vault, which it can update in place: Scriptorium's own files are replaced
// (the old ones backed up in .obsidian/scriptorium-backup-<time>), the user's notes and settings are kept. Any other
// folder with files in it (a vault the user already writes in, or a folder of notes) can be set up as a Scriptorium
// vault: Scriptorium's files are added to its .obsidian folder, the user's settings are merged, and no note is touched
// (see Vaults.SetUp). If the user
// ticks it, a new vault is then opened in Obsidian with its community plugins turned on (see AutoOpen).
// Targets .NET Framework 4.8, which ships with Windows 10 and 11, so nothing else needs installing.
//
// The window is drawn like a Scriptorium page: ink on warm paper, set in EB Garamond and Cormorant Garamond (static
// subsets embedded in this .exe, built by tools/build_fonts.py), with hand-inked buttons, boxes and rules.
//
// Build: tools/build_exe.sh (Mono's csc, on Linux) or .github/workflows/build.yml (Windows) -> dist/Scriptorium-Setup.exe
//
// Copyright (C) 2026 William Liaw
//
// This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
// warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License along with this program. If not, see
// <https://www.gnu.org/licenses/>.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.IO.Compression;
using System.IO.Pipes;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Scriptorium Setup")]
[assembly: AssemblyDescription("Installs the Scriptorium configuration for Obsidian")]
[assembly: AssemblyProduct("Scriptorium")]
[assembly: AssemblyCompany("williamliaw.com")]
[assembly: AssemblyCopyright("Copyright (C) 2026 William Liaw. GPL-3.0-or-later.")]
[assembly: AssemblyVersion("1.4.0.0")]
[assembly: AssemblyFileVersion("1.4.0.0")]

namespace ScriptoriumSetup
{
    static class Program
    {
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        [STAThread]
        static int Main(string[] args)
        {
            // For the tests: --font-root <folder> is a pretend Windows for the fonts; --font-source <folder> has the font
            // files, so that none is downloaded. Both may go with any other command.
            for (int i = 0; i + 1 < args.Length; )
            {
                if (args[i] == "--font-root" || args[i] == "--font-source")
                {
                    if (args[i] == "--font-root") Fonts.FakeRoot = Path.GetFullPath(args[i + 1]); else Fonts.Source = Path.GetFullPath(args[i + 1]);
                    args = args.Take(i).Concat(args.Skip(i + 2)).ToArray();
                }
                // For the tests: --plugin-pins <file> stands in for the pinned releases of the diagram plugins
                // (one line per file: id|name|version|file|SHA-256|address), so that nothing comes from GitHub.
                else if (args[i] == "--plugin-pins")
                {
                    try { DiagramPlugins.All = DiagramPlugins.Parse(File.ReadAllText(Path.GetFullPath(args[i + 1]), Encoding.UTF8)); }
                    catch (Exception e) { Console.Error.WriteLine("FAILED: --plugin-pins: " + e.Message); return 1; }
                    args = args.Take(i).Concat(args.Skip(i + 2)).ToArray();
                }
                else i++;
            }
            // Headless, for support: the state of each of the four font faces (--check-fonts), and putting them right
            // (--repair-fonts). Exit code 0 if all four are in order at the end.
            if (args.Length == 1 && (args[0] == "--check-fonts" || args[0] == "--repair-fonts")) return Fonts.Cli(args[0] == "--repair-fonts");
            // Headless check used by the build script: unpack the embedded vault into a new (or empty) folder and exit.
            if (args.Length == 2 && args[0] == "--extract-only")
            {
                try { Installer.ExtractVault(Path.GetFullPath(args[1]), null, true); Console.WriteLine("OK " + args[1]); return 0; }
                catch (Exception e) { Console.Error.WriteLine("FAILED: " + e.Message); return 1; }
            }
            // Headless (used by the tests): a new vault as the window makes it, in a folder that does not exist yet or is
            // empty: the embedded vault, then the diagram plugins from their releases. No Obsidian, fonts or Longform.
            if (args.Length == 2 && args[0] == "--install-only")
            {
                try
                {
                    string vault = Path.GetFullPath(args[1]);
                    Installer.ExtractVault(vault, Console.WriteLine, true);
                    DiagramPlugins.Headless(vault, Console.WriteLine);
                    return 0;
                }
                catch (Exception e) { Console.Error.WriteLine("FAILED: " + e.Message); return 1; }
            }
            // Headless update (used by the tests): update the Scriptorium vault in that folder in place, without Longform.
            if (args.Length == 2 && args[0] == "--update-only")
            {
                try
                {
                    string vault = Path.GetFullPath(args[1]);
                    if (Vaults.Classify(vault) != Vaults.Target.Vault) throw new InvalidOperationException("This folder is not a Scriptorium vault: " + vault);
                    Vaults.Report report = Vaults.Update(vault, null, Console.WriteLine);
                    Console.WriteLine(Vaults.UpdatedMessage(vault, report));
                    DiagramPlugins.Headless(vault, Console.WriteLine);
                    Fonts.Headless(Console.WriteLine);
                    return 0;
                }
                catch (Exception e) { Console.Error.WriteLine("FAILED: " + e.Message); return 1; }
            }
            // Headless: set up Scriptorium in any existing folder (a vault with notes in it, or a folder of notes), as "Set up"
            // does in the window; --setup-plan only prints what it would change.
            if (args.Length == 2 && (args[0] == "--setup-only" || args[0] == "--setup-plan"))
            {
                try
                {
                    string vault = Path.GetFullPath(args[1]);
                    if (!Directory.Exists(vault)) throw new InvalidOperationException("No such folder: " + vault);
                    if (args[0] == "--setup-plan")
                    {
                        Vaults.SetupPlan plan = Vaults.PlanSetUp(vault);
                        Console.WriteLine("Scriptorium " + (plan.Version ?? "?") + " in " + vault);
                        Console.WriteLine(plan.Summary(true));
                        foreach (string line in plan.Lines) Console.WriteLine(line);
                        return 0;
                    }
                    Vaults.Report report = Vaults.SetUp(vault, null, Console.WriteLine);
                    Console.WriteLine(Vaults.SetUpMessage(vault, report));
                    DiagramPlugins.Headless(vault, Console.WriteLine);
                    Fonts.Headless(Console.WriteLine);
                    return 0;
                }
                catch (Exception e) { Console.Error.WriteLine("FAILED: " + e.Message); return 1; }
            }
            // Headless (used by the tests): add <vault> to the vault list in the obsidian.json given, as the auto-open does;
            // with --cli, turn Obsidian's command line interface on too. Prints the vault's id and whether "cli" was on.
            if ((args.Length == 3 || (args.Length == 4 && args[3] == "--cli")) && args[0] == "--register-only")
            {
                try
                {
                    string file = Path.GetFullPath(args[1]);
                    string text = File.Exists(file) ? File.ReadAllText(file, Encoding.UTF8) : null;
                    AutoOpen.Registration r = AutoOpen.Register(text, args[2], AutoOpen.Now(), args.Length == 4, AutoOpen.NewId);
                    if (r.Changed) AutoOpen.WriteFile(file, r.Text);
                    Console.WriteLine(r.Id + " " + (r.Listed ? "listed" : "added") + " cli-" + (r.CliWasOn ? "on" : "off"));
                    return 0;
                }
                catch (Exception e) { Console.Error.WriteLine("FAILED: " + e.Message); return 1; }
            }
            // Headless (used by the tests): whether Obsidian counts as installed, given what the registry says the
            // obsidian:// links run ("" for no such link) and the folders programs are installed in. Exit code 0 if it is.
            if (args.Length == 1 && args[0] == "--find-obsidian")   // this computer, as the window decides it
            {
                string here = Installer.FindObsidian();
                Console.WriteLine(Installer.DescribeObsidian(here, Installer.ProtocolCommand()));
                return here != null ? 0 : 1;
            }
            if (args.Length >= 2 && args[0] == "--find-obsidian")
            {
                string command = args[1].Length > 0 ? args[1] : null;
                string found = Installer.LocateObsidian(args.Skip(2), command);
                Console.WriteLine(Installer.DescribeObsidian(found, command));
                return found != null ? 0 : 1;
            }
            // Headless (used by the tests): open the vault <vault> with the Obsidian <exe>, as Install does when "Open the
            // vault in Obsidian" is ticked. Exit code 0 if its plugins were turned on.
            if (args.Length == 3 && args[0] == "--auto-open-only")
            {
                if (AutoOpen.ObsidianRunning()) { Console.Error.WriteLine("FAILED: Obsidian is running"); return 1; }
                AutoOpen.Trace = Console.WriteLine;
                AutoOpen.Outcome o = AutoOpen.Open(args[2], Path.GetFullPath(args[1]), 120000, CancellationToken.None);
                Console.WriteLine(o.Result + (o.Problem != null ? ": " + o.Problem : ""));
                if (!AutoOpen.Settle(false)) { Console.WriteLine("Waiting for Obsidian to close, to turn its command line interface off"); AutoOpen.Settle(true); }
                Console.WriteLine("cli " + (o.CliLeftOn ? "was on before; left on" : "off"));
                return o.Result == AutoOpen.Result.Trusted ? 0 : 1;
            }
            if (Installer.IsWindows) { try { SetProcessDPIAware(); } catch { } }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Typefaces.Load();
            // Used by CI: draws the window in a scripted series of states and saves each as a PNG; installs nothing.
            if (args.Length == 2 && args[0] == "--render") return Preview.Run(Path.GetFullPath(args[1]));
            try { using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) Ink.S = Math.Max(1f, g.DpiX / 96f); } catch { }
            Application.Run(new SetupForm());
            // If setup turned Obsidian's command line interface on and could not yet turn it off (the window was closed
            // while the vault was being opened, or Obsidian stopped answering), it is turned off now, without a window:
            // through Obsidian, or in obsidian.json once Obsidian has closed.
            AutoOpen.Settle(true);
            return 0;
        }
    }

    // A pinned download: what it is, where it comes from, and the SHA-256 it must have.
    class Pinned
    {
        public string Label, File, Url, Sha256;
        public Pinned(string label, string file, string url, string sha) { Label = label; File = file; Url = url; Sha256 = sha; }
    }

    static class Installer
    {
        public static bool IsWindows { get { return Environment.OSVersion.Platform == PlatformID.Win32NT; } }

        const string FontBase = "https://raw.githubusercontent.com/google/fonts/5bb28733cec313b63fbd415b574b5ae35c8aa8b8/ofl/";
        public static readonly Pinned[] EbGaramond = {
            new Pinned("EB Garamond Regular (TrueType)", "EBGaramond-Scriptorium.ttf", FontBase + "ebgaramond/EBGaramond%5Bwght%5D.ttf",
                       "ef9512f92f6d579e5dc75af59a5a4b1b8b47d2eda89e00b954d44520e5369027"),
            new Pinned("EB Garamond Italic (TrueType)", "EBGaramond-Italic-Scriptorium.ttf", FontBase + "ebgaramond/EBGaramond-Italic%5Bwght%5D.ttf",
                       "bba2c4499c93c9612b90b9825d32b07da52fce2fe57562a1eb6b833553f93c4e"),
        };
        public static readonly Pinned[] Cormorant = {
            new Pinned("Cormorant Garamond Regular (TrueType)", "CormorantGaramond-Scriptorium.ttf", FontBase + "cormorantgaramond/CormorantGaramond%5Bwght%5D.ttf",
                       "b20b7d9626dd956b2c5e558692ad328b1f19e3275e2782db4fa07670d83f35e0"),
            new Pinned("Cormorant Garamond Italic (TrueType)", "CormorantGaramond-Italic-Scriptorium.ttf", FontBase + "cormorantgaramond/CormorantGaramond-Italic%5Bwght%5D.ttf",
                       "0f48ea6abb2084537854f7174c470991a463b13036309e3b50a81511611c530d"),
        };
        public static readonly Pinned ObsidianSetup = new Pinned("Obsidian 1.15.0", "Obsidian-Setup.exe",
            "https://github.com/obsidianmd/obsidian-releases/releases/download/v1.15.0/Obsidian-1.15.0.exe",
            "b0f60c75a12f96d54cb16b9fc32919966f2ebf029d9af75d67a19ba6555e1da0");

        // Longform is not bundled with Scriptorium (its license is not an open-source one); its official release is
        // downloaded into the new vault instead, pinned by SHA-256 like everything else.
        const string LongformBase = "https://github.com/kevboh/longform/releases/download/2.1.0/";
        public static readonly Pinned[] Longform = {
            new Pinned("Longform 2.1.0 (main.js)", "main.js", LongformBase + "main.js",
                       "d937568a0a522778b1c2968d47288ef5fb18f7c28d02bdccb31415e304daaf3b"),
            new Pinned("Longform 2.1.0 (manifest.json)", "manifest.json", LongformBase + "manifest.json",
                       "b6ff0a8e9e5964cfc1a126a10f1df02366a76fdaa09e2b97ca1c98406f0146c2"),
            new Pinned("Longform 2.1.0 (styles.css)", "styles.css", LongformBase + "styles.css",
                       "c49db364bb574dccbd55bf1d326b01e1a0580045e72d01bfb08bb6ad94e991f5"),
        };

        public static string DefaultVault
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Scriptorium"); }
        }

        // ---------- the vault ----------
        // Unpacks the embedded configuration into a fresh staging folder, checks it, then copies it into a folder that
        // must not exist yet (created here, so an existing folder is never merged into) or, with intoEmpty, into an
        // existing folder that is empty.
        public static void ExtractVault(string destination, Action<string> log) { ExtractVault(destination, log, false); }

        public static void ExtractVault(string destination, Action<string> log, bool intoEmpty)
        {
            bool existed = Directory.Exists(destination);
            if (File.Exists(destination) || (existed && !(intoEmpty && Vaults.IsEmptyFolder(destination))))
                throw new InvalidOperationException("The folder already exists: " + destination + "\nChoose a new folder; nothing was changed.");
            string temp = Path.Combine(Path.GetTempPath(), "scriptorium-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temp);
            try
            {
                string staging = Stage(temp);
                Directory.CreateDirectory(Path.GetDirectoryName(destination));
                if (existed)
                {
                    if (!Vaults.IsEmptyFolder(destination)) throw new InvalidOperationException("The folder is no longer empty: " + destination);
                }
                else
                {
                    if (Directory.Exists(destination)) throw new InvalidOperationException("The folder appeared while installing: " + destination);
                    Directory.CreateDirectory(destination);
                }
                try { CopyTree(staging, destination); }
                catch
                {
                    try { if (existed) { foreach (string e in Directory.GetFileSystemEntries(destination)) Vaults.DeleteEntry(e); } else Directory.Delete(destination, true); } catch { }
                    throw;
                }
                if (log != null) log("Created the vault in " + destination);
            }
            finally { try { Directory.Delete(temp, true); } catch { } }
        }

        // Unpacks the embedded configuration into temp\vault and checks it.
        public static string Stage(string temp)
        {
            string zip = Path.Combine(temp, "Scriptorium.zip");
            using (Stream res = Assembly.GetExecutingAssembly().GetManifestResourceStream("Scriptorium.zip"))
            {
                if (res == null) throw new InvalidOperationException("This installer is damaged: the configuration is missing.");
                using (FileStream fs = File.Create(zip)) res.CopyTo(fs);
            }
            string staging = Path.Combine(temp, "vault");
            ZipFile.ExtractToDirectory(zip, staging);
            if (!File.Exists(Path.Combine(staging, ".obsidian", "appearance.json")))
                throw new InvalidOperationException("This installer is damaged: the configuration is incomplete.");
            return staging;
        }

        static void CopyTree(string from, string to)
        {
            Directory.CreateDirectory(to);
            foreach (string f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)));
            foreach (string d in Directory.GetDirectories(from)) CopyTree(d, Path.Combine(to, Path.GetFileName(d)));
        }

        // ---------- Longform ----------
        // Downloads all three files into a staging folder first, so the plugin folder is only created once every file
        // has been verified; on any failure nothing is added to the vault.
        public static void InstallLongform(string vault, string temp, Action<int> progress, CancellationToken cancel)
        {
            string staging = DownloadLongform(temp, progress, cancel);
            string dir = Path.Combine(vault, ".obsidian", "plugins", "longform");
            Directory.CreateDirectory(dir);
            foreach (Pinned p in Longform) File.Copy(Path.Combine(staging, p.File), Path.Combine(dir, p.File));
        }

        // Downloads and verifies Longform's three files into temp\longform, and returns that folder.
        public static string DownloadLongform(string temp, Action<int> progress, CancellationToken cancel)
        {
            string staging = Path.Combine(temp, "longform");
            Directory.CreateDirectory(staging);
            for (int i = 0; i < Longform.Length; i++)
            {
                int k = i;
                Download(Longform[i], Path.Combine(staging, Longform[i].File),
                         (d, t) => { if (progress != null) progress((int)(100.0 * (k + (t > 0 ? (double)d / t : 0)) / Longform.Length)); }, cancel);
            }
            return staging;
        }

        // ---------- downloads ----------
        public static void Download(Pinned item, string outFile, Action<long, long> progress, CancellationToken cancel)
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            var req = (HttpWebRequest)WebRequest.Create(item.Url);
            req.UserAgent = "Scriptorium-Installer";
            req.Timeout = 60000; req.ReadWriteTimeout = 60000;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (Stream input = resp.GetResponseStream())
            using (FileStream output = File.Create(outFile))
            {
                long total = resp.ContentLength, done = 0;
                byte[] buf = new byte[1 << 20];
                int n;
                while ((n = input.Read(buf, 0, buf.Length)) > 0)
                {
                    cancel.ThrowIfCancellationRequested();
                    output.Write(buf, 0, n); done += n;
                    if (progress != null) progress(done, total);
                }
                if (total >= 0 && done != total) throw new IOException("Incomplete download: " + item.Label);
            }
            if (Sha256(outFile) != item.Sha256)
            {
                File.Delete(outFile);
                throw new InvalidOperationException("Verification failed for " + item.Label + ". Nothing was installed from it.");
            }
        }

        public static string Sha256(string file)
        {
            using (var sha = SHA256.Create())
            using (FileStream fs = File.OpenRead(file))
                return string.Concat(sha.ComputeHash(fs).Select(b => b.ToString("x2")));
        }

        // ---------- Obsidian ----------
        // Obsidian is installed when its program is on the disk, and only then. Obsidian's uninstaller leaves things
        // behind (the obsidian:// link in the registry, the settings folder), so none of those says it is installed:
        // a link whose program is gone counts as not installed, and Setup offers to install Obsidian again.
        public static string FindObsidian()
        {
            return LocateObsidian(new[] {
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) }, ProtocolCommand());
        }

        // Obsidian.exe under one of the folders programs are installed in, or else the program that the obsidian:// links
        // open (command, as the registry has it), for an Obsidian installed elsewhere; null if neither is a file.
        public static string LocateObsidian(IEnumerable<string> baseDirs, string command)
        {
            foreach (string baseDir in baseDirs)
            {
                if (string.IsNullOrEmpty(baseDir)) continue;
                foreach (string exe in new[] { Path.Combine(baseDir, "Obsidian", "Obsidian.exe"), Path.Combine(baseDir, "Programs", "Obsidian", "Obsidian.exe") })
                    if (IsProgram(exe)) return exe;
            }
            string linked = ProtocolExe(command);
            return linked != null && IsProgram(linked) ? linked : null;
        }

        static bool IsProgram(string exe)
        {
            try { return File.Exists(exe) && new FileInfo(exe).Length > 0; } catch { return false; }
        }

        // The program named by the obsidian:// link's command ("C:\...\Obsidian.exe" "%1", or the same without the quotation
        // marks); null if it names none. It may no longer exist.
        public static string ProtocolExe(string command)
        {
            command = (command ?? "").Trim();
            string exe;
            if (command.StartsWith("\""))
            {
                int end = command.IndexOf('"', 1);
                exe = end > 1 ? command.Substring(1, end - 1) : "";
            }
            else
            {
                int end = command.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
                exe = end > 0 ? command.Substring(0, end + 4) : "";
            }
            exe = exe.Trim();
            return exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? exe : null;
        }

        // What the registry says the obsidian:// links run; null when there is no such link (or off Windows).
        public static string ProtocolCommand()
        {
            if (!IsWindows) return null;
            try
            {
                using (RegistryKey k = Registry.ClassesRoot.OpenSubKey(@"obsidian\shell\open\command"))
                    return k != null ? (k.GetValue("") as string ?? "") : null;
            }
            catch { return null; }
        }

        // One line for the record: where Obsidian is, or why it counts as not installed.
        public static string DescribeObsidian(string exe, string command)
        {
            if (exe != null) return "installed: " + exe;
            string linked = ProtocolExe(command);
            if (command != null) return "not installed: the obsidian:// link is left over from an Obsidian that was removed" + (linked != null ? " (" + linked + " is gone)" : "");
            return "not installed";
        }

        // ---------- fonts ----------
        // (Checking and installing the fonts, face by face, is the class Fonts below.)
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);

        public static void AnnounceFontChange()
        {
            UIntPtr result;
            SendMessageTimeout((IntPtr)0xffff, 0x001D /* WM_FONTCHANGE */, UIntPtr.Zero, IntPtr.Zero, 2 /* SMTO_ABORTIFHUNG */, 5000, out result);
        }
    }

    // ---------- the fonts, face by face ----------
    // The typography needs four faces: EB Garamond and Cormorant Garamond, each upright and italic. They are checked and
    // repaired one face at a time. A family with only its italic registered shows every heading in italics (Windows
    // gives the italic when asked for the upright), and a check by family name calls that "already installed".
    // A face is in order only if (a) a Fonts registry value, the user's or the machine's, names a file that exists and
    // is that face (Scriptorium's own file with the pinned SHA-256, or any font file whose name table says so: the
    // user's own copy), and (b) Windows lists the family with that style. Everything else needs repair.
    // What is touched is behind ISystem, so that the logic runs in the tests on any system (--font-root <folder>).
    static class Fonts
    {
        public sealed class Face
        {
            public readonly string Family; public readonly bool Italic; public readonly Pinned Pin;
            public Face(string family, bool italic, Pinned pin) { Family = family; Italic = italic; Pin = pin; }
            public string Name { get { return Family + (Italic ? " italic" : " upright"); } }
            // The registry value Scriptorium writes: its own name, so that another program that installs or removes
            // "Cormorant Garamond Regular (TrueType)" does not write over it or take it away.
            public string ValueName { get { return "Scriptorium " + Family + (Italic ? " Italic" : " Regular") + " (TrueType)"; } }
            public string LegacyValueName { get { return Pin.Label; } }   // what Scriptorium 1.2.3 and earlier wrote
        }

        // The order matters: the upright face of a family comes before its italic.
        public static readonly Face[] Faces = {
            new Face("EB Garamond", false, Installer.EbGaramond[0]), new Face("EB Garamond", true, Installer.EbGaramond[1]),
            new Face("Cormorant Garamond", false, Installer.Cormorant[0]), new Face("Cormorant Garamond", true, Installer.Cormorant[1]),
        };

        public enum Problem { None, NotInstalled, FileMissing, FileDiffers, NotRegistered, NotListed }

        public sealed class State
        {
            public Face Face; public Problem Problem; public string Path;
            public bool Ok { get { return Problem == Problem.None; } }
            public string Says
            {
                get
                {
                    switch (Problem)
                    {
                        case Problem.None: return "installed";
                        case Problem.NotInstalled: return "not installed";
                        case Problem.FileMissing: return "registered with Windows, but its file is gone";
                        case Problem.FileDiffers: return "its file is damaged, or is another font";
                        case Problem.NotRegistered: return "its file is there, but it is not registered with Windows";
                        default: return "registered, but Windows does not list it";
                    }
                }
            }
        }

        public sealed class Registered { public bool Machine; public string Name, Path; }
        public sealed class Identity { public string Family; public bool Italic; }

        public interface ISystem
        {
            string FontDir { get; }
            List<Registered> Registry();                 // the Fonts values of the user and of the machine, paths resolved
            bool Exists(string path);
            string Hash(string path);
            Identity Identify(string path);              // what the font file says it is, or null
            bool[] Styles(string family);                // { upright listed, italic listed }
            void Copy(string from, string to);           // throws IOException if the target is in use
            void SetValue(string name, string path);     // in the user's Fonts key
            void DeleteValue(string name);
            bool Load(string path);                      // AddFontResourceEx
            void Announce();                             // WM_FONTCHANGE to every window
        }

        // --font-root <folder>: a pretend Windows kept in that folder (the tests). --font-source <folder>: take the font
        // files from there instead of downloading them (they are checked against the pinned SHA-256 all the same).
        public static string FakeRoot, Source;
        public static ISystem Current { get { return FakeRoot != null ? (ISystem)new FakeSystem(FakeRoot) : Installer.IsWindows ? new WindowsSystem() : null; } }

        static bool SamePath(string a, string b)
        {
            try { return string.Equals(Path.GetFullPath(a).TrimEnd('\\', '/'), Path.GetFullPath(b).TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase); }
            catch { return string.Equals(a, b, StringComparison.OrdinalIgnoreCase); }
        }

        static bool Is(Identity id, Face face)
        {
            return id != null && id.Italic == face.Italic && id.Family != null &&
                   (string.Equals(id.Family, face.Family, StringComparison.OrdinalIgnoreCase) || id.Family.StartsWith(face.Family + " ", StringComparison.OrdinalIgnoreCase));
        }

        // Only values that could be one of our families are opened and read: a computer has hundreds of fonts.
        static bool Candidate(Registered r)
        {
            string both = (r.Name + " " + Path.GetFileName(r.Path)).Replace(" ", "").Replace("-", "").Replace("_", "");
            return both.IndexOf("garamond", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        public static State[] Check(ISystem s)
        {
            List<Registered> registry = s.Registry().Where(Candidate).ToList();
            var identities = new Dictionary<string, Identity>(StringComparer.OrdinalIgnoreCase);
            var styles = new Dictionary<string, bool[]>();
            var states = new List<State>();
            foreach (Face face in Faces)
            {
                string target = Path.Combine(s.FontDir, face.Pin.File);
                string good = null; bool stale = false;
                foreach (Registered r in registry)
                {
                    if (!s.Exists(r.Path))
                    {
                        if (SamePath(r.Path, target) || r.Name == face.ValueName || r.Name == face.LegacyValueName) stale = true;
                        continue;
                    }
                    Identity id;
                    if (!identities.TryGetValue(r.Path, out id)) { try { id = s.Identify(r.Path); } catch { id = null; } identities[r.Path] = id; }
                    if (Is(id, face) || (SamePath(r.Path, target) && s.Hash(target) == face.Pin.Sha256)) { good = r.Path; break; }
                }
                if (!styles.ContainsKey(face.Family)) styles[face.Family] = s.Styles(face.Family);
                bool listed = styles[face.Family][face.Italic ? 1 : 0];
                var st = new State { Face = face, Path = good ?? target };
                if (good != null) st.Problem = listed ? Problem.None : Problem.NotListed;
                else if (!s.Exists(target)) st.Problem = stale ? Problem.FileMissing : Problem.NotInstalled;
                else if (s.Hash(target) != face.Pin.Sha256) st.Problem = Problem.FileDiffers;
                else st.Problem = Problem.NotRegistered;
                states.Add(st);
            }
            return states.ToArray();
        }

        public static bool AllOk(State[] states) { return states.All(st => st.Ok); }

        // For --check-fonts and the log: one line a face.
        public static IEnumerable<string> Lines(State[] states)
        {
            foreach (State st in states) yield return (st.Ok ? "ok      " : "REPAIR  ") + st.Face.Name + ": " + st.Says + (st.Problem != Problem.NotInstalled ? " (" + st.Path + ")" : "");
        }

        static string Join(IList<string> items)
        {
            if (items.Count <= 1) return string.Concat(items);
            return string.Join(", ", items.Take(items.Count - 1)) + " and " + items[items.Count - 1];
        }

        // What the checkbox says. null: all four faces are in order.
        public static string Offer(State[] states)
        {
            if (AllOk(states)) return null;
            if (states.All(st => st.Problem == Problem.NotInstalled)) return "Install the fonts it uses for me (EB Garamond, Cormorant Garamond)";
            List<State> bad = states.Where(st => !st.Ok).ToList();
            bool missing = bad.All(st => st.Problem == Problem.NotInstalled || st.Problem == Problem.NotRegistered || st.Problem == Problem.FileMissing);
            return "Repair the fonts (" + Join(bad.Select(st => st.Face.Name).ToList()) + (bad.Count == 1 ? " is " : " are ") + (missing ? "missing" : "not in order") + ")";
        }

        public sealed class Outcome
        {
            public State[] After; public readonly List<string> Repaired = new List<string>(), Failed = new List<string>();
            public bool Ok { get { return AllOk(After); } }
        }

        // Puts right whatever Check finds wrong, and looks again. fetch gives a verified copy of a face's file. A family's
        // upright face is always done first, and if it cannot be put right its italic is not installed either: an italic
        // alone is the fault this is here to mend. Never throws for a face: what could not be done is in Failed.
        public static Outcome Repair(ISystem s, Func<Face, string> fetch, Action<string> log)
        {
            if (log == null) log = line => { };
            var outcome = new Outcome();
            State[] before = Check(s);
            bool changed = false;
            var uprightFailed = new HashSet<string>();
            for (int i = 0; i < Faces.Length; i++)
            {
                Face face = Faces[i]; State st = before[i];
                if (st.Ok) continue;
                if (face.Italic && uprightFailed.Contains(face.Family))
                {
                    outcome.Failed.Add(face.Name + ": left as it was, because the upright face could not be installed");
                    continue;
                }
                try
                {
                    string target = Path.Combine(s.FontDir, face.Pin.File);
                    if (st.Problem == Problem.NotListed)
                    {
                        if (!s.Load(st.Path)) throw new InvalidOperationException("Windows could not load " + st.Path + ". Sign out of Windows and in again, then run Scriptorium Setup once more.");
                    }
                    else
                    {
                        if (!s.Exists(target) || s.Hash(target) != face.Pin.Sha256)
                        {
                            string file = fetch(face);
                            try { s.Copy(file, target); }
                            catch (Exception e)
                            {
                                if (!(e is IOException) && !(e is UnauthorizedAccessException)) throw;
                                throw new InvalidOperationException("its file is in use and could not be replaced (" + target + "). Close Obsidian and any other program that shows this font, then run Scriptorium Setup again.");
                            }
                        }
                        s.SetValue(face.ValueName, target);
                        foreach (Registered r in s.Registry())
                            if (!r.Machine && r.Name == face.LegacyValueName && SamePath(r.Path, target)) s.DeleteValue(r.Name);
                        if (!s.Load(target)) throw new InvalidOperationException("Windows could not load " + target + ". Sign out of Windows and in again, then run Scriptorium Setup once more.");
                    }
                    changed = true;
                    outcome.Repaired.Add(face.Name);
                    log((st.Problem == Problem.NotInstalled ? "Installed " : "Repaired ") + face.Name + (st.Problem == Problem.NotInstalled ? "" : " (it was: " + st.Says + ")"));
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception e)
                {
                    if (!face.Italic) uprightFailed.Add(face.Family);
                    outcome.Failed.Add(face.Name + ": " + e.Message);
                    log("Could not " + (st.Problem == Problem.NotInstalled ? "install " : "repair ") + face.Name + ": " + e.Message);
                }
            }
            if (changed) s.Announce();
            outcome.After = Check(s);
            for (int i = 0; i < Faces.Length; i++)
            {
                State st = outcome.After[i];
                if (st.Ok || outcome.Failed.Any(f => f.StartsWith(st.Face.Name + ":", StringComparison.Ordinal))) continue;
                outcome.Repaired.Remove(st.Face.Name);
                outcome.Failed.Add(st.Face.Name + ": still " + st.Says);
                log("After the repair, " + st.Face.Name + " is still " + st.Says);
            }
            return outcome;
        }

        // A face's file from --font-source, or downloaded; either way with the pinned SHA-256.
        public static string Fetch(Face face, string temp, Action<long, long> progress, CancellationToken cancel)
        {
            if (Source != null)
            {
                string given = Path.Combine(Source, face.Pin.File);
                if (!File.Exists(given)) throw new InvalidOperationException("no " + face.Pin.File + " in " + Source);
                if (Installer.Sha256(given) != face.Pin.Sha256) throw new InvalidOperationException(given + " is not the pinned " + face.Pin.Label);
                return given;
            }
            string file = Path.Combine(temp, face.Pin.File);
            Installer.Download(face.Pin, file, progress, cancel);
            return file;
        }

        // What Setup says after a repair, in one or two sentences.
        public static string Report(Outcome o)
        {
            var parts = new List<string>();
            if (o.Repaired.Count > 0) parts.Add("Fonts put right: " + Join(o.Repaired) + ".");
            if (o.Failed.Count > 0) parts.Add("Fonts NOT put right: " + string.Join("; ", o.Failed) + ".");
            if (parts.Count == 0) parts.Add("The fonts were in order already.");
            return string.Join(" ", parts);
        }

        // --check-fonts and --repair-fonts: the state of each face, for support. Exit code 0 if all four are in order.
        public static int Cli(bool repair)
        {
            ISystem s = Current;
            if (s == null) { Console.Error.WriteLine("FAILED: the fonts can be checked on Windows only"); return 2; }
            State[] states = Check(s);
            Console.WriteLine("Fonts folder: " + s.FontDir);
            foreach (string line in Lines(states)) Console.WriteLine(line);
            if (!repair || AllOk(states)) { Console.WriteLine(AllOk(states) ? "All four faces are in order." : "Needs repair: run Scriptorium-Setup.exe --repair-fonts, or Scriptorium Setup itself."); return AllOk(states) ? 0 : 1; }
            string temp = Path.Combine(Path.GetTempPath(), "scriptorium-fonts-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temp);
            try
            {
                Outcome o = Repair(s, f => Fetch(f, temp, null, CancellationToken.None), Console.WriteLine);
                Console.WriteLine("After the repair:");
                foreach (string line in Lines(o.After)) Console.WriteLine(line);
                Console.WriteLine(Report(o));
                return o.Ok ? 0 : 1;
            }
            catch (Exception e) { Console.Error.WriteLine("FAILED: " + e.Message); return 1; }
            finally { try { Directory.Delete(temp, true); } catch { } }
        }

        // The headless update and set-up look at the fonts too, and repair them, as the window does (unless
        // SCRIPTORIUM_NO_FONTS is set: the tests, which must not need the network).
        public static void Headless(Action<string> log)
        {
            ISystem s = Current;
            if (s == null || !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("SCRIPTORIUM_NO_FONTS"))) return;
            try
            {
                if (AllOk(Check(s))) return;
                string temp = Path.Combine(Path.GetTempPath(), "scriptorium-fonts-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(temp);
                try { log(Report(Repair(s, f => Fetch(f, temp, null, CancellationToken.None), log))); }
                finally { try { Directory.Delete(temp, true); } catch { } }
            }
            catch (Exception e) { log("The fonts could not be checked: " + e.Message); }
        }

        // What a TrueType or OpenType file says it is: the family (the typographic one if it has one: a variable font's
        // first family name is that of its default instance, "Cormorant Garamond Light") and whether it is italic.
        public static Identity ReadIdentity(string path)
        {
            byte[] d = File.ReadAllBytes(path);
            Func<int, int> u16 = o => (d[o] << 8) | d[o + 1];
            Func<int, long> u32 = o => ((long)d[o] << 24) | ((long)d[o + 1] << 16) | ((long)d[o + 2] << 8) | d[o + 3];
            if (d.Length < 12) return null;
            long magic = u32(0);
            if (magic != 0x00010000 && magic != 0x4F54544F /* OTTO */ && magic != 0x74727565 /* true */) return null;
            int tables = u16(4), name = -1, os2 = -1, head = -1;
            for (int i = 0; i < tables && 28 + 16 * i <= d.Length; i++)
            {
                string tag = Encoding.ASCII.GetString(d, 12 + 16 * i, 4);
                int offset = (int)u32(12 + 16 * i + 8);
                if (tag == "name") name = offset; else if (tag == "OS/2") os2 = offset; else if (tag == "head") head = offset;
            }
            if (name < 0 || name + 6 > d.Length) return null;
            int count = u16(name + 2), strings = name + u16(name + 4);
            string family = null, typographic = null;
            for (int i = 0; i < count && name + 18 + 12 * i <= d.Length; i++)
            {
                int r = name + 6 + 12 * i, platform = u16(r), id = u16(r + 6), length = u16(r + 8), at = strings + u16(r + 10);
                if (platform != 3 || (id != 1 && id != 16) || at + length > d.Length) continue;
                string text = Encoding.BigEndianUnicode.GetString(d, at, length);
                if (id == 1 && family == null) family = text;
                if (id == 16 && typographic == null) typographic = text;
            }
            bool italic = (os2 >= 0 && os2 + 64 <= d.Length && (u16(os2 + 62) & 1) != 0) || (head >= 0 && head + 46 <= d.Length && (u16(head + 44) & 2) != 0);
            if (family == null && typographic == null) return null;
            return new Identity { Family = typographic ?? family, Italic = italic };
        }

        // ----- Windows itself -----
        sealed class WindowsSystem : ISystem
        {
            const string Key = @"Software\Microsoft\Windows NT\CurrentVersion\Fonts";
            [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern int AddFontResourceEx(string path, uint flags, IntPtr reserved);
            [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
            [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
            [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
            struct LOGFONT
            {
                public int Height, Width, Escapement, Orientation, Weight;
                public byte Italic, Underline, StrikeOut, Charset, OutPrecision, ClipPrecision, Quality, PitchAndFamily;
                [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string FaceName;
            }
            delegate int EnumProc(IntPtr logfont, IntPtr metric, uint type, IntPtr lparam);
            [DllImport("gdi32.dll", CharSet = CharSet.Unicode)] static extern int EnumFontFamiliesEx(IntPtr dc, ref LOGFONT logfont, EnumProc proc, IntPtr lparam, uint flags);

            public string FontDir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Windows\Fonts"); } }

            public List<Registered> Registry()
            {
                var list = new List<Registered>();
                string system = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Fonts");
                foreach (bool machine in new[] { false, true })
                {
                    try
                    {
                        using (RegistryKey k = (machine ? Microsoft.Win32.Registry.LocalMachine : Microsoft.Win32.Registry.CurrentUser).OpenSubKey(Key))
                        {
                            if (k == null) continue;
                            foreach (string name in k.GetValueNames())
                            {
                                string value = k.GetValue(name) as string;
                                if (string.IsNullOrEmpty(value)) continue;
                                string path;
                                try { path = Path.IsPathRooted(value) ? value : Path.Combine(system, value); } catch { continue; }
                                list.Add(new Registered { Machine = machine, Name = name, Path = path });
                            }
                        }
                    }
                    catch { }
                }
                return list;
            }

            public bool Exists(string path) { try { return File.Exists(path); } catch { return false; } }
            public string Hash(string path) { try { return Installer.Sha256(path); } catch { return null; } }
            public Identity Identify(string path) { return ReadIdentity(path); }

            // The faces GDI lists under the family's name, or under "<family> <weight>" (a variable font's other
            // instances are families of their own to GDI: "Cormorant Garamond Light").
            public bool[] Styles(string family)
            {
                var found = new bool[2];
                IntPtr dc = GetDC(IntPtr.Zero);
                try
                {
                    var names = new List<string>();
                    var all = new LOGFONT { Charset = 1 /* DEFAULT_CHARSET */, FaceName = "" };
                    EnumProc collect = (lf, tm, type, lp) =>
                    {
                        string face = ((LOGFONT)Marshal.PtrToStructure(lf, typeof(LOGFONT))).FaceName ?? "";
                        if ((string.Equals(face, family, StringComparison.OrdinalIgnoreCase) || face.StartsWith(family + " ", StringComparison.OrdinalIgnoreCase)) && !names.Contains(face)) names.Add(face);
                        return 1;
                    };
                    EnumFontFamiliesEx(dc, ref all, collect, IntPtr.Zero, 0);
                    EnumProc look = (lf, tm, type, lp) =>
                    {
                        found[((LOGFONT)Marshal.PtrToStructure(lf, typeof(LOGFONT))).Italic != 0 ? 1 : 0] = true;
                        return 1;
                    };
                    foreach (string name in names)
                    {
                        var one = new LOGFONT { Charset = 1, FaceName = name };
                        EnumFontFamiliesEx(dc, ref one, look, IntPtr.Zero, 0);
                    }
                    GC.KeepAlive(collect); GC.KeepAlive(look);
                }
                finally { ReleaseDC(IntPtr.Zero, dc); }
                return found;
            }

            public void Copy(string from, string to) { Directory.CreateDirectory(Path.GetDirectoryName(to)); File.Copy(from, to, true); }
            public void SetValue(string name, string path)
            {
                using (RegistryKey k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(Key)) k.SetValue(name, path, RegistryValueKind.String);
            }
            public void DeleteValue(string name)
            {
                using (RegistryKey k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(Key)) k.DeleteValue(name, false);
            }
            public bool Load(string path) { return AddFontResourceEx(path, 0, IntPtr.Zero) != 0; }
            public void Announce() { Installer.AnnounceFontChange(); }
        }

        // ----- a pretend Windows in a folder (the tests) -----
        // <root>/Fonts is the user's font folder; registry.txt has a line "HKCU|name|path" or "HKLM|name|path" for each
        // Fonts value; a face is listed if a value names an existing file of it, unless unlisted.txt names the file (a
        // font Windows has registered but not loaded), or once it is loaded (loaded.txt). fail.txt makes things fail:
        // "copy <file name>" (the file is in use), "load <file name>". announced.txt counts the WM_FONTCHANGE broadcasts.
        sealed class FakeSystem : ISystem
        {
            readonly string root;
            public FakeSystem(string root) { this.root = Path.GetFullPath(root); Directory.CreateDirectory(this.root); }
            string F(string name) { return Path.Combine(root, name); }
            string[] Read(string name) { return File.Exists(F(name)) ? File.ReadAllLines(F(name)).Where(l => l.Trim().Length > 0).ToArray() : new string[0]; }
            bool Fails(string what, string path) { return Read("fail.txt").Any(l => l.Trim() == what + " " + Path.GetFileName(path)); }

            public string FontDir { get { return F("Fonts"); } }
            public List<Registered> Registry()
            {
                var list = new List<Registered>();
                foreach (string line in Read("registry.txt"))
                {
                    string[] p = line.Split(new[] { '|' }, 3);
                    if (p.Length == 3) list.Add(new Registered { Machine = p[0] == "HKLM", Name = p[1], Path = Path.IsPathRooted(p[2]) ? p[2] : Path.Combine(root, p[2]) });
                }
                return list;
            }
            public bool Exists(string path) { return File.Exists(path); }
            public string Hash(string path) { return Installer.Sha256(path); }
            public Identity Identify(string path) { return ReadIdentity(path); }
            public bool[] Styles(string family)
            {
                var found = new bool[2];
                string[] unlisted = Read("unlisted.txt"), loaded = Read("loaded.txt");
                var paths = Registry().Where(r => !unlisted.Contains(Path.GetFileName(r.Path))).Select(r => r.Path).Concat(loaded).Distinct().ToList();
                foreach (string path in paths)
                {
                    if (!File.Exists(path)) continue;
                    Identity id = null;
                    try { id = ReadIdentity(path); } catch { }
                    if (id != null && id.Family != null && (string.Equals(id.Family, family, StringComparison.OrdinalIgnoreCase) || id.Family.StartsWith(family + " ", StringComparison.OrdinalIgnoreCase)))
                        found[id.Italic ? 1 : 0] = true;
                }
                return found;
            }
            public void Copy(string from, string to)
            {
                if (Fails("copy", to)) throw new IOException("The process cannot access the file because it is being used by another process.");
                Directory.CreateDirectory(Path.GetDirectoryName(to)); File.Copy(from, to, true);
            }
            public void SetValue(string name, string path)
            {
                var lines = Read("registry.txt").Where(l => !l.StartsWith("HKCU|" + name + "|", StringComparison.Ordinal)).ToList();
                lines.Add("HKCU|" + name + "|" + path);
                File.WriteAllLines(F("registry.txt"), lines);
            }
            public void DeleteValue(string name)
            {
                File.WriteAllLines(F("registry.txt"), Read("registry.txt").Where(l => !l.StartsWith("HKCU|" + name + "|", StringComparison.Ordinal)));
            }
            public bool Load(string path)
            {
                if (Fails("load", path)) return false;
                File.AppendAllLines(F("loaded.txt"), new[] { path });
                return true;
            }
            public void Announce() { File.AppendAllLines(F("announced.txt"), new[] { "WM_FONTCHANGE" }); }
        }
    }

    // ---------- the diagram plugins ----------
    // Lagrange draws technical figures with the TikZJax plugin and free-form sketches with the Excalidraw plugin. They are
    // not part of Scriptorium and are not in this installer (TikZJax is MIT-licensed, the Excalidraw plugin AGPL-3.0):
    // each is downloaded from its own release on GitHub, at a pinned version, and every file is checked against its
    // SHA-256 before anything is written to .obsidian/plugins/<id>/. A new vault, an updated vault and a vault that is set
    // up all get them, turned on like Scriptorium's own plugins. The rules, the same as in
    // installers/Setup-Scriptorium-Vault.py, the script installers and the Scriptorium plugin:
    //   - a plugin the vault has at the pinned version or a newer one is left exactly as it is; an older one is replaced;
    //   - only a plugin installed new is turned on: one the vault had and the user turned off stays off;
    //   - Excalidraw, installed new, gets one setting so that its welcome window does not open (see FirstSettings);
    //     settings that are there are never touched;
    //   - a plugin's settings (data.json) are never touched, and nothing is deleted;
    //   - a plugin that cannot be downloaded, or whose files do not match, is not installed: nothing of it is written,
    //     what Setup did to the vault stands, and the log names the plugin and says how to add it in Obsidian.
    // The pins below are written by tools/pin_plugins.py from installers/diagram-plugins.json: change them there.
    static class DiagramPlugins
    {
        public sealed class Plugin { public string Id, Name, Version; public Pinned[] Files; }

        static Plugin Release(string id, string name, string version, string repository, params string[] filesAndHashes)
        {
            var files = new List<Pinned>();
            for (int i = 0; i + 1 < filesAndHashes.Length; i += 2)
                files.Add(new Pinned(name + " " + version + " (" + filesAndHashes[i] + ")", filesAndHashes[i],
                                     "https://github.com/" + repository + "/releases/download/" + version + "/" + filesAndHashes[i], filesAndHashes[i + 1]));
            return new Plugin { Id = id, Name = name, Version = version, Files = files.ToArray() };
        }

        public static Plugin[] All = {
            Release("obsidian-tikzjax", "TikZJax", "0.5.2", "artisticat1/obsidian-tikzjax",
                    "main.js", "cbae1ad4362d44173e56ba512f01e65de1f7cc69a4bf4733bc5711a2de101f41",
                    "manifest.json", "09fbbb05aeffc32bc65365d8526fc2222ee971417dcd4afddeb989498a5e1de1",
                    "styles.css", "d9a7f741ec8fdcbe5e0145152c799238cee8df5a14ddc7dc9feb3bb835ce068d"),
            Release("obsidian-excalidraw-plugin", "Excalidraw", "2.29.2", "zsviczian/obsidian-excalidraw-plugin",
                    "main.js", "49dfc5667a7730dbc124cdfc2a4a8e89188100636493a39d6493bf5696a55541",
                    "manifest.json", "8e82828fd9125615e8a361d0f15553e548cac2ee7a303e55387378a53b925fd9",
                    "styles.css", "6c7a9914f83305d09f9957248897ff2f25cf2c2d4b46b2d9ab42f3c7ee1d29f0"),
        };

        // SCRIPTORIUM_NO_DIAGRAM_PLUGINS is set by the tests of everything else, which must not need the network.
        public static bool Off { get { return !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("SCRIPTORIUM_NO_DIAGRAM_PLUGINS")); } }

        // A stand-in for the pins (--plugin-pins, for the tests): one line per file, id|name|version|file|SHA-256|address.
        public static Plugin[] Parse(string text)
        {
            var plugins = new List<Plugin>();
            var files = new Dictionary<string, List<Pinned>>();
            foreach (string raw in text.Split('\n'))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line[0] == '#') continue;
                string[] f = line.Split('|');
                if (f.Length != 6 || !Regex.IsMatch(f[0], "^[a-z0-9][a-z0-9-]*$") || !Regex.IsMatch(f[3], @"^[A-Za-z0-9_-]+\.[a-z]+$") || !Regex.IsMatch(f[4], "^[0-9a-f]{64}$"))
                    throw new FormatException("a line that cannot be read: " + line);
                if (!files.ContainsKey(f[0])) { files[f[0]] = new List<Pinned>(); plugins.Add(new Plugin { Id = f[0], Name = f[1], Version = f[2] }); }
                files[f[0]].Add(new Pinned(f[1] + " " + f[2] + " (" + f[3] + ")", f[3], f[5], f[4]));
            }
            foreach (Plugin p in plugins) p.Files = files[p.Id].ToArray();
            return plugins.ToArray();
        }

        // Versions compare by their numbers, as the other installers compare them: 2.29.2 < 2.30.0 < 10.0.
        static int[] Key(string version) { return Regex.Matches(version ?? "", "[0-9]+").Cast<Match>().Take(4).Select(m => { int n; return int.TryParse(m.Value, out n) ? n : int.MaxValue; }).ToArray(); }

        public static bool AtLeast(string have, string want)
        {
            int[] a = Key(have), b = Key(want);
            for (int i = 0; i < Math.Max(a.Length, b.Length); i++)
            {
                int x = i < a.Length ? a[i] : 0, y = i < b.Length ? b[i] : 0;
                if (x != y) return x > y;
            }
            return true;
        }

        static string Folder(string vault, Plugin p) { return Path.Combine(vault, ".obsidian", "plugins", p.Id); }

        // The version of the plugin in the vault, or null if it is not there (no manifest that can be read).
        static string VersionIn(string vault, Plugin p)
        {
            try
            {
                var o = MiniJson.Parse(File.ReadAllText(Path.Combine(Folder(vault, p), "manifest.json"))) as MiniJson.Obj;
                string v = o != null ? o.Get("version") as string : null;
                return string.IsNullOrEmpty(v) ? null : v;
            }
            catch { return null; }
        }

        // Whether the vault's own copy stays: it is the pinned version or a newer one, and its code is there.
        static bool Keeps(string vault, Plugin p, string have)
        {
            return have != null && AtLeast(have, p.Version) && File.Exists(Path.Combine(Folder(vault, p), "main.js"));
        }

        // What Install would download into this vault, in words (for the plan shown before a vault is set up).
        public static List<string> PlanLines(string vault)
        {
            var lines = new List<string>();
            if (Off) return lines;
            foreach (Plugin p in All)
            {
                string have = VersionIn(vault, p);
                if (Keeps(vault, p, have)) continue;
                lines.Add("  download .obsidian/plugins/" + p.Id + ": " + p.Name + " " + p.Version + ", from its own release on GitHub" +
                          (have != null ? " (in place of your " + have + ")" : ""));
            }
            return lines;
        }

        public static void Headless(string vault, Action<string> log)
        {
            if (Off) return;
            string temp = Path.Combine(Path.GetTempPath(), "scriptorium-plugins-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temp);
            try { Install(vault, temp, log, null, CancellationToken.None); }
            finally { try { Directory.Delete(temp, true); } catch { } }
        }

        // Adds the plugins to the vault and turns them on (see the top of this class). Never throws: what could not be
        // done is said through log. status(text, percent) follows the downloads. Returns the names of the plugins that
        // were not installed.
        public static List<string> Install(string vault, string temp, Action<string> log, Action<string, int> status, CancellationToken cancel)
        {
            var failed = new List<string>();
            if (Off) return failed;
            foreach (Plugin p in All)
            {
                string have = VersionIn(vault, p);
                try
                {
                    if (Keeps(vault, p, have)) log(p.Name + " " + have + " is already in this vault: left as it is.");
                    else
                    {
                        cancel.ThrowIfCancellationRequested();
                        // Every file is downloaded and checked in a folder of its own before any is put in the vault.
                        string staging = Path.Combine(temp, "diagram-" + p.Id);
                        Directory.CreateDirectory(staging);
                        for (int i = 0; i < p.Files.Length; i++)
                        {
                            int k = i;
                            if (status != null) status("Downloading " + p.Name + " …", 100 * k / p.Files.Length);
                            Installer.Download(p.Files[i], Path.Combine(staging, p.Files[i].File),
                                               (d, t) => { if (status != null) status("Downloading " + p.Name + " …", (int)(100.0 * (k + (t > 0 ? (double)d / t : 0)) / p.Files.Length)); }, cancel);
                        }
                        string folder = Folder(vault, p);
                        Directory.CreateDirectory(folder);
                        // (its settings, data.json, are never touched; the manifest goes last, so that a copy that is
                        // only half there still counts as missing the next time)
                        foreach (Pinned f in p.Files.OrderBy(f => f.File == "manifest.json" ? 1 : 0))
                        {
                            string target = Path.Combine(folder, f.File), part = target + ".scriptorium-tmp";
                            File.Copy(Path.Combine(staging, f.File), part, true);
                            if (File.Exists(target)) File.Delete(target);
                            File.Move(part, target);
                        }
                        log(have != null ? "Updated " + p.Name + " from " + have + " to " + p.Version + " (from its own release on GitHub)"
                                         : "Installed " + p.Name + " " + p.Version + " (from its own release on GitHub)");
                        // Only a plugin installed new is turned on and given its first settings: one that was there
                        // and is not in the list was turned off by the user, and stays off.
                        if (have == null)
                        {
                            string settings = FirstSettings(p), data = Path.Combine(folder, "data.json");
                            if (settings != null && !File.Exists(data)) File.WriteAllBytes(data, new UTF8Encoding(false).GetBytes(settings));
                            TurnOn(vault, p, log);
                        }
                    }
                }
                catch (Exception e)
                {
                    failed.Add(p.Name);
                    try { foreach (Pinned f in p.Files) File.Delete(Path.Combine(Folder(vault, p), f.File + ".scriptorium-tmp")); } catch { }
                    string why = e is OperationCanceledException ? "stopped" : e.Message;
                    log(have != null
                        ? p.Name + " was NOT updated: it stays at " + have + " (" + why + "). To update it: in Obsidian, Settings > Community plugins > Check for updates."
                        : p.Name + " was NOT installed (" + why + "). Scriptorium itself is in place. To add it: in Obsidian, Settings > Community plugins > Browse, search for \"" + p.Name + "\", Install, then Enable.");
                }
            }
            return failed;
        }

        // The data.json written with a plugin that is installed new, where it has none; null for most. Excalidraw opens a
        // "Welcome to Excalidraw" window the first time it runs, while its previousRelease is older than the plugin
        // (src/core/main.ts in its source), and sets previousRelease to its own version when that window is closed
        // (src/shared/Dialogs/ReleaseNotes.ts): writing that one setting keeps the window shut. Excalidraw fills in the
        // rest with its defaults, and still shows its release notes after a later update (showReleaseNotes is left alone).
        static string FirstSettings(Plugin p)
        {
            return p.Id == "obsidian-excalidraw-plugin" ? "{\n  \"previousRelease\": \"" + p.Version + "\"\n}\n" : null;
        }

        // Adds the plugin to the vault's list of community plugins that are on, if it is not in it. A list that is not a
        // JSON list is left as it is.
        static void TurnOn(string vault, Plugin p, Action<string> log)
        {
            string file = Path.Combine(vault, ".obsidian", "community-plugins.json");
            var list = new List<object>();
            if (File.Exists(file))
            {
                try { list = MiniJson.Parse(File.ReadAllText(file)) as List<object>; } catch (FormatException) { list = null; }
                if (list == null)
                {
                    log("Left community-plugins.json as it was (it is not a valid JSON list): turn " + p.Name + " on in Settings > Community plugins.");
                    return;
                }
            }
            if (list.Any(x => x as string == p.Id)) return;
            list.Add(p.Id);
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            File.WriteAllBytes(file, new UTF8Encoding(false).GetBytes(MiniJson.Write(list)));
        }
    }

    // ---------- updating a vault in place ----------
    // A Scriptorium vault is updated by replacing Scriptorium's own files and keeping the user's: the snippet, the three
    // bundled plugins' code, the theme, Longform's code (if it was downloaded) and the vault's README are replaced; every
    // other file of the package is written only if it is missing (settings, data.json, the sample note); the community
    // plugin list and appearance.json are merged; nothing is ever deleted. Every file that is replaced is first copied to
    // .obsidian/scriptorium-backup-<time>/, and if anything fails half-way, the vault is put back from that copy.
    //
    // Setting up (SetUp) does the same for a folder that is not a Scriptorium vault yet: a vault the user already writes
    // in, or a folder of notes. Only .obsidian is written to: no note is touched, and the package's sample note, README,
    // workspace and graph settings are left out. Scriptorium's own files are added (or replaced, if a file of that name
    // differs); the community plugin list, appearance.json (the manuscript snippet on, the Typewriter theme) and app.json
    // (Scriptorium's text size, unless the user has chosen one) are merged; a plugin's data.json and core-plugins.json are
    // written only if missing; hotkeys and everything else are left alone. The whole .obsidian folder as it was is first
    // copied to .obsidian/scriptorium-backup-<time>/.obsidian. Run again, it changes nothing.
    // installers/Setup-Scriptorium-Vault.py follows the same rules on any system; tools/test_setup_vault.py tests both.
    static class Vaults
    {
        // Folder: an existing folder with files in it that is not a Scriptorium vault (it can be set up as one).
        // Other: not a folder at all.
        public enum Target { New, Empty, Vault, Folder, Other }

        public sealed class Report { public string From, To, Backup; public int Replaced, Added; }

        // What SetUp would do to a folder: one line per file, and the counts.
        public sealed class SetupPlan
        {
            public string Version;
            public int Adds, Replaces;
            public List<string> Lines = new List<string>();
            public string Summary(bool would)
            {
                if (Adds + Replaces == 0) return "Scriptorium is already set up here: nothing to change.";
                return (would ? "Would change: " : "Changes: ") + Count(Adds, "file") + " to add, " + Replaces + " to replace or merge.";
            }
        }

        sealed class Change
        {
            public string Rel, Note;
            public byte[] Content;
            public bool Replaces;
        }

        enum Rule { Replace, Keep, Plugins, Appearance, App, Skip }

        static readonly string[] BundledPlugins = { "scriptorium", "manuscriptum", "typewriter-mode", "lagrange" };
        static readonly string[] PluginCode = { "main.js", "manifest.json", "styles.css", "LICENSE" };

        public static Target Classify(string path)
        {
            if (File.Exists(path)) return Target.Other;
            if (!Directory.Exists(path)) return Target.New;
            if (IsScriptoriumVault(path)) return Target.Vault;
            return IsEmptyFolder(path) ? Target.Empty : Target.Folder;
        }

        public static bool IsScriptoriumVault(string dir)
        {
            return File.Exists(Path.Combine(dir, ".obsidian", "plugins", "scriptorium", "manifest.json")) ||
                   File.Exists(Path.Combine(dir, ".obsidian", "snippets", "manuscript.css"));
        }

        public static bool IsEmptyFolder(string dir) { return !Directory.EnumerateFileSystemEntries(dir).Any(); }

        // The Scriptorium plugin's version in a vault, or null if it cannot be read.
        public static string VaultVersion(string dir)
        {
            try { return VersionOf(File.ReadAllText(Path.Combine(dir, ".obsidian", "plugins", "scriptorium", "manifest.json"))); }
            catch { return null; }
        }

        static string packageVersion;

        // The Scriptorium plugin's version in this installer's package.
        public static string PackageVersion()
        {
            if (packageVersion != null) return packageVersion;
            try
            {
                using (Stream res = Assembly.GetExecutingAssembly().GetManifestResourceStream("Scriptorium.zip"))
                using (var zip = new ZipArchive(res, ZipArchiveMode.Read))
                using (var reader = new StreamReader(zip.GetEntry(".obsidian/plugins/scriptorium/manifest.json").Open()))
                    packageVersion = VersionOf(reader.ReadToEnd());
            }
            catch { }
            return packageVersion;
        }

        static string VersionOf(string manifest)
        {
            var o = MiniJson.Parse(manifest) as MiniJson.Obj;
            string v = o != null ? o.Get("version") as string : null;
            return string.IsNullOrEmpty(v) ? null : v;
        }

        public static string UpdatedMessage(string vault, Report r)
        {
            return "Updated Scriptorium in " + vault + " (" + FromTo(r) + "). Restart Obsidian or reload the vault to load it.";
        }

        // The same, shorter, for the status line (the path is in the folder box just above it).
        public static string UpdatedStatus(Report r)
        {
            return "Done. Updated Scriptorium " + FromTo(r) + ". Restart Obsidian or reload the vault to load it.";
        }

        static string FromTo(Report r) { return "from " + (r.From ?? "an unknown version") + " to " + (r.To ?? "an unknown version"); }

        public static string SetUpMessage(string vault, Report r)
        {
            if (r.Replaced + r.Added == 0) return "Scriptorium is already set up in " + vault + ": nothing was changed.";
            return "Set up Scriptorium " + (r.To ?? "") + " in " + vault + ". Open the vault in Obsidian and, when it asks, choose " +
                   "\"Trust author and enable plugins\"; if the vault was open, reload it.";
        }

        public static string SetUpStatus(Report r)
        {
            return r.Replaced + r.Added == 0 ? "Done. Scriptorium was already set up here; nothing was changed."
                                             : "Done. Scriptorium is set up in this vault; your notes were not touched.";
        }

        // setup: the rules for setting up a folder that is not a Scriptorium vault yet (see the top of this class).
        static Rule RuleFor(string rel, bool setup)
        {
            string k = rel.Replace('\\', '/');
            if (k == ".obsidian/community-plugins.json") return Rule.Plugins;
            if (k == ".obsidian/appearance.json") return Rule.Appearance;
            if (setup && k == ".obsidian/app.json") return Rule.App;
            if (k == ".obsidian/snippets/manuscript.css" || k == ".obsidian/plugins/lagrange/LagrangeHand-OFL.txt" ||
                k.StartsWith(".obsidian/themes/Typewriter/", StringComparison.Ordinal) ||
                k.StartsWith(".obsidian/plugins/scriptorium/dropcaps/", StringComparison.Ordinal)) return Rule.Replace;   // the plugin's own sets of drop caps
            if (!setup && k == "README.md") return Rule.Replace;
            foreach (string plugin in BundledPlugins)
                foreach (string file in PluginCode)
                    if (k == ".obsidian/plugins/" + plugin + "/" + file) return Rule.Replace;
            foreach (Pinned p in Installer.Longform)
                if (k == ".obsidian/plugins/longform/" + p.File) return Rule.Replace;
            if (!setup) return Rule.Keep;
            if (k == ".obsidian/core-plugins.json") return Rule.Keep;
            foreach (string plugin in BundledPlugins)
                if (k == ".obsidian/plugins/" + plugin + "/data.json") return Rule.Keep;
            return Rule.Skip;
        }

        // Updates the vault from the package (and Longform's files in longform, if not null); returns what was done.
        public static Report Update(string vault, string longform, Action<string> log)
        {
            if (log == null) log = line => { };
            if (!IsScriptoriumVault(vault)) throw new InvalidOperationException("This folder is not a Scriptorium vault: " + vault);
            var report = new Report { From = VaultVersion(vault) };
            string temp = Path.Combine(Path.GetTempPath(), "scriptorium-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temp);
            try
            {
                string staging = Installer.Stage(temp);
                report.To = VaultVersion(staging);
                var changes = new List<Change>();
                foreach (string file in Directory.GetFiles(staging, "*", SearchOption.AllDirectories).OrderBy(f => f, StringComparer.Ordinal))
                    Plan(vault, file.Substring(staging.Length + 1), File.ReadAllBytes(file), changes, log, null);
                if (longform != null)
                    foreach (Pinned p in Installer.Longform)
                        Plan(vault, Path.Combine(".obsidian", "plugins", "longform", p.File), File.ReadAllBytes(Path.Combine(longform, p.File)), changes, log, null);
                Apply(vault, changes, report, log, false);
                return report;
            }
            finally { try { Directory.Delete(temp, true); } catch { } }
        }

        // What SetUp would change in the folder; nothing is written.
        public static SetupPlan PlanSetUp(string vault)
        {
            var plan = new SetupPlan();
            string temp = Path.Combine(Path.GetTempPath(), "scriptorium-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temp);
            try
            {
                var notes = new List<string>();
                List<Change> changes = PlanSetUp(vault, Installer.Stage(temp), null, notes, out plan.Version);
                Describe(changes, notes, plan);
                plan.Lines.AddRange(DiagramPlugins.PlanLines(vault));
                return plan;
            }
            finally { try { Directory.Delete(temp, true); } catch { } }
        }

        static List<Change> PlanSetUp(string vault, string staging, string longform, List<string> notes, out string version)
        {
            version = VaultVersion(staging);
            // The plugins that will be in the vault afterwards: Scriptorium's, Longform if it comes too, and whatever is
            // installed already. Only those are turned on.
            var present = new HashSet<string>(BundledPlugins, StringComparer.Ordinal);
            if (longform != null) present.Add("longform");
            string plugins = Path.Combine(vault, ".obsidian", "plugins");
            if (Directory.Exists(plugins)) foreach (string d in Directory.GetDirectories(plugins)) present.Add(Path.GetFileName(d));
            var changes = new List<Change>();
            foreach (string file in Directory.GetFiles(staging, "*", SearchOption.AllDirectories)
                                             .OrderBy(f => f.Substring(staging.Length + 1).Replace('\\', '/'), StringComparer.Ordinal))
                Plan(vault, file.Substring(staging.Length + 1), File.ReadAllBytes(file), changes, notes.Add, present);
            if (longform != null)
                foreach (Pinned p in Installer.Longform)
                    Plan(vault, Path.Combine(".obsidian", "plugins", "longform", p.File), File.ReadAllBytes(Path.Combine(longform, p.File)), changes, notes.Add, present);
            return changes;
        }

        static void Describe(List<Change> changes, List<string> notes, SetupPlan plan)
        {
            foreach (Change c in changes)
            {
                string name = c.Rel.Replace('\\', '/');
                if (c.Replaces) plan.Replaces++; else plan.Adds++;
                plan.Lines.Add(c.Note != null ? "  merge    " + name + ": " + c.Note : (c.Replaces ? "  replace  " : "  add      ") + name);
            }
            foreach (string n in notes) plan.Lines.Add("  note     " + n);
        }

        // Sets up Scriptorium in a folder that exists (see the top of this class); returns what was done. The lines of the
        // plan go to log before anything is changed.
        public static Report SetUp(string vault, string longform, Action<string> log)
        {
            if (log == null) log = line => { };
            if (!Directory.Exists(vault)) throw new InvalidOperationException("No such folder: " + vault);
            string leaf = Path.GetFileName(vault.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            if (leaf == ".obsidian" || vault.Replace('\\', '/').Contains("/.obsidian/"))
                throw new InvalidOperationException("That is a folder inside a vault's settings, not a vault: " + vault);
            var report = new Report { From = VaultVersion(vault) };
            string temp = Path.Combine(Path.GetTempPath(), "scriptorium-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temp);
            try
            {
                var notes = new List<string>();
                var plan = new SetupPlan();
                List<Change> changes = PlanSetUp(vault, Installer.Stage(temp), longform, notes, out report.To);
                Describe(changes, notes, plan);
                log(plan.Summary(false));
                foreach (string line in plan.Lines) log(line);
                Apply(vault, changes, report, log, true);
                return report;
            }
            finally { try { Directory.Delete(temp, true); } catch { } }
        }

        // present: null when updating a Scriptorium vault; when setting up, the plugins the vault will hold.
        static void Plan(string vault, string rel, byte[] content, List<Change> changes, Action<string> log, HashSet<string> present)
        {
            bool setup = present != null;
            Rule rule = RuleFor(rel, setup);
            if (rule == Rule.Skip) return;
            string target = Path.Combine(vault, rel);
            if (rule == Rule.App)
            {
                // Obsidian keeps some of app.json's settings (the text size) in appearance.json once it has opened the
                // vault: a setting the vault has there is the vault's own, and is not set again here.
                MiniJson.Obj appearance = null, own = null;
                try { appearance = MiniJson.Parse(File.ReadAllText(Path.Combine(vault, ".obsidian", "appearance.json"))) as MiniJson.Obj; } catch { }
                try { if (File.Exists(target)) own = MiniJson.Parse(File.ReadAllText(target)) as MiniJson.Obj; } catch { }
                var ours = (MiniJson.Obj)MiniJson.Parse(Encoding.UTF8.GetString(content));
                if (appearance != null && ours.Any(kv => appearance.Has(kv.Key)))
                {
                    var rest = new MiniJson.Obj();
                    foreach (KeyValuePair<string, object> kv in ours)
                    {
                        if (!appearance.Has(kv.Key)) { rest.Add(kv); continue; }
                        string theirs = MiniJson.WriteCompact(appearance.Get(kv.Key)), mine = MiniJson.WriteCompact(kv.Value);
                        if (theirs != mine && !(own != null && own.Has(kv.Key)))
                            log("kept your " + kv.Key + " (" + theirs + "; Scriptorium's is " + mine + ")");
                    }
                    if (rest.Count == 0) return;
                    content = Utf8(MiniJson.Write(rest));
                }
            }
            if (!File.Exists(target))
            {
                if (setup && rule == Rule.Plugins)   // only the plugins that will be there (Longform is not bundled)
                    content = Utf8(MiniJson.Write(((List<object>)MiniJson.Parse(Encoding.UTF8.GetString(content))).Where(x => present.Contains(x as string ?? "")).ToList()));
                changes.Add(new Change { Rel = rel, Content = content });
                return;
            }
            if (rule == Rule.Keep) return;
            if (rule == Rule.Replace)
            {
                if (!SameBytes(target, content)) changes.Add(new Change { Rel = rel, Content = content, Replaces = true });
                return;
            }
            string note, name = Path.GetFileName(rel);
            byte[] merged = rule == Rule.Plugins ? MergePlugins(File.ReadAllText(target), content, name, out note, present)
                          : rule == Rule.Appearance ? MergeAppearance(File.ReadAllText(target), name, out note, setup)
                          : MergeApp(File.ReadAllText(target), content, name, out note);
            if (merged != null) changes.Add(new Change { Rel = rel, Content = merged, Replaces = true, Note = note });
            else if (note != null) log(note);
        }

        // The vault's list of community plugins, plus any of ours that are missing (its order kept). Null if nothing needs
        // adding, or if the file is not a JSON list (then note says it was left as it was).
        static byte[] MergePlugins(string text, byte[] ours, string name, out string note, HashSet<string> present)
        {
            note = null;
            List<object> list;
            try { list = MiniJson.Parse(text) as List<object>; }
            catch (FormatException) { list = null; }
            if (list == null) { note = "Left " + name + " as it was: it is not a valid JSON list."; return null; }
            var added = new List<string>();
            foreach (object o in (List<object>)MiniJson.Parse(Encoding.UTF8.GetString(ours)))
            {
                var id = o as string;
                if (id != null && (present == null || present.Contains(id)) && !list.Any(x => x as string == id)) { list.Add(id); added.Add(id); }
            }
            if (added.Count == 0) return null;
            note = (present == null ? "Turned on" : "turn on") + " the community plugin" + (added.Count > 1 ? "s " : " ") + string.Join(", ", added);
            return Utf8(MiniJson.Write(list));
        }

        // appearance.json as it is, with the manuscript snippet enabled. Null if it already is, or if the file is not a
        // JSON object with a list of snippets (then note says it was left as it was).
        // When setting up, the theme is set to Typewriter as well.
        static byte[] MergeAppearance(string text, string name, out string note, bool setup)
        {
            note = null;
            MiniJson.Obj appearance;
            try { appearance = MiniJson.Parse(text) as MiniJson.Obj; }
            catch (FormatException) { appearance = null; }
            if (appearance == null) { note = "Left " + name + " as it was: it is not a valid JSON object."; return null; }
            bool snippet = true;
            if (!appearance.Has("enabledCssSnippets")) appearance.Add(new KeyValuePair<string, object>("enabledCssSnippets", new List<object> { "manuscript" }));
            else
            {
                var snippets = appearance.Get("enabledCssSnippets") as List<object>;
                if (snippets == null) { note = "Left " + name + " as it was: its enabledCssSnippets is not a list."; return null; }
                if (snippets.Any(x => x as string == "manuscript")) snippet = false;
                else snippets.Add("manuscript");
            }
            if (!setup)
            {
                if (!snippet) return null;
                note = "Turned the manuscript snippet back on";
                return Utf8(MiniJson.Write(appearance));
            }
            var notes = new List<string>();
            if (snippet) notes.Add("turn on the manuscript snippet");
            string theme = appearance.Get("cssTheme") as string;
            if (theme != "Typewriter")
            {
                int at = appearance.FindIndex(kv => kv.Key == "cssTheme");
                var pair = new KeyValuePair<string, object>("cssTheme", "Typewriter");
                if (at >= 0) appearance[at] = pair; else appearance.Add(pair);
                notes.Add("change the theme from " + (string.IsNullOrEmpty(theme) ? "the default" : theme) + " to Typewriter");
            }
            if (notes.Count == 0) return null;
            note = string.Join(" and ", notes);
            return Utf8(MiniJson.Write(appearance));
        }

        // app.json with Scriptorium's settings added where the vault has none of its own. Null if nothing is added; note
        // then names any setting of the user's that differs from Scriptorium's and was kept.
        static byte[] MergeApp(string text, byte[] ours, string name, out string note)
        {
            note = null;
            MiniJson.Obj app;
            try { app = MiniJson.Parse(text) as MiniJson.Obj; }
            catch (FormatException) { app = null; }
            if (app == null) { note = "Left " + name + " as it was: it is not a valid JSON object."; return null; }
            var added = new List<string>();
            var kept = new List<string>();
            foreach (KeyValuePair<string, object> kv in (MiniJson.Obj)MiniJson.Parse(Encoding.UTF8.GetString(ours)))
            {
                string theirs = MiniJson.WriteCompact(kv.Value);
                if (!app.Has(kv.Key)) { app.Add(kv); added.Add(kv.Key + " to " + theirs); }
                else if (MiniJson.WriteCompact(app.Get(kv.Key)) != theirs)
                    kept.Add("kept your " + kv.Key + " (" + MiniJson.WriteCompact(app.Get(kv.Key)) + "; Scriptorium's is " + theirs + ")");
            }
            string keptNote = kept.Count > 0 ? string.Join("; ", kept) : null;
            if (added.Count == 0) { note = keptNote; return null; }
            note = "set " + string.Join(", ", added) + (keptNote != null ? "; " + keptNote : "");
            return Utf8(MiniJson.Write(app));
        }

        static byte[] Utf8(string s) { return new UTF8Encoding(false).GetBytes(s); }

        static bool SameBytes(string file, byte[] content)
        {
            var info = new FileInfo(file);
            return info.Length == content.Length && File.ReadAllBytes(file).SequenceEqual(content);
        }

        // Copies a folder tree, leaving out earlier backups.
        static void CopyConfig(string from, string to)
        {
            Directory.CreateDirectory(to);
            foreach (string f in Directory.GetFiles(from)) File.Copy(f, Path.Combine(to, Path.GetFileName(f)));
            foreach (string d in Directory.GetDirectories(from))
                if (!Path.GetFileName(d).StartsWith("scriptorium-backup-", StringComparison.Ordinal)) CopyConfig(d, Path.Combine(to, Path.GetFileName(d)));
        }

        // setup: the whole .obsidian folder is backed up (not only the files replaced), and the plan has been logged.
        static void Apply(string vault, List<Change> changes, Report report, Action<string> log, bool setup)
        {
            List<Change> replacing = changes.Where(c => c.Replaces).ToList();
            string backup = null;
            string config = Path.Combine(vault, ".obsidian");
            if (setup && changes.Count > 0 && Directory.Exists(config) && Directory.EnumerateFileSystemEntries(config).Any())
            {
                string stamp = "scriptorium-backup-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
                backup = Path.Combine(config, stamp);
                for (int n = 2; Directory.Exists(backup) || File.Exists(backup); n++) backup = Path.Combine(config, stamp + "-" + n);
                try { CopyConfig(config, Path.Combine(backup, ".obsidian")); }
                catch (Exception e)
                {
                    DeleteEntry(backup);
                    throw new InvalidOperationException("The vault's .obsidian folder could not be backed up, so nothing was changed: " + e.Message, e);
                }
                report.Backup = backup;
                log("Backed up .obsidian as it was in " + backup);
            }
            else if (!setup && replacing.Count > 0)
            {
                string stamp = "scriptorium-backup-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
                backup = Path.Combine(vault, ".obsidian", stamp);
                for (int n = 2; Directory.Exists(backup) || File.Exists(backup); n++) backup = Path.Combine(vault, ".obsidian", stamp + "-" + n);
                try
                {
                    foreach (Change c in replacing)
                    {
                        string copy = Path.Combine(backup, c.Rel);
                        Directory.CreateDirectory(Path.GetDirectoryName(copy));
                        File.Copy(Path.Combine(vault, c.Rel), copy);
                    }
                }
                catch (Exception e)
                {
                    DeleteEntry(backup);
                    throw new InvalidOperationException("The vault's files could not be backed up, so nothing was changed: " + e.Message, e);
                }
                report.Backup = backup;
                log("Backed up " + Count(replacing.Count, "file") + " in " + backup);
            }

            var written = new List<Change>();
            var made = new List<string>();
            Change current = null;
            try
            {
                foreach (Change c in changes)
                {
                    current = c;
                    string target = Path.Combine(vault, c.Rel);
                    MakeFolders(Path.GetDirectoryName(target), made);
                    File.WriteAllBytes(target, c.Content);
                    written.Add(c);
                }
            }
            catch (Exception e)
            {
                // Put every file back as it was: replaced files from the backup, new files removed, new folders removed.
                bool restored = true;
                if (current != null && !written.Contains(current)) written.Add(current);
                for (int i = written.Count - 1; i >= 0; i--)
                {
                    Change c = written[i];
                    string target = Path.Combine(vault, c.Rel);
                    try
                    {
                        if (!c.Replaces) { if (File.Exists(target)) File.Delete(target); }
                        else
                        {
                            string copy = Path.Combine(backup, c.Rel);
                            if (!File.Exists(target) || !SameBytes(target, File.ReadAllBytes(copy))) File.Copy(copy, target, true);
                        }
                    }
                    catch { restored = false; }
                }
                for (int i = made.Count - 1; i >= 0; i--) { try { Directory.Delete(made[i]); } catch { } }
                if (restored && backup != null) DeleteEntry(backup);
                string what = setup ? "setup" : "update";
                log(restored ? "The " + what + " failed, so every file was put back as it was."
                             : "The " + what + " failed, and some files could not be put back; the originals are in " + backup);
                throw new InvalidOperationException("The " + what + " failed" + (restored ? " and was undone: " : ": ") + e.Message, e);
            }

            report.Replaced = replacing.Count;
            report.Added = changes.Count - replacing.Count;
            if (setup)
            {
                if (report.Added > 0) log("Added " + Count(report.Added, "file"));
                if (report.Replaced > 0) log("Replaced or merged " + Count(report.Replaced, "file"));
                log(changes.Count == 0 ? "Scriptorium is already set up here" : "Your notes were not touched");
                return;
            }
            foreach (Change c in changes) if (c.Note != null) log(c.Note);
            if (report.Replaced > 0) log("Replaced " + Count(report.Replaced, "file"));
            if (report.Added > 0) log("Added " + Count(report.Added, "missing file"));
            if (changes.Count == 0) log("Scriptorium's files were already up to date");
            log("Kept your notes and settings");
        }

        static string Count(int n, string noun) { return n + " " + noun + (n == 1 ? "" : "s"); }

        // Creates a folder and any missing parents, remembering each one it made (outermost first).
        static void MakeFolders(string dir, List<string> made)
        {
            var missing = new Stack<string>();
            for (string d = dir; !string.IsNullOrEmpty(d) && !Directory.Exists(d); d = Path.GetDirectoryName(d)) missing.Push(d);
            while (missing.Count > 0) { string d = missing.Pop(); Directory.CreateDirectory(d); made.Add(d); }
        }

        // Deletes a file or a folder tree, read-only files included; never throws.
        public static void DeleteEntry(string path)
        {
            try
            {
                if (File.Exists(path)) { File.SetAttributes(path, FileAttributes.Normal); File.Delete(path); return; }
                if (!Directory.Exists(path)) return;
                foreach (string f in Directory.GetFiles(path, "*", SearchOption.AllDirectories)) File.SetAttributes(f, FileAttributes.Normal);
                Directory.Delete(path, true);
            }
            catch { }
        }
    }

    // ---------- opening a new vault in Obsidian, with its plugins on ----------
    // The first time Obsidian opens a vault that comes with community plugins, it asks whether to trust the vault's author,
    // and keeps the answer in its own browser storage (localStorage "enable-plugin-<vault id>"), which nothing outside
    // Obsidian should write. Obsidian 1.12 and later has a command line interface that gives the same answer:
    // "plugins:restrict off" does what the question's "Trust author and enable plugins" button does, then reloads the vault
    // with its plugins on. The interface answers only while "cli": true is in Obsidian's obsidian.json, which Obsidian
    // reads when it starts and rewrites while it runs. So, with Obsidian closed, setup adds the vault to the vault list in
    // obsidian.json (keeping every other key and vault) and turns the interface on; starts Obsidian on the vault; sends
    // "plugins:restrict off" through Obsidian's pipe until Obsidian answers; and turns the interface off again through
    // Obsidian itself, unless it was already on. If anything fails, Obsidian asks its usual question, and the interface is
    // still turned off: through Obsidian if it answers, otherwise in obsidian.json once Obsidian has closed.
    static class AutoOpen
    {
        public enum Result { Trusted, Opened, NotOpened }

        public sealed class Outcome
        {
            public Result Result;
            public string Problem;     // why the plugins were not turned on (or the vault not opened), for the log
            public bool CliLeftOn;     // the interface was on before setup, so it was left on
            public bool CliPending;    // setup turned the interface on and could not turn it off yet (Settle will)
        }

        // What Register did to obsidian.json.
        public sealed class Registration
        {
            public string Id;          // the vault's id in the list (the CLI's vault=<id>, and Obsidian's storage keys)
            public bool Listed;        // the folder was in the list already
            public bool HadCli;        // obsidian.json had a "cli" key,
            public object PriorCli;    // with this value
            public bool CliWasOn;      // the interface was on already: it is left alone
            public bool CliTurnedOn;   // Register turned it on, so it must be turned off again
            public string Text;        // obsidian.json's new content
            public bool Changed { get { return !Listed || CliTurnedOn; } }
        }

        // The answer that turns the interface off: Obsidian's own setting switch ("cli" over its ipc), which also updates
        // obsidian.json. Obsidian answers "=> false" (the interface's new state).
        const string CliOff = "code=require('electron').ipcRenderer.sendSync('cli',false)";
        static readonly object gate = new object();
        static Registration pending;   // setup turned the interface on, and it is not off again yet
        static string pendingFile;
        public static Action<string> Trace;   // each command and Obsidian's answer (the headless mode prints them)

        // Obsidian's settings folder: %APPDATA%\obsidian. (Elsewhere, where only the tests run this, $XDG_CONFIG_HOME/obsidian.)
        public static string ConfigDir()
        {
            if (Installer.IsWindows) return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "obsidian");
            string xdg = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME");
            return Path.Combine(string.IsNullOrEmpty(xdg) ? Path.Combine(Environment.GetEnvironmentVariable("HOME") ?? "/", ".config") : xdg, "obsidian");
        }

        public static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }

        // A new vault id the way Obsidian makes them: 16 hexadecimal digits.
        public static string NewId()
        {
            var bytes = new byte[8];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            return string.Concat(bytes.Select(b => b.ToString("x2")));
        }

        // A folder's path as Obsidian keeps it (Node's path.resolve: absolute, no trailing separator).
        public static string VaultPath(string folder)
        {
            string p = Path.GetFullPath(folder), root = Path.GetPathRoot(p) ?? "";
            while (p.Length > root.Length && (p[p.Length - 1] == Path.DirectorySeparatorChar || p[p.Length - 1] == Path.AltDirectorySeparatorChar))
                p = p.Substring(0, p.Length - 1);
            return p;
        }

        static bool SamePath(string listed, string path)
        {
            try { return string.Equals(VaultPath(listed), path, Installer.IsWindows ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal); }
            catch { return false; }
        }

        // How Obsidian reads "cli": JavaScript truthiness.
        static bool Truthy(object v)
        {
            if (v == null) return false;
            if (v is bool) return (bool)v;
            if (v is string) return ((string)v).Length > 0;
            var n = v as MiniJson.Num;
            double d;
            if (n != null) return !double.TryParse(n.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out d) || d != 0;
            return true;
        }

        static KeyValuePair<string, object> Pair(string key, object value) { return new KeyValuePair<string, object>(key, value); }
        static int IndexOf(MiniJson.Obj o, string key) { for (int k = 0; k < o.Count; k++) if (o[k].Key == key) return k; return -1; }

        // Adds the vault to obsidian.json's vault list (or finds it there) and, with turnOnCli, turns the command line
        // interface on. text is the file's content (null if there is none); every other key and vault is kept as it was.
        // Throws FormatException if the file is not a JSON object with an object for its vault list; it is then left alone.
        public static Registration Register(string text, string vault, long now, bool turnOnCli, Func<string> newId)
        {
            var conf = (string.IsNullOrWhiteSpace(text) ? new MiniJson.Obj() : MiniJson.Parse(text)) as MiniJson.Obj;
            if (conf == null) throw new FormatException("obsidian.json is not a JSON object");
            var r = new Registration();
            string path = VaultPath(vault);
            int at = IndexOf(conf, "vaults");
            MiniJson.Obj vaults;
            if (at < 0) conf.Insert(0, Pair("vaults", vaults = new MiniJson.Obj()));
            else if ((vaults = conf[at].Value as MiniJson.Obj) == null) throw new FormatException("the vault list in obsidian.json is not a JSON object");
            foreach (var kv in vaults)
            {
                var entry = kv.Value as MiniJson.Obj;
                string listed = entry != null ? entry.Get("path") as string : null;
                if (listed != null && SamePath(listed, path)) { r.Id = kv.Key; r.Listed = true; break; }
            }
            if (!r.Listed)
            {
                do r.Id = newId(); while (vaults.Has(r.Id));
                vaults.Add(Pair(r.Id, new MiniJson.Obj { Pair("path", path), Pair("ts", new MiniJson.Num(now.ToString(CultureInfo.InvariantCulture))) }));
            }
            at = IndexOf(conf, "cli");
            r.HadCli = at >= 0;
            r.PriorCli = r.HadCli ? conf[at].Value : null;
            r.CliWasOn = Truthy(r.PriorCli);
            if (turnOnCli && !r.CliWasOn)
            {
                if (r.HadCli) conf[at] = Pair("cli", true); else conf.Add(Pair("cli", true));
                r.CliTurnedOn = true;
            }
            r.Text = MiniJson.WriteCompact(conf);
            return r;
        }

        // obsidian.json with "cli" put back as it was before Register turned it on, for when Obsidian is closed; null if
        // there is nothing to put back ("cli" is no longer true).
        public static string RestoreCli(string text, Registration r)
        {
            var conf = MiniJson.Parse(text) as MiniJson.Obj;
            int at = conf != null ? IndexOf(conf, "cli") : -1;
            if (at < 0 || !(conf[at].Value is bool) || !(bool)conf[at].Value) return null;
            if (r.HadCli) conf[at] = Pair("cli", r.PriorCli); else conf.RemoveAt(at);
            return MiniJson.WriteCompact(conf);
        }

        // Written next to the file first, then moved over it, so the file is never half-written.
        public static void WriteFile(string file, string text)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            string temp = file + ".scriptorium-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            File.WriteAllText(temp, text, new UTF8Encoding(false));
            try { if (File.Exists(file)) File.Replace(temp, file, null); else File.Move(temp, file); }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }

        // Is Obsidian running for this user? (Its processes are all Obsidian.exe; elsewhere, for the tests, obsidian.)
        public static bool ObsidianRunning()
        {
            int session = -1;
            try { session = Process.GetCurrentProcess().SessionId; } catch { }
            foreach (Process p in Process.GetProcessesByName(Installer.IsWindows ? "Obsidian" : "obsidian"))
                using (p)
                {
                    try { if (!Installer.IsWindows || session < 0 || p.SessionId == session) return true; }
                    catch { return true; }
                }
            return false;
        }

        // Obsidian 1.12 and later have the command line interface. Obsidian updates itself by downloading newer app
        // packages (obsidian-<version>.asar) into its settings folder and runs the newest, so the version that runs is the
        // newer of Obsidian.exe's and those. (Elsewhere, for the tests: its CLI client ships next to it from 1.12 on.)
        public static bool HasCli(string exe, string configDir)
        {
            var since = new Version(1, 12, 0);
            Version best = null;
            try
            {
                if (!Installer.IsWindows) return File.Exists(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(exe)), "obsidian-cli"));
                FileVersionInfo info = FileVersionInfo.GetVersionInfo(exe);
                best = new Version(info.FileMajorPart, info.FileMinorPart, info.FileBuildPart);
            }
            catch { }
            try
            {
                foreach (string f in Directory.GetFiles(configDir, "obsidian-*.asar"))
                {
                    Match m = Regex.Match(Path.GetFileName(f), @"^obsidian-(\d+)\.(\d+)\.(\d+)\.asar$");
                    if (!m.Success) continue;
                    var v = new Version(int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), int.Parse(m.Groups[3].Value));
                    if (best == null || v > best) best = v;
                }
            }
            catch { }
            return best != null && best >= since;
        }

        // ---------- talking to Obsidian's command line interface ----------
        // What Obsidian's own client (Obsidian.com) sends: one line of JSON with the arguments, then it reads Obsidian's
        // answer until Obsidian closes the connection.
        public static string Request(string[] argv, string cwd)
        {
            var b = new StringBuilder("{\"argv\":[");
            for (int k = 0; k < argv.Length; k++) { if (k > 0) b.Append(','); MiniJson.Quote(b, argv[k]); }
            b.Append("],\"tty\":false,\"cwd\":");
            MiniJson.Quote(b, cwd);
            return b.Append("}\n").ToString();
        }

        // Sends one command; returns Obsidian's answer, or null if Obsidian's CLI could not be reached or did not answer
        // within timeoutMs. The working directory sent is a drive's root, so that no vault is chosen by it.
        public static string Send(string[] argv, int timeoutMs)
        {
            if (timeoutMs <= 0) return null;
            var clock = Stopwatch.StartNew();
            Stream s = null;
            try
            {
                s = Connect(Math.Min(timeoutMs, 2000));
                if (s == null) return null;
                byte[] head = Encoding.UTF8.GetBytes(Request(argv, Path.GetPathRoot(Path.GetTempPath())));
                s.Write(head, 0, head.Length);
                s.Flush();
                var answer = new MemoryStream();
                var buffer = new byte[8192];
                while (true)
                {
                    int left = timeoutMs - (int)clock.ElapsedMilliseconds;
                    if (left <= 0) return null;
                    var read = s.ReadAsync(buffer, 0, buffer.Length);
                    if (!read.Wait(left)) return null;
                    if (read.Result == 0) break;
                    answer.Write(buffer, 0, read.Result);
                }
                string text = Encoding.UTF8.GetString(answer.ToArray()).Trim();
                if (Trace != null) Trace("obsidian " + string.Join(" ", argv) + "  ->  " + text);
                return text;
            }
            catch { return null; }
            finally { if (s != null) s.Dispose(); }
        }

        // Obsidian listens on the pipe \\.\pipe\obsidian-cli-<user name>. (Elsewhere, where only the tests run this, on the
        // Unix socket $XDG_RUNTIME_DIR/.obsidian-cli.sock, or ~/.obsidian-cli.sock.)
        static Stream Connect(int timeoutMs)
        {
            if (Installer.IsWindows)
            {
                var pipe = new NamedPipeClientStream(".", "obsidian-cli-" + Environment.UserName, PipeDirection.InOut);
                try { pipe.Connect(timeoutMs); return pipe; }
                catch { pipe.Dispose(); return null; }
            }
            string dir = Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR");
            if (string.IsNullOrEmpty(dir)) dir = Environment.GetEnvironmentVariable("HOME") ?? "/";
            var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            try { socket.Connect(new UnixEndPoint(Path.Combine(dir, ".obsidian-cli.sock"))); return new NetworkStream(socket, true); }
            catch { socket.Dispose(); return null; }
        }

        sealed class UnixEndPoint : EndPoint
        {
            readonly string path;
            public UnixEndPoint(string path) { this.path = path; }
            public override AddressFamily AddressFamily { get { return AddressFamily.Unix; } }
            public override SocketAddress Serialize()
            {
                byte[] bytes = Encoding.UTF8.GetBytes(path);
                var sa = new SocketAddress(AddressFamily.Unix, 2 + bytes.Length + 1);
                for (int k = 0; k < bytes.Length; k++) sa[2 + k] = bytes[k];
                return sa;
            }
            public override EndPoint Create(SocketAddress sa) { return this; }
        }

        static bool Launch(string exe, string vault)
        {
            try
            {
                using (Process.Start(new ProcessStartInfo(exe, "\"" + (vault.EndsWith("\\") ? vault + "\\" : vault) + "\"") { UseShellExecute = false })) { }
                return true;
            }
            catch { return false; }
        }

        // Opens the new vault in Obsidian (which must be closed: see ObsidianRunning) and turns its community plugins on.
        // Never throws: the outcome says what happened. Gives Obsidian timeoutMs to start and answer.
        public static Outcome Open(string exe, string vault, int timeoutMs, CancellationToken cancel)
        {
            var o = new Outcome { Result = Result.NotOpened };
            string dir = ConfigDir(), file = Path.Combine(dir, "obsidian.json");
            bool cli = HasCli(exe, dir);
            Registration r;
            try
            {
                r = Register(File.Exists(file) ? File.ReadAllText(file, Encoding.UTF8) : null, vault, Now(), cli, NewId);
                if (r.CliTurnedOn) lock (gate) { pending = r; pendingFile = file; }
                if (r.Changed) WriteFile(file, r.Text);
            }
            catch (Exception e)
            {
                lock (gate) pending = null;
                o.Problem = "Obsidian's vault list could not be updated (" + e.Message + ")";
                return o;
            }
            o.CliLeftOn = r.CliWasOn;
            if (!Launch(exe, VaultPath(vault)))
            {
                Settle(false);
                o.Problem = "Obsidian could not be started";
                return o;
            }
            o.Result = Result.Opened;
            if (!cli) { o.Problem = "this Obsidian is older than 1.12 and has no command line interface"; return o; }

            string target = "vault=" + r.Id;
            bool asked = false, trusted = false;
            var clock = Stopwatch.StartNew();
            while (!asked && o.Problem == null && clock.ElapsedMilliseconds < timeoutMs && !cancel.IsCancellationRequested)
            {
                // Until Obsidian is up there is no pipe; then Obsidian answers once the vault has loaded.
                string answer = Send(new[] { target, "plugins:restrict", "off" }, timeoutMs - (int)clock.ElapsedMilliseconds);
                if (answer == null) { Thread.Sleep(500); continue; }
                if (answer.StartsWith("Restricted mode disabled", StringComparison.Ordinal) ||
                    answer.StartsWith("Restricted mode is already disabled", StringComparison.Ordinal)) asked = true;
                else if (answer.StartsWith("Command line interface is not enabled", StringComparison.Ordinal) ||
                         answer.StartsWith("Vault not found", StringComparison.Ordinal)) o.Problem = "Obsidian answered \"" + answer + "\"";
                else Thread.Sleep(500);
            }
            // Obsidian reloads the vault after answering; the next answer comes from the reloaded vault.
            clock.Restart();
            while (asked && !trusted && clock.ElapsedMilliseconds < 60000 && !cancel.IsCancellationRequested)
            {
                if (Send(new[] { target, "plugins:restrict" }, 60000 - (int)clock.ElapsedMilliseconds) == "off") trusted = true;
                else Thread.Sleep(500);
            }
            if (trusted) o.Result = Result.Trusted;
            else if (o.Problem == null)
                o.Problem = cancel.IsCancellationRequested ? "setup was stopped" : asked ? "Obsidian did not confirm that the plugins are on" : "Obsidian did not answer in time";
            o.CliPending = !Settle(false);
            return o;
        }

        // Turns the command line interface off again if setup turned it on: through Obsidian (any open vault; none is
        // opened for it) or, if Obsidian has closed, in obsidian.json. With wait, waits for Obsidian to close if it does not
        // answer; without, gives up for now. True when nothing is left to do.
        public static bool Settle(bool wait)
        {
            Registration r;
            string file;
            lock (gate) { r = pending; file = pendingFile; }
            if (r == null) return true;
            // Right after a reload Obsidian may not know every command yet ("Command "eval" not found"): ask again.
            for (int k = 0; k < 10 && ObsidianRunning(); k++)
            {
                string answer = Send(new[] { "eval", CliOff }, 15000);
                if (answer == "=> false" || (answer != null && answer.StartsWith("Command line interface is not enabled", StringComparison.Ordinal)))
                { Done(r); return true; }
                Thread.Sleep(1000);
            }
            while (ObsidianRunning())
            {
                if (!wait) return false;
                Thread.Sleep(3000);
            }
            try
            {
                string text = RestoreCli(File.ReadAllText(file, Encoding.UTF8), r);
                if (text != null) WriteFile(file, text);
            }
            catch { }
            Done(r);
            return true;
        }

        static void Done(Registration r) { lock (gate) if (pending == r) pending = null; }
    }

    // Just enough JSON for Obsidian's settings files: parses to MiniJson.Obj (keys in order), List<object>, string,
    // MiniJson.Num (the number's text, unchanged), bool and null; writes the way Obsidian does: a vault's settings with
    // JSON.stringify(value, null, 2) (Write), its own obsidian.json with plain JSON.stringify (WriteCompact).
    static class MiniJson
    {
        public sealed class Obj : List<KeyValuePair<string, object>>
        {
            public bool Has(string key) { return this.Any(kv => kv.Key == key); }
            public object Get(string key) { foreach (var kv in this) if (kv.Key == key) return kv.Value; return null; }
        }

        public sealed class Num { public readonly string Text; public Num(string text) { Text = text; } }

        public static object Parse(string text)
        {
            var p = new Parser(text.Length > 0 && text[0] == '﻿' ? text.Substring(1) : text);
            object value = p.Value();
            p.Space();
            if (!p.AtEnd) throw new FormatException("Unexpected text after the JSON value");
            return value;
        }

        sealed class Parser
        {
            readonly string s;
            int i;
            public Parser(string s) { this.s = s; }
            public bool AtEnd { get { return i >= s.Length; } }

            public void Space() { while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++; }

            char Peek() { if (i >= s.Length) throw new FormatException("Unexpected end of JSON"); return s[i]; }

            void Expect(char c) { if (Peek() != c) throw new FormatException("Expected '" + c + "' at " + i); i++; }

            public object Value()
            {
                Space();
                char c = Peek();
                if (c == '{') return Object();
                if (c == '[') return Array();
                if (c == '"') return String();
                if (Word("true")) return true;
                if (Word("false")) return false;
                if (Word("null")) return null;
                return Number();
            }

            bool Word(string w)
            {
                if (string.CompareOrdinal(s, i, w, 0, w.Length) != 0) return false;
                i += w.Length;
                return true;
            }

            Obj Object()
            {
                var o = new Obj();
                Expect('{'); Space();
                if (Peek() == '}') { i++; return o; }
                while (true)
                {
                    Space();
                    string key = String();
                    Space(); Expect(':');
                    o.Add(new KeyValuePair<string, object>(key, Value()));
                    Space();
                    if (Peek() == ',') { i++; continue; }
                    Expect('}');
                    return o;
                }
            }

            List<object> Array()
            {
                var a = new List<object>();
                Expect('['); Space();
                if (Peek() == ']') { i++; return a; }
                while (true)
                {
                    a.Add(Value());
                    Space();
                    if (Peek() == ',') { i++; continue; }
                    Expect(']');
                    return a;
                }
            }

            string String()
            {
                Expect('"');
                var b = new StringBuilder();
                while (true)
                {
                    char c = Peek(); i++;
                    if (c == '"') return b.ToString();
                    if (c < ' ') throw new FormatException("Control character in a string");
                    if (c != '\\') { b.Append(c); continue; }
                    char e = Peek(); i++;
                    switch (e)
                    {
                        case '"': b.Append('"'); break;
                        case '\\': b.Append('\\'); break;
                        case '/': b.Append('/'); break;
                        case 'b': b.Append('\b'); break;
                        case 'f': b.Append('\f'); break;
                        case 'n': b.Append('\n'); break;
                        case 'r': b.Append('\r'); break;
                        case 't': b.Append('\t'); break;
                        case 'u':
                            if (i + 4 > s.Length) throw new FormatException("Bad \\u escape");
                            b.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                            i += 4;
                            break;
                        default: throw new FormatException("Bad escape \\" + e);
                    }
                }
            }

            Num Number()
            {
                int start = i;
                if (i < s.Length && s[i] == '-') i++;
                int digits = Digits();
                if (digits == 0 || (digits > 1 && s[start + (s[start] == '-' ? 1 : 0)] == '0')) throw new FormatException("Bad number at " + start);
                if (i < s.Length && s[i] == '.') { i++; if (Digits() == 0) throw new FormatException("Bad number at " + start); }
                if (i < s.Length && (s[i] == 'e' || s[i] == 'E'))
                {
                    i++;
                    if (i < s.Length && (s[i] == '+' || s[i] == '-')) i++;
                    if (Digits() == 0) throw new FormatException("Bad number at " + start);
                }
                return new Num(s.Substring(start, i - start));
            }

            int Digits() { int n = 0; while (i < s.Length && s[i] >= '0' && s[i] <= '9') { i++; n++; } return n; }
        }

        public static string Write(object value)
        {
            var b = new StringBuilder();
            Write(b, value, "");
            return b.ToString();
        }

        public static string WriteCompact(object value)
        {
            var b = new StringBuilder();
            Write(b, value, null);
            return b.ToString();
        }

        // indent null: no whitespace at all.
        static void Write(StringBuilder b, object v, string indent)
        {
            string inner = indent != null ? indent + "  " : null, open = indent != null ? "\n" : "", colon = indent != null ? ": " : ":";
            var o = v as Obj;
            var a = v as List<object>;
            if (o != null)
            {
                if (o.Count == 0) { b.Append("{}"); return; }
                b.Append('{').Append(open);
                for (int k = 0; k < o.Count; k++)
                {
                    b.Append(inner); Quote(b, o[k].Key); b.Append(colon);
                    Write(b, o[k].Value, inner);
                    b.Append(k < o.Count - 1 ? "," : "").Append(open);
                }
                b.Append(indent).Append('}');
            }
            else if (a != null)
            {
                if (a.Count == 0) { b.Append("[]"); return; }
                b.Append('[').Append(open);
                for (int k = 0; k < a.Count; k++)
                {
                    b.Append(inner); Write(b, a[k], inner);
                    b.Append(k < a.Count - 1 ? "," : "").Append(open);
                }
                b.Append(indent).Append(']');
            }
            else if (v is string) Quote(b, (string)v);
            else if (v is Num) b.Append(((Num)v).Text);
            else if (v is bool) b.Append((bool)v ? "true" : "false");
            else b.Append("null");
        }

        internal static void Quote(StringBuilder b, string s)
        {
            b.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': b.Append("\\\""); break;
                    case '\\': b.Append("\\\\"); break;
                    case '\b': b.Append("\\b"); break;
                    case '\f': b.Append("\\f"); break;
                    case '\n': b.Append("\\n"); break;
                    case '\r': b.Append("\\r"); break;
                    case '\t': b.Append("\\t"); break;
                    default:
                        if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else b.Append(c);
                        break;
                }
            }
            b.Append('"');
        }
    }

    // ---------- the look: ink on paper ----------
    // Colours are the Scriptorium site's: warm paper, soft ink, grey for quiet text, oxblood rubric for the title.
    // Everything is measured in 96-dpi pixels and multiplied by S, the display's scale, so it stays crisp at any DPI.
    static class Ink
    {
        public static readonly Color Paper = Color.FromArgb(0xF7, 0xF2, 0xE7), Black = Color.FromArgb(0x2A, 0x24, 0x20),
                                     Muted = Color.FromArgb(0x59, 0x59, 0x59), Faint = Color.FromArgb(0x9E, 0x9E, 0x9E),
                                     Red = Color.FromArgb(0x8B, 0x23, 0x23), Pencil = Color.FromArgb(0x6E, 0x69, 0x63),
                                     Edge = Color.FromArgb(0xCF, 0xC6, 0xB4);
        public static float S = 1f;              // device pixels per 96-dpi pixel
        public const float Faded = 0.42f;        // how strongly a disabled control is inked

        public static int R(float logical) { return (int)Math.Round(logical * S); }
        public static Color A(Color c, float alpha) { return Color.FromArgb((int)Math.Round(255 * Math.Max(0f, Math.Min(1f, alpha))), c.R, c.G, c.B); }

        public static void Prepare(Graphics g)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.CompositingQuality = CompositingQuality.HighQuality;
            g.TextRenderingHint = TextRenderingHint.AntiAlias;
        }

        // A stable seed from a name, so each control's hand-drawn wobble is the same on every repaint.
        public static uint Seed(string name)
        {
            uint h = 2166136261;
            foreach (char c in name) { h ^= c; h *= 16777619; }
            return h;
        }

        public static PointF[] Bezier(PointF a, PointF b, PointF c, PointF d, int n)
        {
            var p = new PointF[n + 1];
            for (int i = 0; i <= n; i++)
            {
                float t = (float)i / n, u = 1 - t;
                float k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
                p[i] = new PointF(k0 * a.X + k1 * b.X + k2 * c.X + k3 * d.X, k0 * a.Y + k1 * b.Y + k2 * c.Y + k3 * d.Y);
            }
            return p;
        }

        // A pen stroke along a centreline, filled as one shape: the width swells and thins a little with the pen's
        // pressure (a function of the distance along the stroke, so a growing stroke keeps its shape) and tapers over the
        // first taperIn and last taperOut pixels.
        public static void Stroke(Graphics g, PointF[] p, float width, Color color, uint seed, float taperIn, float taperOut)
        {
            int n = p.Length;
            if (n < 2) return;
            var rng = new Rng(seed);
            float phase = rng.Range(0f, 6.283f), wave = rng.Range(26f, 44f) * S;
            var dist = new float[n];
            for (int i = 1; i < n; i++) dist[i] = dist[i - 1] + Distance(p[i - 1], p[i]);
            float total = dist[n - 1];
            if (total < 0.5f) return;
            var shape = new PointF[2 * n];
            for (int i = 0; i < n; i++)
            {
                PointF a = p[Math.Max(i - 1, 0)], b = p[Math.Min(i + 1, n - 1)];
                float dx = b.X - a.X, dy = b.Y - a.Y, d = (float)Math.Sqrt(dx * dx + dy * dy);
                if (d < 1e-4f) { dx = 1; dy = 0; d = 1; }
                float nx = -dy / d, ny = dx / d;
                float tin = taperIn > 0 ? Math.Min(1f, dist[i] / taperIn) : 1f, tout = taperOut > 0 ? Math.Min(1f, (total - dist[i]) / taperOut) : 1f;
                float w = width * (0.42f + 0.58f * (float)Math.Sqrt(Math.Min(tin, tout)))
                          * (1f + 0.16f * (float)Math.Sin(phase + dist[i] / wave) + 0.07f * (float)Math.Sin(2.3f * phase + dist[i] / (wave * 0.29f)));
                shape[i] = new PointF(p[i].X + nx * w / 2, p[i].Y + ny * w / 2);
                shape[2 * n - 1 - i] = new PointF(p[i].X - nx * w / 2, p[i].Y - ny * w / 2);
            }
            using (var brush = new SolidBrush(color)) g.FillPolygon(brush, shape, FillMode.Winding);
        }

        static float Distance(PointF a, PointF b) { float dx = b.X - a.X, dy = b.Y - a.Y; return (float)Math.Sqrt(dx * dx + dy * dy); }

        // A hand-ruled line from x0 to x1 near y: a slow, slightly uneven drift, the same every time for a given seed.
        public static PointF[] Ruled(float x0, float x1, float y, float amplitude, uint seed)
        {
            var rng = new Rng(seed);
            float p1 = rng.Range(0f, 6.283f), p2 = rng.Range(0f, 6.283f), l1 = rng.Range(48f, 80f) * S, l2 = rng.Range(15f, 26f) * S;
            float tilt = rng.Range(-0.5f, 0.5f) * S;
            int n = Math.Max(2, (int)((x1 - x0) / (2 * S)) + 1);
            var p = new PointF[n];
            for (int i = 0; i < n; i++)
            {
                float t = (float)i / (n - 1), x = x0 + (x1 - x0) * t;
                p[i] = new PointF(x, y + tilt * (t - 0.5f) + amplitude * (0.65f * (float)Math.Sin(x / l1 + p1) + 0.35f * (float)Math.Sin(x / l2 + p2)));
            }
            return p;
        }

        // A box drawn by hand in four strokes; each starts a little before its corner and runs a little past the next.
        public static void Box(Graphics g, RectangleF r, Color color, float width, uint seed)
        {
            var rng = new Rng(seed);
            float x0 = r.Left, y0 = r.Top, x1 = r.Right, y1 = r.Bottom;
            Func<float> j = () => rng.Range(-0.9f, 0.9f) * S;   // a hand's unsteadiness
            Func<float> o = () => rng.Range(0.6f, 3.2f) * S;    // overshoot at a corner
            Side(g, new PointF(x0 - o(), y0 + j()), new PointF(x1 + o(), y0 + j()), color, width, rng);
            Side(g, new PointF(x1 + j(), y0 - o()), new PointF(x1 + j(), y1 + o()), color, width, rng);
            Side(g, new PointF(x1 + o(), y1 + j()), new PointF(x0 - o(), y1 + j()), color, width, rng);
            Side(g, new PointF(x0 + j(), y1 + o()), new PointF(x0 + j(), y0 - o()), color, width, rng);
        }

        static void Side(Graphics g, PointF a, PointF d, Color color, float width, Rng rng)
        {
            float dx = d.X - a.X, dy = d.Y - a.Y, len = (float)Math.Sqrt(dx * dx + dy * dy), nx = -dy / len, ny = dx / len;
            float bow1 = rng.Range(-1.1f, 1.1f) * S, bow2 = rng.Range(-1.1f, 1.1f) * S;
            var b = new PointF(a.X + dx / 3 + nx * bow1, a.Y + dy / 3 + ny * bow1);
            var c = new PointF(a.X + 2 * dx / 3 + nx * bow2, a.Y + 2 * dy / 3 + ny * bow2);
            Stroke(g, Bezier(a, b, c, d, Math.Max(8, (int)(len / (2 * S)))), width, color, rng.NextSeed(), 3 * S, 4 * S);
        }

        // The inside of a hand-drawn box, for a wash of ink.
        public static PointF[] Inside(RectangleF r, uint seed)
        {
            var rng = new Rng(seed ^ 0x51ED);
            Func<float> j = () => rng.Range(-0.5f, 0.5f) * S;
            return new[] { new PointF(r.Left + j(), r.Top + j()), new PointF(r.Right + j(), r.Top + j()),
                           new PointF(r.Right + j(), r.Bottom + j()), new PointF(r.Left + j(), r.Bottom + j()) };
        }

        // The keyboard-focus cue: a dotted pencil line under a label.
        public static void Dots(Graphics g, float x0, float x1, float y, Color color)
        {
            using (var brush = new SolidBrush(color))
                for (float x = x0; x <= x1 + 0.1f; x += 3.4f * S)
                {
                    float r = 0.72f * S, dy = 0.35f * S * (float)Math.Sin(x / (9 * S));
                    g.FillEllipse(brush, x - r, y + dy - r, 2 * r, 2 * r);
                }
        }

        // The sheet: warm paper with a quiet, fixed grain (mottling, speckle and fibres) and a faint darkening at the edges.
        public static Bitmap MakePaper(int w, int h)
        {
            var d = new float[w * h];
            var rng = new Rng(0x5C21217u);
            Mottle(d, w, h, Math.Max(6, (int)(64 * S)), 1.6f, rng);
            Mottle(d, w, h, Math.Max(3, (int)(18 * S)), 0.8f, rng);
            for (int i = 0; i < d.Length; i++) d[i] += (rng.Next() + rng.Next() - 1f) * 2.2f;
            int fibres = w * h / (int)(760 * S * S);
            for (int k = 0; k < fibres; k++)
            {
                float x = rng.Next() * w, y = rng.Next() * h;
                float angle = rng.Range(-0.55f, 0.55f) + (rng.Next() < 0.3f ? 1.5708f : 0f);
                float length = rng.Range(4f, 22f) * S, bend = rng.Range(-0.06f, 0.06f) / S;
                float v = rng.Next() < 0.65f ? -rng.Range(1.4f, 3.4f) : rng.Range(0.8f, 2.2f);
                for (float t = 0; t < length; t += 0.7f)
                {
                    Splat(d, w, h, x, y, v * 0.7f);
                    x += 0.7f * (float)Math.Cos(angle); y += 0.7f * (float)Math.Sin(angle); angle += bend * 0.7f;
                }
            }
            int flecks = Math.Max(3, w * h / (int)(52000 * S * S));
            for (int k = 0; k < flecks; k++)
            {
                float x = rng.Next() * w, y = rng.Next() * h, r = rng.Range(0.5f, 1.1f) * S, v = -rng.Range(5f, 10f);
                for (float yy = -r; yy <= r; yy += 0.5f) for (float xx = -r; xx <= r; xx += 0.5f)
                    if (xx * xx + yy * yy <= r * r) Splat(d, w, h, x + xx, y + yy, v * 0.25f);
            }

            var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
            BitmapData data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
            var row = new byte[data.Stride];
            float edge = 44 * S;
            for (int y = 0; y < h; y++)
            {
                float ey = Math.Min(1f, Math.Min(y, h - 1 - y) / edge);
                for (int x = 0; x < w; x++)
                {
                    float ex = Math.Min(1f, Math.Min(x, w - 1 - x) / edge), f = ex * ey;
                    f = f * f * (3 - 2 * f);
                    float v = (1 - f) * 9f, n = d[y * w + x];
                    row[3 * x] = Clamp(231 + 0.9f * n - 1.5f * v);
                    row[3 * x + 1] = Clamp(242 + n - 0.95f * v);
                    row[3 * x + 2] = Clamp(247 + n - 0.7f * v);
                }
                Marshal.Copy(row, 0, IntPtr.Add(data.Scan0, y * data.Stride), data.Stride);
            }
            bmp.UnlockBits(data);
            return bmp;
        }

        static byte Clamp(float v) { return (byte)Math.Max(0, Math.Min(255, (int)Math.Round(v))); }

        static void Splat(float[] d, int w, int h, float x, float y, float v)
        {
            int ix = (int)Math.Floor(x), iy = (int)Math.Floor(y);
            float fx = x - ix, fy = y - iy;
            Add(d, w, h, ix, iy, v * (1 - fx) * (1 - fy)); Add(d, w, h, ix + 1, iy, v * fx * (1 - fy));
            Add(d, w, h, ix, iy + 1, v * (1 - fx) * fy); Add(d, w, h, ix + 1, iy + 1, v * fx * fy);
        }

        static void Add(float[] d, int w, int h, int x, int y, float v) { if (x >= 0 && y >= 0 && x < w && y < h) d[y * w + x] += v; }

        // One octave of smooth value noise.
        static void Mottle(float[] d, int w, int h, int cell, float amplitude, Rng rng)
        {
            int gw = w / cell + 2, gh = h / cell + 2;
            var grid = new float[gw * gh];
            for (int i = 0; i < grid.Length; i++) grid[i] = rng.Range(-1f, 1f);
            for (int y = 0; y < h; y++)
            {
                int iy = y / cell;
                float fy = (float)(y % cell) / cell; fy = fy * fy * (3 - 2 * fy);
                for (int x = 0; x < w; x++)
                {
                    int ix = x / cell;
                    float fx = (float)(x % cell) / cell; fx = fx * fx * (3 - 2 * fx);
                    float top = grid[iy * gw + ix] * (1 - fx) + grid[iy * gw + ix + 1] * fx;
                    float bottom = grid[(iy + 1) * gw + ix] * (1 - fx) + grid[(iy + 1) * gw + ix + 1] * fx;
                    d[y * w + x] += amplitude * (top * (1 - fy) + bottom * fy);
                }
            }
        }
    }

    // A small deterministic random number generator (xorshift32), so the paper and the hand-drawn lines never change.
    sealed class Rng
    {
        uint s;
        public Rng(uint seed) { s = seed == 0 ? 0x9E3779B9u : seed; }
        public float Next() { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return (s >> 8) * (1f / 16777216f); }
        public float Range(float a, float b) { return a + (b - a) * Next(); }
        public uint NextSeed() { Next(); return s; }
    }

    // ---------- type ----------
    // Static subsets of EB Garamond and Cormorant Garamond (SIL OFL 1.1), embedded in this .exe. They are loaded twice:
    // into a private GDI+ collection for drawing, and into GDI (privately, for this process only) so the folder box, a
    // native text box, can use them too. If anything fails, the window falls back to Georgia.
    static class Typefaces
    {
        // One private collection per face, so GDI+ never has to group faces into families by itself.
        static readonly List<PrivateFontCollection> collections = new List<PrivateFontCollection>();
        public static FontFamily Text, Italic, Semi, Display;
        public static bool Embedded;
        public static string Report = "";
        public const char SmallCapA = '\uF761';   // the semibold face's small capitals a..z (see tools/build_fonts.py)

        [DllImport("gdi32.dll")] static extern IntPtr AddFontMemResourceEx(IntPtr font, uint size, IntPtr reserved, ref uint count);

        public static void Load()
        {
            if (Text != null) return;
            Text = Face("SetupText-Regular.ttf"); Italic = Face("SetupText-Italic.ttf");
            Semi = Face("SetupText-SemiBold.ttf"); Display = Face("SetupDisplay-SemiBold.ttf");
            Embedded = Text != null && Italic != null && Semi != null && Display != null;
            if (!Embedded)
            {
                FontFamily serif;
                try { serif = new FontFamily("Georgia"); } catch { serif = FontFamily.GenericSerif; }
                Text = Italic = Semi = Display = serif;
            }
        }

        static FontFamily Face(string name)
        {
            try
            {
                byte[] data;
                using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
                {
                    if (s == null) throw new FileNotFoundException("not embedded");
                    using (var m = new MemoryStream()) { s.CopyTo(m); data = m.ToArray(); }
                }
                // GDI+ reads the font from this memory for as long as the process runs, so it is never freed.
                IntPtr memory = Marshal.AllocCoTaskMem(data.Length);
                Marshal.Copy(data, 0, memory, data.Length);
                var collection = new PrivateFontCollection();
                collections.Add(collection);
                collection.AddMemoryFont(memory, data.Length);
                uint count = 0;
                if (Installer.IsWindows) AddFontMemResourceEx(memory, (uint)data.Length, IntPtr.Zero, ref count);
                FontFamily[] families = collection.Families;
                Report += name + ": " + (families.Length > 0 ? families[0].Name : "no family") + " (GDI: " + count + "); ";
                return families.Length > 0 ? families[0] : null;
            }
            catch (Exception e) { Report += name + ": " + e.GetType().Name + " " + e.Message + "; "; return null; }
        }

        // Sizes are 96-dpi pixels; fonts are made in device pixels. Italic text comes from the italic face.
        public static Font Make(FontFamily family, float px, FontStyle style)
        {
            if (Embedded && family == Text && (style & FontStyle.Italic) != 0) family = Italic;
            if (!family.IsStyleAvailable(style))
                foreach (FontStyle st in new[] { FontStyle.Regular, FontStyle.Italic, FontStyle.Bold })
                    if (family.IsStyleAvailable(st)) { style = st; break; }
            return new Font(family, px * Ink.S, style, GraphicsUnit.Pixel);
        }

        // Small capitals for the semibold face: lower-case letters map to its small-capital glyphs.
        public static string SmallCaps(string s)
        {
            if (!Embedded) return s;
            var c = s.ToCharArray();
            for (int i = 0; i < c.Length; i++) if (c[i] >= 'a' && c[i] <= 'z') c[i] = (char)(SmallCapA + (c[i] - 'a'));
            return new string(c);
        }
    }

    // Lines of type set by hand: baseline placement, letter-spacing and word wrapping (GDI+ does none of these well).
    static class Lettering
    {
        public static readonly StringFormat Format = MakeFormat();

        static StringFormat MakeFormat()
        {
            var f = (StringFormat)StringFormat.GenericTypographic.Clone();
            f.FormatFlags |= StringFormatFlags.MeasureTrailingSpaces | StringFormatFlags.NoWrap;
            return f;
        }

        public static float Ascent(Font f) { return f.Size * f.FontFamily.GetCellAscent(f.Style) / f.FontFamily.GetEmHeight(f.Style); }

        public static float Width(Graphics g, string s, Font f) { return s.Length == 0 ? 0 : g.MeasureString(Quotes(s), f, PointF.Empty, Format).Width; }

        public static void Line(Graphics g, string s, Font f, Color c, float x, float baseline)
        {
            using (var b = new SolidBrush(c)) g.DrawString(Quotes(s), f, b, x, baseline - Ascent(f), Format);
        }

        // Straight quotes are set as curly ones, as a compositor would.
        public static string Quotes(string s)
        {
            if (s.IndexOf('"') < 0 && s.IndexOf('\'') < 0) return s;
            var c = s.ToCharArray();
            for (int i = 0; i < c.Length; i++)
            {
                bool opening = i == 0 || char.IsWhiteSpace(c[i - 1]) || c[i - 1] == '(';
                if (c[i] == '"') c[i] = opening ? '\u201C' : '\u201D';
                else if (c[i] == '\'') c[i] = opening ? '\u2018' : '\u2019';
            }
            return new string(c);
        }

        public static float SpacedWidth(Graphics g, string s, Font f, float tracking)
        {
            float w = 0;
            foreach (char ch in s) w += Width(g, ch.ToString(), f) + tracking;
            return s.Length > 0 ? w - tracking : 0;
        }

        public static void Spaced(Graphics g, string s, Font f, Color c, float x, float baseline, float tracking)
        {
            using (var b = new SolidBrush(c))
                foreach (char ch in s)
                {
                    string one = ch.ToString();
                    g.DrawString(one, f, b, x, baseline - Ascent(f), Format);
                    x += Width(g, one, f) + tracking;
                }
        }

        // Greedy word wrap; a word longer than the line (a long path) is broken where it must be.
        public static List<string> Wrap(Graphics g, string s, Font f, float width)
        {
            var lines = new List<string>();
            foreach (string para in (s ?? "").Replace("\r", "").Split('\n'))
            {
                string line = "";
                foreach (string word in para.Split(' '))
                {
                    string trial = line.Length == 0 ? word : line + " " + word;
                    if (Width(g, trial, f) <= width) { line = trial; continue; }
                    if (line.Length > 0) { lines.Add(line); line = ""; }
                    string rest = word;
                    while (Width(g, rest, f) > width && rest.Length > 1)
                    {
                        int k = rest.Length - 1;
                        while (k > 1 && Width(g, rest.Substring(0, k), f) > width) k--;
                        lines.Add(rest.Substring(0, k)); rest = rest.Substring(k);
                    }
                    line = rest;
                }
                lines.Add(line);
            }
            return lines;
        }

        // A throwaway Graphics for measuring (fonts are in pixels, so its resolution does not matter).
        public static Graphics Measure()
        {
            var g = Graphics.FromImage(Scratch);
            Ink.Prepare(g);
            return g;
        }
        static readonly Bitmap Scratch = new Bitmap(4, 4);
    }

    // ---------- controls drawn in ink ----------
    interface IInked { void PaintTo(Graphics g); }

    // A window drawn as a sheet of paper: the setup window and the update question.
    interface IPage
    {
        Bitmap Paper { get; }
        Size PageSize { get; }
        void PaintPage(Graphics g);
    }

    static class Sheet
    {
        // Paints the part of the window's paper that lies under a control, so every control sits on the same sheet.
        public static void Under(Control c, Graphics g)
        {
            var page = c.FindForm() as IPage;
            if (page == null) { g.Clear(Ink.Paper); return; }
            Point at = Offset(c);
            var form = page;
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.DrawImage(form.Paper, new Rectangle(0, 0, c.Width, c.Height), at.X, at.Y, c.Width, c.Height, GraphicsUnit.Pixel);
        }

        // Where a control sits on its window's page.
        public static Point Offset(Control c)
        {
            var p = Point.Empty;
            for (Control x = c; x != null && !(x is Form); x = x.Parent) p.Offset(x.Left, x.Top);
            return p;
        }

        // A sheet of paper for a page, made once for its size.
        public static Bitmap Paper(ref Bitmap paper, Size size)
        {
            if (paper == null || paper.Size != size) { if (paper != null) paper.Dispose(); paper = Ink.MakePaper(Math.Max(1, size.Width), Math.Max(1, size.Height)); }
            return paper;
        }

        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        // Windows 11: a paper-coloured title bar with ink text (DWMWA_BORDER_COLOR 34, CAPTION_COLOR 35, TEXT_COLOR 36).
        // Older versions of Windows ignore these, and so do we.
        public static void TitleBar(IntPtr handle)
        {
            try
            {
                int border = ColorRef(Ink.Edge), caption = ColorRef(Ink.Paper), text = ColorRef(Ink.Black);
                DwmSetWindowAttribute(handle, 34, ref border, 4);
                DwmSetWindowAttribute(handle, 35, ref caption, 4);
                DwmSetWindowAttribute(handle, 36, ref text, 4);
            }
            catch { }
        }

        static int ColorRef(Color c) { return c.R | (c.G << 8) | (c.B << 16); }
    }

    // Static text: wrapped, set on baselines, optionally centred, letter-spaced or in small capitals.
    class InkLabel : Control, IInked
    {
        public Color InkColor;
        public bool Centered, SmallCaps;
        public int MaxLines;
        public float Leading = 1.36f, Tracking;
        public float Above = 0.98f, Below = 0.34f;   // room above the first baseline and below the last, in ems

        public InkLabel(string text, Font font, Color color, bool centered)
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            SetStyle(ControlStyles.Selectable, false);
            TabStop = false; Text = text; Font = font; InkColor = color; Centered = centered;
            AccessibleRole = AccessibleRole.StaticText;
        }

        protected override void OnTextChanged(EventArgs e) { base.OnTextChanged(e); Invalidate(); }

        float LineHeight { get { return (float)Math.Round(Font.Size * Leading); } }
        float FirstBaseline { get { return (float)Math.Round(Font.Size * Above); } }

        List<string> Lines(Graphics g, float width)
        {
            string text = SmallCaps ? Typefaces.SmallCaps(Text) : Text;
            List<string> lines = Tracking > 0 ? new List<string> { text } : Lettering.Wrap(g, text, Font, width);
            if (MaxLines > 0 && lines.Count > MaxLines)
            {
                string last = lines[MaxLines - 1];
                while (last.Length > 0 && Lettering.Width(g, last + "…", Font) > width) last = last.Substring(0, last.Length - 1);
                lines = lines.Take(MaxLines - 1).ToList(); lines.Add(last + "…");
            }
            return lines;
        }

        public int HeightFor(int width, int lines)
        {
            using (Graphics g = Lettering.Measure())
            {
                int n = lines > 0 ? lines : Lines(g, width).Count;
                return (int)Math.Ceiling(FirstBaseline + (n - 1) * LineHeight + Font.Size * Below);
            }
        }

        protected override void OnPaintBackground(PaintEventArgs e) { }
        protected override void OnPaint(PaintEventArgs e) { PaintTo(e.Graphics); }

        public void PaintTo(Graphics g)
        {
            Sheet.Under(this, g);
            Ink.Prepare(g);
            List<string> lines = Lines(g, Width);
            float baseline = FirstBaseline;
            foreach (string line in lines)
            {
                float w = Tracking > 0 ? Lettering.SpacedWidth(g, line, Font, Tracking * Font.Size) : Lettering.Width(g, line, Font);
                float x = Centered ? (float)Math.Round((Width - w) / 2) : 0;
                if (Tracking > 0) Lettering.Spaced(g, line, Font, InkColor, x, baseline, Tracking * Font.Size);
                else Lettering.Line(g, line, Font, InkColor, x, baseline);
                baseline += LineHeight;
            }
        }
    }

    // A push button drawn as a hand-inked box with a small-capital label: rubric ink for the main action, plain ink
    // otherwise. Hover lays a faint wash of ink inside; pressing darkens it and moves everything down a pixel. It is a
    // real Button, so the keyboard (Space, Enter), AcceptButton/CancelButton and accessibility work as usual.
    class InkButton : Button, IInked
    {
        public readonly bool Primary;
        internal bool Hover, Pressed, ShowFocus;   // ShowFocus forces the focus cue (for the rendered previews)

        public InkButton(string text, bool primary)
        {
            Primary = primary; Text = text;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            FlatStyle = FlatStyle.Flat; FlatAppearance.BorderSize = 0; UseVisualStyleBackColor = false; BackColor = Ink.Paper;
            Font = Typefaces.Make(Typefaces.Semi, 16f, FontStyle.Regular);
        }

        public int PreferredWidth(int minimum)
        {
            using (Graphics g = Lettering.Measure())
                return Math.Max(Ink.R(minimum), (int)Math.Ceiling(Lettering.SpacedWidth(g, Typefaces.SmallCaps(Text), Font, 0.05f * Font.Size) + 46 * Ink.S));
        }

        protected override void OnMouseEnter(EventArgs e) { Hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { Hover = false; Pressed = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { if (e.Button == MouseButtons.Left) { Pressed = true; Invalidate(); } base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { Pressed = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) { bool inside = ClientRectangle.Contains(e.Location); if (inside != Pressed) { Pressed = inside; Invalidate(); } }
            base.OnMouseMove(e);
        }
        protected override void OnKeyDown(KeyEventArgs e) { if (e.KeyCode == Keys.Space) { Pressed = true; Invalidate(); } base.OnKeyDown(e); }
        protected override void OnKeyUp(KeyEventArgs e) { if (e.KeyCode == Keys.Space) { Pressed = false; Invalidate(); } base.OnKeyUp(e); }
        protected override void OnLostFocus(EventArgs e) { Pressed = false; base.OnLostFocus(e); Invalidate(); }
        protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
        protected override void OnEnabledChanged(EventArgs e) { Hover = false; Pressed = false; base.OnEnabledChanged(e); Invalidate(); }
        protected override void OnTextChanged(EventArgs e) { base.OnTextChanged(e); Invalidate(); }

        protected override void OnPaintBackground(PaintEventArgs e) { }
        protected override void OnPaint(PaintEventArgs e) { PaintTo(e.Graphics); }

        public void PaintTo(Graphics g)
        {
            Sheet.Under(this, g);
            Ink.Prepare(g);
            float s = Ink.S, alpha = Enabled ? 1f : Ink.Faded;
            bool down = Pressed && Enabled;
            var state = g.Save();
            if (down) g.TranslateTransform(s, s);
            var box = new RectangleF(3.5f * s, 3.5f * s, Width - 7 * s, Height - 7 * s);
            uint seed = Ink.Seed(Name.Length > 0 ? Name : Text);
            if (Enabled && (Hover || down))
                using (var wash = new SolidBrush(Ink.A(Ink.Black, down ? 0.11f : 0.06f))) g.FillPolygon(wash, Ink.Inside(box, seed));
            Color ink = Primary ? Ink.Red : Ink.Black;
            Ink.Box(g, box, Ink.A(ink, 0.9f * alpha), 1.35f * s, seed);

            string label = Typefaces.SmallCaps(Text);
            float tracking = 0.05f * Font.Size, w = Lettering.SpacedWidth(g, label, Font, tracking);
            float x = (float)Math.Round((Width - w) / 2), baseline = (float)Math.Round(Height / 2f + Font.Size * 0.22f);
            Lettering.Spaced(g, label, Font, Ink.A(ink, alpha), x, baseline, tracking);
            if (ShowFocus || (Focused && ShowFocusCues)) Ink.Dots(g, x, x + w, baseline + 4.5f * s, Ink.A(ink, 0.75f));
            g.Restore(state);
        }
    }

    // A check box drawn as the site's hand-inked box (its SVG path, scaled), ticked with the site's oxblood pen tick.
    class InkCheck : CheckBox, IInked
    {
        internal bool Hover, ShowFocus;
        bool record;

        // After a successful install the boxes stay disabled but are written in full ink: a record of what was done.
        public bool Record { get { return record; } set { record = value; Invalidate(); } }

        // From the site's .ink-check (a 24 x 24 view box): the box, drawn as one stroke, and the tick, a filled shape.
        static readonly PointF[] BoxPath = {
            new PointF(3.3f, 4.2f), new PointF(7.6f, 3.7f), new PointF(13.1f, 4f), new PointF(20.5f, 3.5f),
            new PointF(20.8f, 9.1f), new PointF(20.4f, 14.6f), new PointF(20.8f, 20.6f),
            new PointF(14.7f, 21f), new PointF(9.2f, 20.5f), new PointF(3.5f, 20.9f),
            new PointF(3.2f, 15.1f), new PointF(3.7f, 9.6f), new PointF(3f, 3.9f) };
        static readonly PointF[] TickPath = {
            new PointF(5.6f, 12.2f), new PointF(7.3f, 13.4f), new PointF(8.6f, 14.9f), new PointF(9.9f, 16.6f),
            new PointF(13f, 11.6f), new PointF(16.6f, 6.6f), new PointF(21.8f, 1.9f),
            new PointF(22.3f, 1.6f), new PointF(22.6f, 2.1f), new PointF(22.2f, 2.5f),
            new PointF(17.6f, 7.4f), new PointF(13.9f, 12.6f), new PointF(10.8f, 18.6f),
            new PointF(10.5f, 19.2f), new PointF(9.8f, 19.2f), new PointF(9.5f, 18.7f),
            new PointF(8.4f, 16.6f), new PointF(7f, 14.6f), new PointF(5.3f, 12.9f),
            new PointF(4.9f, 12.5f), new PointF(5.2f, 11.9f), new PointF(5.6f, 12.2f) };

        public InkCheck()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            AutoSize = false; UseVisualStyleBackColor = false; BackColor = Ink.Paper;
            Font = Typefaces.Make(Typefaces.Text, 16.5f, FontStyle.Regular);
        }

        float BoxSize { get { return 18 * Ink.S; } }
        float LabelX { get { return (float)Math.Round(BoxSize + 11 * Ink.S); } }

        public int PreferredWidth()
        {
            using (Graphics g = Lettering.Measure()) return (int)Math.Ceiling(LabelX + Lettering.Width(g, Text, Font) + 6 * Ink.S);
        }

        protected override void OnMouseEnter(EventArgs e) { Hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { Hover = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnEnabledChanged(EventArgs e) { Hover = false; base.OnEnabledChanged(e); Invalidate(); }
        protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
        protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }
        protected override void OnTextChanged(EventArgs e) { base.OnTextChanged(e); Invalidate(); }

        protected override void OnPaintBackground(PaintEventArgs e) { }
        protected override void OnPaint(PaintEventArgs e) { PaintTo(e.Graphics); }

        public void PaintTo(Graphics g)
        {
            Sheet.Under(this, g);
            Ink.Prepare(g);
            float s = Ink.S, alpha = Enabled || record ? 1f : Ink.Faded;
            float baseline = (float)Math.Round(Height / 2f + Font.Size * 0.27f);
            float k = BoxSize / 18f, cx = 1.5f * s + BoxSize / 2, cy = baseline - Font.Size * 0.3f;
            var place = new Matrix(k, 0, 0, k, cx - 12 * k, cy - 12.2f * k);
            using (var box = new GraphicsPath())
            {
                // Each box is drawn by hand: the site's path with its points nudged a little, differently for each box.
                var rng = new Rng(Ink.Seed(Name.Length > 0 ? Name : Text));
                box.AddBeziers(BoxPath.Select(p => new PointF(p.X + rng.Range(-0.35f, 0.35f), p.Y + rng.Range(-0.35f, 0.35f))).ToArray());
                box.Transform(place);
                if (Enabled && Hover)
                    using (var wash = new SolidBrush(Ink.A(Ink.Black, 0.07f))) g.FillPath(wash, box);
                using (var pen = new Pen(Ink.A(Ink.Black, 0.88f * alpha), 1.45f * k) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                    g.DrawPath(pen, box);
            }
            if (Checked)
                using (var tick = new GraphicsPath())
                {
                    tick.AddBeziers(TickPath);
                    tick.CloseFigure();
                    tick.Transform(place);
                    using (var brush = new SolidBrush(Ink.A(Ink.Red, alpha))) g.FillPath(brush, tick);
                }
            place.Dispose();
            Lettering.Line(g, Text, Font, Ink.A(Ink.Black, alpha), LabelX, baseline);
            if (ShowFocus || (Focused && ShowFocusCues))
                Ink.Dots(g, LabelX, LabelX + Lettering.Width(g, Text, Font), baseline + 4.5f * s, Ink.A(Ink.Black, 0.7f));
        }
    }

    // Progress, written in ink: a faint pencil guide line, and a pen stroke along it as far as the work has gone, with a
    // small blot where the pen rests. While the length of the work is unknown, a short stroke sweeps along the guide.
    class InkProgress : Control, IInked
    {
        int value;
        bool marquee;
        internal float Phase;
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 30 };
        Bitmap guide;

        public InkProgress()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            SetStyle(ControlStyles.Selectable, false);
            TabStop = false; AccessibleName = "Progress";
            timer.Tick += (s, e) => { Phase = (Phase + 0.012f) % 1f; Invalidate(); };
        }

        public int Value { get { return value; } set { this.value = Math.Max(0, Math.Min(100, value)); Invalidate(); } }

        public bool Marquee
        {
            get { return marquee; }
            set { marquee = value; Phase = 0; if (value) timer.Start(); else timer.Stop(); Invalidate(); }
        }

        internal void StopTimer() { timer.Stop(); }

        protected override AccessibleObject CreateAccessibilityInstance() { return new Accessible(this); }

        sealed class Accessible : ControlAccessibleObject
        {
            readonly InkProgress owner;
            public Accessible(InkProgress owner) : base(owner) { this.owner = owner; }
            public override AccessibleRole Role { get { return AccessibleRole.ProgressBar; } }
            public override string Value { get { return owner.marquee ? "Working" : owner.value + "%"; } }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) { timer.Dispose(); if (guide != null) guide.Dispose(); }
            base.Dispose(disposing);
        }

        protected override void OnPaintBackground(PaintEventArgs e) { }
        protected override void OnPaint(PaintEventArgs e) { PaintTo(e.Graphics); }

        float X0 { get { return 2 * Ink.S; } }
        float X1 { get { return Width - 2 * Ink.S; } }
        float Mid { get { return (float)Math.Round(Height / 2f); } }

        // The pen's path: a slow drift just above the guide, a function of x so the line does not move as it grows.
        PointF[] PenLine(float a, float b)
        {
            float s = Ink.S;
            int n = Math.Max(2, (int)((b - a) / (1.5f * s)) + 1);
            var p = new PointF[n];
            for (int i = 0; i < n; i++)
            {
                float x = a + (b - a) * i / (n - 1);
                p[i] = new PointF(x, Mid - 0.5f * s + 0.6f * s * (float)Math.Sin(x / (37 * s) + 1.3f) + 0.3f * s * (float)Math.Sin(x / (13 * s) + 0.4f));
            }
            return p;
        }

        void Blot(Graphics g, PointF at)
        {
            float s = Ink.S;
            using (var b = new SolidBrush(Ink.A(Ink.Black, 0.93f)))
            {
                g.FillEllipse(b, at.X - 2.1f * s, at.Y - 1.8f * s, 4.0f * s, 3.7f * s);
                g.FillEllipse(b, at.X - 0.6f * s, at.Y - 2.2f * s, 2.4f * s, 2.2f * s);
            }
        }

        public void PaintTo(Graphics g)
        {
            Sheet.Under(this, g);
            Ink.Prepare(g);
            float s = Ink.S;
            if (guide == null || guide.Size != Size)
            {
                if (guide != null) guide.Dispose();
                guide = new Bitmap(Math.Max(1, Width), Math.Max(1, Height), PixelFormat.Format32bppPArgb);
                using (Graphics gg = Graphics.FromImage(guide))
                {
                    Ink.Prepare(gg);
                    var rng = new Rng(0xB1A5u);
                    for (float x = X0; x < X1; x += 2.2f * s)
                        using (var pen = new Pen(Ink.A(Ink.Pencil, rng.Range(0.16f, 0.40f)), 0.95f * s))
                        {
                            float x2 = Math.Min(X1, x + 2.6f * s);
                            gg.DrawLine(pen, x, Mid + 0.4f * s * (float)Math.Sin(x / (41 * s)), x2, Mid + 0.4f * s * (float)Math.Sin(x2 / (41 * s)));
                        }
                }
            }
            g.DrawImage(guide, 0, 0, guide.Width, guide.Height);

            Color ink = Ink.A(Ink.Black, 0.9f);
            if (marquee)
            {
                float span = (X1 - X0) * 0.26f, head = X0 + Phase * (X1 - X0 + span), tail = head - span;
                float a = Math.Max(X0, tail), b = Math.Min(X1, head);
                if (b - a > 2 * s)
                {
                    PointF[] p = PenLine(a, b);
                    Ink.Stroke(g, p, 2.1f * s, ink, 0xC0FFEEu, span * 0.85f, head > X1 ? 6 * s : 0);
                    if (head <= X1) Blot(g, p[p.Length - 1]);
                }
            }
            else if (value > 0)
            {
                float head = X0 + (X1 - X0) * value / 100f;
                PointF[] p = PenLine(X0, Math.Max(X0 + 2 * s, head));
                Ink.Stroke(g, p, 2.1f * s, ink, 0xC0FFEEu, 7 * s, 0);
                Blot(g, p[p.Length - 1]);
            }
        }
    }

    // The details: a ledger. Faint ruled lines with a rubric margin rule; entries in italic ink, newest at the bottom,
    // as many as fit (long ones wrap). Errors are written in rubric.
    class InkLog : Control, IInked
    {
        readonly List<KeyValuePair<string, bool>> entries = new List<KeyValuePair<string, bool>>();

        public InkLog()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            SetStyle(ControlStyles.Selectable, false);
            TabStop = false; AccessibleName = "Details"; AccessibleRole = AccessibleRole.StaticText;
            Font = Typefaces.Make(Typefaces.Text, 15.5f, FontStyle.Italic);
            ContextMenu = new ContextMenu(new[] { new MenuItem("Copy the details", (s, e) => { try { if (AllText.Length > 0) Clipboard.SetText(AllText); } catch { } }) });
        }

        public string AllText { get { return string.Join(Environment.NewLine, entries.Select(e => e.Key)); } }
        public float LineHeight { get { return (float)Math.Round(22 * Ink.S); } }

        public void Append(string line, bool error) { entries.Add(new KeyValuePair<string, bool>(line, error)); AccessibleDescription = line; Invalidate(); }
        public void Clear() { entries.Clear(); AccessibleDescription = null; Invalidate(); }

        protected override void OnPaintBackground(PaintEventArgs e) { }
        protected override void OnPaint(PaintEventArgs e) { PaintTo(e.Graphics); }

        public void PaintTo(Graphics g)
        {
            Sheet.Under(this, g);
            Ink.Prepare(g);
            float s = Ink.S, lh = LineHeight, margin = (float)Math.Round(11 * s), textX = (float)Math.Round(21 * s);
            int rows = Math.Max(1, (int)((Height - 3 * s) / lh));
            using (var rule = new SolidBrush(Ink.A(Ink.Faint, 0.42f)))
                for (int k = 1; k <= rows; k++) g.FillRectangle(rule, 0, RuleY(k), Width, Math.Max(1f, (float)Math.Floor(s)));
            using (var red = new SolidBrush(Ink.A(Ink.Red, 0.32f)))
                g.FillRectangle(red, margin, 0, Math.Max(1f, (float)Math.Floor(s)), RuleY(rows) + 2 * s);

            var lines = new List<KeyValuePair<string, bool>>();
            foreach (var e in entries)
                foreach (string line in Lettering.Wrap(g, e.Key, Font, Width - textX - 4 * s)) lines.Add(new KeyValuePair<string, bool>(line, e.Value));
            int first = Math.Max(0, lines.Count - rows);
            for (int i = first; i < lines.Count; i++)
                Lettering.Line(g, lines[i].Key, Font, lines[i].Value ? Ink.Red : Ink.Black, textX, RuleY(i - first + 1) - (float)Math.Round(4.5f * s));
        }

        float RuleY(int k) { return (float)Math.Round(k * LineHeight + 2 * Ink.S); }
    }

    class SetupForm : Form, IPage
    {
        readonly TextBox pathBox = new TextBox();
        readonly InkButton browse = new InkButton("Browse…", false);
        readonly InkCheck fontsBox = new InkCheck(), obsidianBox = new InkCheck(), longformBox = new InkCheck(), diagramsBox = new InkCheck(), openBox = new InkCheck();
        readonly InkProgress bar = new InkProgress();
        readonly InkLabel title, tagline, intro, folderLabel, folderHint, status;
        readonly InkLog details = new InkLog();
        readonly InkButton installButton = new InkButton("Install", true), closeButton = new InkButton("Close", false);
        readonly CancellationTokenSource cancel = new CancellationTokenSource();
        readonly bool preview;   // drawn for --render: nothing is detected, started or installed
        Thread worker;
        string installedPath;
        Bitmap paper;
        float ornamentY, ruleY;
        bool finished;   // the install succeeded: the choices made are shown in full ink, as a record
        // What the folder is (a new folder, an empty one, a Scriptorium vault, anything else), checked as the path is typed.
        Vaults.Target target = Vaults.Target.New;
        readonly System.Windows.Forms.Timer detect = new System.Windows.Forms.Timer { Interval = 350 };
        int detectSeq;

        public SetupForm() : this(false) { }

        internal SetupForm(bool preview)
        {
            this.preview = preview;
            SuspendLayout();
            Text = "Scriptorium Setup";
            // Laid out in 96-dpi pixels times Ink.S (the exe is DPI-aware), so the drawing and the layout scale together.
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Ink.Paper; ForeColor = Ink.Black;
            DoubleBuffered = true;
            Font = Typefaces.Make(Typefaces.Text, 16f, FontStyle.Regular);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            title = new InkLabel("Scriptorium", Typefaces.Make(Typefaces.Display, 48f, FontStyle.Regular), Ink.Red, true) { Above = 0.86f, Below = 0.27f };
            tagline = new InkLabel("Book-page typography for Obsidian.", Typefaces.Make(Typefaces.Text, 18f, FontStyle.Italic), Ink.Muted, true);
            intro = new InkLabel("This creates a new vault with the Scriptorium configuration and a Lorem\u00A0Ipsum sample note.",
                                 Typefaces.Make(Typefaces.Text, 17f, FontStyle.Regular), Ink.Black, false) { Leading = 1.32f };
            folderLabel = new InkLabel("New vault folder", Typefaces.Make(Typefaces.Semi, 16f, FontStyle.Regular), Ink.Black, false) { SmallCaps = true, Tracking = 0.06f };
            folderHint = new InkLabel("A new or empty folder, or a Scriptorium vault to update. Other folders are left alone.",
                                      Typefaces.Make(Typefaces.Text, 16f, FontStyle.Italic), Ink.Muted, false);
            status = new InkLabel("Ready.", Typefaces.Make(Typefaces.Text, 16f, FontStyle.Italic), Ink.Muted, false) { MaxLines = 2, Leading = 1.3f };

            pathBox.Text = preview ? @"C:\Users\Ada\Documents\Scriptorium" : Installer.DefaultVault;
            pathBox.BorderStyle = BorderStyle.None; pathBox.AutoSize = false; pathBox.ForeColor = Ink.Black; pathBox.BackColor = Ink.Paper;
            pathBox.Font = Typefaces.Make(Typefaces.Text, 17f, FontStyle.Regular);
            pathBox.AccessibleName = "New vault folder";
            pathBox.EnabledChanged += (s, e) => { pathBox.Visible = pathBox.Enabled; Invalidate(); };
            browse.Name = "browse"; browse.Click += OnBrowse;

            ShowInstalled(FontsOffer(), ObsidianInstalled());
            fontsBox.Name = "fonts"; obsidianBox.Name = "obsidian"; longformBox.Name = "longform"; openBox.Name = "open";
            longformBox.Text = "Download the Longform plugin from its official release"; longformBox.Checked = true;
            diagramsBox.Name = "diagrams"; diagramsBox.Text = "Download the TikZJax and Excalidraw plugins, for diagrams"; diagramsBox.Checked = true;
            openBox.Text = OpenNew; openBox.Checked = true;

            installButton.Name = "install"; closeButton.Name = "close";
            installButton.Click += OnInstall; closeButton.Click += (s, e) => Close();
            installButton.TextChanged += (s, e) => LayoutButtons();
            closeButton.TextChanged += (s, e) => LayoutButtons();
            AcceptButton = installButton; CancelButton = closeButton;

            Control[] order = { pathBox, browse, fontsBox, obsidianBox, longformBox, diagramsBox, openBox, installButton, closeButton };
            for (int i = 0; i < order.Length; i++) order[i].TabIndex = i;
            Controls.AddRange(new Control[] { title, tagline, intro, folderLabel, pathBox, browse, folderHint,
                                              fontsBox, obsidianBox, longformBox, diagramsBox, openBox, bar, status, details, installButton, closeButton });
            LayoutPage();
            FormClosing += OnClosing;
            ResumeLayout(false);
            if (!preview)
            {
                // The default folder is checked at once (it is local), so a window opened on an existing vault starts in
                // Update; later edits are checked once typing pauses.
                try
                {
                    string full = Path.GetFullPath(pathBox.Text.Trim());
                    Vaults.Target t = Vaults.Classify(full);
                    ShowTarget(t, true, t == Vaults.Target.Vault ? Vaults.VaultVersion(full) : null);
                }
                catch { }
                detect.Tick += (s, e) => Detect();
                pathBox.TextChanged += (s, e) => { detect.Stop(); detect.Start(); };
            }
        }

        // fontsOffer: what the fonts need ("Install the fonts …", "Repair the fonts (…)"), or null if all four faces are in order.
        void ShowInstalled(string fontsOffer, bool hasObsidian)
        {
            bool hasFonts = fontsOffer == null;
            fontsBox.Text = hasFonts ? "EB Garamond and Cormorant Garamond are already installed" : fontsOffer;
            fontsBox.Checked = !hasFonts; fontsBox.Enabled = !hasFonts;
            obsidianBox.Text = hasObsidian ? "Obsidian is already installed" : "Download and install Obsidian 1.15.0 for me";
            obsidianBox.Checked = !hasObsidian; obsidianBox.Enabled = !hasObsidian;
        }

        bool Running { get { return (worker != null && worker.IsAlive) || installedPath != null; } }

        // Looks at the folder (off the UI thread: a network path can be slow) and says what Install or Update will do.
        void Detect()
        {
            detect.Stop();
            if (Running) return;
            int seq = ++detectSeq;
            string text = pathBox.Text.Trim();
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Vaults.Target t = Vaults.Target.New;
                string version = null;
                bool valid = true;
                try
                {
                    string full = Path.GetFullPath(text);
                    t = Vaults.Classify(full);
                    if (t == Vaults.Target.Vault) version = Vaults.VaultVersion(full);
                }
                catch { valid = false; }
                try { UI(() => { if (seq == detectSeq && !Running && pathBox.Enabled) ShowTarget(t, valid, version); }); } catch { }
            });
        }

        // What the last box offers: a new vault is opened in Obsidian with its plugins on; an update (of a vault Obsidian
        // already knows and trusts) just opens Obsidian, as before.
        const string OpenNew = "Open the vault in Obsidian and turn on its plugins", OpenUpdated = "Open Obsidian when done";

        void ShowTarget(Vaults.Target t, bool valid, string version)
        {
            target = valid ? t : Vaults.Target.New;
            installButton.Text = valid && t == Vaults.Target.Vault ? "Update" : valid && t == Vaults.Target.Folder ? "Set up" : "Install";
            string open = target == Vaults.Target.Vault ? OpenUpdated : OpenNew;
            if (openBox.Text != open) { openBox.Text = open; openBox.Width = openBox.PreferredWidth(); }
            if (!valid) Status("That folder path is not valid.", true);
            else if (t == Vaults.Target.Vault)
                Status("This is a Scriptorium vault (" + (version ?? "unknown version") + "). Update replaces Scriptorium's files and keeps your notes and settings.");
            else if (t == Vaults.Target.Empty) Status("This folder is empty: Scriptorium will be installed in it.");
            else if (t == Vaults.Target.Folder)
                Status("This folder has files in it. Set up makes it a Scriptorium vault: your notes are not touched and your settings are merged.");
            else if (t == Vaults.Target.Other) Status("That is a file, not a folder. Choose a folder.", true);
            else Status("Ready.");
        }

        // What the fonts need, face by face (Fonts.Offer); in a preview, and where the fonts cannot be looked at, to be installed.
        string FontsOffer()
        {
            const string install = "Install the fonts it uses for me (EB Garamond, Cormorant Garamond)";
            if (preview) return install;
            try { Fonts.ISystem s = Fonts.Current; return s == null ? install : Fonts.Offer(Fonts.Check(s)); }
            catch { return install; }
        }
        // Only a program on the disk counts (Installer.FindObsidian): not the obsidian:// link an uninstalled Obsidian leaves.
        bool ObsidianInstalled() { return !preview && Installer.FindObsidian() != null; }

        // ---------- the page ----------
        const float PageWidth = 600, PageMargin = 40;
        int bottomY;
        Size pageSize;   // the laid-out page (the client size, unless Windows had to make the window smaller)
        public Size PageSize { get { return pageSize; } }

        void Place(Control c, float x, ref float y, float width, float after)
        {
            var label = c as InkLabel;
            int h = label != null ? label.HeightFor(Ink.R(width), label == status ? 2 : 0) : c.Height;
            c.SetBounds(Ink.R(x), (int)Math.Round(y), Ink.R(width), h);
            y += h + after * Ink.S;
        }

        // The page is laid out once (its width is fixed); the ledger gets as many lines as the screen has room for, up to
        // four, so the window always fits (1080p at 150% included).
        void LayoutPage()
        {
            LayoutPage(4);
            if (preview) return;
            try
            {
                int room = Screen.FromPoint(Cursor.Position).WorkingArea.Height - SizeFromClientSize(Size.Empty).Height;
                for (int rows = 3; rows >= 2 && PageSize.Height > room; rows--) LayoutPage(rows);
            }
            catch { }
        }

        void LayoutPage(int logRows)
        {
            float s = Ink.S, cw = PageWidth - 2 * PageMargin, y = 12 * s;
            Place(title, PageMargin, ref y, cw, 0);
            Place(tagline, PageMargin, ref y, cw, 0);
            ornamentY = y + 12 * s; y += 26 * s;
            Place(intro, PageMargin, ref y, cw, 12);
            Place(folderLabel, PageMargin, ref y, cw, 0);

            int bw = Ink.R(108), bh = Ink.R(36);
            browse.SetBounds(Ink.R(PageWidth - PageMargin + 3.5f) - bw, (int)Math.Round(y), bw, bh);
            // The text box is cut just below its descenders, so the ruled line drawn under it stays visible.
            int th = (int)Math.Ceiling(Lettering.Ascent(pathBox.Font) + 0.31f * pathBox.Font.Size);
            pathBox.SetBounds(Ink.R(PageMargin), (int)Math.Round(y + (bh - th) / 2f - 1 * s), browse.Left - Ink.R(PageMargin + 18), th);
            ruleY = (float)Math.Round(pathBox.Bottom + 1.5f * s);
            y += bh + 2 * s;
            Place(folderHint, PageMargin, ref y, cw, 9);

            foreach (InkCheck c in new[] { fontsBox, obsidianBox, longformBox, diagramsBox, openBox })
            {
                c.SetBounds(Ink.R(PageMargin - 1.5f), (int)Math.Round(y), c.PreferredWidth(), Ink.R(27));
                y += 27 * s;
            }
            y += 9 * s;
            bar.SetBounds(Ink.R(PageMargin - 2), (int)Math.Round(y), Ink.R(cw + 4), Ink.R(20)); y += 20 * s;
            Place(status, PageMargin, ref y, cw, 2);
            details.SetBounds(Ink.R(PageMargin), (int)Math.Round(y), Ink.R(cw), (int)Math.Round(logRows * details.LineHeight + 6 * s)); y += details.Height + 12 * s;
            bottomY = (int)Math.Round(y);
            LayoutButtons();
            pageSize = new Size(Ink.R(PageWidth), bottomY + Ink.R(38) + Ink.R(16));
            ClientSize = pageSize;
            if (paper != null) { paper.Dispose(); paper = null; }
            pathBox.BackColor = AveragePaper(pathBox.Bounds);
        }

        void LayoutButtons()
        {
            int bh = Ink.R(38), right = Ink.R(PageWidth - PageMargin + 3.5f);
            closeButton.SetBounds(right - closeButton.PreferredWidth(104), bottomY, closeButton.PreferredWidth(104), bh);
            installButton.SetBounds(closeButton.Left - Ink.R(10) - installButton.PreferredWidth(116), bottomY, installButton.PreferredWidth(116), bh);
            Invalidate();
        }

        // The window's sheet of paper, made once for its size.
        public Bitmap Paper { get { return Sheet.Paper(ref paper, PageSize); } }


        Color AveragePaper(Rectangle r)
        {
            Bitmap b = Paper;
            long sr = 0, sg = 0, sb = 0, n = 0;
            for (int y = Math.Max(0, r.Top); y < Math.Min(b.Height, r.Bottom); y += 2)
                for (int x = Math.Max(0, r.Left); x < Math.Min(b.Width, r.Right); x += 3) { Color c = b.GetPixel(x, y); sr += c.R; sg += c.G; sb += c.B; n++; }
            return n == 0 ? Ink.Paper : Color.FromArgb((int)(sr / n), (int)(sg / n), (int)(sb / n));
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Sheet.TitleBar(Handle);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            // The folder box starts with the caret at the end of the path, not with the whole path highlighted.
            pathBox.SelectionStart = pathBox.TextLength; pathBox.SelectionLength = 0;
        }

        protected override void WndProc(ref Message m)
        {
            base.WndProc(ref m);
            // A preview drawn at a larger scale may be taller than the (small) CI screen: do not let Windows clip it.
            if (preview && m.Msg == 0x0024 /* WM_GETMINMAXINFO */) { Marshal.WriteInt32(m.LParam, 32, 20000); Marshal.WriteInt32(m.LParam, 36, 20000); }
        }

        protected override void OnPaintBackground(PaintEventArgs e) { }
        protected override void OnPaint(PaintEventArgs e) { PaintPage(e.Graphics); }

        public void PaintPage(Graphics g)
        {
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.DrawImage(Paper, 0, 0, Paper.Width, Paper.Height);
            Ink.Prepare(g);
            float s = Ink.S, cx = PageSize.Width / 2f;

            // Under the subtitle: a fleuron between two short pen rules.
            using (Font f = Typefaces.Make(Typefaces.Display, 25f, FontStyle.Regular))
            {
                const string fleuron = "\u2766";
                float w = Lettering.Width(g, fleuron, f), baseline = (float)Math.Round(ornamentY + f.Size * 0.30f);
                Lettering.Line(g, fleuron, f, Ink.A(Ink.Muted, 0.95f), (float)Math.Round(cx - w / 2), baseline);
                float gap = 12 * s, len = 62 * s;
                Ink.Stroke(g, Ink.Ruled(cx - w / 2 - gap - len, cx - w / 2 - gap, ornamentY, 0.35f * s, 0xA11Eu), 1.25f * s, Ink.A(Ink.Black, 0.6f), 0xA11Fu, 10 * s, 3 * s);
                Ink.Stroke(g, Ink.Ruled(cx + w / 2 + gap, cx + w / 2 + gap + len, ornamentY, 0.35f * s, 0xA120u), 1.25f * s, Ink.A(Ink.Black, 0.6f), 0xA121u, 3 * s, 10 * s);
            }

            // The folder path is written on a hand-ruled line. While setup runs, the text box is hidden and the path is
            // written here in faded ink.
            float x0 = pathBox.Left, x1 = pathBox.Right;
            float alpha = pathBox.Enabled || finished ? 1f : Ink.Faded;
            Ink.Stroke(g, Ink.Ruled(x0 - 1 * s, x1 + 4 * s, ruleY, 0.45f * s, 0x9A7Bu), 1.2f * s, Ink.A(Ink.Black, 0.72f * alpha), 0x9A7Cu, 5 * s, 5 * s);
            if (!pathBox.Enabled)
            {
                string text = pathBox.Text;
                while (text.Length > 1 && Lettering.Width(g, text, pathBox.Font) > x1 - x0 - 4 * s) text = text.Substring(0, text.Length - 2) + "…";
                Lettering.Line(g, text, pathBox.Font, Ink.A(Ink.Black, alpha), x0 + 1 * s, pathBox.Top + Lettering.Ascent(pathBox.Font) + 1 * s);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) detect.Dispose();
            if (disposing && paper != null) { paper.Dispose(); paper = null; }
            base.Dispose(disposing);
        }

        // ---------- behaviour ----------
        void OnBrowse(object sender, EventArgs e)
        {
            using (var dlg = new FolderBrowserDialog { Description = "Choose where to create the Scriptorium vault folder", ShowNewFolderButton = true })
            {
                if (dlg.ShowDialog(this) == DialogResult.OK) pathBox.Text = Path.Combine(dlg.SelectedPath, "Scriptorium");
            }
        }

        void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (worker != null && worker.IsAlive)
            {
                if (MessageBox.Show(this, "Setup is still running. Stop it?", "Scriptorium Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
                { e.Cancel = true; return; }
                cancel.Cancel();
            }
        }

        internal void Log(string line) { Log(line, false); }
        internal void Log(string line, bool error) { UI(() => details.Append(line, error)); }
        internal void Status(string text) { Status(text, false); }
        internal void Status(string text, bool failed) { UI(() => { status.Text = text; status.InkColor = failed ? Ink.Red : Ink.Muted; status.Invalidate(); }); }
        internal void Progress(int value, bool marquee)
        {
            UI(() => {
                if (bar.Marquee != marquee) bar.Marquee = marquee;
                if (!marquee) bar.Value = value;
            });
        }
        void UI(Action a) { if (IsDisposed) return; if (InvokeRequired) BeginInvoke(a); else a(); }

        void OnInstall(object sender, EventArgs e)
        {
            if (installedPath != null) { Process.Start("explorer.exe", "\"" + installedPath + "\""); return; }
            string dest;
            try { dest = Path.GetFullPath(pathBox.Text.Trim()); }
            catch { MessageBox.Show(this, "That folder path is not valid.", "Scriptorium Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
            Vaults.Target t;
            try { t = Vaults.Classify(dest); }
            catch (Exception ex) { MessageBox.Show(this, ex.Message, "Scriptorium Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
            if (t == Vaults.Target.Other)
            {
                MessageBox.Show(this, "That is a file, not a folder:\n" + dest + "\n\nChoose a folder.",
                                "Scriptorium Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (t == Vaults.Target.Folder)
            {
                // Show what setting it up will change, and ask.
                ShowTarget(t, true, null);
                Vaults.SetupPlan plan;
                try { plan = Vaults.PlanSetUp(dest); }
                catch (Exception ex) { MessageBox.Show(this, ex.Message, "Scriptorium Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
                using (var ask = new ConfirmForm(dest, plan)) if (ask.ShowDialog(this) != DialogResult.OK) return;
            }
            if (t == Vaults.Target.Vault)
            {
                ShowTarget(t, true, Vaults.VaultVersion(dest));
                using (var ask = new ConfirmForm(dest)) if (ask.ShowDialog(this) != DialogResult.OK) return;
            }
            bool fonts = fontsBox.Checked && fontsBox.Enabled, obsidian = obsidianBox.Checked && obsidianBox.Enabled,
                 longform = longformBox.Checked, diagrams = diagramsBox.Checked, open = openBox.Checked;
            Busy();
            worker = new Thread(() => Run(dest, t, fonts, obsidian, longform, diagrams, open)) { IsBackground = true };
            worker.SetApartmentState(ApartmentState.STA);
            worker.Start();
        }

        internal void Busy()
        {
            detect.Stop();
            foreach (Control c in new Control[] { pathBox, browse, fontsBox, obsidianBox, longformBox, diagramsBox, openBox, installButton }) c.Enabled = false;
            details.Clear();
        }

        void Run(string dest, Vaults.Target target, bool fonts, bool obsidian, bool longform, bool diagrams, bool open)
        {
            string temp = Path.Combine(Path.GetTempPath(), "scriptorium-setup-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temp);
            try
            {
                string exe = Installer.FindObsidian();
                if (obsidian)
                {
                    Status("Downloading Obsidian …");
                    string setup = Path.Combine(temp, Installer.ObsidianSetup.File);
                    Installer.Download(Installer.ObsidianSetup, setup, (d, t) => Progress(t > 0 ? (int)(100 * d / t) : 0, t <= 0), cancel.Token);
                    Log("Downloaded and verified " + Installer.ObsidianSetup.Label);
                    Status("Installing Obsidian for this user …"); Progress(0, true);
                    using (Process p = Process.Start(new ProcessStartInfo(setup, "/S /currentuser") { UseShellExecute = false }))
                    {
                        p.WaitForExit();
                        if (p.ExitCode != 0)
                            throw new InvalidOperationException("Obsidian's installer failed (exit code " + p.ExitCode + "), so Obsidian was not installed. " +
                                "Nothing else was changed. Install Obsidian from https://obsidian.md, then run Scriptorium Setup again.");
                    }
                    exe = Installer.FindObsidian();
                    if (exe == null)
                        throw new InvalidOperationException("Obsidian's installer ran, but Obsidian is still not on this computer (Obsidian.exe was not found). " +
                            "Nothing else was changed. Install Obsidian from https://obsidian.md, then run Scriptorium Setup again.");
                    Log("Installed Obsidian (" + exe + ")");
                }
                if (fonts)
                {
                    // Face by face: whatever is missing, unregistered or damaged is put right, and looked at again.
                    Fonts.ISystem system = Fonts.Current;
                    if (system != null)
                    {
                        int need = Math.Max(1, Fonts.Check(system).Count(st => !st.Ok)), done = 0;
                        Fonts.Outcome o = Fonts.Repair(system, face =>
                        {
                            int k = done++;
                            Status("Downloading fonts (" + (k + 1) + " of " + need + ") …");
                            return Fonts.Fetch(face, temp, (d, t) => Progress((int)(100.0 * (k + (t > 0 ? (double)d / t : 0)) / need), false), cancel.Token);
                        }, Log);
                        if (o.Failed.Count > 0) Log(Fonts.Report(o), true);
                    }
                }
                cancel.Token.ThrowIfCancellationRequested();
                if (target == Vaults.Target.Vault || target == Vaults.Target.Folder) { UpdateVault(dest, temp, longform, diagrams, open, exe, target == Vaults.Target.Folder); return; }
                Status("Creating the vault …"); Progress(0, true);
                Installer.ExtractVault(dest, Log, target == Vaults.Target.Empty);
                if (longform)
                {
                    // The vault exists now, so a Longform failure (or a stop) must not fail or undo the install.
                    Status("Downloading Longform …"); Progress(0, false);
                    try
                    {
                        Installer.InstallLongform(dest, temp, p => Progress(p, false), cancel.Token);
                        Log("Installed Longform 2.1.0 from its official release");
                    }
                    catch (Exception ex)
                    {
                        Log("Longform could not be downloaded; install it from Settings → Community plugins.");
                        Log("  (" + ex.Message + ")");
                    }
                }
                // (the vault exists now: a diagram plugin that cannot be downloaded does not fail or undo the install)
                if (diagrams) DiagramPlugins.Install(dest, temp, Log, (text, percent) => { Status(text); Progress(percent, false); }, cancel.Token);
                Progress(100, false);
                AutoOpen.Outcome opened = open ? OpenNewVault(dest, exe) : null;
                Progress(100, false);
                installedPath = dest;
                UI(() => Done(dest));
                if (opened != null && opened.Result == AutoOpen.Result.Trusted)
                {
                    Log("Opened the vault in Obsidian with its community plugins on.");
                    Log("Open Lorem Ipsum in Reading view.");
                }
                else if (opened != null && opened.Result == AutoOpen.Result.Opened)
                {
                    Log("Opened the vault in Obsidian; its plugins are not on yet (" + opened.Problem + ").", opened.Problem != null && !opened.Problem.StartsWith("this Obsidian"));
                    Log("When Obsidian asks, choose \"Trust author and enable plugins\". Then open Lorem Ipsum in Reading view.");
                }
                else
                {
                    if (opened != null && opened.Problem != null) Log("Did not open the vault in Obsidian: " + opened.Problem + ".", true);
                    Log("In Obsidian, choose \"Open folder as vault\" and select the folder above (its path is on the clipboard).");
                    Log("Then open Lorem Ipsum in Reading view. Restart Obsidian if it was already running, so it sees new fonts.");
                    if (open) OpenVaultChooser(exe);
                }
                if (opened != null && opened.CliPending)
                    Log("Obsidian's command line interface, turned on for setup, will be turned off when Obsidian closes.");
            }
            catch (OperationCanceledException)
            {
                Status(target == Vaults.Target.Vault || target == Vaults.Target.Folder ? "Stopped. Nothing in the vault was changed." : "Stopped. Nothing was created.");
                UI(() => ResetControls());
            }
            catch (Exception ex)
            {
                Log("Error: " + ex.Message, true);
                Status("Setup failed. See the details below.", true);
                UI(() => {
                    MessageBox.Show(this, ex.Message, "Scriptorium Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    ResetControls();
                });
            }
            finally
            {
                try { Directory.Delete(temp, true); } catch { }
            }
        }

        // "Open the vault in Obsidian and turn on its plugins" (see AutoOpen). That needs Obsidian closed, so if it is open
        // the user is asked to close it and retry, or to skip (the vault is then left for "Open folder as vault").
        AutoOpen.Outcome OpenNewVault(string dest, string exe)
        {
            if (exe == null) return new AutoOpen.Outcome { Problem = "Obsidian is not installed on this computer (Obsidian.exe was not found)" };
            while (AutoOpen.ObsidianRunning())
            {
                Status("Obsidian is open …");
                DialogResult answer = Ask("Obsidian is open. To open the new vault with its plugins turned on, Setup has to start " +
                                          "Obsidian itself.\n\nClose Obsidian, then choose Retry. Choose Cancel to skip this; you can " +
                                          "then open the vault from Obsidian's vault switcher.");
                if (answer != DialogResult.Retry) return new AutoOpen.Outcome { Problem = "Obsidian was open" };
            }
            Status("Opening the vault in Obsidian and turning on its plugins …"); Progress(0, true);
            return AutoOpen.Open(exe, dest, 120000, cancel.Token);
        }

        DialogResult Ask(string text)
        {
            if (IsDisposed) return DialogResult.Cancel;
            return (DialogResult)Invoke(new Func<DialogResult>(() =>
                MessageBox.Show(this, text, "Scriptorium Setup", MessageBoxButtons.RetryCancel, MessageBoxIcon.Information)));
        }

        // Obsidian's vault switcher, where "Open folder as vault" is.
        void OpenVaultChooser(string exe)
        {
            try
            {
                // (never through the obsidian:// link alone: without the program it is a leftover that opens nothing)
                if (exe != null) Process.Start(new ProcessStartInfo(exe, "obsidian://choose-vault") { UseShellExecute = false });
                else Log("Obsidian is not installed on this computer: install it from https://obsidian.md, then open the folder above as a vault.", true);
            }
            catch (Exception ex) { Log("Could not open Obsidian: " + ex.Message, true); }
        }

        // Update: Longform is downloaded first (if ticked), then the vault is updated in one step, backed up and undone on
        // failure (see Vaults.Update). setup: the folder is not a Scriptorium vault yet, and is set up as one (see
        // Vaults.SetUp); it is then opened like a new vault, with its plugins turned on.
        void UpdateVault(string dest, string temp, bool longform, bool diagrams, bool open, string exe, bool setup)
        {
            string longformFiles = null;
            if (longform)
            {
                Status("Downloading Longform …"); Progress(0, false);
                try
                {
                    longformFiles = Installer.DownloadLongform(temp, p => Progress(p, false), cancel.Token);
                    Log("Downloaded and verified Longform 2.1.0");
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception ex)
                {
                    Log("Longform could not be downloaded, so it was left as it is.");
                    Log("  (" + ex.Message + ")");
                }
            }
            cancel.Token.ThrowIfCancellationRequested();
            Status(setup ? "Setting up the vault …" : "Updating the vault …"); Progress(0, true);
            Vaults.Report report = setup ? Vaults.SetUp(dest, longformFiles, line => Log(line.TrimStart()))
                                         : Vaults.Update(dest, longformFiles, line => Log(line));
            // (the vault is updated, or set up, now: the diagram plugins cannot fail or undo that)
            if (diagrams) DiagramPlugins.Install(dest, temp, Log, (text, percent) => { Status(text); Progress(percent, false); }, cancel.Token);
            Progress(100, false);
            if (setup)
            {
                AutoOpen.Outcome opened = open ? OpenNewVault(dest, exe) : null;
                Progress(100, false);
                installedPath = dest;
                string setUp = Vaults.SetUpStatus(report);
                UI(() => UpdateDone(setUp));
                if (opened != null && opened.Result == AutoOpen.Result.Trusted) Log("Opened the vault in Obsidian with its community plugins on.");
                else if (opened != null && opened.Result == AutoOpen.Result.Opened)
                    Log("Opened the vault in Obsidian. When it asks, choose \"Trust author and enable plugins\".");
                else
                {
                    if (opened != null && opened.Problem != null) Log("Did not open the vault in Obsidian: " + opened.Problem + ".", true);
                    Log("Open the vault in Obsidian (reload it if it was open) and, when it asks, choose \"Trust author and enable plugins\".");
                }
                if (opened != null && opened.CliPending)
                    Log("Obsidian's command line interface, turned on for setup, will be turned off when Obsidian closes.");
                return;
            }
            installedPath = dest;
            string message = Vaults.UpdatedMessage(dest, report), done = Vaults.UpdatedStatus(report);
            UI(() => UpdateDone(done));
            Log(message);
            if (open)
            {
                try
                {
                    if (exe != null) Process.Start(new ProcessStartInfo(exe) { UseShellExecute = false });
                    else Log("Obsidian is not installed on this computer, so the vault was not opened: install it from https://obsidian.md.", true);
                }
                catch (Exception ex) { Log("Could not open Obsidian: " + ex.Message, true); }
            }
        }

        internal void UpdateDone(string message)
        {
            status.Text = message; status.InkColor = Ink.Muted; status.Invalidate();
            installButton.Text = "Open folder"; installButton.Enabled = true; closeButton.Text = "Finish";
            ShowRecord(true);
        }

        internal void Done(string dest)
        {
            status.Text = "Done. Your vault is in " + dest;
            if (!preview) Clipboard.SetText(dest);
            installButton.Text = "Open folder"; installButton.Enabled = true; closeButton.Text = "Finish";
            ShowRecord(true);
        }

        void ShowRecord(bool on)
        {
            finished = on;
            foreach (InkCheck c in new[] { fontsBox, obsidianBox, longformBox, diagramsBox, openBox }) c.Record = on;
            Invalidate();
        }

        internal void ResetControls()
        {
            ShowRecord(false);
            Progress(0, false);
            foreach (Control c in new Control[] { pathBox, browse, longformBox, diagramsBox, openBox, installButton }) c.Enabled = true;
            string offer = FontsOffer();   // after an install or a repair the fonts are looked at again
            fontsBox.Text = offer ?? "EB Garamond and Cormorant Garamond are already installed";
            fontsBox.Enabled = offer != null; fontsBox.Checked = offer != null;
            obsidianBox.Enabled = !ObsidianInstalled();
        }

        // ---------- for the rendered previews ----------
        internal InkButton InstallButton { get { return installButton; } }
        internal InkButton BrowseButton { get { return browse; } }
        internal InkCheck LongformBox { get { return longformBox; } }
        internal InkProgress Bar { get { return bar; } }
        internal string PreviewPath { get { return pathBox.Text; } }
        internal void PreviewTarget(Vaults.Target t, string version) { ShowTarget(t, true, version); }
        internal void PreviewInstalled() { ShowInstalled(null, true); }
    }

    // The question asked before an update, drawn like the setup window: a heading in rubric, a short pen rule, what will
    // happen, the vault's path, and two inked buttons (Update is the default; Esc or Cancel says no).
    class ConfirmForm : Form, IPage
    {
        readonly InkLabel heading, body, where;
        readonly InkButton yes = new InkButton("Update", true), no = new InkButton("Cancel", false);
        Bitmap paper;
        Size pageSize;
        float ruleY;
        const float PageWidth = 480, PageMargin = 34;

        public ConfirmForm(string vault) : this(vault, null) { }

        // plan: not null when the folder is to be set up as a Scriptorium vault (what will change is said in the question).
        public ConfirmForm(string vault, Vaults.SetupPlan plan)
        {
            SuspendLayout();
            Text = "Scriptorium Setup";
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false; MinimizeBox = false; ShowInTaskbar = false; ShowIcon = false;
            StartPosition = FormStartPosition.CenterParent;
            BackColor = Ink.Paper; ForeColor = Ink.Black;
            DoubleBuffered = true;
            Font = Typefaces.Make(Typefaces.Text, 16f, FontStyle.Regular);

            string question = "Update Scriptorium in this vault?";
            string says = "Your notes and settings stay; Scriptorium's files are replaced (the old ones are backed up in " +
                          ".obsidian\\scriptorium-backup-…).";
            if (plan != null)
            {
                question = "Set up Scriptorium in this vault?";
                yes.Text = "Set up";
                says = plan.Adds + plan.Replaces == 0
                    ? "Scriptorium is already set up here: nothing will be changed."
                    : "Your notes are not touched. In its .obsidian folder, " + plan.Adds + (plan.Adds == 1 ? " file is" : " files are") + " added and " +
                      plan.Replaces + " replaced or merged: Scriptorium's plugins, snippet and theme are added, your own plugins and " +
                      "snippets stay on, and the theme becomes Typewriter. The folder as it is now is first copied to " +
                      ".obsidian\\scriptorium-backup-….";
            }
            heading = new InkLabel(question, Typefaces.Make(Typefaces.Display, 31f, FontStyle.Regular), Ink.Red, false) { Above = 0.9f, Below = 0.28f };
            body = new InkLabel(says, Typefaces.Make(Typefaces.Text, 16.5f, FontStyle.Regular), Ink.Black, false) { Leading = 1.32f };
            where = new InkLabel(vault, Typefaces.Make(Typefaces.Text, 15.5f, FontStyle.Italic), Ink.Muted, false) { MaxLines = 2 };
            yes.Name = "confirm-update"; no.Name = "confirm-cancel";
            yes.DialogResult = DialogResult.OK; no.DialogResult = DialogResult.Cancel;
            yes.TabIndex = 0; no.TabIndex = 1;
            AcceptButton = yes; CancelButton = no;
            Controls.AddRange(new Control[] { heading, body, where, yes, no });

            float s = Ink.S, cw = PageWidth - 2 * PageMargin, y = 16 * s;
            Place(heading, ref y, cw, 0);
            ruleY = y + 6 * s; y += 18 * s;
            Place(body, ref y, cw, 8);
            Place(where, ref y, cw, 18);
            int bh = Ink.R(38), right = Ink.R(PageWidth - PageMargin + 3.5f), top = (int)Math.Round(y);
            no.SetBounds(right - no.PreferredWidth(104), top, no.PreferredWidth(104), bh);
            yes.SetBounds(no.Left - Ink.R(10) - yes.PreferredWidth(116), top, yes.PreferredWidth(116), bh);
            pageSize = new Size(Ink.R(PageWidth), top + bh + Ink.R(16));
            ClientSize = pageSize;
            ResumeLayout(false);
        }

        static void Place(InkLabel label, ref float y, float width, float after)
        {
            int h = label.HeightFor(Ink.R(width), 0);
            label.SetBounds(Ink.R(PageMargin), (int)Math.Round(y), Ink.R(width), h);
            y += h + after * Ink.S;
        }

        public Size PageSize { get { return pageSize; } }
        public Bitmap Paper { get { return Sheet.Paper(ref paper, PageSize); } }

        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Sheet.TitleBar(Handle); }
        protected override void OnPaintBackground(PaintEventArgs e) { }
        protected override void OnPaint(PaintEventArgs e) { PaintPage(e.Graphics); }

        public void PaintPage(Graphics g)
        {
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.DrawImage(Paper, 0, 0, Paper.Width, Paper.Height);
            Ink.Prepare(g);
            float s = Ink.S, x0 = PageMargin * s;
            Ink.Stroke(g, Ink.Ruled(x0, x0 + 74 * s, ruleY, 0.35f * s, 0xB0B0u), 1.25f * s, Ink.A(Ink.Red, 0.55f), 0xB0B1u, 3 * s, 12 * s);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && paper != null) { paper.Dispose(); paper = null; }
            base.Dispose(disposing);
        }
    }

    // --render <folder>: draws the window, offscreen, in a scripted series of states and saves each as a PNG, plus the
    // frames of a whole (simulated) install for an animation. Nothing is detected, downloaded or installed. Used by CI so
    // the design can be reviewed from real Windows renderings.
    static class Preview
    {
        static StreamWriter log;

        public static int Run(string dir)
        {
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
            Directory.CreateDirectory(Path.Combine(dir, "anim"));
            using (log = new StreamWriter(Path.Combine(dir, "render.log")))
            {
                try
                {
                    log.WriteLine("Embedded fonts: " + Typefaces.Embedded + ". " + Typefaces.Report);
                    using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) log.WriteLine("Screen DPI: " + g.DpiX + ", OS: " + Environment.OSVersion);
                    States(dir);
                    UpdateStates(dir);
                    Animation(dir);
                    Ink.S = 1.5f;
                    using (SetupForm f = Open()) { log.WriteLine("Client size at 150%: " + f.ClientSize); Save(f, dir, "08-ready-150.png"); }
                    Ink.S = 1f;
                    log.WriteLine("OK");
                    return 0;
                }
                catch (Exception e) { log.WriteLine("FAILED: " + e); return 1; }
            }
        }

        static SetupForm Open()
        {
            var f = new SetupForm(true) { StartPosition = FormStartPosition.Manual, Location = new Point(-30000, -30000), ShowInTaskbar = false };
            f.Show();
            Application.DoEvents();
            return f;
        }

        static void States(string dir)
        {
            Ink.S = 1f;
            using (SetupForm f = Open())
            {
                log.WriteLine("Client size: " + f.ClientSize);
                Save(f, dir, "01-ready.png");
                try { f.DrawToBitmapCheck(dir); } catch (Exception e) { log.WriteLine("DrawToBitmap: " + e.Message); }
                CaptureScreen(f, dir, "00-window.png");

                f.InstallButton.Hover = true; f.LongformBox.ShowFocus = true;
                Save(f, dir, "06-hover-focus.png");
                f.InstallButton.Hover = false; f.LongformBox.ShowFocus = false;
                f.BrowseButton.ShowFocus = true; f.InstallButton.Hover = true; f.InstallButton.Pressed = true; f.LongformBox.Hover = true;
                Save(f, dir, "07-pressed-focus.png");
                f.BrowseButton.ShowFocus = false; f.InstallButton.Hover = false; f.InstallButton.Pressed = false; f.LongformBox.Hover = false;

                f.Busy();
                f.Log("Downloaded and verified " + Installer.ObsidianSetup.Label);
                f.Log("Installed Obsidian");
                f.Log("Installed " + Installer.EbGaramond[0].Label);
                f.Status("Downloading fonts (2 of 4) …"); f.Progress(40, false);
                Save(f, dir, "02-fonts-40.png");

                for (int i = 1; i < 4; i++) f.Log("Installed " + (i < 2 ? Installer.EbGaramond[i] : Installer.Cormorant[i - 2]).Label);
                f.Status("Creating the vault …"); f.Progress(0, true); f.Bar.StopTimer(); f.Bar.Phase = 0.42f;
                Save(f, dir, "03-installing.png");

                f.Log("Created the vault in " + f.PreviewPath);
                f.Status("Downloading Longform …"); f.Progress(0, false);
                f.Log("Installed Longform 2.1.0 from its official release");
                f.Progress(100, false);
                f.Done(f.PreviewPath);
                f.Log("Opened the vault in Obsidian with its community plugins on.");
                f.Log("Open Lorem Ipsum in Reading view.");
                Save(f, dir, "04-done.png");
            }
            using (SetupForm f = Open())
            {
                f.Busy();
                f.Log("Downloaded and verified " + Installer.ObsidianSetup.Label);
                f.Log("Installed Obsidian");
                f.Log("Error: Verification failed for " + Installer.EbGaramond[0].Label + ". Nothing was installed from it.", true);
                f.Status("Setup failed. See the details below.", true);
                f.ResetControls();
                Save(f, dir, "05-error.png");
            }
        }

        // Updating a vault: the folder is a Scriptorium vault (the button reads Update), the question, the update done;
        // and a folder with files in it that is not a vault yet (the button reads Set up), and its question.
        static void UpdateStates(string dir)
        {
            Ink.S = 1f;
            string from = Vaults.PackageVersion();   // what Scriptorium Setup 1.0.4 installed
            using (SetupForm f = Open())
            {
                f.PreviewInstalled();
                f.PreviewTarget(Vaults.Target.Vault, from);
                Save(f, dir, "09-update-ready.png");

                using (var ask = new ConfirmForm(f.PreviewPath) { StartPosition = FormStartPosition.Manual, Location = new Point(-30000, -30000) })
                {
                    ask.Show();
                    Application.DoEvents();
                    Save(ask, dir, "10-update-confirm.png");
                    CaptureScreen(ask, dir, "10-update-confirm-window.png");
                }

                f.Busy();
                f.Status("Updating the vault …"); f.Progress(0, true); f.Bar.StopTimer(); f.Bar.Phase = 0.6f;
                f.Log("Downloaded and verified Longform 2.1.0");
                Save(f, dir, "11-update-running.png");

                string vault = f.PreviewPath;
                var report = new Vaults.Report { From = from, To = Vaults.PackageVersion(), Replaced = 9, Added = 0 };
                f.Log("Backed up 9 files in " + Path.Combine(vault, ".obsidian", "scriptorium-backup-20261111-121500"));
                f.Log("Turned the manuscript snippet back on");
                f.Log("Replaced 9 files");
                f.Log("Kept your notes and settings");
                string message = Vaults.UpdatedMessage(vault, report);
                f.Progress(100, false);
                f.UpdateDone(Vaults.UpdatedStatus(report));
                f.Log(message);
                Save(f, dir, "12-update-done.png");
            }
            using (SetupForm f = Open())
            {
                f.PreviewTarget(Vaults.Target.Folder, null);
                Save(f, dir, "13-set-up-ready.png");
                using (var ask = new ConfirmForm(f.PreviewPath, new Vaults.SetupPlan { Adds = 25, Replaces = 2 }) { StartPosition = FormStartPosition.Manual, Location = new Point(-30000, -30000) })
                {
                    ask.Show();
                    Application.DoEvents();
                    Save(ask, dir, "14-set-up-confirm.png");
                }
            }
        }

        static void Animation(string dir)
        {
            Ink.S = 1f;
            using (SetupForm f = Open())
            using (var timing = new StreamWriter(Path.Combine(dir, "anim", "frames.txt")))
            {
                int n = 0;
                Action<int> frame = ms => { string name = "frame-" + n.ToString("000") + ".png"; Save(f, dir, Path.Combine("anim", name)); timing.WriteLine(name + " " + ms); n++; };
                frame(1600);
                f.InstallButton.Hover = true; frame(600);
                f.InstallButton.Pressed = true; frame(180);
                f.InstallButton.Pressed = false; f.InstallButton.Hover = false;
                f.Busy(); f.Status("Downloading Obsidian …"); f.Progress(0, false); f.Bar.StopTimer(); frame(260);
                foreach (int p in new[] { 9, 22, 38, 55, 71, 86, 100 }) { f.Progress(p, false); frame(130); }
                f.Log("Downloaded and verified " + Installer.ObsidianSetup.Label);
                f.Status("Installing Obsidian for this user …"); f.Progress(0, true); f.Bar.StopTimer();
                for (int k = 0; k < 7; k++) { f.Bar.Phase = k / 7f; f.Bar.Invalidate(); frame(110); }
                f.Log("Installed Obsidian");
                var fonts = Installer.EbGaramond.Concat(Installer.Cormorant).ToArray();
                for (int i = 0; i < fonts.Length; i++)
                {
                    f.Status("Downloading fonts (" + (i + 1) + " of " + fonts.Length + ") …");
                    if (i == 0) { f.Progress(0, false); }
                    foreach (double q in new[] { 0.3, 0.65, 1.0 }) { f.Progress((int)(100.0 * (i + q) / fonts.Length), false); frame(110); }
                    f.Log("Installed " + fonts[i].Label);
                }
                f.Status("Creating the vault …"); f.Progress(0, true); f.Bar.StopTimer();
                for (int k = 0; k < 5; k++) { f.Bar.Phase = 0.1f + k / 6f; f.Bar.Invalidate(); frame(110); }
                f.Log("Created the vault in " + f.PreviewPath);
                f.Status("Downloading Longform …"); f.Progress(0, false);
                foreach (int p in new[] { 34, 67, 100 }) { f.Progress(p, false); frame(130); }
                f.Log("Installed Longform 2.1.0 from its official release");
                f.Status("Opening the vault in Obsidian and turning on its plugins …"); f.Progress(0, true); f.Bar.StopTimer();
                for (int k = 0; k < 5; k++) { f.Bar.Phase = 0.2f + k / 6f; f.Bar.Invalidate(); frame(110); }
                f.Progress(100, false);
                f.Done(f.PreviewPath);
                f.Log("Opened the vault in Obsidian with its community plugins on.");
                f.Log("Open Lorem Ipsum in Reading view.");
                frame(1400);
                f.InstallButton.Hover = true; frame(3000);
            }
        }

        // Draws the window's client area the way Windows paints it: the page, then each control with its own paint
        // routine; the native text box is printed by Windows itself (WM_PRINT, via DrawToBitmap).
        internal static Bitmap Capture(Form f)
        {
            var page = (IPage)f;
            var bmp = new Bitmap(page.PageSize.Width, page.PageSize.Height, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                page.PaintPage(g);
                for (int i = f.Controls.Count - 1; i >= 0; i--)   // bottom of the z-order first, as Windows paints them
                {
                    Control c = f.Controls[i];
                    if (!c.Visible) continue;
                    GraphicsState state = g.Save();
                    g.TranslateTransform(c.Left, c.Top);
                    g.SetClip(new Rectangle(0, 0, c.Width, c.Height));
                    var inked = c as IInked;
                    if (inked != null) inked.PaintTo(g);
                    else
                        using (var cb = new Bitmap(c.Width, c.Height, PixelFormat.Format32bppArgb))
                        {
                            c.DrawToBitmap(cb, new Rectangle(0, 0, c.Width, c.Height));
                            g.InterpolationMode = InterpolationMode.NearestNeighbor;
                            g.PixelOffsetMode = PixelOffsetMode.Half;
                            g.DrawImage(cb, new Rectangle(0, 0, c.Width, c.Height), 0, 0, c.Width, c.Height, GraphicsUnit.Pixel);
                        }
                    g.Restore(state);
                }
            }
            return bmp;
        }

        static void Save(Form f, string dir, string name)
        {
            Application.DoEvents();
            using (Bitmap b = Capture(f)) b.Save(Path.Combine(dir, name), ImageFormat.Png);
            log.WriteLine("Saved " + name);
        }

        // The real window on the (CI) desktop, title bar and all, if there is a desktop to draw it on.
        static void CaptureScreen(Form f, string dir, string name)
        {
            try
            {
                f.Location = new Point(40, 40); f.TopMost = true;
                f.Refresh();
                for (int i = 0; i < 20; i++) { Application.DoEvents(); Thread.Sleep(25); }
                using (var b = new Bitmap(f.Width, f.Height, PixelFormat.Format32bppArgb))
                {
                    using (Graphics g = Graphics.FromImage(b)) g.CopyFromScreen(f.Location, Point.Empty, f.Size);
                    b.Save(Path.Combine(dir, name), ImageFormat.Png);
                }
                log.WriteLine("Saved " + name);
            }
            catch (Exception e) { log.WriteLine("Screen capture: " + e.Message); }
            finally { f.TopMost = false; f.Location = new Point(-30000, -30000); Application.DoEvents(); }
        }
    }

    static class FormExtensions
    {
        // For comparison: what Control.DrawToBitmap makes of the whole form.
        public static void DrawToBitmapCheck(this SetupForm f, string dir)
        {
            using (var b = new Bitmap(f.Width, f.Height, PixelFormat.Format32bppArgb))
            {
                f.DrawToBitmap(b, new Rectangle(0, 0, f.Width, f.Height));
                b.Save(Path.Combine(dir, "00-drawtobitmap.png"), ImageFormat.Png);
            }
        }
    }
}
