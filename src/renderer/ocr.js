'use strict';
// Lokalne rozpoznawanie tekstu ze zrzutu ekranu (Tesseract, działa bez internetu i bez konta).

(function () {
  let loading = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Nie udało się wczytać modułu rozpoznawania tekstu.'));
      document.head.appendChild(s);
    });
  }

  function ensure() {
    if (window.Tesseract) return Promise.resolve();
    if (!loading) loading = loadScript('vendor/tesseract/tesseract.min.js').catch((e) => { loading = null; throw e; });
    return loading;
  }

  // Powiększa małe zrzuty i zamienia je na skalę szarości – drobne cyfry czyta się wtedy pewniej.
  function prepare(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const longest = Math.max(img.naturalWidth, img.naturalHeight);
        const scale = longest < 1400 ? Math.min(2.5, 2400 / longest) : 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = px.data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) {
          const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          d[i] = d[i + 1] = d[i + 2] = g;
          sum += g;
        }
        // ciemny motyw → odwróć kolory (ciemny tekst na jasnym tle)
        if (sum / (d.length / 4) < 110) for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
        ctx.putImageData(px, 0, 0);
        resolve(canvas);
      };
      img.onerror = () => reject(new Error('Nie mogę otworzyć tego obrazu.'));
      img.src = dataUrl;
    });
  }

  async function recognize(dataUrl, onProgress) {
    await ensure();
    const canvas = await prepare(dataUrl);
    const base = new URL('vendor/tesseract/', location.href).href;
    const worker = await window.Tesseract.createWorker('eng', 1, {
      workerPath: base + 'worker.min.js',
      corePath: base + 'core',
      langPath: base + 'lang',
      workerBlobURL: false,
      gzip: true,
      cacheMethod: 'none',
      logger: (m) => { if (onProgress && m && m.status === 'recognizing text') onProgress(m.progress || 0); }
    });
    try {
      await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
      const res = await worker.recognize(canvas);
      return res.data.text || '';
    } finally {
      await worker.terminate();
    }
  }

  window.Ocr = { recognize };
})();
