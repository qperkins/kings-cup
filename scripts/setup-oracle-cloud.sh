#!/usr/bin/env bash
# One-time Oracle Cloud ARM instance setup for King's Cup backend.
# Run as root or with sudo on a fresh Ubuntu 22.04/24.04 or Oracle Linux instance.
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"

if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
  echo "Usage: $0 <domain> <letsencrypt-email>"
  echo "Example: $0 api.kxc.cards admin@example.com"
  exit 1
fi

REPO_DIR="/opt/kings-cup-backend"
APP_USER="${APP_USER:-ubuntu}"

echo "==> Installing Docker"
if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ca-certificates curl git ufw certbot
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y dnf-plugins-core git curl firewalld certbot
  dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
  dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now firewalld
else
  echo "Unsupported OS: need apt-get or dnf"
  exit 1
fi

systemctl enable --now docker

if id "$APP_USER" >/dev/null 2>&1; then
  usermod -aG docker "$APP_USER"
fi

echo "==> Configuring firewall (ports 22, 80, 443)"
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=ssh
  firewall-cmd --permanent --add-service=http
  firewall-cmd --permanent --add-service=https
  firewall-cmd --reload
fi

echo "==> Fixing Oracle default iptables (insert rules before REJECT)"
if iptables -L INPUT -n | grep -q "reject-with icmp-host-prohibited"; then
  iptables -I INPUT $(iptables -L INPUT --line-numbers | grep "reject-with icmp-host-prohibited" | head -1 | cut -d' ' -f1) -p tcp --dport 80 -j ACCEPT
  iptables -I INPUT $(iptables -L INPUT --line-numbers | grep "reject-with icmp-host-prohibited" | head -1 | cut -d' ' -f1) -p tcp --dport 443 -j ACCEPT
  mkdir -p /etc/iptables
  iptables-save > /etc/iptables/rules.v4
  echo "iptables rules persisted to /etc/iptables/rules.v4"
fi

echo "==> Cloning repository"
mkdir -p "$REPO_DIR"
if [[ ! -d "$REPO_DIR/.git" ]]; then
  git clone https://github.com/qperkins/kings-cup.git "$REPO_DIR"
fi

echo "==> Configuring nginx SSL paths for domain: $DOMAIN"
if [[ "$DOMAIN" != "api.kxc.cards" ]]; then
  sed -i "s/api.kxc.cards/${DOMAIN}/g" "$REPO_DIR/nginx/nginx.prod.conf"
fi

echo "==> Obtaining Let's Encrypt certificate"
mkdir -p /var/www/certbot
certbot certonly --standalone -d "$DOMAIN" --email "$EMAIL" --agree-tos --non-interactive

echo "==> Verifying certbot auto-renewal is enabled"
if systemctl list-timers 2>/dev/null | grep -q certbot; then
  echo "certbot systemd timer is active"
elif [[ -f /etc/cron.d/certbot ]]; then
  echo "certbot cron job is present"
else
  echo "WARNING: certbot renewal timer/cron not found — enabling certbot.timer"
  systemctl enable --now certbot.timer 2>/dev/null || true
fi

echo "==> Starting production stack"
cd "$REPO_DIR"
docker compose -f docker-compose.prod.yml pull || echo "Note: first pull may fail until GHCR package is public (see DEPLOYMENT.md)"
docker compose -f docker-compose.prod.yml up -d

echo "==> Setup complete"
echo "Verify SSL renewal: certbot certificates"
echo "Verify health: curl -sf https://${DOMAIN}/health"
