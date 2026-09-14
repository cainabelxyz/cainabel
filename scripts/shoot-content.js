// Content-kit screenshot rig: renders the branded cards and live pages with
// the real site (localhost:8123 must be serving web/) into marketing/assets.
//   node scripts/shoot-content.js

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'marketing', 'assets');
mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--hide-scrollbars', '--force-device-scale-factor=1'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(url, file, { wait = 1200, clip = null, before = null, viewport = null } = {}) {
  if (viewport) await page.setViewport(viewport);
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  if (before) await before();
  await settle(wait);
  const opts = { path: join(out, file) };
  if (clip) {
    const rect = await page.evaluate((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, clip);
    opts.clip = rect;
  }
  await page.screenshot(opts);
  console.log('✓', file);
  if (viewport) await page.setViewport({ width: 1600, height: 900 });
}

const base = 'http://localhost:8123';

// branded cards
for (const c of ['h24', 'h12', 'h6', 'h1', 'spec', 'checks', 'gas', 'isa']) {
  await shot(`${base}/cards.html?c=${c}`, `card-${c}.png`, { wait: 900, clip: '.card' });
}

// the gate
await shot(`${base}/index.html`, 'shot-gate.png', { wait: 1500 });

// the field page: hero with the live sim running a while
await shot(`${base}/field.html`, 'shot-field-hero.png', { wait: 5000 });

// the live fieldbox alone, mid-battle
await shot(`${base}/field.html`, 'shot-fieldbox.png', { wait: 6500, clip: '.fieldbox' });

// the workbench mid-fight
await shot(`${base}/workbench.html`, 'shot-workbench.png', {
  wait: 500,
  before: async () => {
    await page.click('#btn-fight');
    await settle(2600);
    await page.evaluate(() => window.scrollTo(0, document.querySelector('.benchfield').offsetTop - 80));
  },
});

// workbench practice field clipped
await shot(`${base}/workbench.html`, 'shot-practice.png', {
  wait: 300,
  before: async () => { await page.click('#btn-fight'); await settle(3200); },
  clip: '.benchfield',
});

// mobile gate, for the "works everywhere" shot
await shot(`${base}/index.html`, 'shot-mobile-gate.png', {
  wait: 1500,
  viewport: { width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 },
});

await browser.close();
console.log('done →', out);
