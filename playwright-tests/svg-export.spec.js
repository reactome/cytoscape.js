import { test, expect } from '@playwright/test';

const FIXTURE_IDS = [
  'basic-shapes',
  'compound',
  'images',
  'curved-dashed',
  'labels',
  'gradients',
];

test.describe('cy.svg() export', () => {
  let consoleErrors;

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    page.on('console', msg => {
      if( msg.type() === 'error' ){
        consoleErrors.push(msg.text());
        // eslint-disable-next-line no-console
        console.log(`[browser:error] ${msg.text()}`);
      }
    });
    page.on('pageerror', err => {
      consoleErrors.push(String(err));
    });
    await page.goto('http://127.0.0.1:3333/debug/svg-export/index.html');
    await page.waitForFunction(() => {
      const s = document.getElementById('summary');
      return s && s.textContent && s.textContent.length > 0;
    }, { timeout: 20000 });
  });

  test('no browser-side errors during render', async ({ page }) => {
    if( consoleErrors.length > 0 ){
      // Dump every SVG that has a malformed path so we can fix it.
      const allSvgs = await page.evaluate(() => window.lastSvg || {});
      for( const id of Object.keys(allSvgs) ){
        const svg = allSvgs[id];
        const badPaths = (svg.match(/<path d="[^"]*"/g) || []).filter(p => !/d="[Mm]/.test(p));
        if( badPaths.length > 0 ){
          // eslint-disable-next-line no-console
          console.log(`[bad paths in ${id}]:\n${badPaths.slice(0, 5).join('\n')}`);
        }
      }
    }
    expect(consoleErrors, `browser console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  });

  test('summary reports zero errors', async ({ page }) => {
    const summary = await page.textContent('#summary');
    expect(summary).toMatch(/0 with errors/);
  });

  for( const id of FIXTURE_IDS ){
    test(`fixture "${id}" renders without throwing`, async ({ page }) => {
      const errText = await page.textContent(`#${id}-err`);
      expect(errText.trim()).toBe('');
    });

    test(`fixture "${id}" produces a non-trivial SVG`, async ({ page }) => {
      const svg = await page.evaluate(id => window.lastSvg && window.lastSvg[id], id);
      expect(svg, `no SVG was produced for ${id}`).toBeTruthy();
      expect(svg).toMatch(/^<svg /);
      expect(svg.length).toBeGreaterThan(200);
    });
  }

  test('basic-shapes SVG contains node + edge paths', async ({ page }) => {
    const svg = await page.evaluate(() => window.lastSvg['basic-shapes']);
    // expect at least a few <path> elements (one per node + edges)
    const numPaths = (svg.match(/<path /g) || []).length;
    expect(numPaths).toBeGreaterThan(5);
  });

  test('labels fixture SVG contains <text> elements', async ({ page }) => {
    const svg = await page.evaluate(() => window.lastSvg['labels']);
    const numTexts = (svg.match(/<text /g) || []).length;
    expect(numTexts).toBeGreaterThan(0);
  });

  test('images fixture SVG contains <image> elements', async ({ page }) => {
    const svg = await page.evaluate(() => window.lastSvg['images']);
    const numImages = (svg.match(/<image /g) || []).length;
    expect(numImages).toBeGreaterThan(0);
  });

  test('gradients fixture SVG defines gradients', async ({ page }) => {
    const svg = await page.evaluate(() => window.lastSvg['gradients']);
    expect(svg).toMatch(/<linearGradient |<radialGradient /);
  });
});
