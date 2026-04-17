# site/

Static content served at `https://get.xagenpay.com` via GitHub Pages.

Only `CNAME` and `index.html` are committed. The `install`, `install.sh`, and
`get` files are **copied in at deploy time** by
`.github/workflows/pages.yml` from the repo-root `install.sh`, so there is
one source of truth.

Published URLs after deploy:

| Path                                    | Serves               |
| --------------------------------------- | -------------------- |
| `https://get.xagenpay.com/`             | Landing page (HTML)  |
| `https://get.xagenpay.com/install`      | Install script       |
| `https://get.xagenpay.com/install.sh`   | Install script (alias) |

Do **not** edit anything under this directory besides `CNAME` and
`index.html` — edits to generated files get overwritten on the next deploy.
