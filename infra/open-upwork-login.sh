#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

docker compose exec -T upwork-agent node - <<'NODE'
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.goto('https://www.upwork.com/ab/account-security/login', { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  console.log(`Opened: ${page.url()}`);
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE
