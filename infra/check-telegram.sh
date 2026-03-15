#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f .env ]; then
  echo "Missing .env in project root"
  exit 1
fi

set -a
. ./.env
set +a

if [ -z "${BOT_TOKEN:-}" ]; then
  echo "BOT_TOKEN is missing"
  exit 1
fi

echo "== bot identity =="
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getMe" | jq .
echo

echo "== configured chat =="
if [ -n "${CHAT_ID:-}" ]; then
  curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getChat?chat_id=${CHAT_ID}" | jq .
else
  echo "CHAT_ID is empty"
fi
echo

echo "== recent updates =="
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?limit=20" | jq .
echo

echo "If recent updates are empty, send any message to the bot (or the group), then run this script again."
