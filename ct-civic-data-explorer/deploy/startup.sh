#!/usr/bin/env bash
set -euo pipefail

# Swap gives Docker builds and MySQL startup room on a 1 GiB e2-micro.
if [[ ! -f /swapfile ]]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
fi
if ! grep -q '^/swapfile ' /etc/fstab; then
  printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
fi
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  swapon /swapfile
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q docker.io docker-compose-v2
systemctl enable --now docker
install -d -m 0700 /opt/ctde
touch /opt/ctde/.host-ready
