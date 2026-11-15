'use strict';
// Kopiuje do src/renderer/vendor pliki potrzebne w oknie aplikacji (czcionka Inter),
// żeby interfejs był samowystarczalny – ten sam katalog trafia do AppImage i do aplikacji na Androida.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const out = (...p) => path.join(root, 'src', 'renderer', 'vendor', ...p);

const files = [
  [nm('@fontsource-variable', 'inter', 'files', 'inter-latin-wght-normal.woff2'), out('fonts', 'inter-latin.woff2')],
  [nm('@fontsource-variable', 'inter', 'files', 'inter-latin-ext-wght-normal.woff2'), out('fonts', 'inter-latin-ext.woff2')]
];

let missing = 0;
for (const [from, to] of files) {
  if (!fs.existsSync(from)) { console.warn('[vendor] brak pliku: ' + path.relative(root, from)); missing++; continue; }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
console.log(`[vendor] skopiowano ${files.length - missing} z ${files.length} plików`);
