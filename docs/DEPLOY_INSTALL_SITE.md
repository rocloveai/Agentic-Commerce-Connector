# Deploying the Install Site (`get.xagenpay.com`)

How to wire up the one-liner installer endpoint end-to-end. You only need to
do steps 1–3 once; after that, pushing to `main` auto-redeploys.

## 1. Turn on GitHub Pages

1. Repo → **Settings** → **Pages**.
2. **Source**: *GitHub Actions* (not "Deploy from a branch").
3. Save. The first `pages.yml` run will publish to
   `https://<owner>.github.io/<repo>/` until the custom domain kicks in.

## 2. Add the DNS record at your registrar

In whichever registrar hosts `xagenpay.com`, add:

| Type    | Name  | Value                       | TTL    |
| ------- | ----- | --------------------------- | ------ |
| `CNAME` | `get` | `selfvibecoding.github.io.` | 300 s  |

Notes:

- The value is `<github-username>.github.io` (lowercase, trailing dot).
  Replace `selfvibecoding` if you fork under a different account.
- Do **not** proxy through Cloudflare on the first run — GitHub's cert
  issuance needs a direct CNAME. You can turn the orange cloud on later.
- `xagenpay.com` itself is unaffected; this only adds the `get.` subdomain.

Propagation is typically <5 minutes. Check with:

```bash
dig +short get.xagenpay.com
# → selfvibecoding.github.io.
# → 185.199.108.153
# → 185.199.109.153
# → 185.199.110.153
# → 185.199.111.153
```

## 3. Confirm the custom domain in GitHub

1. Repo → **Settings** → **Pages** → **Custom domain**:
   enter `get.xagenpay.com`, click **Save**.
2. Wait for the "DNS check in progress" indicator to turn green (1–10 min).
3. Tick **Enforce HTTPS**. GitHub auto-provisions a Let's Encrypt cert —
   can take up to 24h the first time, usually <10 min.

The `site/CNAME` file in this repo already contains `get.xagenpay.com`, so
the GitHub Pages action re-asserts the custom domain on every deploy. You
should never need to re-enter it unless you change domains.

## 4. Trigger the first deploy

Any push that touches `install.sh`, `site/**`, or `.github/workflows/pages.yml`
triggers `.github/workflows/pages.yml`. To force a deploy without code
changes: **Actions** → **pages** → **Run workflow** (on `main`).

## 5. Smoke test

```bash
# Landing page (HTML)
curl -sI https://get.xagenpay.com/ | head -1
# → HTTP/2 200

# Install script (what `curl | sh` fetches)
curl -sSL https://get.xagenpay.com/install | head -20

# End-to-end (dry run — exits before running `acc init`)
ACC_VERSION=v0.4.0 curl -fsSL https://get.xagenpay.com/install | sh
```

## Troubleshooting

| Symptom                                     | Likely cause                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| `NXDOMAIN` for `get.xagenpay.com`           | CNAME record not added, or still propagating.                                   |
| "Your site is having problems being served" | Another repo on the same account already claims `get.xagenpay.com`.             |
| Certificate error (`ERR_SSL_…`)             | Cert not issued yet — remove-then-re-add the custom domain in Pages settings.   |
| HTML landing served for `/install`          | Old cache. Pass a cache-buster: `curl -fsSL https://get.xagenpay.com/install?v=1`. |
| `404` at `/install`                         | `pages.yml` hasn't run since the file layout change. Re-run the workflow.       |

## Updating the installer

The canonical script lives at the repo root: [`install.sh`](../install.sh).
Edit it there; the Pages workflow copies it into `_site/install` and
`_site/install.sh` on every deploy. No changes under `site/` are needed for
a new release of the installer itself.
