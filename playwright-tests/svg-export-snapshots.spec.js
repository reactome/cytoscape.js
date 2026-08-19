import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const FIXTURE_IDS = [
  'basic-shapes',
  'compound',
  'images',
  'curved-dashed',
  'labels',
  'gradients',
];

const OUT_DIR = path.resolve('test-results/svg-export-snapshots');

test.describe.configure({ mode: 'serial' });

test('capture PNG vs SVG side-by-side for each fixture', async ({ page }) => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const consoleErrors = [];
  page.on('console', msg => {
    if( msg.type() === 'error' ) consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => consoleErrors.push(String(err)));

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('http://127.0.0.1:3333/debug/svg-export/index.html');
  await page.waitForFunction(() => {
    const s = document.getElementById('summary');
    return s && s.textContent && s.textContent.length > 0;
  }, { timeout: 20000 });

  for( const id of FIXTURE_IDS ){
    const pngEl = page.locator(`#${id}-png`);
    const svgEl = page.locator(`#${id}-svg`);
    const test = page.locator(`.test:has(#${id}-canvas)`);

    await test.scrollIntoViewIfNeeded();
    // Give the DOM a moment to paint after scroll.
    await page.waitForTimeout(150);

    await pngEl.screenshot({ path: path.join(OUT_DIR, `${id}-png.png`) });
    await svgEl.screenshot({ path: path.join(OUT_DIR, `${id}-svg.png`) });

    // Also save the raw SVG markup for offline inspection.
    const svgText = await page.evaluate(id => window.lastSvg && window.lastSvg[id], id);
    if( svgText ){
      fs.writeFileSync(path.join(OUT_DIR, `${id}.svg`), svgText);
    }
  }

  // Combined screenshot of the whole harness.
  await page.screenshot({ path: path.join(OUT_DIR, 'all.png'), fullPage: true });

  // eslint-disable-next-line no-console
  console.log(`Snapshots saved to ${OUT_DIR}`);
  if( consoleErrors.length > 0 ){
    // eslint-disable-next-line no-console
    console.log(`Console errors during capture:\n${consoleErrors.join('\n')}`);
  }
  expect(consoleErrors).toEqual([]);
});
