#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One-shot server installer for Ubuntu / Debian.
#
# Run this on a fresh Linux box (Aliyun Lightweight, DigitalOcean droplet,
# Hetzner, etc.) as root or via sudo. It:
#
#   1. Creates a dedicated `acc` user with a locked-down home.
#   2. Installs acc (curl | sh) into /home/acc/.acc/bin.
#   3. Drops a systemd unit that runs `acc start` as the acc user.
#   4. Installs Caddy from the official apt repo.
#   5. Configures Caddy to reverse-proxy ${ACC_PUBLIC_HOSTNAME} → 127.0.0.1:10000.
#   6. Enables + starts both services.
#
# The operator is still responsible for two things that can't be automated:
#
#   - Pointing a DNS A record for ${ACC_PUBLIC_HOSTNAME} at this server's IP.
#     Caddy's Let's Encrypt ACME challenge needs that to issue a cert.
#   - Running `sudo -u acc /home/acc/.acc/bin/acc init` after this script
#     finishes, to generate keys and populate .env. The wizard is
#     interactive by design — we don't want to ship sensitive bootstrap
#     values inside a shell script.
#
# Env overrides:
#   ACC_PUBLIC_HOSTNAME  (required) e.g. acc.xagenpay.com
#   ACC_USER             default: acc
# ---------------------------------------------------------------------------

set -eu

ACC_PUBLIC_HOSTNAME="${ACC_PUBLIC_HOSTNAME:-}"
ACC_USER="${ACC_USER:-acc}"

if [ -z "$ACC_PUBLIC_HOSTNAME" ]; then
    echo "error: set ACC_PUBLIC_HOSTNAME (e.g. ACC_PUBLIC_HOSTNAME=acc.xagenpay.com sudo bash install-server.sh)" >&2
    exit 2
fi

if [ "$EUID" -ne 0 ]; then
    echo "error: run as root (sudo bash $0)" >&2
    exit 2
fi

# ── 1. System user ──────────────────────────────────────────────────────────
if ! id -u "$ACC_USER" >/dev/null 2>&1; then
    echo "→ Creating system user: $ACC_USER"
    useradd --system --create-home --shell /bin/bash "$ACC_USER"
    chmod 750 "/home/$ACC_USER"
else
    echo "✓ User $ACC_USER already exists"
fi

# ── 2. Install acc ──────────────────────────────────────────────────────────
echo "→ Installing acc for $ACC_USER …"
# Run the install script as the acc user so files land in its home.
sudo -u "$ACC_USER" -- bash -c 'curl -fsSL https://get.xagenpay.com/install | sh'

# ── 3. systemd unit ─────────────────────────────────────────────────────────
echo "→ Installing systemd unit"
cat > /etc/systemd/system/acc.service <<EOF
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
EOF
systemctl daemon-reload

# ── 4. Install Caddy ────────────────────────────────────────────────────────
if ! command -v caddy >/dev/null 2>&1; then
    echo "→ Installing Caddy from the official apt repo"
    apt-get update
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    apt-get update
    apt-get install -y caddy
else
    echo "✓ Caddy already installed"
fi

# ── 5. Caddyfile ────────────────────────────────────────────────────────────
echo "→ Writing /etc/caddy/Caddyfile for $ACC_PUBLIC_HOSTNAME"
mkdir -p /var/log/caddy
cat > /etc/caddy/Caddyfile <<EOF
${ACC_PUBLIC_HOSTNAME} {
    reverse_proxy 127.0.0.1:10000 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host {host}
        transport http {
            dial_timeout 5s
            response_header_timeout 60s
        }
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
EOF
systemctl reload caddy || systemctl restart caddy

# ── 6. Instructions ─────────────────────────────────────────────────────────
cat <<EOF

✓ Server bootstrap complete.

Remaining manual steps — do these in order:

  1. Point DNS:
       A   ${ACC_PUBLIC_HOSTNAME}  → $(curl -s https://checkip.amazonaws.com 2>/dev/null || echo "<this-server's-public-IP>")

  2. Wait 1-5 min for DNS to propagate. Verify:
       dig +short ${ACC_PUBLIC_HOSTNAME}

  3. Run the init wizard as the acc user:
       sudo -u ${ACC_USER} bash
       acc init
       # selfUrl → https://${ACC_PUBLIC_HOSTNAME}
       # Everything else: follow the prompts.

  4. Start the service:
       sudo systemctl enable --now acc
       sudo systemctl status acc

  5. Verify end-to-end:
       curl -sI https://${ACC_PUBLIC_HOSTNAME}/health
       curl https://${ACC_PUBLIC_HOSTNAME}/skill.md

Logs:
  sudo journalctl -u acc -f            # acc connector logs
  sudo journalctl -u caddy -f          # Caddy logs
  sudo tail -f /var/log/caddy/acc-access.log
EOF
