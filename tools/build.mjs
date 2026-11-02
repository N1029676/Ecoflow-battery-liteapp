// Bundles js/ into ONE self-contained index.html (classic inline script, no modules, no server).
// Usage: npm run build
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const out = await build({
  entryPoints: ['js/app.js'], bundle: true, write: false, format: 'iife', target: 'es2020', minify: false, legalComments: 'none',
});
const js = out.outputFiles[0].text.replaceAll('</script', '<\\/script');
const tpl = readFileSync('tools/template.html', 'utf8');
const marker = '<script type="module" src="js/app.js"></script>';
if (!tpl.includes(marker)) throw new Error('template marker missing');
writeFileSync('index.html', tpl.replace(marker, () => `<script>\n${js}</script>`));
console.log(`index.html written (${(readFileSync('index.html').length / 1024).toFixed(0)} KB)`);
