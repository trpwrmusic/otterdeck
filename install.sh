#!/usr/bin/env bash
# Installs or updates Otterdeck on Linux, for this user only (no root needed).
#
#   curl -fsSL https://raw.githubusercontent.com/trpwrmusic/otterdeck/master/install.sh | bash
#
# Optional, as environment variables:
#   OTTER_VERSION      a specific version, e.g. 0.2.0 (default: the newest)
#   OTTER_BUNDLE       a local package instead of the download (for tests)
#   OTTER_INSTALL_DIR  installation folder (default: ~/.local/lib/otterdeck)
#   OTTER_ROLE         server or desktop for a first install (default: server without a desktop)
#
# Otterdeck runs as a systemd user service and starts with the computer. Layout:
# <dir>/node (own Node.js), <dir>/versions/<version>, <dir>/current (the version that starts).
# Settings and projects live in ~/.local/share/otterdeck and survive updates.
set -euo pipefail

REPO=trpwrmusic/otterdeck
NODE_VERSION=v22.14.0
say() { printf '  %s\n' "$*"; }

case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) echo "Otterdeck gibt es für $(uname -m) noch nicht." >&2; exit 1 ;;
esac

BASE="${OTTER_INSTALL_DIR:-$HOME/.local/lib/otterdeck}"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/otterdeck"
mkdir -p "$BASE/versions" "$DATA" "$HOME/.local/bin"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo
echo "Otterdeck wird installiert"
say "Ordner: $BASE"

# ---- Node.js: an own copy ----
if [ ! -x "$BASE/node/bin/node" ] || [ "$("$BASE/node/bin/node" --version)" != "$NODE_VERSION" ]; then
  say "Node.js $NODE_VERSION laden"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$ARCH.tar.gz" | tar -xz -C "$TMP"
  rm -rf "$BASE/node"
  mv "$TMP/node-$NODE_VERSION-linux-$ARCH" "$BASE/node"
fi
NODE="$BASE/node/bin/node"

# ---- Otterdeck itself ----
if [ -n "${OTTER_BUNDLE:-}" ]; then
  cp "$OTTER_BUNDLE" "$TMP/otterdeck.tar.gz"
else
  ASSET="otterdeck-linux-$ARCH.tar.gz"
  if [ -n "${OTTER_VERSION:-}" ]; then URL="https://github.com/$REPO/releases/download/v${OTTER_VERSION#v}/$ASSET"
  else URL="https://github.com/$REPO/releases/latest/download/$ASSET"; fi
  say "Otterdeck laden"
  curl -fsSL "$URL" -o "$TMP/otterdeck.tar.gz"
fi
mkdir -p "$TMP/app"
tar -xzf "$TMP/otterdeck.tar.gz" -C "$TMP/app"
VERSION="$("$NODE" -p "require('$TMP/app/package.json').version")"
TARGET="$BASE/versions/$VERSION"
if [ -f "$TARGET/server/index.ts" ]; then
  say "Version $VERSION ist schon da"
else
  rm -rf "$TARGET"
  mv "$TMP/app" "$TARGET"
  say "Version $VERSION installiert"
fi
printf '%s' "$VERSION" >"$BASE/current"

# Older versions: keep the one that starts and the one before.
{ ls -1t "$BASE/versions" | grep -vx "$VERSION" || true; } | tail -n +2 | while read -r old; do rm -rf "${BASE:?}/versions/${old:?}"; done

# ---- "otter" command ----
cat >"$HOME/.local/bin/otter" <<EOF
#!/bin/sh
# otter: open Otterdeck, or otter stop / status / restart
exec "$NODE" "$BASE/versions/\$(cat "$BASE/current")/bin/otter.mjs" "\$@"
EOF
chmod +x "$HOME/.local/bin/otter"

# ---- role at first install: a computer without a desktop is a server ----
if [ ! -f "$DATA/settings.json" ] && [ ! -f "$DATA/state.json" ]; then
  ROLE="${OTTER_ROLE:-}"
  if [ -z "$ROLE" ]; then
    if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then ROLE=desktop; else ROLE=server; fi
  fi
  printf '{\n  "role": "%s"\n}\n' "$ROLE" >"$DATA/settings.json"
  say "Rolle: $ROLE (änderbar in den Einstellungen)"
fi

# ---- systemd user service: runs in the background and starts with the computer ----
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  cat >"$HOME/.config/systemd/user/otterdeck.service" <<EOF
[Unit]
Description=Otterdeck
After=network-online.target

[Service]
# The version in "current" (an update switches it and restarts the service).
ExecStart=/bin/sh -c 'cd "$BASE/versions/\$(cat "$BASE/current")" && exec "$NODE" --import tsx server/index.ts'
Environment=PATH=$BASE/node/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable otterdeck.service >/dev/null 2>&1
  systemctl --user restart otterdeck.service
  say "Dienst otterdeck läuft (systemctl --user status otterdeck)"
  # Without linger, user services stop when you log out.
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
    loginctl enable-linger "$USER" 2>/dev/null && say "Läuft jetzt auch ohne Anmeldung weiter" ||
      say "Damit Otterdeck ohne Anmeldung weiterläuft: sudo loginctl enable-linger $USER"
  fi
else
  say "Kein systemd gefunden. Starten mit: otter"
fi

# ---- Tailscale: the way in from other devices ----
PORT=4747
if command -v tailscale >/dev/null; then
  if [ "${ROLE:-}" = server ] || grep -q '"role": *"server"' "$DATA/settings.json" 2>/dev/null; then
    if tailscale serve --bg --https="$PORT" "http://127.0.0.1:4747" >/dev/null 2>&1; then
      say "Im Tailnet erreichbar: https://$(tailscale status --json | "$NODE" -p "JSON.parse(require('fs').readFileSync(0)).Self.DNSName.replace(/\.$/, '')"):$PORT"
    else
      say "Tailscale-Freigabe braucht einmal: sudo tailscale set --operator=$USER"
      say "danach: tailscale serve --bg --https=$PORT http://127.0.0.1:4747"
    fi
  fi
else
  say "Tailscale fehlt. Für den Zugriff von anderen Geräten: https://tailscale.com/download"
fi

if ! command -v claude >/dev/null && [ ! -x "$HOME/.local/bin/claude" ]; then
  echo
  say "Claude Code fehlt noch. Installieren mit:"
  say "  curl -fsSL https://claude.ai/install.sh | bash"
fi
echo
