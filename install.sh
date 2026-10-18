#!/usr/bin/env bash
# Install MHO Studio out of the repo, build the launchers, register the tile.
# Idempotent: safe to run after every change, and required after one — the
# shortcuts run the installed copy, not the repo.
set -euo pipefail

APP_ID="mho-studio"
APP_NAME="MHO Studio"
APP_ICON="📈"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/$APP_ID"
SHORTCUTS="$HOME/Desktop/Apps"

mkdir -p "$DEST" "$HOME/.config/$APP_ID" "$HOME/.local/state/$APP_ID" "$SHORTCUTS"

# On a Mac without Apple's command line developer tools, /usr/bin/git and /usr/bin/python3 are
# placeholders: running one pops up "install the developer tools" (Xcode). Nothing here needs
# them, so they are only used when they are real.
real() {   # real <tool>: the tool exists and is not one of those placeholders
  command -v "$1" >/dev/null 2>&1 || return 1
  [ "$(uname)" != "Darwin" ] && return 0
  [ "$(command -v "$1")" != "/usr/bin/$1" ] && return 0
  xcode-select -p >/dev/null 2>&1
}

# Pin Node absolutely: Finder gives an app a different PATH than a shell.
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "Node.js is not installed. Download the macOS installer (.pkg, Node 22 LTS or newer) from" >&2
  echo "https://nodejs.org/en/download , install it, then run this again. (No Xcode or Homebrew needed.)" >&2
  exit 1
fi
if ! "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)'; then
  echo "Node.js $("$NODE" -v) is too old: MHO Studio needs 22.18 or newer (https://nodejs.org/en/download)." >&2
  exit 1
fi
NODE="$(cd "$(dirname "$NODE")" && pwd)/$(basename "$NODE")"
NPM="$(dirname "$NODE")/npm"
echo "node: $NODE ($("$NODE" -v))"

# 1. Build the interface in the repo.
( cd "$SRC/ui" && "$NPM" install --silent && "$NPM" run build )

# 2. A running instance keeps its old code in memory but would serve the new interface
#    from disk, and the two would not match. Stop it; the next launch starts fresh.
if pkill -f "$DEST/server/main.ts" 2>/dev/null; then echo "stopped the running $APP_NAME"; sleep 1; fi

# 3. Code -> ~/.local/share. Settings and presets (~/.config) are untouched.
rsync -a --delete \
  --exclude '.git' --exclude 'node_modules' --exclude 'test-results' --exclude 'playwright-report' \
  --exclude 'ui/tests/screenshots' --exclude '.DS_Store' --exclude 'packaging' --exclude '.github' \
  "$SRC/" "$DEST/"
# 3b. What was installed, for the in-app updater (server/update.ts): the branch and commit, from
#     git when this is a checkout, from the updater when it downloaded the commit itself.
BRANCH="${MHO_STUDIO_UPDATE_BRANCH:-}"
COMMIT="${MHO_STUDIO_UPDATE_COMMIT:-}"
DIRTY=false
FROM=update
if [ -z "$COMMIT" ]; then
  FROM=folder
  if [ -d "$SRC/.git" ] && real git && git -C "$SRC" rev-parse HEAD >/dev/null 2>&1; then
    FROM=git
    BRANCH="$(git -C "$SRC" rev-parse --abbrev-ref HEAD)"
    COMMIT="$(git -C "$SRC" rev-parse HEAD)"
    if [ -n "$(git -C "$SRC" status --porcelain)" ]; then DIRTY=true; fi
  fi
fi
cat > "$DEST/build.json" <<BUILD
{ "branch": "$BRANCH", "commit": "$COMMIT", "dirty": $DIRTY, "from": "$FROM", "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
BUILD

# 4a. The server's two dependencies, both optional, both prebuilt native binaries per platform:
#     `usb` (USB-TMC to the scope) and `serialport` (the STM32 board's Si5351 for Bode sweeps).
#     If they cannot be installed, the app still runs and says which part is unavailable.
( cd "$DEST/server" && "$NPM" install --omit=dev --silent ) || echo "note: USB and serial support could not be installed; LAN and the simulators still work"

# 4. The .command — the shortcut that always works.
CMD="$SHORTCUTS/$APP_NAME.command"
cat > "$CMD" <<LAUNCH
#!/usr/bin/env bash
cd "$DEST"
exec "$NODE" "$DEST/server/main.ts" "\$@"
LAUNCH
chmod +x "$CMD"

# 5. Windows: install-windows.bat / install-windows.ps1 and run-mho-studio.bat are kept
#    as files in the repo (CRLF, see .gitattributes); this script does not write them.

# A downloaded ZIP marks every file as quarantined; the installed copy is our own.
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

# 6. App Launcher tile and .app bundle (the Launcher's own install-time tool) — only where App
#    Launcher is installed, and never through the python3 placeholder (see real() above).
if [ -f "$HOME/.local/share/app-launcher/launcher/mkapp.py" ] && real python3; then
python3 "$DEST/scripts/register_launcher.py" \
  --id "$APP_ID" --name "$APP_NAME" --icon "$APP_ICON" --category "Apps" \
  --description "RIGOL MHO900 and Teledyne LeCroy scopes: live scope, settings, triggers, deep memory, FFT, screenshots, console" \
  --cwd "$DEST" \
  --command "\"$NODE\" \"$DEST/server/main.ts\"" \
  --bundle || true
# No --url: the port is chosen by the OS at start-up and the server opens the browser itself.
else
  echo "App Launcher is not installed here: start MHO Studio with $SHORTCUTS/$APP_NAME.command"
fi

# 7. The real icon LAST: mkapp writes an emoji icon that this replaces.
bash "$SRC/scripts/make_icon.sh" "$SRC/branding/icon.svg" "$APP_NAME" "$SRC/ui/public" >/dev/null
cp "$SRC/ui/public/favicon.svg" "$SRC/ui/public/apple-touch-icon.png" "$DEST/ui/dist/" 2>/dev/null || true

echo
echo "Installed to $DEST"
echo "Double-click: $CMD  (or the $APP_NAME tile in App Launcher)"
