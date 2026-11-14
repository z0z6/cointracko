'use strict';
// Kopiuje do src/renderer/vendor pliki potrzebne w oknie aplikacji (czcionka Inter, silnik OCR),
// żeby interfejs był samowystarczalny – ten sam katalog trafia do AppImage i do aplikacji na Androida.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const out = (...p) => path.join(root, 'src', 'renderer', 'vendor', ...p);

const files = [
  [nm('@fontsource-variable', 'inter', 'files', 'inter-latin-wght-normal.woff2'), out('fonts', 'inter-latin.woff2')],
  [nm('@fontsource-variable', 'inter', 'files', 'inter-latin-ext-wght-normal.woff2'), out('fonts', 'inter-latin-ext.woff2')],
  [nm('tesseract.js', 'dist', 'tesseract.min.js'), out('tesseract', 'tesseract.min.js')],
  [nm('tesseract.js', 'dist', 'worker.min.js'), out('tesseract', 'worker.min.js')],
  [nm('tesseract.js-core', 'tesseract-core-simd-lstm.wasm.js'), out('tesseract', 'core', 'tesseract-core-simd-lstm.wasm.js')],
  [nm('tesseract.js-core', 'tesseract-core-lstm.wasm.js'), out('tesseract', 'core', 'tesseract-core-lstm.wasm.js')],
  [nm('tesseract.js-core', 'tesseract-core-relaxedsimd-lstm.wasm.js'), out('tesseract', 'core', 'tesseract-core-relaxedsimd-lstm.wasm.js')],
  [nm('@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'), out('tesseract', 'lang', 'eng.traineddata.gz')]
];

let missing = 0;
for (const [from, to] of files) {
  if (!fs.existsSync(from)) { console.warn('[vendor] brak pliku: ' + path.relative(root, from)); missing++; continue; }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
console.log(`[vendor] skopiowano ${files.length - missing} z ${files.length} plików`);
