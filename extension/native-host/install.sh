#!/usr/bin/env bash
# Registers host.py with Brave so the extension can call it. Run once.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/config.json" ] || { cp "$HERE/config.example.json" "$HERE/config.json"; echo "created config.json, edit it"; }
ID="$(cat "$HERE/extension-id.txt")"
# Brave's documented folder, plus Chrome's: the Brave 1.99 build on this Mac only reads Chrome's.
for DIR in "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
           "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"; do
  mkdir -p "$DIR"
  cat > "$DIR/com.pagecrawl.cookies.json" <<JSON
{
  "name": "com.pagecrawl.cookies",
  "description": "Saves and copies cookies for the Pagecrawl cookies extension",
  "path": "$HERE/host.py",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ID/"]
}
JSON
  echo "registered in $DIR"
done
echo "extension id $ID"
