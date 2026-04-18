#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One-command server installer for ACC.
#
# Usage:
#   curl -fsSL https://get.xagenpay.com/install-server | \
#     ACC_PUBLIC_HOSTNAME=acc.mystore.com bash
#
# Optional env vars:
#   ACC_ADMIN_EMAIL   email registered with Let's Encrypt (certbot).
#                     Recommended for expiry notifications; not required.
#   ACC_USER          dedicated system user (default: acc).
#   ACC_PORT          local loopback port acc binds to (default: 10000).
#
# What the script does, end to end:
#   1. Pre-flight (root? hostname set? DNS matches this server's IP?)
#   2. Detects existing install → offers upgrade or bails cleanly.
#   3. Creates the acc system user with a locked-down home.
#   4. Installs the acc binary into ~acc/.acc/bin via the CLI installer.
#   5. Writes a systemd unit that runs `acc start` as the acc user.
#   6. Configures a reverse-proxy:
#        - nginx if it's already running on this host (most common)
#        - Caddy otherwise (installs from Cloudsmith; auto-TLS)
#      Includes certbot setup for nginx.
#   7. Runs `acc init` interactively (re-attaching stdin to /dev/tty so the
#      wizard works even when piped through `curl | bash`). Pre-seeds the
#      public URL from ACC_PUBLIC_HOSTNAME; everything else — signer,
#      payout address, Shopify pair — runs through the normal prompts.
#   8. `systemctl enable --now acc`; smoke-tests the public URL.
#
# The merchant's browser handles the Shopify authorize step; they can do
# that from their laptop/phone while SSH'd into the server. No display /
# browser / X11 is required on the server itself.
# ---------------------------------------------------------------------------

set -euo pipefail

ACC_PUBLIC_HOSTNAME="${ACC_PUBLIC_HOSTNAME:-}"
ACC_USER="${ACC_USER:-acc}"
ACC_PORT="${ACC_PORT:-10000}"
ACC_ADMIN_EMAIL="${ACC_ADMIN_EMAIL:-}"

# ── Helpers (defined up top so they're available when bash streams the
#     file from curl and reaches the reverse-proxy case block below) ────────

write_caddyfile() {
    mkdir -p /var/log/caddy
    cat > /etc/caddy/Caddyfile <<CADDY
${ACC_PUBLIC_HOSTNAME} {
    reverse_proxy 127.0.0.1:${ACC_PORT} {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host {host}
    }
    log {
        output file /var/log/caddy/acc-access.log {
            roll_size 50MiB
            roll_keep 7
        }
        format json
    }
    header {
        -Server
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
}
CADDY
}

# ── Pre-flight ──────────────────────────────────────────────────────────────

if [ -z "${ACC_PUBLIC_HOSTNAME}" ]; then
    cat >&2 <<EOF
error: ACC_PUBLIC_HOSTNAME is required.
       curl -fsSL https://get.xagenpay.com/install-server | \\
         ACC_PUBLIC_HOSTNAME=acc.mystore.com bash
EOF
    exit 2
fi

if [ "$(id -u)" -ne 0 ]; then
    echo "error: must run as root. Re-invoke with sudo." >&2
    exit 2
fi

echo
echo "▲  ACC server bootstrap"
echo "   Hostname:   ${ACC_PUBLIC_HOSTNAME}"
echo "   User:       ${ACC_USER}"
echo "   Local port: ${ACC_PORT}"
echo

# DNS sanity check. Non-fatal — user may be configuring DNS in parallel —
# but warn so they don't waste time on a broken certbot run later.
server_ip="$(curl -sS --max-time 5 https://checkip.amazonaws.com 2>/dev/null || true)"
if command -v dig >/dev/null 2>&1; then
    dns_ip="$(dig +short "${ACC_PUBLIC_HOSTNAME}" @8.8.8.8 2>/dev/null | tail -1 || true)"
else
    dns_ip=""
fi
if [ -n "${server_ip}" ] && [ -n "${dns_ip}" ] && [ "${server_ip}" != "${dns_ip}" ]; then
    cat >&2 <<EOF
⚠  DNS for ${ACC_PUBLIC_HOSTNAME} resolves to ${dns_ip}
   but this server's public IP appears to be ${server_ip}.
   TLS issuance (certbot / Caddy ACME) will fail until the A record
   points here. Continuing — fix DNS + re-run this installer once it
   propagates.

EOF
fi

# Idempotency: detect existing install before stomping anything.
if systemctl list-unit-files acc.service >/dev/null 2>&1 && \
   [ -e "/home/${ACC_USER}/.acc/bin/acc" ]; then
    echo "ℹ  acc is already installed on this host."
    echo "   To upgrade the binary: sudo -u ${ACC_USER} /home/${ACC_USER}/.acc/bin/acc upgrade"
    echo "   To reconfigure from scratch: systemctl stop acc; rm -rf /home/${ACC_USER}/.acc; sudo userdel ${ACC_USER}; then re-run this installer."
    echo
    echo "Aborting to avoid overwriting existing state." >&2
    exit 1
fi

# ── 1. System user ─────────────────────────────────────────────────────────

if ! id -u "${ACC_USER}" >/dev/null 2>&1; then
    echo "→ Creating system user: ${ACC_USER}"
    useradd --system --create-home --shell /bin/bash "${ACC_USER}"
    chmod 750 "/home/${ACC_USER}"
else
    echo "✓ User ${ACC_USER} already exists"
fi

# ── 2. Install binary ──────────────────────────────────────────────────────

if [ ! -x "/home/${ACC_USER}/.acc/bin/acc" ]; then
    echo "→ Installing acc binary for ${ACC_USER}…"
    sudo -u "${ACC_USER}" -- bash -c 'curl -fsSL https://get.xagenpay.com/install | sh'
else
    echo "✓ acc binary already present"
fi

# ── 3. systemd unit ────────────────────────────────────────────────────────

echo "→ Writing systemd unit /etc/systemd/system/acc.service"
cat > /etc/systemd/system/acc.service <<UNIT
[Unit]
Description=Agentic Commerce Connector (acc start)
Documentation=https://github.com/rocloveai/Agentic-Commerce-Connector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${ACC_USER}
Group=${ACC_USER}
WorkingDirectory=/home/${ACC_USER}
Environment=HOME=/home/${ACC_USER}
Environment=PORTAL_PORT=${ACC_PORT}
ExecStart=/home/${ACC_USER}/.acc/bin/acc start
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/${ACC_USER}/.acc
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload

# ── 4. Reverse proxy + TLS ─────────────────────────────────────────────────

proxy_kind=""
if command -v nginx >/dev/null 2>&1 && systemctl is-active --quiet nginx; then
    proxy_kind="nginx"
elif command -v caddy >/dev/null 2>&1 && systemctl is-active --quiet caddy; then
    proxy_kind="caddy"
fi

case "${proxy_kind}" in
    nginx)
        echo "→ nginx detected — configuring site block"
        site_file="/etc/nginx/sites-available/${ACC_PUBLIC_HOSTNAME}"
        cat > "${site_file}" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${ACC_PUBLIC_HOSTNAME};

    location / {
        proxy_pass http://127.0.0.1:${ACC_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
}
NGINX
        ln -sf "${site_file}" "/etc/nginx/sites-enabled/${ACC_PUBLIC_HOSTNAME}"
        nginx -t
        systemctl reload nginx

        if ! command -v certbot >/dev/null 2>&1; then
            echo "→ Installing certbot"
            apt-get update
            apt-get install -y certbot python3-certbot-nginx
        fi
        certbot_args=(--nginx -d "${ACC_PUBLIC_HOSTNAME}" --non-interactive --agree-tos --redirect)
        if [ -n "${ACC_ADMIN_EMAIL}" ]; then
            certbot_args+=(--email "${ACC_ADMIN_EMAIL}")
        else
            certbot_args+=(--register-unsafely-without-email)
        fi
        if certbot "${certbot_args[@]}"; then
            echo "✓ certbot issued + wired into nginx"
        else
            echo "⚠  certbot failed. The HTTP-only site is up on port 80."
            echo "   Re-run after DNS propagates:"
            echo "     sudo certbot --nginx -d ${ACC_PUBLIC_HOSTNAME}"
        fi
        ;;

    caddy)
        echo "→ Caddy detected — configuring Caddyfile"
        write_caddyfile
        systemctl reload caddy || systemctl restart caddy
        ;;

    *)
        echo "→ Installing Caddy from the official apt repo"
        apt-get update
        apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
            | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
            | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
        apt-get update
        apt-get install -y caddy
        write_caddyfile
        systemctl enable --now caddy
        ;;
esac

# ── 5. Interactive acc init ────────────────────────────────────────────────

cat <<EOF

──────────────────────────────────────────────────────────────────
Now running \`acc init\` — the Shopify-connect wizard.

You'll be prompted (via arrow keys) for:
  • signer wallet       → auto-generate (recommended)
  • payout address      → paste your cold wallet, or same as signer
  • Shopify domain      → your-shop.myshopify.com
  • open browser URL    → on any device; the URL is SSH-safe

──────────────────────────────────────────────────────────────────

EOF

# Re-attach stdin to the controlling TTY so the arrow-key / raw-mode
# prompts inside acc init work even though this script is being piped
# from curl. No-op under a plain bash run.
if [ -t 1 ] && [ -r /dev/tty ]; then
    exec </dev/tty
fi

# Seed the public URL; everything else is interactive.
sudo -u "${ACC_USER}" \
     --preserve-env=ACC_PUBLIC_HOSTNAME \
     -- bash -lc "cd ~ && ACC_PUBLIC_HOSTNAME='${ACC_PUBLIC_HOSTNAME}' /home/${ACC_USER}/.acc/bin/acc init"

# ── 6. Enable + start service ──────────────────────────────────────────────

systemctl enable --now acc
sleep 2

# Only redirect check + success banner if acc is actually running.
if systemctl is-active --quiet acc; then
    cat <<EOF

──────────────────────────────────────────────────────────────────
✅ ACC is live.

  UCP discovery:  https://${ACC_PUBLIC_HOSTNAME}/ucp/v1/discovery
  Skill file:     https://${ACC_PUBLIC_HOSTNAME}/.well-known/acc-skill.md
  Health:         https://${ACC_PUBLIC_HOSTNAME}/health

Logs:
  sudo journalctl -u acc -f

Admin / maintenance:
  sudo -u ${ACC_USER} /home/${ACC_USER}/.acc/bin/acc doctor
  sudo -u ${ACC_USER} /home/${ACC_USER}/.acc/bin/acc publish
  sudo -u ${ACC_USER} /home/${ACC_USER}/.acc/bin/acc upgrade
──────────────────────────────────────────────────────────────────
EOF
else
    cat >&2 <<EOF

⚠  acc service did not start cleanly.
   Diagnostics:
     sudo systemctl status acc --no-pager -l
     sudo journalctl -u acc --no-pager -n 50
EOF
    exit 1
fi

