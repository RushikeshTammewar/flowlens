#!/bin/bash
# First-time EC2 setup for FlowLens backend.
# Run this once on a fresh Ubuntu instance.
#
# Usage: ssh ubuntu@<ec2-ip> 'bash -s' < infra/setup-ec2.sh
set -euo pipefail

echo "=== FlowLens EC2 Setup ==="

# System packages
sudo apt-get update -qq
sudo apt-get install -y -qq \
    software-properties-common git nginx certbot python3-certbot-nginx \
    xvfb

# Python 3.12 (browser-use requires 3.11+)
if ! python3.12 --version 2>/dev/null; then
    echo "--- Installing Python 3.12 ---"
    sudo add-apt-repository -y ppa:deadsnakes/ppa
    sudo apt-get update -qq
    sudo apt-get install -y -qq python3.12 python3.12-venv python3.12-dev
fi

PYTHON=python3.12

# Clone repo
if [ ! -d ~/flowlens ]; then
    git clone https://github.com/RushikeshTammewar/flowlens.git ~/flowlens
fi
cd ~/flowlens

# Python venv
$PYTHON -m venv .venv
source .venv/bin/activate
pip install -q --upgrade pip
pip install -q -r backend/requirements.txt -r agent/requirements.txt

# Playwright for remote browser auth feature
python -m playwright install chromium --with-deps

# Systemd service
sudo cp infra/flowlens-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable flowlens-api
sudo systemctl start flowlens-api

# Nginx reverse proxy
sudo tee /etc/nginx/sites-available/flowlens-api > /dev/null <<'NGINX'
server {
    listen 80;
    server_name api.flowlens.in;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE support
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
        proxy_read_timeout 300s;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/flowlens-api /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

echo ""
echo "=== Setup complete ==="
echo "Backend running at http://$(curl -s ifconfig.me):8000"
echo ""
echo "Next steps:"
echo "  1. Create .env with GEMINI_API_KEY and GEMINI_MODEL"
echo "  2. Point api.flowlens.in DNS to this server's IP"
echo "  3. Run: sudo certbot --nginx -d api.flowlens.in"
echo "  4. Add these GitHub secrets for CI/CD:"
echo "     EC2_HOST  = $(curl -s ifconfig.me)"
echo "     EC2_USER  = ubuntu"
echo "     EC2_SSH_KEY = (paste your private key)"
