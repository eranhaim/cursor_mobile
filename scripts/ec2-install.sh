#!/usr/bin/env bash
# Run on EC2 after cloning: bash scripts/ec2-install.sh
set -euo pipefail
cd "$(dirname "$0")/.."
sudo apt-get update -qq
sudo apt-get install -y -qq git curl ca-certificates
if ! command -v node &>/dev/null || [[ "$(node -v 2>/dev/null || echo v0)" < v20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
npm ci
npm run build
echo "Build OK. Create ~/cursor_mobile/.env then: cd $(pwd) && nohup npm start >> bot.log 2>&1 &"
