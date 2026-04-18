# Server deployment (Linux)

Automated one-shot setup for a fresh Ubuntu / Debian box. Installs
`acc`, a dedicated system user, a hardened systemd unit, and Caddy as
the front-facing HTTPS proxy.

## Prerequisites

- Ubuntu 22.04+ / Debian 12+ with root / sudo access
- Public DNS `A` record pointing at the server (Caddy's Let's Encrypt
  ACME challenge needs this — if DNS doesn't resolve, cert issuance
  fails and `curl` hits plain TCP errors)
- Ports **80** and **443** open on your firewall + cloud security group

## One command

```bash
ssh root@<your-server-ip>
curl -fsSL https://raw.githubusercontent.com/rocloveai/Agentic-Commerce-Connector/main/deploy/scripts/install-server.sh \
  | ACC_PUBLIC_HOSTNAME=acc.xagenpay.com bash
```

This provisions everything except the wizard step. At the end it
prints the remaining manual commands (run `acc init` as the `acc`
user, then `systemctl enable --now acc`).

## Layout after install

```
/home/acc/
├── .acc/
│   ├── bin/acc              ← compiled binary
│   ├── config.json          ← wizard output
│   ├── .env                 ← wizard output (chmod 600)
│   ├── keys/
│   │   ├── enc.key          ← AES-256 for token encryption
│   │   └── signer.key       ← marketplace signer (plaintext 0600)
│   ├── db/acc.sqlite        ← installation store
│   └── skill/acc-skill.md   ← published to marketplace

/etc/systemd/system/acc.service   ← foreground-style unit, journalctl-logged
/etc/caddy/Caddyfile              ← one site block for ACC_PUBLIC_HOSTNAME
/var/log/caddy/acc-access.log     ← rotated JSON request log
```

## Operations

```bash
# Start / stop / restart
sudo systemctl {start|stop|restart|status} acc

# Logs
sudo journalctl -u acc -f
sudo journalctl -u caddy -f

# Upgrade acc to latest release (CLI's self-update is fine as root-less)
sudo -u acc /home/acc/.acc/bin/acc upgrade
sudo systemctl restart acc

# Reload Caddy after editing Caddyfile
sudo systemctl reload caddy

# Re-run wizard (keeps existing keys, can change Shopify creds)
sudo -u acc /home/acc/.acc/bin/acc init
sudo systemctl restart acc
```

## Shopify Partners app configuration

In https://partners.shopify.com → your app → Configuration:

| Field | Value |
|---|---|
| **App URL** | `https://acc.xagenpay.com` |
| **Allowed redirection URL(s)** | `https://acc.xagenpay.com/auth/shopify/callback` |

Then copy the app's **Client ID** + **Client secret** into the wizard
prompts (step 6 of `acc init`). They land in `~/.acc/.env`.

## Testing a merchant install end-to-end

```bash
# On your laptop (or anywhere with acc installed)
acc shopify connect --shop=<merchant-store>.myshopify.com
```

The CLI prints an install URL + QR code. The merchant opens it in a
browser, clicks "Install app", Shopify calls back into
`https://acc.xagenpay.com/auth/shopify/callback`, and the connector
stores the encrypted tokens in SQLite. `acc shopify connect` polls the
DB until it sees the row, then exits successfully.

## Uninstall

```bash
sudo systemctl disable --now acc
sudo rm /etc/systemd/system/acc.service
sudo systemctl daemon-reload
sudo rm /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo userdel -r acc  # removes /home/acc including all keys + SQLite data
```
