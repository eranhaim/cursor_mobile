#!/usr/bin/env bash
set -euxo pipefail
cd ~
if [ -d cursor_mobile/.git ]; then
  cd cursor_mobile
  git fetch origin
  git reset --hard origin/main
else
  git clone https://github.com/eranhaim/cursor_mobile.git
  cd cursor_mobile
fi
bash scripts/ec2-install.sh
echo "Deploy build finished."
