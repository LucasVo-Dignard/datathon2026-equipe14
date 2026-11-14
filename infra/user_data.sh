#!/bin/bash
# Runs once on first boot: installs nginx and serves a white page saying "allo".
set -euxo pipefail

dnf update -y
dnf install -y nginx

cat > /usr/share/nginx/html/index.html <<'HTML'
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>allo</title></head>
  <body style="background:#fff;margin:0"><p>allo</p></body>
</html>
HTML

systemctl enable --now nginx
