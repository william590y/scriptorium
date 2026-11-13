#!/bin/bash
set -euo pipefail
printf '\nScriptorium - Obsidian configuration installer\n'
default_path="$HOME/Documents/Scriptorium"
printf 'New vault folder (Enter for %s): ' "$default_path"
read -r destination
destination="${destination:-$default_path}"
case "$destination" in /*) ;; *) printf 'Please enter an absolute path.\n'; exit 1 ;; esac
if [ -e "$destination" ] || [ -L "$destination" ]; then
  printf 'Folder already exists: %s. Choose a new folder; nothing was changed.\n' "$destination"
  printf 'To set up Scriptorium in a vault you already have, use Setup-Scriptorium-Vault.py (see the README).\n'
  exit 1
fi
for utility in curl unzip; do
  command -v "$utility" >/dev/null || { printf 'Please install %s and try again.\n' "$utility"; exit 1; }
done
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
curl --progress-bar --fail --location --proto '=https' --tlsv1.2 'https://williamliaw.com/assets/downloads/Scriptorium.zip' -o "$work_dir/Writing.zip"
verify_hash() {
  local actual_hash
  if command -v shasum >/dev/null; then
    actual_hash="$(shasum -a 256 "$1")"
  elif command -v sha256sum >/dev/null; then
    actual_hash="$(sha256sum "$1")"
  else
    printf 'Please install shasum or sha256sum for package verification.\n'; exit 1
  fi
  actual_hash="${actual_hash%% *}"
  [ "$actual_hash" = "$2" ] || { echo "Download verification failed for $1."; exit 1; }
}
verify_hash "$work_dir/Writing.zip" 'e0c4aae7b6d5a53a0ba79495061bbaac31a9e47c4b61c35f340d8e3a70ee68e8'
unzip -q "$work_dir/Writing.zip" -d "$work_dir/vault"
[ -f "$work_dir/vault/.obsidian/appearance.json" ] || { printf 'Invalid configuration archive.\n'; exit 1; }
# ---- Finding Obsidian ----
# Obsidian counts as installed only if the app is really there. macOS can still name an Obsidian that was removed: the
# one in the Trash, or a path whose app is gone. Such leftovers do not count, and Obsidian is installed again.
usable_app() {
  case "$1" in ''|*/.Trash/*|*/.Trashes/*) return 1 ;; esac
  [ -d "$1" ] && [ -x "$1/Contents/MacOS/Obsidian" ]
}
find_obsidian_app() {
  local found
  found="$(osascript -l JavaScript -e 'ObjC.import("AppKit"); const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier("md.obsidian"); if (url && !url.isNil()) ObjC.unwrap(url.path)' 2>/dev/null || true)"
  for found in "$found" "${OBSIDIAN_APPLICATIONS:-/Applications}/Obsidian.app" "$HOME/Applications/Obsidian.app"; do
    if usable_app "$found"; then printf '%s\n' "$found"; return 0; fi
  done
  return 1
}
# ---- End of finding Obsidian ----
app_path="$(find_obsidian_app || true)"
if [ -z "$app_path" ]; then
  app_path="$HOME/Applications/Obsidian.app"
  if [ -e "$app_path" ]; then
    printf '%s is there but is not a working Obsidian. Move it to the Trash, then run this again.\n' "$app_path"
    exit 1
  fi
  if true; then
    echo "Installing Obsidian in $HOME/Applications ..."
    if ! curl --progress-bar --fail --location --proto '=https' --tlsv1.2 'https://github.com/obsidianmd/obsidian-releases/releases/download/v1.15.0/Obsidian-1.15.0.dmg' -o "$work_dir/Obsidian.dmg"; then
      printf 'Obsidian could not be downloaded, so it was not installed and nothing else was changed.\nCheck the connection and run this again, or install Obsidian from https://obsidian.md first.\n'
      exit 1
    fi
    verify_hash "$work_dir/Obsidian.dmg" 'd3f837e6fd3efaf65fa0bec987b18296982995d4ddae3171a7f7f67e0e2b7aa8'
    mount_dir="$work_dir/disk"
    mkdir "$mount_dir"
    hdiutil attach -readonly -nobrowse -mountpoint "$mount_dir" "$work_dir/Obsidian.dmg" >/dev/null
    trap 'hdiutil detach "$mount_dir" >/dev/null && rm -rf "$work_dir"' EXIT
    mkdir -p "$HOME/Applications"
    staging_app="$(mktemp -d "$HOME/Applications/.obsidian-XXXXXXXX")"
    if ! ditto "$mount_dir/Obsidian.app" "$staging_app/Obsidian.app" || ! mv -n "$staging_app/Obsidian.app" "$app_path"; then
      rm -rf "$staging_app"
      printf 'Obsidian could not be copied to %s, so it was not installed and nothing else was changed.\n' "$app_path"
      exit 1
    fi
    rm -rf "$staging_app"
    hdiutil detach "$mount_dir" >/dev/null
    trap 'rm -rf "$work_dir"' EXIT
    if ! usable_app "$app_path"; then
      printf 'Obsidian was copied, but %s is still not a working app, so nothing else was changed.\nInstall Obsidian from https://obsidian.md, then run this again.\n' "$app_path"
      exit 1
    fi
    printf 'Installed Obsidian (%s)\n' "$app_path"
  fi
fi
# Install missing font families for the current user.
font_jobs=()
font_dir="$HOME/Library/Fonts"
installed_fonts="$(system_profiler SPFontsDataType 2>/dev/null || true)"
install_font() {
  local filename="$1" url="$2" checksum="$3"
  if [ -f "$font_dir/$filename" ]; then
    verify_hash "$font_dir/$filename" "$checksum"
    return
  fi
  curl --progress-bar --fail --location --proto '=https' --tlsv1.2 "$url" -o "$work_dir/$filename"
  verify_hash "$work_dir/$filename" "$checksum"
  mkdir -p "$font_dir"
  install -m 644 "$work_dir/$filename" "$font_dir/$filename"
}
if ! printf '%s\n' "$installed_fonts" | grep -Fq 'EB Garamond'; then
  printf 'Installing EB Garamond ...\n'
  install_font 'EBGaramond-Scriptorium.ttf' 'https://raw.githubusercontent.com/google/fonts/5bb28733cec313b63fbd415b574b5ae35c8aa8b8/ofl/ebgaramond/EBGaramond%5Bwght%5D.ttf' 'ef9512f92f6d579e5dc75af59a5a4b1b8b47d2eda89e00b954d44520e5369027' &
  font_jobs+=("$!")
  install_font 'EBGaramond-Italic-Scriptorium.ttf' 'https://raw.githubusercontent.com/google/fonts/5bb28733cec313b63fbd415b574b5ae35c8aa8b8/ofl/ebgaramond/EBGaramond-Italic%5Bwght%5D.ttf' 'bba2c4499c93c9612b90b9825d32b07da52fce2fe57562a1eb6b833553f93c4e' &
  font_jobs+=("$!")
fi
if ! printf '%s\n' "$installed_fonts" | grep -Fq 'Cormorant Garamond'; then
  printf 'Installing Cormorant Garamond ...\n'
  install_font 'CormorantGaramond-Scriptorium.ttf' 'https://raw.githubusercontent.com/google/fonts/5bb28733cec313b63fbd415b574b5ae35c8aa8b8/ofl/cormorantgaramond/CormorantGaramond%5Bwght%5D.ttf' 'b20b7d9626dd956b2c5e558692ad328b1f19e3275e2782db4fa07670d83f35e0' &
  font_jobs+=("$!")
  install_font 'CormorantGaramond-Italic-Scriptorium.ttf' 'https://raw.githubusercontent.com/google/fonts/5bb28733cec313b63fbd415b574b5ae35c8aa8b8/ofl/cormorantgaramond/CormorantGaramond-Italic%5Bwght%5D.ttf' '0f48ea6abb2084537854f7174c470991a463b13036309e3b50a81511611c530d' &
  font_jobs+=("$!")
fi
font_download_failed=0
for job in ${font_jobs[*]-}; do
  wait "$job" || font_download_failed=1
done
[ "$font_download_failed" -eq 0 ] || { echo "Font installation failed. Please try again."; exit 1; }
# mkdir fails if the destination appeared during the download; never merge into an existing vault.
mkdir -p "$(dirname "$destination")"
mkdir "$destination"
cp -R "$work_dir/vault/." "$destination/"
vault_path="$(cd "$destination" && pwd)"

# ---- Open the new vault in Obsidian with its community plugins on ----
# The first time Obsidian opens a vault that comes with plugins, it asks whether to trust the vault's author and keeps
# the answer in its own storage. Obsidian 1.12 and later has a command line interface that gives the same answer:
# "plugins:restrict off" does what the question's "Trust author and enable plugins" does. The interface answers only
# while "cli": true is in Obsidian's obsidian.json, which Obsidian reads when it starts and rewrites while it runs. So,
# with Obsidian closed, this adds the vault to obsidian.json's vault list and turns the interface on, starts Obsidian on
# the vault, asks it to leave Restricted mode, and turns the interface off again through Obsidian (unless it was on
# already). If anything fails, Obsidian asks its usual question.
config_dir="$HOME/Library/Application Support/obsidian"
cli_client=""   # Obsidian's command line client, in the app from Obsidian 1.12 on
[ -x "$app_path/Contents/MacOS/obsidian-cli" ] && cli_client="$app_path/Contents/MacOS/obsidian-cli"

obsidian_running() { pgrep -u "$(id -u)" -x Obsidian >/dev/null 2>&1; }

# Edits obsidian.json, which Obsidian rewrites while it runs, so only while Obsidian is closed:
#   register FILE VAULT yes|no  adds VAULT to the vault list (or finds it there) and, with yes, turns the interface on
#                               ("cli": true); prints the vault's id, then "on" if the interface was on, else "cli" as it
#                               was ("absent", or its JSON).
#   restore FILE PRIOR          puts "cli" back to PRIOR, if it is still true.
# Every other key and vault is kept. A file that is not a JSON object is left alone (and the command fails).
cat > "$work_dir/obsidian-json.js" <<'JS'
function edit(text, args, now, newId) {
  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  var conf = /\S/.test(text) ? JSON.parse(text.replace(/^\uFEFF/, '')) : {}, changed = false, out = '';
  if (!conf || typeof conf !== 'object' || Array.isArray(conf)) throw new Error('obsidian.json is not a JSON object');
  if (args[0] === 'register') {
    var vault = args[2], id = null;
    if (!has(conf, 'vaults')) conf.vaults = {};
    var vaults = conf.vaults;
    if (!vaults || typeof vaults !== 'object' || Array.isArray(vaults)) throw new Error('the vault list in obsidian.json is not a JSON object');
    for (var k in vaults) {
      var v = vaults[k];
      if (v && typeof v === 'object' && typeof v.path === 'string' && v.path.replace(/\/+/g, '/').replace(/(.)\/$/, '$1') === vault) { id = k; break; }
    }
    if (id === null) {
      do id = newId(); while (has(vaults, id));
      vaults[id] = { path: vault, ts: now };
      changed = true;
    }
    var wasOn = has(conf, 'cli') && !!conf.cli;   // Obsidian's own reading of it
    out = id + '\n' + (wasOn ? 'on' : has(conf, 'cli') ? JSON.stringify(conf.cli) : 'absent');
    if (args[3] === 'yes' && !wasOn) { conf.cli = true; changed = true; }
  } else if (args[0] === 'restore' && conf.cli === true) {
    if (args[2] === 'absent') delete conf.cli; else conf.cli = JSON.parse(args[2]);
    changed = true;
  }
  return { out: out, text: changed ? JSON.stringify(conf) : null };
}

function run(argv) {
  ObjC.import('Foundation');
  var file = argv[1], text = '';
  if ($.NSFileManager.defaultManager.fileExistsAtPath(file)) {
    var read = $.NSString.stringWithContentsOfFileEncodingError(file, $.NSUTF8StringEncoding, null);
    if (read.isNil()) throw new Error('cannot read ' + file);
    text = ObjC.unwrap(read);
  }
  var r = edit(text, argv, Date.now(), function () {
    var id = '';
    for (var i = 0; i < 16; i++) id += Math.floor(Math.random() * 16).toString(16);
    return id;
  });
  if (r.text !== null && !$(r.text).writeToFileAtomicallyEncodingError(file, true, $.NSUTF8StringEncoding, null)) throw new Error('cannot write ' + file);
  return r.out;
}
JS
obsidian_json() { osascript -l JavaScript "$work_dir/obsidian-json.js" "$@"; }

# Runs Obsidian's command line client and prints Obsidian's answer; gives up after $1 seconds.
ask_obsidian() {
  local limit="$1" ticks=0 pid
  shift
  "$cli_client" "$@" > "$work_dir/answer" 2>&1 < /dev/null &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$ticks" -ge $((limit * 5)) ]; then kill "$pid" 2>/dev/null || true; break; fi
    sleep 0.2
    ticks=$((ticks + 1))
  done
  wait "$pid" 2>/dev/null || true
  cat "$work_dir/answer" 2>/dev/null || true
}

# Returns 0 if the vault is open with its plugins on, 2 if it is open without them, 1 if it was not opened.
open_new_vault() {
  local registration vault_id prior_cli answer asked=no trusted=no restored=no deadline turn_on=no watch_js
  if obsidian_running; then
    printf 'Obsidian is open, so Scriptorium did not open the new vault in it: that needs Obsidian closed.\n'
    return 1
  fi
  [ -n "$cli_client" ] && turn_on=yes
  mkdir -p "$config_dir"
  if ! registration="$(obsidian_json register "$config_dir/obsidian.json" "$vault_path" "$turn_on")"; then
    printf 'Could not add the vault to the vault list in %s.\n' "$config_dir/obsidian.json"
    return 1
  fi
  vault_id="$(printf '%s\n' "$registration" | sed -n 1p)"
  prior_cli="$(printf '%s\n' "$registration" | sed -n 2p)"
  printf 'Opening the vault in Obsidian ...\n'
  if ! open -a "$app_path" --args "$vault_path"; then
    [ "$turn_on" = yes ] && obsidian_json restore "$config_dir/obsidian.json" "$prior_cli" >/dev/null
    printf 'Could not start Obsidian.\n'
    return 1
  fi
  if [ "$turn_on" = no ]; then
    printf 'This Obsidian is older than 1.12 and has no command line interface, so its plugins are not on yet.\n'
    return 2
  fi
  # Until Obsidian is up its client cannot reach it; then Obsidian answers once the vault has loaded (just after loading
  # it may not know the command yet, and says so: ask again).
  deadline=$((SECONDS + 120))
  while [ "$asked" = no ] && [ "$SECONDS" -lt "$deadline" ]; do
    answer="$(ask_obsidian 60 "vault=$vault_id" plugins:restrict off)"
    case "$answer" in
      'Restricted mode disabled'*|'Restricted mode is already disabled'*) asked=yes ;;
      'Command line interface is not enabled'*|'Vault not found'*) break ;;
      *) sleep 1 ;;
    esac
  done
  # Obsidian reloads the vault after answering; the reloaded vault confirms.
  deadline=$((SECONDS + 60))
  while [ "$asked" = yes ] && [ "$trusted" = no ] && [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(ask_obsidian 60 "vault=$vault_id" plugins:restrict)" = off ]; then trusted=yes; else sleep 1; fi
  done
  if [ "$prior_cli" != on ]; then
    # Turn the interface off again through Obsidian's own setting, which also updates obsidian.json.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      obsidian_running || break
      answer="$(ask_obsidian 15 eval "code=require('electron').ipcRenderer.sendSync('cli',false)")"
      case "$answer" in '=> false'|'Command line interface is not enabled'*) restored=yes; break ;; esac
      sleep 1
    done
    if [ "$restored" = no ] && ! obsidian_running && obsidian_json restore "$config_dir/obsidian.json" "$prior_cli" >/dev/null; then
      restored=yes
    fi
    if [ "$restored" = no ]; then
      # Obsidian runs but does not answer: turn the interface off in obsidian.json once Obsidian has closed. (This
      # outlives the script, so it keeps its own copy of the editor.)
      watch_js="$(mktemp -t scriptorium-obsidian-json)"
      cp "$work_dir/obsidian-json.js" "$watch_js"
      (
        trap '' HUP
        while obsidian_running; do sleep 5; done
        osascript -l JavaScript "$watch_js" restore "$config_dir/obsidian.json" "$prior_cli"
        rm -f "$watch_js"
      ) >/dev/null 2>&1 < /dev/null &
      printf "Obsidian's command line interface, turned on for this, will be turned off when Obsidian closes.\n"
    fi
  fi
  if [ "$trusted" = yes ]; then return 0; fi
  printf 'Could not turn on its plugins automatically (Obsidian did not confirm in time).\n'
  return 2
}

printf '\nInstalled in %s\n' "$destination"
opened=0
open_new_vault || opened=$?
case "$opened" in
  0) printf 'Opened it in Obsidian with its community plugins on (as "Trust author and enable plugins" does).\n'
     printf 'Fonts are ready. Open Lorem Ipsum in Reading view.\n' ;;
  2) printf 'When Obsidian asks, choose "Trust author and enable plugins" (or Restricted mode, to review them first).\n'
     printf 'Fonts are ready. Open Lorem Ipsum in Reading view.\n' ;;
  *) printf 'Fonts are ready. Restart any running Obsidian windows to load newly installed fonts.\nOpen Lorem Ipsum in Reading view. Review community plugins before enabling them.\n'
     printf 'In Obsidian, choose Open folder as vault and select %s\n' "$destination"
     open -a "$app_path" obsidian://choose-vault ;;
esac
printf '\nPress Enter to close. '
read -r _
