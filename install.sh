#!/usr/bin/env sh
# shellcheck shell=sh
# ---------------------------------------------------------------------------
# acc installer — served at https://get.xagenpay.com/install
#
#   curl -fsSL https://get.xagenpay.com/install | sh
#
# Detects OS/arch, downloads the matching release tarball from GitHub, and
# installs the `acc` binary to ~/.acc/bin (overridable via ACC_INSTALL_DIR).
# Tries to append that directory to the user's shell rc if it isn't already
# on PATH. Never writes outside $HOME unless ACC_INSTALL_DIR is set to a
# system path — we won't sudo implicitly.
#
# Env overrides:
#   ACC_VERSION       Pin a specific release tag (e.g. v0.4.0). Default: latest.
#   ACC_INSTALL_DIR   Target directory. Default: $HOME/.acc/bin.
#   ACC_REPO          GitHub <owner>/<repo>. Default: rocloveai/Agentic-Commerce-Connector.
# ---------------------------------------------------------------------------

set -eu

REPO="${ACC_REPO:-rocloveai/Agentic-Commerce-Connector}"
INSTALL_DIR="${ACC_INSTALL_DIR:-$HOME/.acc/bin}"
VERSION="${ACC_VERSION:-latest}"

msg() { printf '%s\n' "$*" >&2; }
err() { msg "error: $*"; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ── Platform detection ──────────────────────────────────────────────────────
detect_platform() {
    uname_s=$(uname -s 2>/dev/null || echo unknown)
    uname_m=$(uname -m 2>/dev/null || echo unknown)
    case "$uname_s" in
        Darwin) os=darwin ;;
        Linux)  os=linux ;;
        *)      err "unsupported OS: $uname_s (acc ships for macOS + Linux)" ;;
    esac
    case "$uname_m" in
        arm64|aarch64) arch=arm64 ;;
        x86_64|amd64)  arch=x64 ;;
        *)             err "unsupported architecture: $uname_m" ;;
    esac
    printf '%s-%s' "$os" "$arch"
}

# ── Resolve release version ─────────────────────────────────────────────────
resolve_version() {
    if [ "$VERSION" = "latest" ]; then
        api="https://api.github.com/repos/${REPO}/releases/latest"
        tag=$(curl -fsSL "$api" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
        [ -n "$tag" ] || err "could not resolve latest release from $api"
        printf '%s' "$tag"
    else
        printf '%s' "$VERSION"
    fi
}

# ── Download + install ──────────────────────────────────────────────────────
install_binary() {
    platform=$1
    tag=$2
    asset="acc-${platform}.tar.gz"
    url="https://github.com/${REPO}/releases/download/${tag}/${asset}"

    tmp=$(mktemp -d 2>/dev/null || mktemp -d -t acc-install)
    trap 'rm -rf "$tmp"' EXIT

    msg "↓ Downloading ${asset} (${tag})"
    if have curl; then
        curl -fsSL "$url" -o "$tmp/${asset}" || err "download failed from $url"
    elif have wget; then
        wget -qO "$tmp/${asset}" "$url" || err "download failed from $url"
    else
        err "neither curl nor wget is installed"
    fi

    msg "∗ Extracting to ${INSTALL_DIR}"
    mkdir -p "$INSTALL_DIR"
    tar -xzf "$tmp/${asset}" -C "$tmp"

    # Tarballs ship a single file named `acc`. Guard against layout drift.
    if [ ! -f "$tmp/acc" ]; then
        err "tarball did not contain a file named 'acc' — layout drift?"
    fi

    mv "$tmp/acc" "$INSTALL_DIR/acc"
    chmod +x "$INSTALL_DIR/acc"

    # macOS Gatekeeper flags curl-downloaded files with quarantine, which
    # can block the first run. Strip it. The binary itself is ad-hoc
    # signed by Bun at build time on our macOS runner, so no extra
    # codesign step is needed (and would in fact fail — running `codesign
    # --force` over Bun's compiled single-file executable breaks with
    # "invalid or unsupported format" because the bundle payload appended
    # after the Mach-O confuses codesign's load-command walk).
    if [ "$(uname -s)" = "Darwin" ]; then
        xattr -d com.apple.quarantine "$INSTALL_DIR/acc" 2>/dev/null || true
    fi
}

# ── Ensure install dir is on PATH ───────────────────────────────────────────
ensure_path() {
    case ":$PATH:" in
        *:"$INSTALL_DIR":*) return 0 ;;
    esac

    rc=""
    case "${SHELL:-}" in
        */zsh)  rc="$HOME/.zshrc" ;;
        */bash) rc="$HOME/.bashrc" ;;
        */fish) rc="$HOME/.config/fish/config.fish" ;;
    esac

    if [ -z "$rc" ] || [ ! -w "$(dirname "$rc")" ]; then
        msg ""
        msg "⚠ ${INSTALL_DIR} is not on your PATH."
        msg "  Add it manually:"
        msg "    export PATH=\"${INSTALL_DIR}:\$PATH\""
        return 0
    fi

    line="export PATH=\"${INSTALL_DIR}:\$PATH\""
    if [ "${rc##*/}" = "config.fish" ]; then
        line="set -gx PATH \"${INSTALL_DIR}\" \$PATH"
    fi

    if [ -f "$rc" ] && grep -Fq "$INSTALL_DIR" "$rc" 2>/dev/null; then
        # Already present; nothing to do.
        return 0
    fi

    mkdir -p "$(dirname "$rc")"
    printf '\n# Added by acc installer\n%s\n' "$line" >> "$rc"
    msg "✓ Added ${INSTALL_DIR} to PATH in $(basename "$rc")"
    msg "  Open a new shell or run:  source ${rc#$HOME/~}"
}

# ── Main ────────────────────────────────────────────────────────────────────
main() {
    platform=$(detect_platform)
    tag=$(resolve_version)

    msg "Installing acc ${tag} for ${platform} …"
    install_binary "$platform" "$tag"
    ensure_path

    msg ""
    msg "✓ Installed: $("$INSTALL_DIR/acc" version 2>/dev/null || printf 'acc (%s)\n' "$tag")"
    msg ""
    msg "Next:"
    msg "  acc init        # 8-step setup wizard"
    msg "  acc start       # boot the connector"
    msg "  acc doctor      # diagnose issues"
}

main "$@"
