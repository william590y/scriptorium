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
verify_hash "$work_dir/Writing.zip" '2ee17d46c056dbd5c14e7f133dd0e1362729042cfb2efe3a179b9905ac3d9e62'
unzip -q "$work_dir/Writing.zip" -d "$work_dir/vault"
[ -f "$work_dir/vault/.obsidian/appearance.json" ] || { printf 'Invalid configuration archive.\n'; exit 1; }
app_path="$(osascript -l JavaScript -e 'ObjC.import("AppKit"); const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier("md.obsidian"); if (url && !url.isNil()) ObjC.unwrap(url.path)' 2>/dev/null || true)"
if [ ! -d "$app_path" ] && [ -d /Applications/Obsidian.app ]; then
  app_path=/Applications/Obsidian.app
fi
if [ ! -d "$app_path" ]; then
  app_path="$HOME/Applications/Obsidian.app"
  if [ ! -d "$app_path" ]; then
    echo "Installing Obsidian in $HOME/Applications ..."
    curl --progress-bar --fail --location --proto '=https' --tlsv1.2 'https://github.com/obsidianmd/obsidian-releases/releases/download/v1.15.0/Obsidian-1.15.0.dmg' -o "$work_dir/Obsidian.dmg"
    verify_hash "$work_dir/Obsidian.dmg" 'd3f837e6fd3efaf65fa0bec987b18296982995d4ddae3171a7f7f67e0e2b7aa8'
    mount_dir="$work_dir/disk"
    mkdir "$mount_dir"
    hdiutil attach -readonly -nobrowse -mountpoint "$mount_dir" "$work_dir/Obsidian.dmg" >/dev/null
    trap 'hdiutil detach "$mount_dir" >/dev/null && rm -rf "$work_dir"' EXIT
    mkdir -p "$HOME/Applications"
    staging_app="$(mktemp -d "$HOME/Applications/.obsidian-XXXXXXXX")"
    if ! ditto "$mount_dir/Obsidian.app" "$staging_app/Obsidian.app" || ! mv -n "$staging_app/Obsidian.app" "$app_path"; then
      rm -rf "$staging_app"
      exit 1
    fi
    rm -rf "$staging_app"
    hdiutil detach "$mount_dir" >/dev/null
    trap 'rm -rf "$work_dir"' EXIT
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
printf '\nInstalled in %s\n' "$destination"
printf 'Fonts are ready. Restart any running Obsidian windows to load newly installed fonts.\nOpen Lorem Ipsum in Reading view. Review community plugins before enabling them.\n'
printf 'In Obsidian, choose Open folder as vault and select %s\n' "$destination"
open -a "$app_path" obsidian://choose-vault
printf '\nPress Enter to close. '
read -r _
