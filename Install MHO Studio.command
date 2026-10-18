#!/usr/bin/env bash
# Double-click to install MHO Studio on a Mac (it runs install.sh in this folder).
# Needs only Node.js 22.18 or newer (https://nodejs.org/en/download) — no Xcode, no Homebrew.
# Afterwards start the app with "MHO Studio.command" in ~/Desktop/Apps.
#
# A folder downloaded as a ZIP is quarantined by macOS: the first time, right-click this file →
# Open (macOS 15: System Settings → Privacy & Security → "Open Anyway").
cd "$(dirname "$0")"
# A double-clicked .command gets a login shell's PATH; add where the Node installer puts node.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "MHO Studio needs Node.js 22.18 or newer, and it is not installed."
  echo "Opening the download page: take the macOS Installer (.pkg), install it, then double-click this file again."
  open "https://nodejs.org/en/download"
  echo
  read -r -p "Press Return to close this window."
  exit 1
fi
if bash ./install.sh; then
  echo
  echo "Done. Starting MHO Studio…"
  open "$HOME/Desktop/Apps/MHO Studio.command"
else
  echo
  echo "The installation stopped — the message above says where."
fi
echo
read -r -p "Press Return to close this window."
