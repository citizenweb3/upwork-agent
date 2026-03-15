#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "== docker compose ps =="
docker compose ps
echo

echo "== docker compose logs (last 120 lines) =="
docker compose logs --no-color --tail=120
echo

echo "== published noVNC port =="
docker compose port upwork-agent 6080 || true
echo

echo "== app data inside container =="
docker compose exec -T upwork-agent sh -lc '
  set -e
  ls -la /app/data
  echo
  echo "-- browser-data --"
  ls -la /app/data/browser-data || true
  echo
  echo "-- logs --"
  ls -la /app/data/logs || true
'
echo

echo "== Chrome CDP probe inside container =="
docker compose exec -T upwork-agent sh -lc '
  curl -fsS http://127.0.0.1:9222/json/version
'
echo

echo "== optional app probes =="
docker compose exec -T upwork-agent sh -lc '
  yarn morning || true
'
