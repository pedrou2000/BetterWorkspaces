#!/usr/bin/env bash
# install.sh — symlink the applet into Cinnamon for development.
# Run once inside your dev VM. After that, just edit files and reload
# Cinnamon (Alt+F2, type "r", Enter). No copy/pull needed.
set -euo pipefail

UUID="better-workspaces@pedrou2000"
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="$HOME/.local/share/cinnamon/applets/$UUID"

if [ ! -d "$SRC" ]; then
    echo "error: applet folder not found at $SRC" >&2
    exit 1
fi

mkdir -p "$HOME/.local/share/cinnamon/applets"
rm -rf "$DEST"
ln -s "$SRC" "$DEST"

echo "Linked:"
echo "  $SRC"
echo "  -> $DEST"
echo
echo "Next steps:"
echo "  1. Reload Cinnamon:  Alt+F2, type 'r', Enter"
echo "  2. Enable it:        System Settings > Applets > BetterWorkspaces > +"
echo "  3. Watch for errors: Alt+F2, type 'lg', Enter (Looking Glass, Log tab)"
