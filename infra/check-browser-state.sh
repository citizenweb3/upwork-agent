#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

docker compose exec -T upwork-agent node - <<'NODE'
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const pages = context.pages();

  console.log('== open pages ==');
  for (const [index, page] of pages.entries()) {
    let title = '';
    try {
      title = await page.title();
    } catch {
      title = '<unavailable>';
    }
    console.log(`${index + 1}. ${title} :: ${page.url()}`);
  }

  const current = pages[0];
  if (current) {
    const url = current.url();
    const lower = url.toLowerCase();

    console.log('');
    console.log('== quick diagnosis ==');
    if (lower.includes('/login') || lower.includes('account-security')) {
      console.log('Browser appears to be on an Upwork login page.');
    } else if (lower.includes('captcha') || lower.includes('challenge')) {
      console.log('Browser appears to be on a challenge/CAPTCHA page.');
    } else if (lower.includes('/nx/search/jobs')) {
      console.log('Browser is on the Upwork jobs search page.');
    } else {
      console.log(`Browser current URL: ${url}`);
    }
  }

  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE
