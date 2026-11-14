'use strict';
// Przygotowuje katalog www/ dla Capacitora (Android): kopia src/renderer.
// Na Androidzie most Capacitora bywa wstrzykiwany jako skrypt w treści strony,
// dlatego w tej kopii polityka CSP dopuszcza skrypty inline (w wersji desktopowej pozostaje ścisła).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src', 'renderer');
const dst = path.join(root, 'www');

if (!fs.existsSync(path.join(src, 'vendor', 'fonts'))) require('./vendor.js');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
fs.copyFileSync(path.join(root, 'src', 'assets', 'icon.png'), path.join(dst, 'icon.png'));

const pkg = require(path.join(root, 'package.json'));
const index = path.join(dst, 'index.html');
let html = fs.readFileSync(index, 'utf8');
html = html.replace("script-src 'self' 'wasm-unsafe-eval'", "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");
html = html.replace('<html lang="pl">', `<html lang="pl" data-version="${pkg.version}">`);
fs.writeFileSync(index, html);
console.log('[build-web] gotowe: www/ (wersja ' + pkg.version + ')');
