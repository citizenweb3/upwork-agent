#!/usr/bin/env bash

set -euo pipefail

echo "== user =="
id
echo

echo "== docker binary =="
command -v docker
docker --version || true
echo

echo "== docker contexts =="
docker context ls || true
echo

echo "== current context =="
docker context show || true
echo

echo "== docker.sock permissions =="
ls -l /var/run/docker.sock || true
echo

echo "== docker version probe =="
if docker version; then
  echo
  echo "Docker daemon is reachable."
  exit 0
fi
echo

echo "Docker daemon is NOT reachable."
echo
echo "Try one of these paths:"
echo "1. If you use Docker Desktop:"
echo "   systemctl --user start docker-desktop"
echo "   docker context use desktop-linux"
echo "   docker version"
echo
echo "2. If you use system Docker daemon:"
echo "   sudo usermod -aG docker \$USER"
echo "   newgrp docker"
echo "   docker version"
