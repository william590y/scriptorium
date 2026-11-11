// Scriptorium Setup: a small Windows installer with a window, doing what Install-Scriptorium-Windows.cmd does.
//
// It creates a NEW vault folder from the Scriptorium configuration (embedded in this .exe, so it always matches the
// installer's version), installs Obsidian for the current user if it is missing, and installs EB Garamond and Cormorant
// Garamond for the current user if they are missing. The Longform plugin is not bundled: if the user ticks it, it is
// downloaded from its author's official release into the new vault. Every download is pinned by SHA-256. An existing
// folder is never changed. Targets .NET Framework 4.8, which ships with Windows 10 and 11, so nothing else needs installing.
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
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Text;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Scriptorium Setup")]
[assembly: AssemblyDescription("Installs the Scriptorium configuration for Obsidian")]
[assembly: AssemblyProduct("Scriptorium")]
[assembly: AssemblyCompany("williamliaw.com")]
[assembly: AssemblyCopyright("Copyright (C) 2026 William Liaw. GPL-3.0-or-later.")]
[assembly: AssemblyVersion("1.0.3.0")]
[assembly: AssemblyFileVersion("1.0.3.0")]

namespace ScriptoriumSetup
{
    static class Program
    {
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        [STAThread]
        static int Main(string[] args)
        {
            // Headless check used by the build script: unpack the embedded vault into a new folder and exit.
            if (args.Length == 2 && args[0] == "--extract-only")
            {
                try { Installer.ExtractVault(Path.GetFullPath(args[1]), null); Console.WriteLine("OK " + args[1]); return 0; }
                catch (Exception e) { Console.Error.WriteLine("FAILED: " + e.Message); return 1; }
            }
            if (Installer.IsWindows) { try { SetProcessDPIAware(); } catch { } }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm());
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
        // must not exist yet (created here, so an existing folder is never merged into).
        public static void ExtractVault(string destination, Action<string> log)
        {
            if (Directory.Exists(destination) || File.Exists(destination))
                throw new InvalidOperationException("The folder already exists: " + destination + "\nChoose a new folder; nothing was changed.");
            string temp = Path.Combine(Path.GetTempPath(), "scriptorium-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temp);
            try
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
                Directory.CreateDirectory(Path.GetDirectoryName(destination));
                if (Directory.Exists(destination)) throw new InvalidOperationException("The folder appeared while installing: " + destination);
                Directory.CreateDirectory(destination);
                try { CopyTree(staging, destination); }
                catch { try { Directory.Delete(destination, true); } catch { } throw; }
                if (log != null) log("Created the vault in " + destination);
            }
            finally { try { Directory.Delete(temp, true); } catch { } }
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
            string staging = Path.Combine(temp, "longform");
            Directory.CreateDirectory(staging);
            for (int i = 0; i < Longform.Length; i++)
            {
                int k = i;
                Download(Longform[i], Path.Combine(staging, Longform[i].File),
                         (d, t) => { if (progress != null) progress((int)(100.0 * (k + (t > 0 ? (double)d / t : 0)) / Longform.Length)); }, cancel);
            }
            string dir = Path.Combine(vault, ".obsidian", "plugins", "longform");
            Directory.CreateDirectory(dir);
            foreach (Pinned p in Longform) File.Copy(Path.Combine(staging, p.File), Path.Combine(dir, p.File));
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
        public static string FindObsidian()
        {
            foreach (string baseDir in new[] {
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) })
            {
                if (string.IsNullOrEmpty(baseDir)) continue;
                foreach (string rel in new[] { @"Obsidian\Obsidian.exe", @"Programs\Obsidian\Obsidian.exe" })
                {
                    string exe = Path.Combine(baseDir, rel);
                    if (File.Exists(exe)) return exe;
                }
            }
            return null;
        }

        public static bool ObsidianProtocolRegistered()
        {
            if (!IsWindows) return false;
            using (RegistryKey k = Registry.ClassesRoot.OpenSubKey(@"obsidian\shell\open\command")) return k != null;
        }

        // ---------- fonts ----------
        [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
        static extern int AddFontResourceEx(string path, uint flags, IntPtr reserved);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);

        public static bool FontFamilyInstalled(string family)
        {
            using (var fonts = new InstalledFontCollection())
                return fonts.Families.Any(f => string.Equals(f.Name, family, StringComparison.OrdinalIgnoreCase));
        }

        // Per-user font install (no administrator rights needed, Windows 10 1809 and later).
        public static void InstallFont(Pinned font, string downloaded)
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Windows\Fonts");
            string target = Path.Combine(dir, font.File);
            if (File.Exists(target))
            {
                if (Sha256(target) != font.Sha256) throw new InvalidOperationException("A different font file is already installed at " + target);
            }
            else
            {
                Directory.CreateDirectory(dir);
                File.Copy(downloaded, target);
            }
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows NT\CurrentVersion\Fonts"))
                k.SetValue(font.Label, target, RegistryValueKind.String);
            if (AddFontResourceEx(target, 0, IntPtr.Zero) == 0) throw new InvalidOperationException("Windows could not load the font " + target);
        }

        public static void AnnounceFontChange()
        {
            UIntPtr result;
            SendMessageTimeout((IntPtr)0xffff, 0x001D /* WM_FONTCHANGE */, UIntPtr.Zero, IntPtr.Zero, 2 /* SMTO_ABORTIFHUNG */, 5000, out result);
        }
    }

    class SetupForm : Form
    {
        readonly TextBox pathBox = new TextBox();
        readonly Button browse = new Button();
        readonly CheckBox fontsBox = new CheckBox(), obsidianBox = new CheckBox(), longformBox = new CheckBox(), openBox = new CheckBox();
        readonly ProgressBar bar = new ProgressBar();
        readonly Label status = new Label();
        readonly TextBox details = new TextBox();
        readonly Button installButton = new Button(), closeButton = new Button();
        readonly CancellationTokenSource cancel = new CancellationTokenSource();
        Thread worker;
        string installedPath;

        static readonly Color Paper = Color.FromArgb(0xF7, 0xF2, 0xE7), Ink = Color.FromArgb(0x2A, 0x24, 0x20),
                              Muted = Color.FromArgb(0x59, 0x59, 0x59), Rubric = Color.FromArgb(0x8B, 0x23, 0x23);

        public SetupForm()
        {
            SuspendLayout();
            Text = "Scriptorium Setup";
            // Laid out at 96 dpi; WinForms scales everything to the display's scaling (the exe is DPI-aware).
            AutoScaleDimensions = new SizeF(96f, 96f);
            AutoScaleMode = AutoScaleMode.Dpi;
            Font = new Font("Segoe UI", 9f);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(560, 564);
            BackColor = Paper; ForeColor = Ink;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            // One column of rows; each row sizes to its content, the details box takes what is left.
            var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, Padding = new Padding(22, 14, 22, 14), BackColor = Paper };
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));

            var title = new Label { Text = "Scriptorium", Font = new Font("Georgia", 22f, FontStyle.Regular), ForeColor = Rubric,
                                    AutoSize = true, Margin = new Padding(0, 0, 0, 2) };
            var subtitle = new Label { Text = "Book-page typography for Obsidian. This creates a new vault with the Scriptorium " +
                                              "configuration and a Lorem Ipsum sample note.",
                                       ForeColor = Muted, AutoSize = true, MaximumSize = new Size(510, 0), Margin = new Padding(1, 0, 0, 12) };
            var folderLabel = new Label { Text = "New vault folder", AutoSize = true, Margin = new Padding(1, 0, 0, 3) };

            var folderRow = new TableLayoutPanel { ColumnCount = 2, AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0) };
            folderRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
            folderRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            pathBox.Text = Installer.DefaultVault; pathBox.Dock = DockStyle.Fill; pathBox.Margin = new Padding(0, 1, 8, 0);
            browse.Text = "Browse…"; browse.AutoSize = true; browse.MinimumSize = new Size(88, 0); browse.Margin = new Padding(0); browse.Click += OnBrowse;
            folderRow.Controls.Add(pathBox, 0, 0); folderRow.Controls.Add(browse, 1, 0);

            var folderHint = new Label { Text = "The folder must not exist yet. An existing folder is never changed.", ForeColor = Muted,
                                         AutoSize = true, Margin = new Padding(1, 4, 0, 12) };

            bool hasFonts = Installer.FontFamilyInstalled("EB Garamond") && Installer.FontFamilyInstalled("Cormorant Garamond");
            fontsBox.Text = hasFonts ? "EB Garamond and Cormorant Garamond are already installed"
                                     : "Install the fonts it uses for me (EB Garamond, Cormorant Garamond)";
            fontsBox.Checked = !hasFonts; fontsBox.Enabled = !hasFonts;
            bool hasObsidian = Installer.FindObsidian() != null || Installer.ObsidianProtocolRegistered();
            obsidianBox.Text = hasObsidian ? "Obsidian is already installed" : "Download and install Obsidian 1.15.0 for me";
            obsidianBox.Checked = !hasObsidian; obsidianBox.Enabled = !hasObsidian;
            longformBox.Text = "Download the Longform plugin from its official release"; longformBox.Checked = true;
            openBox.Text = "Open Obsidian when done"; openBox.Checked = true;
            foreach (CheckBox c in new[] { fontsBox, obsidianBox, longformBox, openBox }) { c.AutoSize = true; c.Margin = new Padding(0, 0, 0, 4); }
            openBox.Margin = new Padding(0, 0, 0, 14);

            bar.Dock = DockStyle.Fill; bar.Height = 18; bar.Margin = new Padding(0, 0, 0, 6);
            status.Text = "Ready."; status.AutoSize = true; status.MaximumSize = new Size(510, 0); status.Margin = new Padding(1, 0, 0, 6);
            details.Multiline = true; details.ReadOnly = true; details.ScrollBars = ScrollBars.Vertical; details.Dock = DockStyle.Fill;
            details.BackColor = Color.White; details.Font = new Font("Consolas", 8.5f); details.Margin = new Padding(0, 0, 0, 10);

            var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0), WrapContents = false };
            closeButton.Text = "Close"; installButton.Text = "Install";
            foreach (Button b in new[] { closeButton, installButton }) { b.AutoSize = true; b.MinimumSize = new Size(96, 30); b.Margin = new Padding(8, 0, 0, 0); }
            installButton.Click += OnInstall; closeButton.Click += (s, e) => Close();
            buttons.Controls.Add(closeButton); buttons.Controls.Add(installButton);
            AcceptButton = installButton; CancelButton = closeButton;

            Control[] rows = { title, subtitle, folderLabel, folderRow, folderHint, fontsBox, obsidianBox, longformBox, openBox, bar, status, details, buttons };
            grid.RowCount = rows.Length;
            for (int i = 0; i < rows.Length; i++)
            {
                grid.RowStyles.Add(rows[i] == details ? new RowStyle(SizeType.Percent, 100f) : new RowStyle(SizeType.AutoSize));
                grid.Controls.Add(rows[i], 0, i);
            }
            Controls.Add(grid);
            FormClosing += OnClosing;
            ResumeLayout(false);
            PerformLayout();
        }

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

        void Log(string line) { UI(() => { details.AppendText(line + Environment.NewLine); }); }
        void Status(string text) { UI(() => status.Text = text); }
        void Progress(int value, bool marquee)
        {
            UI(() => {
                bar.Style = marquee ? ProgressBarStyle.Marquee : ProgressBarStyle.Continuous;
                if (!marquee) bar.Value = Math.Max(0, Math.Min(100, value));
            });
        }
        void UI(Action a) { if (IsDisposed) return; if (InvokeRequired) BeginInvoke(a); else a(); }

        void OnInstall(object sender, EventArgs e)
        {
            if (installedPath != null) { Process.Start("explorer.exe", "\"" + installedPath + "\""); return; }
            string dest;
            try { dest = Path.GetFullPath(pathBox.Text.Trim()); }
            catch { MessageBox.Show(this, "That folder path is not valid.", "Scriptorium Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning); return; }
            if (Directory.Exists(dest) || File.Exists(dest))
            {
                MessageBox.Show(this, "This folder already exists:\n" + dest + "\n\nChoose a new folder name.", "Scriptorium Setup",
                                MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            bool fonts = fontsBox.Checked && fontsBox.Enabled, obsidian = obsidianBox.Checked && obsidianBox.Enabled,
                 longform = longformBox.Checked, open = openBox.Checked;
            foreach (Control c in new Control[] { pathBox, browse, fontsBox, obsidianBox, longformBox, openBox, installButton }) c.Enabled = false;
            details.Clear();
            worker = new Thread(() => Run(dest, fonts, obsidian, longform, open)) { IsBackground = true };
            worker.SetApartmentState(ApartmentState.STA);
            worker.Start();
        }

        void Run(string dest, bool fonts, bool obsidian, bool longform, bool open)
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
                        if (p.ExitCode != 0) throw new InvalidOperationException("Obsidian setup exited with code " + p.ExitCode + ".");
                    }
                    exe = Installer.FindObsidian();
                    if (exe == null && !Installer.ObsidianProtocolRegistered()) throw new InvalidOperationException("Obsidian setup did not complete.");
                    Log("Installed Obsidian");
                }
                if (fonts)
                {
                    var wanted = new System.Collections.Generic.List<Pinned>();
                    if (!Installer.FontFamilyInstalled("EB Garamond")) wanted.AddRange(Installer.EbGaramond);
                    if (!Installer.FontFamilyInstalled("Cormorant Garamond")) wanted.AddRange(Installer.Cormorant);
                    for (int i = 0; i < wanted.Count; i++)
                    {
                        Pinned f = wanted[i];
                        Status("Downloading fonts (" + (i + 1) + " of " + wanted.Count + ") …");
                        string file = Path.Combine(temp, f.File);
                        int k = i;
                        Installer.Download(f, file, (d, t) => Progress((int)(100.0 * (k + (t > 0 ? (double)d / t : 0)) / wanted.Count), false), cancel.Token);
                        Installer.InstallFont(f, file);
                        Log("Installed " + f.Label);
                    }
                    if (wanted.Count > 0) Installer.AnnounceFontChange();
                }
                cancel.Token.ThrowIfCancellationRequested();
                Status("Creating the vault …"); Progress(0, true);
                Installer.ExtractVault(dest, Log);
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
                Progress(100, false);
                installedPath = dest;
                UI(() => {
                    status.Text = "Done. Your vault is in " + dest;
                    Clipboard.SetText(dest);
                    installButton.Text = "Open folder"; installButton.Enabled = true; closeButton.Text = "Finish";
                });
                Log("In Obsidian, choose \"Open folder as vault\" and select the folder above (its path is on the clipboard).");
                Log("Then open Lorem Ipsum in Reading view. Restart Obsidian if it was already running, so it sees new fonts.");
                if (open)
                {
                    try
                    {
                        if (exe != null) Process.Start(new ProcessStartInfo(exe, "obsidian://choose-vault") { UseShellExecute = false });
                        else Process.Start("obsidian://choose-vault");
                    }
                    catch (Exception ex) { Log("Could not open Obsidian: " + ex.Message); }
                }
            }
            catch (OperationCanceledException)
            {
                Status("Stopped. Nothing was created.");
                UI(() => ResetControls());
            }
            catch (Exception ex)
            {
                Log("Error: " + ex.Message);
                Status("Setup failed. See the details below.");
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

        void ResetControls()
        {
            Progress(0, false);
            foreach (Control c in new Control[] { pathBox, browse, longformBox, openBox, installButton }) c.Enabled = true;
            fontsBox.Enabled = !(Installer.FontFamilyInstalled("EB Garamond") && Installer.FontFamilyInstalled("Cormorant Garamond"));
            obsidianBox.Enabled = !(Installer.FindObsidian() != null || Installer.ObsidianProtocolRegistered());
        }
    }
}
