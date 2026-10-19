#!/bin/bash
# Installs Asciiwave via Adobe's own plugin installer (UPIA),
# so Creative Cloud knows the plugin and doesn't drop it from the list again.
# Restart Photoshop afterwards: Plugins > Asciiwave.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"

rm -f "$HERE/dist/Asciiwave.ccx"
mkdir -p "$HERE/dist"
(cd "$HERE/ascii" && zip -qr "$HERE/dist/Asciiwave.ccx" . -x '.*')

# only remove if already installed (otherwise the installer hangs)
if "$UPIA" --list all 2>/dev/null | grep -q "Asciiwave"; then
  "$UPIA" --remove "Asciiwave" >/dev/null 2>&1 || true
fi
"$UPIA" --install "$HERE/dist/Asciiwave.ccx"
echo "Done. Restart Photoshop > Plugins > Asciiwave"
