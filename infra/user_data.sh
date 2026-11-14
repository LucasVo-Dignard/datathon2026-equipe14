#!/bin/bash
# Runs once on first boot: installs nginx and serves a placeholder page.
set -euxo pipefail

dnf update -y
dnf install -y nginx

cat > /usr/share/nginx/html/index.html <<'HTML'
<!doctype html>
<html>
  <head><title>datathon2026-equipe14</title></head>
  <body><h1>datathon2026-equipe14 EC2 is up</h1></body>
</html>
HTML

systemctl enable --now nginx
