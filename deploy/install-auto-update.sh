#!/usr/bin/env bash
# One-time setup on the server: installs a systemd timer that runs deploy/auto-update.sh every 5 minutes.
#   sudo /opt/upzy/deploy/install-auto-update.sh
# Check it:  systemctl list-timers upzy-update   |   journalctl -u upzy-update -n 30
# Remove it: sudo systemctl disable --now upzy-update.timer
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run with sudo."; exit 1; }
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
user="${UPZY_USER:-ubuntu}"
chmod +x "$dir/auto-update.sh"

cat > /etc/systemd/system/upzy-update.service <<UNIT
[Unit]
Description=Update Upzy to the latest release
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$user
WorkingDirectory=$dir
ExecStart=$dir/auto-update.sh
TimeoutStartSec=15min
UNIT

cat > /etc/systemd/system/upzy-update.timer <<'UNIT'
[Unit]
Description=Check for a new Upzy release every 5 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
RandomizedDelaySec=30s

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now upzy-update.timer
echo "Installed. Next runs:"; systemctl list-timers upzy-update --no-pager
