// Scriptorium Setup: a small Windows installer with a window, doing what Install-Scriptorium-Windows.cmd does.
//
// It creates a NEW vault folder from the Scriptorium configuration (embedded in this .exe, so it always matches the
// installer's version), installs Obsidian for the current user if it is missing, and installs EB Garamond and Cormorant
// Garamond for the current user if they are missing. The Longform plugin is not bundled: if the user ticks it, it is
// downloaded from its author's official release into the new vault. Every download is pinned by SHA-256. An existing
// folder is never changed. Targets .NET Framework 4.8, which ships with Windows 10 and 11, so nothing else needs installing.
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
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
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
            Typefaces.Load();
            // Used by CI: draws the window in a scripted series of states and saves each as a PNG; installs nothing.
            if (args.Length == 2 && args[0] == "--render") return Preview.Run(Path.GetFullPath(args[1]));
            try { using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) Ink.S = Math.Max(1f, g.DpiX / 96f); } catch { }
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
        public const float Faded = 0.38f;        // how strongly a disabled control is inked

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
                float w = width * (0.42f + 0.58f * (float)Math.Sqrt(Math.Min(tin, tout))) * (1f + 0.14f * (float)Math.Sin(phase + dist[i] / wave));
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

        public static float Width(Graphics g, string s, Font f) { return s.Length == 0 ? 0 : g.MeasureString(s, f, PointF.Empty, Format).Width; }

        public static void Line(Graphics g, string s, Font f, Color c, float x, float baseline)
        {
            using (var b = new SolidBrush(c)) g.DrawString(s, f, b, x, baseline - Ascent(f), Format);
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

    static class Sheet
    {
        // Paints the part of the window's paper that lies under a control, so every control sits on the same sheet.
        public static void Under(Control c, Graphics g)
        {
            var form = c.FindForm() as SetupForm;
            if (form == null) { g.Clear(Ink.Paper); return; }
            Point at = form.PointToPage(c);
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.DrawImage(form.Paper, new Rectangle(0, 0, c.Width, c.Height), at.X, at.Y, c.Width, c.Height, GraphicsUnit.Pixel);
        }
    }

    // Static text: wrapped, set on baselines, optionally centred, letter-spaced or in small capitals.
    class InkLabel : Control, IInked
    {
        public Color InkColor;
        public bool Centered, SmallCaps;
        public int MaxLines;
        public float Leading = 1.36f, Tracking;

        public InkLabel(string text, Font font, Color color, bool centered)
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            SetStyle(ControlStyles.Selectable, false);
            TabStop = false; Text = text; Font = font; InkColor = color; Centered = centered;
            AccessibleRole = AccessibleRole.StaticText;
        }

        protected override void OnTextChanged(EventArgs e) { base.OnTextChanged(e); Invalidate(); }

        float LineHeight { get { return (float)Math.Round(Font.Size * Leading); } }
        float FirstBaseline { get { return (float)Math.Round(Font.Size * 0.98f); } }

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
                return (int)Math.Ceiling(FirstBaseline + (n - 1) * LineHeight + Font.Size * 0.34f);
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
            Font = Typefaces.Make(Typefaces.Text, 16f, FontStyle.Regular);
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
                    Ink.Stroke(g, p, 2.3f * s, ink, 0xC0FFEEu, span * 0.85f, head > X1 ? 6 * s : 0);
                    if (head <= X1) Blot(g, p[p.Length - 1]);
                }
            }
            else if (value > 0)
            {
                float head = X0 + (X1 - X0) * value / 100f;
                PointF[] p = PenLine(X0, Math.Max(X0 + 2 * s, head));
                Ink.Stroke(g, p, 2.3f * s, ink, 0xC0FFEEu, 7 * s, 0);
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
            Font = Typefaces.Make(Typefaces.Text, 15f, FontStyle.Italic);
            ContextMenu = new ContextMenu(new[] { new MenuItem("Copy the details", (s, e) => { try { if (AllText.Length > 0) Clipboard.SetText(AllText); } catch { } }) });
        }

        public string AllText { get { return string.Join(Environment.NewLine, entries.Select(e => e.Key)); } }
        public float LineHeight { get { return (float)Math.Round(21 * Ink.S); } }

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
                Lettering.Line(g, lines[i].Key, Font, lines[i].Value ? Ink.Red : Ink.A(Ink.Black, 0.92f), textX, RuleY(i - first + 1) - (float)Math.Round(4.5f * s));
        }

        float RuleY(int k) { return (float)Math.Round(k * LineHeight + 2 * Ink.S); }
    }

    class SetupForm : Form
    {
        readonly TextBox pathBox = new TextBox();
        readonly InkButton browse = new InkButton("Browse…", false);
        readonly InkCheck fontsBox = new InkCheck(), obsidianBox = new InkCheck(), longformBox = new InkCheck(), openBox = new InkCheck();
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

        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

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

            title = new InkLabel("Scriptorium", Typefaces.Make(Typefaces.Display, 50f, FontStyle.Regular), Ink.Red, true);
            tagline = new InkLabel("Book-page typography for Obsidian.", Typefaces.Make(Typefaces.Text, 18f, FontStyle.Italic), Ink.Muted, true);
            intro = new InkLabel("This creates a new vault with the Scriptorium configuration and a Lorem Ipsum sample note.",
                                 Typefaces.Make(Typefaces.Text, 16.5f, FontStyle.Regular), Ink.Black, false);
            folderLabel = new InkLabel("New vault folder", Typefaces.Make(Typefaces.Semi, 16f, FontStyle.Regular), Ink.Black, false) { SmallCaps = true, Tracking = 0.06f };
            folderHint = new InkLabel("The folder must not exist yet. An existing folder is never changed.",
                                      Typefaces.Make(Typefaces.Text, 15.5f, FontStyle.Italic), Ink.Muted, false);
            status = new InkLabel("Ready.", Typefaces.Make(Typefaces.Text, 16f, FontStyle.Italic), Ink.Muted, false) { MaxLines = 2, Leading = 1.3f };

            pathBox.Text = preview ? @"C:\Users\Ada\Documents\Scriptorium" : Installer.DefaultVault;
            pathBox.BorderStyle = BorderStyle.None; pathBox.ForeColor = Ink.Black; pathBox.BackColor = Ink.Paper;
            pathBox.Font = Typefaces.Make(Typefaces.Text, 16.5f, FontStyle.Regular);
            pathBox.AccessibleName = "New vault folder";
            pathBox.EnabledChanged += (s, e) => { pathBox.Visible = pathBox.Enabled; Invalidate(); };
            browse.Name = "browse"; browse.Click += OnBrowse;

            bool hasFonts = FontsInstalled();
            fontsBox.Text = hasFonts ? "EB Garamond and Cormorant Garamond are already installed"
                                     : "Install the fonts it uses for me (EB Garamond, Cormorant Garamond)";
            fontsBox.Checked = !hasFonts; fontsBox.Enabled = !hasFonts;
            bool hasObsidian = ObsidianInstalled();
            obsidianBox.Text = hasObsidian ? "Obsidian is already installed" : "Download and install Obsidian 1.15.0 for me";
            obsidianBox.Checked = !hasObsidian; obsidianBox.Enabled = !hasObsidian;
            fontsBox.Name = "fonts"; obsidianBox.Name = "obsidian"; longformBox.Name = "longform"; openBox.Name = "open";
            longformBox.Text = "Download the Longform plugin from its official release"; longformBox.Checked = true;
            openBox.Text = "Open Obsidian when done"; openBox.Checked = true;

            installButton.Name = "install"; closeButton.Name = "close";
            installButton.Click += OnInstall; closeButton.Click += (s, e) => Close();
            installButton.TextChanged += (s, e) => LayoutButtons();
            closeButton.TextChanged += (s, e) => LayoutButtons();
            AcceptButton = installButton; CancelButton = closeButton;

            Control[] order = { pathBox, browse, fontsBox, obsidianBox, longformBox, openBox, installButton, closeButton };
            for (int i = 0; i < order.Length; i++) order[i].TabIndex = i;
            Controls.AddRange(new Control[] { title, tagline, intro, folderLabel, pathBox, browse, folderHint,
                                              fontsBox, obsidianBox, longformBox, openBox, bar, status, details, installButton, closeButton });
            LayoutPage();
            FormClosing += OnClosing;
            ResumeLayout(false);
        }

        bool FontsInstalled() { return !preview && Installer.FontFamilyInstalled("EB Garamond") && Installer.FontFamilyInstalled("Cormorant Garamond"); }
        bool ObsidianInstalled() { return !preview && (Installer.FindObsidian() != null || Installer.ObsidianProtocolRegistered()); }

        // ---------- the page ----------
        const float PageWidth = 580, PageMargin = 40;
        int bottomY;

        void Place(Control c, float x, ref float y, float width, float after)
        {
            var label = c as InkLabel;
            int h = label != null ? label.HeightFor(Ink.R(width), label == status ? 2 : 0) : c.Height;
            c.SetBounds(Ink.R(x), (int)Math.Round(y), Ink.R(width), h);
            y += h + after * Ink.S;
        }

        void LayoutPage()
        {
            float s = Ink.S, cw = PageWidth - 2 * PageMargin, y = 10 * s;
            Place(title, PageMargin, ref y, cw, -6);
            Place(tagline, PageMargin, ref y, cw, 0);
            ornamentY = y + 14 * s; y += 30 * s;
            Place(intro, PageMargin, ref y, cw, 14);
            Place(folderLabel, PageMargin, ref y, cw, 0);

            int bw = Ink.R(108), bh = Ink.R(36);
            browse.SetBounds(Ink.R(PageWidth - PageMargin + 3.5f) - bw, (int)Math.Round(y), bw, bh);
            int th = pathBox.PreferredHeight;
            pathBox.SetBounds(Ink.R(PageMargin), (int)Math.Round(y + (bh - th) / 2f - 3 * s), browse.Left - Ink.R(PageMargin + 18), th);
            ruleY = (float)Math.Round(pathBox.Top + Lettering.Ascent(pathBox.Font) + 5 * s);
            y += bh + 2 * s;
            Place(folderHint, PageMargin, ref y, cw, 12);

            foreach (InkCheck c in new[] { fontsBox, obsidianBox, longformBox, openBox })
            {
                c.SetBounds(Ink.R(PageMargin - 1.5f), (int)Math.Round(y), c.PreferredWidth(), Ink.R(28));
                y += 28 * s;
            }
            y += 12 * s;
            bar.SetBounds(Ink.R(PageMargin - 2), (int)Math.Round(y), Ink.R(cw + 4), Ink.R(20)); y += 22 * s;
            Place(status, PageMargin, ref y, cw, 4);
            details.SetBounds(Ink.R(PageMargin), (int)Math.Round(y), Ink.R(cw), (int)Math.Round(5 * details.LineHeight + 6 * s)); y += details.Height + 16 * s;
            bottomY = (int)Math.Round(y);
            LayoutButtons();
            ClientSize = new Size(Ink.R(PageWidth), bottomY + bh + Ink.R(20));
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
        internal Bitmap Paper
        {
            get
            {
                Size size = ClientSize;
                if (paper == null || paper.Size != size) { if (paper != null) paper.Dispose(); paper = Ink.MakePaper(Math.Max(1, size.Width), Math.Max(1, size.Height)); }
                return paper;
            }
        }

        internal Point PointToPage(Control c)
        {
            var p = Point.Empty;
            for (Control x = c; x != null && x != this; x = x.Parent) p.Offset(x.Left, x.Top);
            return p;
        }

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
            // Windows 11: a paper-coloured title bar with ink text (DWMWA_BORDER_COLOR 34, CAPTION_COLOR 35, TEXT_COLOR 36).
            // Older versions of Windows ignore these, and so do we.
            try
            {
                int border = ColorRef(Ink.Edge), caption = ColorRef(Ink.Paper), text = ColorRef(Ink.Black);
                DwmSetWindowAttribute(Handle, 34, ref border, 4);
                DwmSetWindowAttribute(Handle, 35, ref caption, 4);
                DwmSetWindowAttribute(Handle, 36, ref text, 4);
            }
            catch { }
        }

        static int ColorRef(Color c) { return c.R | (c.G << 8) | (c.B << 16); }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            // The folder box starts with the caret at the end of the path, not with the whole path highlighted.
            pathBox.SelectionStart = pathBox.TextLength; pathBox.SelectionLength = 0;
        }

        protected override void OnPaintBackground(PaintEventArgs e) { }
        protected override void OnPaint(PaintEventArgs e) { PaintPage(e.Graphics); }

        internal void PaintPage(Graphics g)
        {
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.DrawImage(Paper, 0, 0, Paper.Width, Paper.Height);
            Ink.Prepare(g);
            float s = Ink.S, cx = ClientSize.Width / 2f;

            // Under the subtitle: a fleuron between two short pen rules.
            using (Font f = Typefaces.Make(Typefaces.Display, 23f, FontStyle.Regular))
            {
                const string fleuron = "\u2766";
                float w = Lettering.Width(g, fleuron, f), baseline = (float)Math.Round(ornamentY + f.Size * 0.30f);
                Lettering.Line(g, fleuron, f, Ink.A(Ink.Muted, 0.95f), (float)Math.Round(cx - w / 2), baseline);
                float gap = 12 * s, len = 54 * s;
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
            if (Directory.Exists(dest) || File.Exists(dest))
            {
                MessageBox.Show(this, "This folder already exists:\n" + dest + "\n\nChoose a new folder name.", "Scriptorium Setup",
                                MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            bool fonts = fontsBox.Checked && fontsBox.Enabled, obsidian = obsidianBox.Checked && obsidianBox.Enabled,
                 longform = longformBox.Checked, open = openBox.Checked;
            Busy();
            worker = new Thread(() => Run(dest, fonts, obsidian, longform, open)) { IsBackground = true };
            worker.SetApartmentState(ApartmentState.STA);
            worker.Start();
        }

        internal void Busy()
        {
            foreach (Control c in new Control[] { pathBox, browse, fontsBox, obsidianBox, longformBox, openBox, installButton }) c.Enabled = false;
            details.Clear();
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
                    var wanted = new List<Pinned>();
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
                UI(() => Done(dest));
                Log("In Obsidian, choose \"Open folder as vault\" and select the folder above (its path is on the clipboard).");
                Log("Then open Lorem Ipsum in Reading view. Restart Obsidian if it was already running, so it sees new fonts.");
                if (open)
                {
                    try
                    {
                        if (exe != null) Process.Start(new ProcessStartInfo(exe, "obsidian://choose-vault") { UseShellExecute = false });
                        else Process.Start("obsidian://choose-vault");
                    }
                    catch (Exception ex) { Log("Could not open Obsidian: " + ex.Message, true); }
                }
            }
            catch (OperationCanceledException)
            {
                Status("Stopped. Nothing was created.");
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
            foreach (InkCheck c in new[] { fontsBox, obsidianBox, longformBox, openBox }) c.Record = on;
            Invalidate();
        }

        internal void ResetControls()
        {
            ShowRecord(false);
            Progress(0, false);
            foreach (Control c in new Control[] { pathBox, browse, longformBox, openBox, installButton }) c.Enabled = true;
            fontsBox.Enabled = !FontsInstalled();
            obsidianBox.Enabled = !ObsidianInstalled();
        }

        // ---------- for the rendered previews ----------
        internal InkButton InstallButton { get { return installButton; } }
        internal InkButton BrowseButton { get { return browse; } }
        internal InkCheck LongformBox { get { return longformBox; } }
        internal InkProgress Bar { get { return bar; } }
        internal string PreviewPath { get { return pathBox.Text; } }
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
                    Animation(dir);
                    Ink.S = 1.5f;
                    using (SetupForm f = Open()) Save(f, dir, "08-ready-150.png");
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
                Save(f, dir, "01-ready.png");
                try { f.DrawToBitmapCheck(dir); } catch (Exception e) { log.WriteLine("DrawToBitmap: " + e.Message); }
                CaptureScreen(f, dir);

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
                f.Log("In Obsidian, choose \"Open folder as vault\" and select the folder above (its path is on the clipboard).");
                f.Log("Then open Lorem Ipsum in Reading view. Restart Obsidian if it was already running, so it sees new fonts.");
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
                    foreach (double q in new[] { 0.4, 0.8 }) { f.Progress((int)(100.0 * (i + q) / fonts.Length), false); frame(120); }
                    f.Log("Installed " + fonts[i].Label);
                }
                f.Status("Creating the vault …"); f.Progress(0, true); f.Bar.StopTimer();
                for (int k = 0; k < 5; k++) { f.Bar.Phase = 0.1f + k / 6f; f.Bar.Invalidate(); frame(110); }
                f.Log("Created the vault in " + f.PreviewPath);
                f.Status("Downloading Longform …"); f.Progress(0, false);
                foreach (int p in new[] { 34, 67, 100 }) { f.Progress(p, false); frame(130); }
                f.Log("Installed Longform 2.1.0 from its official release");
                f.Progress(100, false);
                f.Done(f.PreviewPath);
                f.Log("In Obsidian, choose \"Open folder as vault\" and select the folder above (its path is on the clipboard).");
                f.Log("Then open Lorem Ipsum in Reading view. Restart Obsidian if it was already running, so it sees new fonts.");
                frame(1400);
                f.InstallButton.Hover = true; frame(3000);
            }
        }

        // Draws the window's client area the way Windows paints it: the page, then each control with its own paint
        // routine; the native text box is printed by Windows itself (WM_PRINT, via DrawToBitmap).
        internal static Bitmap Capture(SetupForm f)
        {
            var bmp = new Bitmap(f.ClientSize.Width, f.ClientSize.Height, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                f.PaintPage(g);
                foreach (Control c in f.Controls)
                {
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

        static void Save(SetupForm f, string dir, string name)
        {
            Application.DoEvents();
            using (Bitmap b = Capture(f)) b.Save(Path.Combine(dir, name), ImageFormat.Png);
            log.WriteLine("Saved " + name);
        }

        // The real window on the (CI) desktop, title bar and all, if there is a desktop to draw it on.
        static void CaptureScreen(SetupForm f, string dir)
        {
            try
            {
                f.Location = new Point(40, 40); f.TopMost = true;
                f.Refresh();
                for (int i = 0; i < 20; i++) { Application.DoEvents(); Thread.Sleep(25); }
                using (var b = new Bitmap(f.Width, f.Height, PixelFormat.Format32bppArgb))
                {
                    using (Graphics g = Graphics.FromImage(b)) g.CopyFromScreen(f.Location, Point.Empty, f.Size);
                    b.Save(Path.Combine(dir, "00-window.png"), ImageFormat.Png);
                }
                log.WriteLine("Saved 00-window.png");
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
