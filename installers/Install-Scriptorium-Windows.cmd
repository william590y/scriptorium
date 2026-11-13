@echo off
setlocal
set "WRITING_INSTALLER=%~f0"
powershell.exe -NoProfile -Command "$text = [IO.File]::ReadAllText($env:WRITING_INSTALLER); $parts = $text -split '(?m)^# POWERSHELL_START\r?$', 2; try { & ([scriptblock]::Create($parts[1])) } catch { Write-Host $_ -ForegroundColor Red; exit 1 }"
set "RESULT=%errorlevel%"
pause
exit /b %RESULT%
# POWERSHELL_START
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'Continue'
# Console selection can suspend the installer until a key is pressed.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ScriptoriumConsole {
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll")]
    public static extern bool GetConsoleMode(IntPtr handle, out uint mode);
    [DllImport("kernel32.dll")]
    public static extern bool SetConsoleMode(IntPtr handle, uint mode);
}
'@
$consoleInput = [ScriptoriumConsole]::GetStdHandle(-10)
$consoleMode = [uint32]0
if ([ScriptoriumConsole]::GetConsoleMode($consoleInput, [ref]$consoleMode)) {
    [void][ScriptoriumConsole]::SetConsoleMode($consoleInput, (($consoleMode -band 0xffffffbf) -bor 0x80))
}

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Get-ScriptoriumDownload($Uri, $OutFile) {
    $activity = 'Downloading ' + [IO.Path]::GetFileName($OutFile)
    $response = $null
    $inputStream = $null
    $outputStream = $null
    $complete = $false
    try {
        $request = [Net.HttpWebRequest]::Create($Uri)
        $request.UserAgent = 'Scriptorium-Installer'
        $request.Timeout = 60000
        $request.ReadWriteTimeout = 60000
        $response = $request.GetResponse()
        $total = $response.ContentLength
        $inputStream = $response.GetResponseStream()
        $outputStream = [IO.File]::Open($OutFile, [IO.FileMode]::Create, [IO.FileAccess]::Write)
        $buffer = New-Object byte[] 1048576
        $downloaded = [long]0
        $timer = [Diagnostics.Stopwatch]::StartNew()
        do {
            $count = $inputStream.Read($buffer, 0, $buffer.Length)
            if ($count -gt 0) {
                $outputStream.Write($buffer, 0, $count)
                $downloaded += $count
            }
            if ($timer.ElapsedMilliseconds -ge 150 -or $count -eq 0) {
                if ($total -gt 0) {
                    $percent = [Math]::Min(100, [Math]::Floor(100.0 * $downloaded / $total))
                    $status = '{0}% - {1:N0} / {2:N0} bytes' -f $percent, $downloaded, $total
                    Write-Progress -Activity $activity -Status $status -PercentComplete $percent
                } else {
                    Write-Progress -Activity $activity -Status ('{0:N0} bytes downloaded (total size unavailable)' -f $downloaded) -PercentComplete -1
                }
                $timer.Restart()
            }
        } while ($count -gt 0)
        if ($total -ge 0 -and $downloaded -ne $total) { throw "Incomplete download: $OutFile" }
        $complete = $true
        Write-Host ('Downloaded {0:N0} bytes - {1}' -f $downloaded, [IO.Path]::GetFileName($OutFile))
    } finally {
        if ($outputStream) { $outputStream.Dispose() }
        if ($inputStream) { $inputStream.Dispose() }
        if ($response) { $response.Dispose() }
        Write-Progress -Activity $activity -Completed
        if (!$complete) { Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue }
    }
}

Write-Host 'Scriptorium - Obsidian configuration installer'
$defaultPath = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Scriptorium'
$answer = Read-Host "New vault folder (Enter for $defaultPath)"
$destination = if ([string]::IsNullOrWhiteSpace($answer)) { $defaultPath } else { [IO.Path]::GetFullPath($answer) }
if (Test-Path -LiteralPath $destination) { throw "Folder already exists: $destination. Choose a new folder; nothing was changed. To set up Scriptorium in a vault you already have, use Scriptorium-Setup.exe (Set up)." }
$tempPath = Join-Path ([IO.Path]::GetTempPath()) ('obsidian-writing-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tempPath | Out-Null
try {
    $archive = Join-Path $tempPath 'Writing.zip'
    Get-ScriptoriumDownload -Uri 'https://williamliaw.com/assets/downloads/Scriptorium.zip' -OutFile $archive
    $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne '53b353cfe1353679220b9a3bedc4091676b2438aafa2cb558a18cd814ce85962') { throw 'Package verification failed. Please download the current installer from the Projects page.' }
    $staging = Join-Path $tempPath 'vault'
    Expand-Archive -LiteralPath $archive -DestinationPath $staging
    if (!(Test-Path -LiteralPath (Join-Path $staging '.obsidian/appearance.json'))) { throw 'Invalid configuration archive.' }
    function Find-Obsidian {
        foreach ($base in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
            if (!$base) { continue }
            foreach ($relative in @('Obsidian\Obsidian.exe', 'Programs\Obsidian\Obsidian.exe')) {
                $exe = Join-Path $base $relative
                if (Test-Path -LiteralPath $exe -PathType Leaf) { return $exe }
            }
        }
        $cmd = Get-Command Obsidian.exe -CommandType Application -ErrorAction SilentlyContinue
        if ($cmd -and (Test-Path -LiteralPath $cmd.Source -PathType Leaf)) { return $cmd.Source }
        # An Obsidian installed elsewhere: the program its obsidian:// links run, if that program is still there.
        # Obsidian's uninstaller leaves the link in the registry, so the link alone does not mean Obsidian is installed.
        $command = [string](Get-ItemProperty -LiteralPath 'Registry::HKEY_CLASSES_ROOT\obsidian\shell\open\command' -ErrorAction SilentlyContinue).'(default)'
        if ($command -match '^\s*"([^"]+\.exe)"' -or $command -match '^\s*(.+?\.exe)(\s|$)') {
            if (Test-Path -LiteralPath $Matches[1] -PathType Leaf) { return $Matches[1] }
        }
    }
    $exe = Find-Obsidian
    if (!$exe) {
        Write-Host 'Downloading Obsidian ...'
        $setup = Join-Path $tempPath 'Obsidian-Setup.exe'
        Get-ScriptoriumDownload -Uri 'https://github.com/obsidianmd/obsidian-releases/releases/download/v1.15.0/Obsidian-1.15.0.exe' -OutFile $setup
        if ((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash -ne 'b0f60c75a12f96d54cb16b9fc32919966f2ebf029d9af75d67a19ba6555e1da0') { throw 'Obsidian download verification failed.' }
        Write-Host 'Installing Obsidian for the current user ...'
        $process = Start-Process -FilePath $setup -ArgumentList '/S', '/currentuser' -PassThru
        try {
            while (!$process.WaitForExit(250)) {
                Write-Progress -Activity 'Installing Obsidian' -Status 'Setup is running. No keyboard input is needed.' -PercentComplete -1
            }
            $process.WaitForExit()
        } finally {
            Write-Progress -Activity 'Installing Obsidian' -Completed
        }
        if ($process.ExitCode -ne 0) { throw "Obsidian's installer failed (exit code $($process.ExitCode)), so Obsidian was not installed. Install Obsidian from https://obsidian.md, then run this again." }
        $exe = Find-Obsidian
        if (!$exe) { throw "Obsidian's installer ran, but Obsidian is still not on this computer (Obsidian.exe was not found). Install Obsidian from https://obsidian.md, then run this again." }
        Write-Host "Installed Obsidian ($exe)"
    }
    # Install missing font families for this user, including roman and italic faces.
    Add-Type -AssemblyName System.Drawing
    $installed = New-Object System.Drawing.Text.InstalledFontCollection
    $families = @($installed.Families | ForEach-Object { $_.Name })
    $installed.Dispose()
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ScriptoriumFontRegistration {
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
    public static extern int AddFontResourceEx(string path, uint flags, IntPtr reserved);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
    $fontDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'
    $fontRegistry = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Fonts'
    function Install-ScriptoriumFont($file, $url, $hash, $label) {
        $target = Join-Path $fontDir $file
        if (Test-Path -LiteralPath $target) {
            if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $hash) { throw "Existing font differs: $target" }
        } else {
            $download = Join-Path $tempPath $file
            Get-ScriptoriumDownload -Uri $url -OutFile $download
            if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $hash) { throw "Font verification failed: $file" }
            New-Item -ItemType Directory -Path $fontDir -Force | Out-Null
            Copy-Item -LiteralPath $download -Destination $target
        }
        New-Item -Path $fontRegistry -Force | Out-Null
        New-ItemProperty -Path $fontRegistry -Name $label -Value $target -PropertyType String -Force | Out-Null
        if ([ScriptoriumFontRegistration]::AddFontResourceEx($target, 0, [IntPtr]::Zero) -eq 0) {
            throw "Could not load font: $target"
        }
    }
    if ($families -notcontains 'EB Garamond') {
        Write-Host 'Installing EB Garamond ...'
        Install-ScriptoriumFont 'EBGaramond-Scriptorium.ttf' 'https://raw.githubusercontent.com/google/fonts/5bb28733cec313b63fbd415b574b5ae35c8aa8b8/ofl/ebgaramond/EBGaramond%5Bwght%5D.ttf' 'ef9512f92f6d579e5dc75af59a5a4b1b8b47d2eda89e00b954d44520e5369027' 'EB Garamond Regular (TrueType)'
        Install-ScriptoriumFont 'EBGaramond-Italic-Scriptorium.ttf' 'https://raw.githubusercontent.com/google/fonts/5bb28733cec313b63fbd415b574b5ae35c8aa8b8/ofl/ebgaramond/EBGaramond-Italic%5Bwght%5D.ttf' 'bba2c4499c93c9612b90b9825d32b07da52fce2fe57562a1eb6b833553f93c4e' 'EB Garamond Italic (TrueType)'
    }
    if ($families -notcontains 'Cormorant Garamond') {
        Write-Host 'Installing Cormorant Garamond ...'
        Install-ScriptoriumFont 'CormorantGaramond-Scriptorium.ttf' 'https://raw.githubusercontent.com/google/fonts/5bb28733cec313b63fbd415b574b5ae35c8aa8b8/ofl/cormorantgaramond/CormorantGaramond%5Bwght%5D.ttf' 'b20b7d9626dd956b2c5e558692ad328b1f19e3275e2782db4fa07670d83f35e0' 'Cormorant Garamond Regular (TrueType)'
        Install-ScriptoriumFont 'CormorantGaramond-Italic-Scriptorium.ttf' 'https://raw.githubusercontent.com/google/fonts/5bb28733cec313b63fbd415b574b5ae35c8aa8b8/ofl/cormorantgaramond/CormorantGaramond-Italic%5Bwght%5D.ttf' '0f48ea6abb2084537854f7174c470991a463b13036309e3b50a81511611c530d' 'Cormorant Garamond Italic (TrueType)'
    }
    $broadcastResult = [UIntPtr]::Zero
    [void][ScriptoriumFontRegistration]::SendMessageTimeout([IntPtr]0xffff, 0x001d, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 5000, [ref]$broadcastResult)
    # CreateDirectory alone would merge; this deliberately fails if another process created the folder.
    New-Item -ItemType Directory -Path $destination -ErrorAction Stop | Out-Null
    Get-ChildItem -LiteralPath $staging -Force | Copy-Item -Destination $destination -Recurse
    Write-Host "Installed in $destination"

    # ---- Open the new vault in Obsidian with its community plugins on ----
    # The first time Obsidian opens a vault that comes with plugins, it asks whether to trust the vault's author and keeps
    # the answer in its own storage. Obsidian 1.12 and later has a command line interface that gives the same answer:
    # "plugins:restrict off" does what the question's "Trust author and enable plugins" does. The interface answers only
    # while "cli": true is in Obsidian's obsidian.json, which Obsidian reads when it starts and rewrites while it runs. So,
    # with Obsidian closed, this adds the vault to obsidian.json's vault list and turns the interface on, starts Obsidian
    # on the vault, asks it (through its pipe, as Obsidian.com does) to leave Restricted mode, and turns the interface off
    # again through Obsidian (unless it was on already). If anything fails, Obsidian asks its usual question.
    $obsidianSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Web.Script.Serialization;
public static class ScriptoriumObsidian {
    // A folder's path as Obsidian keeps it: full, without a trailing separator.
    public static string VaultPath(string folder) {
        string path = Path.GetFullPath(folder), root = Path.GetPathRoot(path) ?? "";
        while (path.Length > root.Length && (path.EndsWith("\\") || path.EndsWith("/"))) path = path.Substring(0, path.Length - 1);
        return path;
    }
    static bool Same(string listed, string path) {
        try { return string.Equals(VaultPath(listed), path, StringComparison.OrdinalIgnoreCase); } catch { return false; }
    }
    // How Obsidian reads "cli": JavaScript truthiness.
    static bool Truthy(object v) {
        if (v == null) return false;
        if (v is bool) return (bool)v;
        if (v is string) return ((string)v).Length > 0;
        if (v is int || v is long || v is decimal || v is double) return Convert.ToDouble(v) != 0;
        return true;
    }
    static void Write(string file, string text) {
        Directory.CreateDirectory(Path.GetDirectoryName(file));
        string temp = file + ".scriptorium-tmp";
        File.WriteAllText(temp, text, new UTF8Encoding(false));
        if (File.Exists(file)) File.Replace(temp, file, null); else File.Move(temp, file);
    }
    // Adds the vault to obsidian.json's vault list (or finds it there) and, with turnOnCli, turns the interface on;
    // every other key and vault is kept. Returns the vault's id, a newline, and "on" if the interface was on, else "cli"
    // as it was ("absent", or its JSON). Throws, leaving the file alone, if it is not a JSON object with an object for
    // its vault list.
    public static string Register(string file, string vault, bool turnOnCli) {
        var json = new JavaScriptSerializer();
        string text = File.Exists(file) ? File.ReadAllText(file, Encoding.UTF8) : "";
        var conf = (text.Trim().Length == 0 ? new Dictionary<string, object>() : json.DeserializeObject(text)) as Dictionary<string, object>;
        if (conf == null) throw new FormatException("obsidian.json is not a JSON object");
        object value;
        if (!conf.TryGetValue("vaults", out value)) conf["vaults"] = value = new Dictionary<string, object>();
        var vaults = value as Dictionary<string, object>;
        if (vaults == null) throw new FormatException("the vault list in obsidian.json is not a JSON object");
        string path = VaultPath(vault), id = null;
        bool changed = false;
        foreach (var kv in vaults) {
            var entry = kv.Value as Dictionary<string, object>;
            object listed;
            if (entry != null && entry.TryGetValue("path", out listed) && listed is string && Same((string)listed, path)) { id = kv.Key; break; }
        }
        if (id == null) {
            var bytes = new byte[8];
            using (var random = System.Security.Cryptography.RandomNumberGenerator.Create())
                do { random.GetBytes(bytes); id = BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); } while (vaults.ContainsKey(id));
            long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            vaults[id] = new Dictionary<string, object> { { "path", path }, { "ts", now } };
            changed = true;
        }
        object cli;
        bool had = conf.TryGetValue("cli", out cli), wasOn = had && Truthy(cli);
        string prior = wasOn ? "on" : had ? json.Serialize(cli) : "absent";
        if (turnOnCli && !wasOn) { conf["cli"] = true; changed = true; }
        if (changed) Write(file, json.Serialize(conf));
        return id + "\n" + prior;
    }
    // Puts "cli" back to prior ("absent", or its JSON) if it is still true. Only while Obsidian is closed.
    public static void Restore(string file, string prior) {
        var json = new JavaScriptSerializer();
        var conf = json.DeserializeObject(File.ReadAllText(file, Encoding.UTF8)) as Dictionary<string, object>;
        object cli;
        if (conf == null || !conf.TryGetValue("cli", out cli) || !(cli is bool) || !(bool)cli) return;
        if (prior == "absent") conf.Remove("cli"); else conf["cli"] = json.DeserializeObject(prior);
        Write(file, json.Serialize(conf));
    }
    // Sends one command to Obsidian's CLI pipe (one line of JSON) and returns Obsidian's answer, or null if Obsidian could
    // not be reached or did not answer within timeoutMs.
    public static string Send(string[] argv, int timeoutMs) {
        var json = new JavaScriptSerializer();
        var clock = Stopwatch.StartNew();
        try {
            using (var pipe = new NamedPipeClientStream(".", "obsidian-cli-" + Environment.UserName, PipeDirection.InOut)) {
                pipe.Connect(Math.Min(timeoutMs, 2000));
                string request = "{\"argv\":" + json.Serialize(argv) + ",\"tty\":false,\"cwd\":" + json.Serialize(Path.GetPathRoot(Path.GetTempPath())) + "}\n";
                byte[] head = Encoding.UTF8.GetBytes(request);
                pipe.Write(head, 0, head.Length);
                pipe.Flush();
                var answer = new MemoryStream();
                var buffer = new byte[8192];
                while (true) {
                    int left = timeoutMs - (int)clock.ElapsedMilliseconds;
                    if (left <= 0) return null;
                    var read = pipe.ReadAsync(buffer, 0, buffer.Length);
                    if (!read.Wait(left)) return null;
                    if (read.Result == 0) break;
                    answer.Write(buffer, 0, read.Result);
                }
                return Encoding.UTF8.GetString(answer.ToArray()).Trim();
            }
        } catch { return null; }
    }
}
'@
    # 'trusted': open with its plugins on; 'opened': open, Obsidian asks; 'no': not opened. Anything unexpected leaves
    # the vault to "Open folder as vault", as before.
    $opened = 'no'
    $registration = $null
    try {
        Add-Type -AssemblyName System.Web.Extensions
        $obsidianReferences = @([System.Uri].Assembly.Location, [System.IO.Pipes.NamedPipeClientStream].Assembly.Location,
                                [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location)
        Add-Type -TypeDefinition $obsidianSource -ReferencedAssemblies $obsidianReferences
        $obsidianJson = Join-Path $env:APPDATA 'obsidian\obsidian.json'
        $cliOff = "code=require('electron').ipcRenderer.sendSync('cli',false)"
        function Test-ObsidianRunning {
            $session = (Get-Process -Id $PID).SessionId
            return [bool](Get-Process -Name Obsidian -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session })
        }
        # Obsidian 1.12 and later have the command line interface. Obsidian runs the newest of its installer's version and
        # the app updates it downloads into its settings folder (obsidian-<version>.asar).
        function Test-ObsidianCli($obsidianExe) {
            $newest = New-Object Version 0, 0, 0
            try {
                $info = (Get-Item -LiteralPath $obsidianExe).VersionInfo
                $newest = New-Object Version $info.FileMajorPart, $info.FileMinorPart, $info.FileBuildPart
            } catch { }
            foreach ($file in @(Get-ChildItem -LiteralPath (Split-Path $obsidianJson) -Filter 'obsidian-*.asar' -File -ErrorAction SilentlyContinue)) {
                if ($file.Name -match '^obsidian-(\d+)\.(\d+)\.(\d+)\.asar$') {
                    $version = New-Object Version ([int]$Matches[1]), ([int]$Matches[2]), ([int]$Matches[3])
                    if ($version -gt $newest) { $newest = $version }
                }
            }
            return $newest -ge (New-Object Version 1, 12, 0)
        }
        if (!$exe) {
            Write-Host 'Obsidian.exe was not found, so Scriptorium did not open the vault in Obsidian.'
        } elseif (Test-ObsidianRunning) {
            Write-Host 'Obsidian is open, so Scriptorium did not open the new vault in it: that needs Obsidian closed.'
        } else {
            $turnOn = Test-ObsidianCli $exe
            try { $registration = [ScriptoriumObsidian]::Register($obsidianJson, $destination, $turnOn).Split("`n") }
            catch { Write-Host "Could not add the vault to the vault list in ${obsidianJson}: $($_.Exception.Message)" }
            if ($registration) {
                $vaultId = $registration[0]
                $priorCli = $registration[1]
                Write-Host 'Opening the vault in Obsidian ...'
                Start-Process -FilePath $exe -ArgumentList ('"' + [ScriptoriumObsidian]::VaultPath($destination) + '"')
                $opened = 'opened'
                if (!$turnOn) {
                    Write-Host 'This Obsidian is older than 1.12 and has no command line interface, so its plugins are not on yet.'
                } else {
                    # Until Obsidian is up there is no pipe; then Obsidian answers once the vault has loaded (just after
                    # loading it may not know the command yet, and says so: ask again).
                    $asked = $false
                    $clock = [Diagnostics.Stopwatch]::StartNew()
                    while (!$asked -and $clock.Elapsed.TotalSeconds -lt 120) {
                        $answer = [ScriptoriumObsidian]::Send(@("vault=$vaultId", 'plugins:restrict', 'off'), 60000)
                        if ($answer -like 'Restricted mode disabled*' -or $answer -like 'Restricted mode is already disabled*') { $asked = $true }
                        elseif ($answer -like 'Command line interface is not enabled*' -or $answer -like 'Vault not found*') { break }
                        else { Start-Sleep -Milliseconds 500 }
                    }
                    # Obsidian reloads the vault after answering; the reloaded vault confirms.
                    $clock.Restart()
                    while ($asked -and $opened -ne 'trusted' -and $clock.Elapsed.TotalSeconds -lt 60) {
                        if ([ScriptoriumObsidian]::Send(@("vault=$vaultId", 'plugins:restrict'), 60000) -eq 'off') { $opened = 'trusted' }
                        else { Start-Sleep -Milliseconds 500 }
                    }
                    if ($priorCli -ne 'on') {
                        # Turn the interface off again through Obsidian's own setting, which also updates obsidian.json.
                        $restored = $false
                        for ($attempt = 0; $attempt -lt 10 -and (Test-ObsidianRunning); $attempt++) {
                            $answer = [ScriptoriumObsidian]::Send(@('eval', $cliOff), 15000)
                            if ($answer -eq '=> false' -or $answer -like 'Command line interface is not enabled*') { $restored = $true; break }
                            Start-Sleep -Seconds 1
                        }
                        if (!$restored -and !(Test-ObsidianRunning)) {
                            try { [ScriptoriumObsidian]::Restore($obsidianJson, $priorCli); $restored = $true } catch { }
                        }
                        if (!$restored) {
                            # Obsidian runs but does not answer: a hidden PowerShell turns the interface off in obsidian.json
                            # once Obsidian has closed.
                            $watchSource = Join-Path ([IO.Path]::GetTempPath()) ('scriptorium-obsidian-' + [guid]::NewGuid() + '.cs')
                            [IO.File]::WriteAllText($watchSource, $obsidianSource)
                            $quote = { param($text) "'" + $text.Replace("'", "''") + "'" }
                            $watch = @"
Add-Type -AssemblyName System.Web.Extensions
Add-Type -TypeDefinition ([IO.File]::ReadAllText($(& $quote $watchSource))) -ReferencedAssemblies @($(($obsidianReferences | ForEach-Object { & $quote $_ }) -join ', '))
`$session = (Get-Process -Id `$PID).SessionId
while (Get-Process -Name Obsidian -ErrorAction SilentlyContinue | Where-Object { `$_.SessionId -eq `$session }) { Start-Sleep -Seconds 5 }
[ScriptoriumObsidian]::Restore($(& $quote $obsidianJson), $(& $quote $priorCli))
Remove-Item -LiteralPath $(& $quote $watchSource) -ErrorAction SilentlyContinue
"@
                            $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($watch))
                            Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile', '-EncodedCommand', $encoded
                            Write-Host "Obsidian's command line interface, turned on for this, will be turned off when Obsidian closes."
                        }
                    }
                    if ($opened -ne 'trusted') { Write-Host 'Could not turn on its plugins automatically (Obsidian did not confirm in time).' }
                }
            }
        }
    } catch {
        Write-Host "Could not open the vault in Obsidian: $($_.Exception.Message)"
        if ($registration -and $registration[1] -ne 'on' -and !(Test-ObsidianRunning)) {
            try { [ScriptoriumObsidian]::Restore($obsidianJson, $registration[1]) } catch { }
        }
        if ($opened -eq 'trusted') { $opened = 'opened' }
    }
    if ($opened -eq 'trusted') {
        Write-Host 'Opened it in Obsidian with its community plugins on (as "Trust author and enable plugins" does).'
        Write-Host 'Fonts are ready. Open Lorem Ipsum in Reading view.'
    } elseif ($opened -eq 'opened') {
        Write-Host 'When Obsidian asks, choose "Trust author and enable plugins" (or Restricted mode, to review them first).'
        Write-Host 'Fonts are ready. Open Lorem Ipsum in Reading view.'
    } else {
        Write-Host 'Fonts are ready. Restart any running Obsidian windows to load newly installed fonts.'
        Write-Host 'Open Lorem Ipsum in Reading view. Review the bundled community plugins before enabling them.'
        Write-Host "In Obsidian, choose Open folder as vault and select $destination"
        if ($exe) { Start-Process -FilePath $exe -ArgumentList 'obsidian://choose-vault' }
        else { Write-Host 'Obsidian is not installed on this computer: install it from https://obsidian.md first.' }
    }
} finally {
    Remove-Item -LiteralPath $tempPath -Recurse -Force -ErrorAction SilentlyContinue
}
