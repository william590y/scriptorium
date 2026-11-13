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
verify_hash "$work_dir/Writing.zip" '855ceb85e9c3760fbaa956d9845f0b370bab5010dc3fb548a6687b26ada66dd3'
unzip -q "$work_dir/Writing.zip" -d "$work_dir/vault"
[ -f "$work_dir/vault/.obsidian/appearance.json" ] || { printf 'Invalid configuration archive.\n'; exit 1; }
# ---- Finding Obsidian ----
# Obsidian counts as installed only if something here can start it. What a removed Obsidian leaves behind does not
# count: an empty or unreadable AppImage, or a handler for obsidian:// links (a .desktop entry, or only its name in
# mimeapps.list) whose program is gone. Then Obsidian is installed again.
app_image="$HOME/Applications/Obsidian.AppImage"
obsidian_cmd="$(command -v obsidian || true)"
# Obsidian's own command line client, which Obsidian can install as "obsidian", talks to a running Obsidian but cannot
# start one, so it is not a launcher.
is_cli_client() { [ -f "$1" ] && [ "$(wc -c < "$1")" -lt 1000000 ] && grep -q 'unable to find Obsidian' "$1"; }
# Whether the .desktop entry named $1 exists and the program on its Exec line can be run.
desktop_entry_works() {
  local name="$1" dirs dir file line program
  [ -n "$name" ] || return 1
  IFS=: read -r -a dirs <<< "${XDG_DATA_HOME:-$HOME/.local/share}:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
  for dir in "${dirs[@]}"; do
    file="$dir/applications/$name"
    [ -f "$file" ] || continue
    line="$(sed -n 's/^Exec=//p' "$file" | head -n 1)"
    while :; do   # past "env" and VAR=value, to the program
      case "$line" in
        'env '*) line="${line#env }" ;;
        [A-Za-z_]*=*' '*) case "${line%% *}" in *=*) line="${line#* }" ;; *) break ;; esac ;;
        *) break ;;
      esac
    done
    case "$line" in
      '"'*) program="${line#\"}"; program="${program%%\"*}" ;;
      *) program="${line%% *}" ;;
    esac
    [ -n "$program" ] || return 1
    case "$program" in
      /*) [ -x "$program" ] && [ -s "$program" ] ;;
      *) command -v "$program" >/dev/null 2>&1 ;;
    esac
    return
  done
  return 1
}
find_obsidian() {
  if [ -n "$obsidian_cmd" ] && ! is_cli_client "$(readlink -f "$obsidian_cmd")"; then
    launcher=(obsidian)
  elif [ -x "$app_image" ] && [ -s "$app_image" ]; then
    launcher=("$app_image")
  elif command -v flatpak >/dev/null && flatpak info md.obsidian.Obsidian >/dev/null 2>&1; then
    launcher=(flatpak run md.obsidian.Obsidian)
  elif command -v xdg-open >/dev/null && command -v xdg-mime >/dev/null && desktop_entry_works "$(xdg-mime query default x-scheme-handler/obsidian 2>/dev/null || true)"; then
    launcher=(xdg-open)
  else
    return 1
  fi
}
# ---- End of finding Obsidian ----
if ! find_obsidian; then
  case "$(uname -m)" in
    x86_64) asset=Obsidian-1.15.0.AppImage; checksum=1dd8cfb593deaa644101bdb4df65b159ed7985993b6572dd25fd1363459e91cc ;;
    aarch64|arm64) asset=Obsidian-1.15.0-arm64.AppImage; checksum=fb350986a6083f1a26330c297ba2bef8191d60f00f982d4b420c821aceaf04f5 ;;
    *) echo "Obsidian supports x86-64 and ARM64 Linux desktops."; exit 1 ;;
  esac
  echo "Installing Obsidian in $HOME/Applications ..."
  if ! curl --progress-bar --fail --location --proto '=https' --tlsv1.2 "https://github.com/obsidianmd/obsidian-releases/releases/download/v1.15.0/$asset" -o "$work_dir/Obsidian.AppImage"; then
    printf 'Obsidian could not be downloaded, so it was not installed and nothing else was changed.\nCheck the connection and run this again, or install Obsidian from https://obsidian.md first.\n'
    exit 1
  fi
  verify_hash "$work_dir/Obsidian.AppImage" "$checksum"
  mkdir -p "$HOME/Applications"
  # (what is left of an Obsidian that was here before, an empty or unusable file, makes way)
  if [ -e "$app_image" ] || [ -L "$app_image" ]; then mv -f "$app_image" "$app_image.old-$(date +%Y%m%d-%H%M%S)"; fi
  staged_app="$(mktemp "$HOME/Applications/.obsidian-XXXXXXXX")"
  if ! install -m 755 "$work_dir/Obsidian.AppImage" "$staged_app" || ! ln "$staged_app" "$app_image"; then
    rm -f "$staged_app"
    echo "Could not install $app_image. Check the path and try again."
    exit 1
  fi
  rm "$staged_app"
  if ! [ -x "$app_image" ] || ! [ -s "$app_image" ]; then
    printf 'Obsidian was downloaded, but %s is still not there, so nothing else was changed.\nInstall Obsidian from https://obsidian.md, then run this again.\n' "$app_image"
    exit 1
  fi
  printf 'Installed Obsidian (%s)\n' "$app_image"
  launcher=("$app_image")
fi
# Install missing font families for the current user.
font_jobs=()
font_dir="${XDG_DATA_HOME:-$HOME/.local/share}/fonts/scriptorium"
installed_fonts="$(fc-list --format='%{family}\n' 2>/dev/null || true)"
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
if [ -d "$font_dir" ] && command -v fc-cache >/dev/null; then fc-cache -f "$font_dir"; fi
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
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/obsidian"
obsidian_kind=other   # appimage or native: an Obsidian that keeps its settings in $config_dir
cli_client=""         # Obsidian's command line client, shipped with Obsidian 1.12 and later
appimage_file=""
if [ "${launcher[0]}" = "$app_image" ]; then
  appimage_file="$app_image"
elif [ "${launcher[0]}" = obsidian ]; then
  obsidian_file="$(readlink -f "$obsidian_cmd")"
  case "$obsidian_file" in
    /snap/*|*/snap) ;;   # a snap keeps its settings elsewhere
    *.AppImage|*.appimage) appimage_file="$obsidian_file" ;;
    */obsidian)
      obsidian_kind=native
      [ -x "${obsidian_file%/*}/obsidian-cli" ] && cli_client="${obsidian_file%/*}/obsidian-cli" ;;
  esac
fi
if [ -n "$appimage_file" ]; then
  obsidian_kind=appimage
  # Only the client is unpacked from the AppImage; this needs no FUSE.
  (cd "$work_dir" && "$appimage_file" --appimage-extract obsidian-cli >/dev/null 2>&1) || true
  [ -x "$work_dir/squashfs-root/obsidian-cli" ] && cli_client="$work_dir/squashfs-root/obsidian-cli"
fi

# Starts Obsidian in a session of its own, so that closing this terminal does not close it.
start_obsidian() {
  if [ "${launcher[0]}" = "$app_image" ] && [ ! -r /dev/fuse ]; then
    set -- env APPIMAGE_EXTRACT_AND_RUN=1 "${launcher[@]}" "$@"
  else
    set -- "${launcher[@]}" "$@"
  fi
  if command -v setsid >/dev/null; then
    setsid "$@" >/dev/null 2>&1 < /dev/null &
  else
    nohup "$@" >/dev/null 2>&1 < /dev/null &
  fi
}

obsidian_running() { pgrep -u "$(id -u)" -x obsidian >/dev/null 2>&1; }

# Edits obsidian.json, which Obsidian rewrites while it runs, so only while Obsidian is closed:
#   register FILE VAULT yes|no  adds VAULT to the vault list (or finds it there) and, with yes, turns the interface on
#                               ("cli": true); prints the vault's id, then "on" if the interface was on, else "cli" as it
#                               was ("absent", or its JSON).
#   restore FILE PRIOR          puts "cli" back to PRIOR, if it is still true.
# Every other key and vault is kept. A file that is not a JSON object is left alone (and the command fails).
obsidian_json() {
  python3 -I - "$@" <<'PY'
import json, os, random, sys, time
mode, path = sys.argv[1], sys.argv[2]
try:
    with open(path, encoding='utf-8-sig') as f:
        text = f.read()
except FileNotFoundError:
    text = ''
conf = json.loads(text) if text.strip() else {}
if not isinstance(conf, dict):
    sys.exit('obsidian.json is not a JSON object')
changed = False
if mode == 'register':
    vault, turn_on = sys.argv[3], sys.argv[4] == 'yes'
    vaults = conf.setdefault('vaults', {})
    if not isinstance(vaults, dict):
        sys.exit('the vault list in obsidian.json is not a JSON object')
    vault_id = next((k for k, v in vaults.items() if isinstance(v, dict) and isinstance(v.get('path'), str)
                     and os.path.normpath(v['path']) == vault), None)
    if vault_id is None:
        vault_id = '%016x' % random.SystemRandom().getrandbits(64)
        while vault_id in vaults:
            vault_id = '%016x' % random.SystemRandom().getrandbits(64)
        vaults[vault_id] = {'path': vault, 'ts': int(time.time() * 1000)}
        changed = True
    # Obsidian reads "cli" with JavaScript truthiness.
    was_on = 'cli' in conf and (isinstance(conf['cli'], (dict, list)) or conf['cli'] not in (None, False, 0, ''))
    prior = 'on' if was_on else json.dumps(conf['cli']) if 'cli' in conf else 'absent'
    if turn_on and not was_on:
        conf['cli'] = True
        changed = True
    print(vault_id)
    print(prior)
elif mode == 'restore' and conf.get('cli') is True:
    if sys.argv[3] == 'absent':
        del conf['cli']
    else:
        conf['cli'] = json.loads(sys.argv[3])
    changed = True
if changed:
    temp = path + '.scriptorium-tmp'
    with open(temp, 'w', encoding='utf-8') as f:
        json.dump(conf, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(temp, path)
PY
}

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
  local registration vault_id prior_cli answer asked=no trusted=no restored=no deadline turn_on=no
  if [ "$obsidian_kind" = other ]; then
    printf 'Scriptorium does not know where this Obsidian (%s) keeps its vault list, so it did not open the vault.\n' "${launcher[*]}"
    return 1
  fi
  if ! command -v python3 >/dev/null || ! command -v pgrep >/dev/null; then
    printf 'Opening the vault in Obsidian needs python3 and pgrep, and one of them is missing.\n'
    return 1
  fi
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
  start_obsidian "$vault_path"
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
    if [ "$restored" = no ] && ! obsidian_running && obsidian_json restore "$config_dir/obsidian.json" "$prior_cli"; then
      restored=yes
    fi
    if [ "$restored" = no ]; then
      # Obsidian runs but does not answer: turn the interface off in obsidian.json once Obsidian has closed.
      (
        trap '' HUP
        while obsidian_running; do sleep 5; done
        obsidian_json restore "$config_dir/obsidian.json" "$prior_cli"
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
     start_obsidian obsidian://choose-vault ;;
esac
printf '\nPress Enter to close. '
read -r _
