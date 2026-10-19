#!/bin/bash
# Installs MS ASCII via Adobe's own plugin installer (UPIA),
# so Creative Cloud knows the plugin and doesn't drop it from the list again.
# Restart Photoshop afterwards: Plugins > MS ASCII.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"

rm -f "$HERE/dist/MS-ASCII.ccx"
mkdir -p "$HERE/dist"
(cd "$HERE/ascii" && zip -qr "$HERE/dist/MS-ASCII.ccx" . -x '.*')

# only remove if already installed (otherwise the installer hangs)
if "$UPIA" --list all 2>/dev/null | grep -q "MS ASCII"; then
  "$UPIA" --remove "MS ASCII" >/dev/null 2>&1 || true
fi
"$UPIA" --install "$HERE/dist/MS-ASCII.ccx"
echo "Done. Restart Photoshop > Plugins > MS ASCII"
