'use strict';
// Wykres notowań rysowany na <canvas>: linia z wypełnieniem, siatka, podziałki, celownik pod kursorem/palcem.

(function () {
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function fmtTime(t, days) {
    const d = new Date(t);
    if (days <= 1) return d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    if (days <= 90) return d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
    if (days > 900) return d.toLocaleDateString('pl-PL', { month: 'short', year: 'numeric' });
    return d.toLocaleDateString('pl-PL', { month: 'short', year: '2-digit' });
  }
  function fmtFull(t, days) {
    const d = new Date(t);
    return days <= 30
      ? d.toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // points: [[czas, cena]], opts: { days, format(v) }
  function priceChart(canvas, points, opts = {}) {
    const days = opts.days || 7;
    const format = opts.format || ((v) => String(v));
    const data = Core.downsample(points, 600);
    let hover = null;

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const hgt = canvas.clientHeight;
      if (!w || !hgt) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr); }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, hgt);
      if (data.length < 2) return;

      const font = css('--font') || 'sans-serif';
      const text2 = css('--text-2');
      const sep = css('--sep');
      const up = data[data.length - 1][1] >= data[0][1];
      const color = up ? css('--green') : css('--red');

      let min = Infinity, max = -Infinity;
      for (const p of data) { if (p[1] < min) min = p[1]; if (p[1] > max) max = p[1]; }
      if (min === max) { min *= 0.99; max *= 1.01; }
      const padY = (max - min) * 0.08;
      const lo = min - padY, hi = max + padY;

      ctx.font = `500 11px ${font}`;
      const ticks = Core.niceTicks(lo, hi, 4);
      const labelW = Math.max(...ticks.map((t) => ctx.measureText(format(t)).width), 30);
      const area = { l: 8, r: w - labelW - 14, t: 10, b: hgt - 24 };
      const t0 = data[0][0], t1 = data[data.length - 1][0];
      const X = (t) => area.l + ((t - t0) / (t1 - t0 || 1)) * (area.r - area.l);
      const Y = (v) => area.b - ((v - lo) / (hi - lo)) * (area.b - area.t);

      // siatka pozioma + podziałki cen (po prawej)
      ctx.strokeStyle = sep; ctx.lineWidth = 1; ctx.fillStyle = text2; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      for (const t of ticks) {
        const y = Math.round(Y(t)) + 0.5;
        ctx.beginPath(); ctx.moveTo(area.l, y); ctx.lineTo(area.r, y); ctx.stroke();
        ctx.fillText(format(t), area.r + 8, y);
      }
      // podziałki czasu
      ctx.textBaseline = 'alphabetic';
      const n = Math.max(2, Math.min(6, Math.floor((area.r - area.l) / 110)));
      for (let i = 0; i <= n; i++) {
        const t = t0 + ((t1 - t0) * i) / n;
        ctx.textAlign = i === 0 ? 'left' : i === n ? 'right' : 'center';
        ctx.fillText(fmtTime(t, days), X(t), hgt - 6);
      }

      // wypełnienie i linia
      const path = new Path2D();
      data.forEach((p, i) => { const x = X(p[0]), y = Y(p[1]); if (i) path.lineTo(x, y); else path.moveTo(x, y); });
      const fill = new Path2D(path);
      fill.lineTo(area.r, area.b); fill.lineTo(area.l, area.b); fill.closePath();
      const grad = ctx.createLinearGradient(0, area.t, 0, area.b);
      grad.addColorStop(0, color + '40'); grad.addColorStop(1, color + '00');
      ctx.fillStyle = grad; ctx.fill(fill);
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke(path);

      // ostatnia cena – kropka
      const last = data[data.length - 1];
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X(last[0]), Y(last[1]), 3.5, 0, Math.PI * 2); ctx.fill();

      // celownik
      if (hover != null) {
        const p = data[hover];
        const x = X(p[0]), y = Y(p[1]);
        ctx.strokeStyle = css('--sep-strong'); ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, area.t); ctx.lineTo(Math.round(x) + 0.5, area.b); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = css('--card'); ctx.strokeStyle = color; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        if (opts.onHover) opts.onHover({ time: p[0], price: p[1], label: fmtFull(p[0], days), base: data[0][1] });
      }
      canvas._geom = { area, t0, t1 };
    }

    function pick(clientX) {
      const g = canvas._geom;
      if (!g) return;
      const rect = canvas.getBoundingClientRect();
      const x = Math.max(g.area.l, Math.min(g.area.r, clientX - rect.left));
      const t = g.t0 + ((x - g.area.l) / (g.area.r - g.area.l || 1)) * (g.t1 - g.t0);
      let lo = 0, hi = data.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (data[mid][0] < t) lo = mid; else hi = mid; }
      hover = Math.abs(data[lo][0] - t) < Math.abs(data[hi][0] - t) ? lo : hi;
      draw();
    }
    function leave() { hover = null; draw(); if (opts.onHover) opts.onHover(null); }

    canvas.onmousemove = (e) => pick(e.clientX);
    canvas.onmouseleave = leave;
    canvas.ontouchstart = canvas.ontouchmove = (e) => { if (e.touches[0]) pick(e.touches[0].clientX); };
    canvas.ontouchend = leave;

    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    draw();
    return { redraw: draw, destroy: () => ro.disconnect() };
  }

  // Miniwykres (SVG) do wierszy listy.
  function sparkline(values, width = 96, height = 30) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('class', 'spark');
    svg.setAttribute('aria-hidden', 'true');
    const v = Core.downsample((values || []).filter((x) => isFinite(x)), 48);
    if (v.length < 2) return svg;
    const min = Math.min(...v), max = Math.max(...v);
    const span = max - min || 1;
    const pts = v.map((y, i) => `${((i / (v.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - ((y - min) / span) * (height - 4)).toFixed(1)}`).join(' ');
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', pts);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke-width', '1.6');
    line.setAttribute('stroke-linejoin', 'round');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('class', v[v.length - 1] >= v[0] ? 'up' : 'down');
    svg.appendChild(line);
    return svg;
  }

  // Wykres kołowy (pierścień, SVG). segments: [{ label, share, color, title }]
  function donut(segments, size = 180, thickness = 28) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('class', 'donut');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Struktura portfela: ' + segments.map((s) => `${s.label} ${(s.share * 100).toFixed(1)}%`).join(', '));
    const c = size / 2;
    const r = c - 2;
    const ri = r - thickness;
    const total = segments.reduce((a, s) => a + s.share, 0) || 1;
    const gap = segments.length > 1 ? 0.018 : 0; // odstęp między segmentami (radiany)
    const pt = (rad, ang) => `${(c + rad * Math.sin(ang)).toFixed(2)} ${(c - rad * Math.cos(ang)).toFixed(2)}`;
    let a0 = 0;
    for (const s of segments) {
      const span = (s.share / total) * Math.PI * 2;
      const a1 = a0 + span;
      const path = document.createElementNS(ns, 'path');
      if (segments.length === 1 || span >= Math.PI * 2 - 0.001) {
        path.setAttribute('d', `M ${pt(r, 0)} A ${r} ${r} 0 1 1 ${pt(r, Math.PI)} A ${r} ${r} 0 1 1 ${pt(r, 0)} Z M ${pt(ri, 0)} A ${ri} ${ri} 0 1 0 ${pt(ri, Math.PI)} A ${ri} ${ri} 0 1 0 ${pt(ri, 0)} Z`);
        path.setAttribute('fill-rule', 'evenodd');
      } else {
        const g = Math.min(gap, span / 3);
        const s0 = a0 + g / 2, s1 = a1 - g / 2;
        const large = s1 - s0 > Math.PI ? 1 : 0;
        path.setAttribute('d', `M ${pt(r, s0)} A ${r} ${r} 0 ${large} 1 ${pt(r, s1)} L ${pt(ri, s1)} A ${ri} ${ri} 0 ${large} 0 ${pt(ri, s0)} Z`);
      }
      path.setAttribute('fill', s.color);
      const title = document.createElementNS(ns, 'title');
      title.textContent = s.title || s.label;
      path.appendChild(title);
      svg.appendChild(path);
      a0 = a1;
    }
    return svg;
  }

  window.Charts = { priceChart, sparkline, donut };
})();
