// Renders icon.svg to icon-192.png / icon-512.png with headless Chromium (playwright).
// Usage: PLAYWRIGHT_PATH=<path to playwright module> node tools/make-icons.mjs
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const b = await chromium.launch();
for (const size of [192, 512]) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  await p.goto(pathToFileURL(resolve('icon.svg')).href);
  await p.screenshot({ path: `icon-${size}.png` });
  await p.close();
}
await b.close();
