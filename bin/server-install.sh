#!/usr/bin/env bash
# Installs or updates Otterdeck on a Linux server, as a systemd user service (no root needed).
# Runs on the server, from the unpacked Otterdeck folder (~/otterdeck). See README → Server.
#
# Settings (environment, all optional):
#   OTTER_SERVE_PORT        HTTPS port in the tailnet (default 4747; 443 is often taken)
#   OTTER_TAILSCALE         tailscale CLI (default: tailscale in PATH)
#   OTTER_TAILSCALE_SOCKET  socket of a tailscaled running without root
set -euo pipefail
cd "$(dirname "$0")/.."
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
DIR="$PWD"
NODE_DIR="${NODE_DIR:-$HOME/.local/node/bin}"
export PATH="$NODE_DIR:$HOME/.local/bin:$PATH"
PORT="${OTTER_SERVE_PORT:-4747}"

echo "· Pakete"
# node-pty would need a compiler; the prebuilt fork brings its own binary.
npm install --no-audit --no-fund --ignore-scripts >/dev/null
npm rebuild @homebridge/node-pty-prebuilt-multiarch >/dev/null

echo "· Dienst"
mkdir -p "$HOME/.config/systemd/user"
cat >"$HOME/.config/systemd/user/otterdeck.service" <<UNIT
[Unit]
Description=Otterdeck (Server)
After=network-online.target

[Service]
WorkingDirectory=$DIR
Environment=OTTER_SERVER=1
Environment=OTTER_SERVE_PORT=$PORT
Environment=OTTER_TAILSCALE=${OTTER_TAILSCALE:-$(command -v tailscale || echo tailscale)}
Environment=OTTER_TAILSCALE_SOCKET=${OTTER_TAILSCALE_SOCKET:-}
Environment=PATH=$NODE_DIR:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE_DIR/node --import tsx server/index.ts
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now otterdeck.service >/dev/null
systemctl --user restart otterdeck.service
sleep 3
systemctl --user --no-pager --lines=0 status otterdeck.service | head -3

echo "· Tailscale (nur im Tailnet, kein Funnel)"
TS=(${OTTER_TAILSCALE:-tailscale})
[ -n "${OTTER_TAILSCALE_SOCKET:-}" ] && TS+=(--socket "$OTTER_TAILSCALE_SOCKET")
"${TS[@]}" serve --bg --https="$PORT" "http://127.0.0.1:4747" >/dev/null
"${TS[@]}" serve status | sed -n '1,20p'
