#!/usr/bin/env bash
# Prepares a fresh Oracle Cloud (Ubuntu, Ampere A1) instance to run the agent.
# Safe to re-run: every step checks whether it is already done.
#
#   curl -fsSL https://raw.githubusercontent.com/YashikKhunt/discord-coding-assistant/main/infra/scripts/setup-oracle.sh | bash
#
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/YashikKhunt/discord-coding-assistant.git}"
APP_DIR="${APP_DIR:-/opt/dca}"
USER_NAME="${SUDO_USER:-$(id -un)}"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }

if [[ $EUID -eq 0 && -z "${SUDO_USER:-}" ]]; then
  warn "Running as root. The app will be owned by root; that works, but a normal user is nicer."
fi
SUDO=""
[[ $EUID -ne 0 ]] && SUDO="sudo"

log "System packages"
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq ca-certificates curl git jq unzip netfilter-persistent iptables-persistent

log "Swap file (2 GB, protects against short memory spikes)"
if ! swapon --show | grep -q /swapfile; then
  $SUDO fallocate -l 2G /swapfile
  $SUDO chmod 600 /swapfile
  $SUDO mkswap -q /swapfile
  $SUDO swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
else
  echo "swapfile already active"
fi

log "Docker Engine"
if ! command -v docker >/dev/null; then
  $SUDO install -m 0755 -d /etc/apt/keyrings
  $SUDO curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  $SUDO chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" |
    $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "docker already installed: $(docker --version)"
fi
$SUDO usermod -aG docker "$USER_NAME" || true

log "gVisor (runsc) sandbox runtime"
if ! command -v runsc >/dev/null; then
  ARCH="$(uname -m)"
  URL="https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}"
  TMP="$(mktemp -d)"
  ( cd "$TMP"
    curl -fsSLO "${URL}/runsc" -O "${URL}/runsc.sha512" \
         -O "${URL}/containerd-shim-runsc-v1" -O "${URL}/containerd-shim-runsc-v1.sha512"
    sha512sum -c runsc.sha512 containerd-shim-runsc-v1.sha512
    $SUDO cp -f runsc containerd-shim-runsc-v1 /usr/local/bin/
    $SUDO chmod 755 /usr/local/bin/runsc /usr/local/bin/containerd-shim-runsc-v1 )
  rm -rf "$TMP"
  $SUDO /usr/local/bin/runsc install
  $SUDO systemctl restart docker
else
  echo "runsc already installed: $(runsc --version | head -1)"
fi

log "Checking that gVisor can actually run a container"
if $SUDO docker run --rm --runtime=runsc alpine:3 true 2>/dev/null; then
  echo "gVisor works; sandboxes will use SANDBOX_RUNTIME=runsc"
else
  warn "gVisor could not start a container on this kernel."
  warn "Set SANDBOX_RUNTIME=runc in .env to fall back to plain Docker isolation."
fi

log "Firewall: allow HTTP/HTTPS"
# Oracle's Ubuntu images ship with REJECT rules in the INPUT chain, so opening the
# ports in the cloud console alone is not enough.
for port in 80 443; do
  if ! $SUDO iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    $SUDO iptables -I INPUT 6 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
  fi
done
$SUDO netfilter-persistent save >/dev/null
echo "ports 80 and 443 accepted locally (also add an ingress rule in the OCI security list)"

log "Application directory: $APP_DIR"
$SUDO mkdir -p "$APP_DIR"
$SUDO chown -R "$USER_NAME":"$USER_NAME" "$APP_DIR"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull --ff-only
else
  # Clone into a temporary directory and move the contents in: $APP_DIR may already
  # hold files (backups, .env) and `git clone` refuses a non-empty target.
  TMP_CLONE="$(mktemp -d)"
  git clone --depth 50 "$REPO_URL" "$TMP_CLONE/repo"
  ( shopt -s dotglob; mv "$TMP_CLONE/repo/"* "$APP_DIR/" )
  rm -rf "$TMP_CLONE"
fi
mkdir -p "$APP_DIR/backups"

log "Sandbox images (this takes a few minutes the first time)"
$SUDO docker build -q -t dca-sandbox-node:latest "$APP_DIR/infra/images/sandbox-node"
$SUDO docker build -q -t dca-sandbox-python:latest "$APP_DIR/infra/images/sandbox-python"

log "Nightly backup at 03:20 UTC"
CRON_LINE="20 3 * * * $APP_DIR/infra/scripts/backup.sh >> $APP_DIR/backups/backup.log 2>&1"
# `grep -v` exits 1 when the crontab is empty, which would abort the script under `set -e`.
( { crontab -l 2>/dev/null || true; } | grep -v 'infra/scripts/backup.sh' || true; echo "$CRON_LINE" ) |
  crontab -

cat <<EOF

Setup complete.

Next:
  1. cp $APP_DIR/.env.example $APP_DIR/.env && chmod 600 $APP_DIR/.env
     Fill in: Discord, GitHub bot token, Anthropic key, DOMAIN, ACME_EMAIL,
     POSTGRES_PASSWORD (openssl rand -hex 24), INTERNAL_API_TOKEN, SESSION_SECRET.
  2. Point your domain's A record at this machine: $(curl -fsS4 https://ifconfig.co 2>/dev/null || echo "<public IP>")
  3. cd $APP_DIR && ./infra/scripts/deploy.sh
  4. Log out and back in so your user can run docker without sudo.
EOF
