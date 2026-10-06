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

# Pin Node absolutely: Finder gives an app a different PATH than a shell.
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "Node is not on PATH. Install Node 22.18 or newer (brew install node) and run this again." >&2
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
  --exclude 'ui/tests/screenshots' --exclude '.DS_Store' \
  "$SRC/" "$DEST/"
# 4a. The server's one dependency, optional: `usb` (USB-TMC; prebuilt native binary per platform).
#     If it cannot be installed, the app still runs and says USB is unavailable.
( cd "$DEST/server" && "$NPM" install --omit=dev --silent ) || echo "note: USB support could not be installed; LAN and the simulator still work"

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

# 6. App Launcher tile and .app bundle (the Launcher's own install-time tool).
python3 "$DEST/scripts/register_launcher.py" \
  --id "$APP_ID" --name "$APP_NAME" --icon "$APP_ICON" --category "Apps" \
  --description "RIGOL MHO900 and Teledyne LeCroy scopes: live scope, settings, triggers, deep memory, FFT, screenshots, console" \
  --cwd "$DEST" \
  --command "\"$NODE\" \"$DEST/server/main.ts\"" \
  --bundle || true
# No --url: the port is chosen by the OS at start-up and the server opens the browser itself.

# 7. The real icon LAST: mkapp writes an emoji icon that this replaces.
"$SRC/scripts/make_icon.sh" "$SRC/branding/icon.svg" "$APP_NAME" "$SRC/ui/public" >/dev/null
cp "$SRC/ui/public/favicon.svg" "$SRC/ui/public/apple-touch-icon.png" "$DEST/ui/dist/" 2>/dev/null || true

echo
echo "Installed to $DEST"
echo "Double-click: $CMD  (or the $APP_NAME tile in App Launcher)"
