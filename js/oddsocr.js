// Read sportsbook odds from a screenshot.
// Text recognition runs in the browser (Tesseract.js), so the image never leaves the device.
// The parsers are pure functions, so they can be tested without images.

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let loader = null;
let workerPromise = null;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  loader ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT_URL;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => { loader = null; reject(new Error("Couldn't load the text reader. Check your connection.")); };
    document.head.appendChild(s);
  });
  return loader;
}

async function getWorker() {
  const T = await loadTesseract();
  workerPromise ||= T.createWorker('eng');
  return workerPromise;
}

/** Upscale, grayscale, flip dark mode, and threshold to pure black text on white (Otsu). */
async function preprocess(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(3, Math.max(1, 1800 / bmp.width));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h); const d = img.data;
  const ys = new Uint8ClampedArray(w * h); let sum = 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) { ys[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; sum += ys[j]; }
  const invert = sum / ys.length < 128;
  const hist = new Array(256).fill(0);
  for (let j = 0; j < ys.length; j++) { if (invert) ys[j] = 255 - ys[j]; hist[ys[j]]++; }
  let total = 0; for (let t = 0; t < 256; t++) total += t * hist[t];
  let sB = 0, wB = 0, best = 0, th = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue; const wF = ys.length - wB; if (!wF) break;
    sB += t * hist[t]; const v = wB * wF * (sB / wB - (total - sB) / wF) ** 2;
    if (v > best) { best = v; th = t; }
  }
  for (let i = 0, j = 0; i < d.length; i += 4, j++) d[i] = d[i + 1] = d[i + 2] = ys[j] > th ? 255 : 0;
  ctx.putImageData(img, 0, 0);
  return { canvas: c, scale };
}

/**
 * Image file -> {text, words}. Reads twice (sparse-text and column modes) and merges,
 * because each mode misses different numbers on odds boards.
 */
export async function readImage(file, onProgress) {
  const worker = await getWorker();
  const { canvas, scale } = await preprocess(file);
  const words = []; let text = '';
  const modes = ['11', '4'];
  for (let k = 0; k < modes.length; k++) {
    onProgress?.((k + 0.1) / modes.length);
    await worker.setParameters({ tessedit_pageseg_mode: modes[k] });
    const { data } = await worker.recognize(canvas);
    if (k === 0) text = data.text || '';
    for (const wd of data.words || []) {
      const b = { text: wd.text, conf: wd.confidence, x0: wd.bbox.x0 / scale, y0: wd.bbox.y0 / scale, x1: wd.bbox.x1 / scale, y1: wd.bbox.y1 / scale };
      const dup = words.findIndex((o) => overlap(o, b) > 0.5);
      if (dup < 0) words.push(b);
      else if (b.conf > words[dup].conf + 15) words[dup] = b;
    }
    onProgress?.((k + 1) / modes.length);
  }
  return { text, words };
}

function overlap(a, b) {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  const area = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
  return area > 0 ? inter / area : 0;
}

// ---------------- shared helpers ----------------

function teamAliases(t) {
  const words = new Set();
  for (const s of [t.name, t.short, t.abbr, t.location, t.nickname]) if (s) words.add(s.toLowerCase());
  const parts = (t.name || '').split(/\s+/);
  if (parts.length > 1) words.add(parts[parts.length - 1].toLowerCase());
  return [...words].filter((w) => w.length >= 2);
}

function findTeam(line, aliases) {
  const l = ` ${line.toLowerCase()} `;
  let best = null;
  for (const side of ['home', 'away']) {
    for (const a of aliases[side]) {
      const re = new RegExp(`(^|[^a-z])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`);
      const m = l.match(re);
      if (m && (best == null || m.index < best.index || (m.index === best.index && a.length > best.len))) best = { side, index: m.index, len: a.length };
    }
  }
  return best?.side ?? null;
}

/** Fix common OCR slips: quote marks for minus signs, unicode dashes, ½, © for O. */
export function cleanOcr(s) {
  return String(s)
    .replace(/[−–—]/g, '-')
    .replace(/[“”"‘’'~](?=\s?\d)/g, '-')
    .replace(/½/g, '.5')
    .replace(/(\d)\s*[,·]\s*5\b/g, '$1.5')
    .replace(/[©@](?=\s?\d)/g, 'O');
}

const makeClassifier = (expect) => (v) => {
  if (expect.total && expect.home && expect.away) {
    const dGame = Math.abs(v - expect.total);
    const dTeam = Math.min(Math.abs(v - expect.home), Math.abs(v - expect.away));
    return dGame <= dTeam ? 'game' : 'team';
  }
  return v >= 100 ? 'game' : 'team';
};

/** A total missing its decimal ("1325") gets it back ("132.5"). */
const fixTotal = (v, raw) => (v > 260 && !String(raw).includes('.') ? v / 10 : v);

function summarize(out, teams, guessed) {
  const n = (x) => (x > 0 ? `+${x}` : `${x}`);
  const q = (k) => (guessed.has(k) ? '?' : '');
  const found = [];
  const H = teams.home.short, A = teams.away.short;
  if (out.spreadHome != null) found.push(`Spread: ${H} ${out.spreadHome === 0 ? 'PK' : n(out.spreadHome)}${out.spreadHomeOdds != null ? ` (${n(out.spreadHomeOdds)}${q('spreadHomeOdds')})` : ''} / ${A}${out.spreadAwayOdds != null ? ` (${n(out.spreadAwayOdds)}${q('spreadAwayOdds')})` : ''}`);
  if (out.total != null) found.push(`Total: ${out.total}${out.overOdds != null ? ` · O ${n(out.overOdds)}${q('overOdds')}` : ''}${out.underOdds != null ? ` · U ${n(out.underOdds)}${q('underOdds')}` : ''}`);
  if (out.mlHome != null || out.mlAway != null) found.push(`Moneyline: ${A} ${out.mlAway != null ? n(out.mlAway) + q('mlAway') : '—'} · ${H} ${out.mlHome != null ? n(out.mlHome) + q('mlHome') : '—'}`);
  for (const [k, name] of [['ttAway', A], ['ttHome', H]]) {
    if (out[k] != null) found.push(`${name} team total: ${out[k]}${out[`${k}OverOdds`] != null ? ` · O ${n(out[`${k}OverOdds`])}${q(`${k}OverOdds`)}` : ''}${out[`${k}UnderOdds`] != null ? ` · U ${n(out[`${k}UnderOdds`])}${q(`${k}UnderOdds`)}` : ''}`);
  }
  return found;
}

// ---------------- text parser (fallback, and for pasted text) ----------------

const TOKEN = new RegExp([
  String.raw`(?<ou>\b(?:over|under|o|u)\b\.?\s*(?<ouv>\d{2,4}(?:\.\d)?))`,
  String.raw`(?<pk>\bpk\b|\bpick(?:'?em)?\b)`,
  String.raw`(?<even>\beven\b)`,
  String.raw`(?<![\w.:/])(?<signed>[+-]\s?\d{1,4}(?:\.\d)?)(?![\d:/])`,
].join('|'), 'gi');

/** Parse plain text (one row per line). */
export function parseOddsText(text, teams, expect = {}) {
  const clean = cleanOcr(text);
  const aliases = { home: teamAliases(teams.home), away: teamAliases(teams.away) };
  const classify = makeClassifier(expect);
  const out = {}; const spread = {};
  let current = null, pending = null;
  const setOnce = (k, v) => { if (out[k] == null) out[k] = v; };

  for (const raw of clean.split(/\n+/)) {
    const line = raw.trim(); if (!line) continue;
    const side = findTeam(line, aliases);
    if (side) { current = side; pending = null; }
    const team = side ?? current;
    for (const m of line.matchAll(TOKEN)) {
      const g = m.groups;
      if (g.ou) {
        const v = fixTotal(+g.ouv, g.ouv); const over = /^o/i.test(g.ou.trim());
        if (v < 30 || v > 260) continue;
        if (classify(v) === 'game') { setOnce('total', v); pending = over ? 'overOdds' : 'underOdds'; }
        else if (team) { const T = team === 'home' ? 'ttHome' : 'ttAway'; setOnce(T, v); pending = `${T}${over ? 'Over' : 'Under'}Odds`; }
      } else if (g.pk) {
        if (team && spread[team] == null) { spread[team] = 0; pending = team === 'home' ? 'spreadHomeOdds' : 'spreadAwayOdds'; }
      } else {
        const v = g.even ? 100 : +g.signed.replace(/\s/g, '');
        const a = Math.abs(v);
        if (!g.even && a < 100) {
          if (a <= 60 && !pending && team && spread[team] == null) { spread[team] = v; pending = team === 'home' ? 'spreadHomeOdds' : 'spreadAwayOdds'; }
        } else if (a <= 10000) {
          if (pending) { setOnce(pending, v); pending = null; }
          else if (team) setOnce(team === 'home' ? 'mlHome' : 'mlAway', v);
        }
      }
    }
  }
  if (spread.home != null) out.spreadHome = spread.home;
  else if (spread.away != null) out.spreadHome = -spread.away;
  return { lines: out, found: summarize(out, teams, new Set()), guessed: [] };
}

// ---------------- layout parser (uses word positions) ----------------

/** Turn OCR words into typed tokens with positions. */
function tokenize(words) {
  const ws = words
    .map((w) => ({ ...w, t: cleanOcr(w.text).trim().replace(/^[([{|]+|[)\]}|,;]+$/g, '') }))
    .filter((w) => w.t)
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const hMed = median(ws.map((w) => w.y1 - w.y0)) || 12;
  const toks = [];
  const used = new Set();
  for (let i = 0; i < ws.length; i++) {
    if (used.has(i)) continue;
    const w = ws[i]; const t = w.t;
    const box = { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, cy: (w.y0 + w.y1) / 2 };
    // "O"/"Over"/"U"/"Under" followed by a number on the same row
    if (/^(o|u|over|under)$/i.test(t)) {
      const j = ws.findIndex((n, k) => !used.has(k) && k !== i && Math.abs((n.y0 + n.y1) / 2 - box.cy) < hMed * 0.6 && n.x0 > w.x1 - 2 && n.x0 - w.x1 < hMed * 2.5 && /^\d{2,4}(\.\d)?$/.test(n.t));
      if (j >= 0) {
        used.add(j);
        const n = ws[j]; const v = fixTotal(+n.t, n.t);
        toks.push({ kind: 'ou', over: /^o/i.test(t), v, ...box, x1: n.x1, y1: Math.max(w.y1, n.y1) });
        continue;
      }
    }
    // "O132.5", "0132.5", "U1325": letter stuck to the number (O often reads as 0)
    let m = t.match(/^([oO0uU])(\d{3,4}(?:\.\d)?)$/);
    if (m && !(m[1] === '0' && +m[2] < 30)) { toks.push({ kind: 'ou', over: /[oO0]/.test(m[1]), v: fixTotal(+m[2], m[2]), ...box }); continue; }
    if (/^(pk|pick|pick'?em)$/i.test(t)) { toks.push({ kind: 'num', v: 0, signed: true, dec: true, pk: true, ...box }); continue; }
    if (/^even$/i.test(t)) { toks.push({ kind: 'num', v: 100, signed: true, dec: false, ...box }); continue; }
    m = t.match(/^([+-]?)(\d{1,4}(?:\.\d)?)$/);
    if (m) { toks.push({ kind: 'num', v: +(m[1] + m[2]), signed: !!m[1], dec: m[2].includes('.'), ...box }); continue; }
    toks.push({ kind: 'word', t, ...box });
  }
  return { toks, hMed };
}

function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

/** Group tokens into rows by vertical position. */
function rowsOf(toks, hMed) {
  const rows = [];
  for (const t of [...toks].sort((a, b) => a.cy - b.cy)) {
    const r = rows.find((row) => Math.abs(row.cy - t.cy) < hMed * 0.6);
    if (r) { r.toks.push(t); r.cy = (r.cy * (r.toks.length - 1) + t.cy) / r.toks.length; } else rows.push({ cy: t.cy, toks: [t] });
  }
  for (const r of rows) { r.toks.sort((a, b) => a.x0 - b.x0); r.text = r.toks.map((t) => t.t ?? (t.kind === 'ou' ? `${t.over ? 'O' : 'U'} ${t.v}` : t.v)).join(' '); }
  return rows;
}

/**
 * Parse OCR words with positions. Uses column headers (Spread / Total / Moneyline) when
 * present and pairs each line with the odds beside or under it.
 * @returns {lines, found, guessed}
 */
export function parseOddsWords(words, teams, expect = {}) {
  const { toks, hMed } = tokenize(words);
  const rows = rowsOf(toks, hMed);
  const aliases = { home: teamAliases(teams.home), away: teamAliases(teams.away) };
  const classify = makeClassifier(expect);

  // Column headers
  const cols = {};
  for (const t of toks) {
    if (t.kind !== 'word') continue;
    const cx = (t.x0 + t.x1) / 2;
    if (/^spread$|^handicap$|^line$/i.test(t.t) && cols.spread == null) cols.spread = { cx, y: t.cy };
    else if (/^totals?$/i.test(t.t) && cols.total == null) cols.total = { cx, y: t.cy };
    else if (/^money(line)?$|^ml$/i.test(t.t) && cols.ml == null) cols.ml = { cx, y: t.cy };
  }
  const colOf = (t) => {
    const cx = (t.x0 + t.x1) / 2; let best = null, bd = Infinity;
    for (const [k, c] of Object.entries(cols)) { if (t.cy < c.y) continue; const d = Math.abs(cx - c.cx); if (d < bd) { bd = d; best = k; } }
    return best;
  };

  // Team bands: from a row naming a team down to the next such row
  const bands = [];
  for (const r of rows) {
    const side = findTeam(r.text, aliases);
    if (side) bands.push({ side, top: r.cy - hMed, toks: [] });
  }
  if (!bands.length) return null;
  for (let i = 0; i < bands.length; i++) bands[i].bottom = i + 1 < bands.length ? bands[i + 1].top : Infinity;
  for (const t of toks) {
    if (t.kind === 'word') continue;
    const b = bands.find((bd) => t.cy >= bd.top && t.cy < bd.bottom);
    if (b) b.toks.push(t);
  }

  const out = {}; const guessed = new Set(); const spread = {};
  const set = (k, v, guess = false) => { if (out[k] == null && v != null) { out[k] = v; if (guess) guessed.add(k); } };
  // Price for a spread or total. These live near -110, so anything past -400/+300 is a misread:
  // usually the minus sign read as a 1 ("-115" -> "1115" or "-1115").
  const oddsVal = (t) => {
    let v = t.v, guess = !t.signed && v !== 100;
    const a = Math.abs(v);
    if (a >= 1000 && String(a)[0] === '1' && a - 1000 >= 100 && a - 1000 <= 400) { v = -(a - 1000); guess = true; }
    else if (guess) v = -a; // juice lost its sign: almost always negative
    if (v < -400 || v > 300) return [null, false];
    return [v, guess];
  };
  const isOdds = (t) => t.kind === 'num' && !t.pk && !t.dec && Math.abs(t.v) >= 100 && Math.abs(t.v) <= 10000;

  for (const band of bands) {
    const T = band.toks; const team = band.side;
    const claimed = new Set();
    const lineToks = [];
    // In the main grid (first total sits in the Total column), the first number in the Spread
    // column is the spread even if OCR dropped its decimal ("-115" -> -11.5).
    const firstOU = T.find((t) => t.kind === 'ou');
    const gridBand = cols.spread && (!firstOU || colOf(firstOU) !== 'spread');
    if (gridBand) {
      const sp = T.filter((t) => t.kind === 'num' && colOf(t) === 'spread').sort((a, b) => a.cy - b.cy || a.x0 - b.x0)[0];
      if (sp) {
        let v = sp.v;
        if (!sp.dec && Math.abs(v) >= 100 && Math.abs(v) < 700) v = v / 10;
        if (Math.abs(v) <= 60) { sp.v = v; sp.dec = true; lineToks.push({ tok: sp, kind: 'spread' }); claimed.add(sp); }
      }
    }
    for (const t of T) {
      if (claimed.has(t)) continue;
      if (t.kind === 'ou') lineToks.push({ tok: t, kind: 'ou' });
      else if (t.kind === 'num' && (t.dec || t.pk || Math.abs(t.v) <= 60) && (t.signed || t.pk) && !(gridBand && lineToks.some((l) => l.kind === 'spread'))) lineToks.push({ tok: t, kind: 'spread' });
    }
    // Pair each line with the odds beside it (same row, to the right) or under it (same column)
    for (const L of lineToks.sort((a, b) => a.tok.cy - b.tok.cy || a.tok.x0 - b.tok.x0)) {
      const l = L.tok; let best = null, bd = Infinity;
      for (const o of T) {
        if (o === l || claimed.has(o) || !isOdds(o)) continue;
        if (lineToks.some((x) => x.tok === o)) continue;
        const sameRow = Math.abs(o.cy - l.cy) < hMed * 0.6 && o.x0 >= l.x1 - 2;
        const below = o.cy > l.cy && o.cy - l.cy < hMed * 2.6 && o.x0 < l.x1 + hMed && o.x1 > l.x0 - hMed;
        if (!sameRow && !below) continue;
        // don't jump over another line value on the same row
        if (sameRow && lineToks.some((x) => x.tok !== l && Math.abs(x.tok.cy - l.cy) < hMed * 0.6 && x.tok.x0 > l.x1 && x.tok.x0 < o.x0)) continue;
        const d = sameRow ? (o.x0 - l.x1) : (o.cy - l.cy) * 1.2;
        if (d < bd) { bd = d; best = o; }
      }
      if (best) claimed.add(best);
      if (L.kind === 'spread') {
        if (spread[team] == null) spread[team] = { v: l.v, signed: l.signed || l.pk || l.v === 0 };
        const k = team === 'home' ? 'spreadHomeOdds' : 'spreadAwayOdds';
        if (best) { const [v, g] = oddsVal(best); set(k, v, g); }
      } else {
        const v = l.v; if (v < 30 || v > 260) continue;
        let k;
        if (classify(v) === 'game') { set('total', v); k = l.over ? 'overOdds' : 'underOdds'; }
        else { const TT = team === 'home' ? 'ttHome' : 'ttAway'; set(TT, v); k = `${TT}${l.over ? 'Over' : 'Under'}Odds`; }
        if (best) { const [ov, g] = oddsVal(best); set(k, ov, g); }
      }
    }
    // Leftover odds in a team's band: the moneyline (prefer the Moneyline column)
    const left = T.filter((t) => isOdds(t) && !claimed.has(t) && !lineToks.some((x) => x.tok === t));
    if (left.length) {
      const ml = (cols.ml && left.find((t) => colOf(t) === 'ml')) || (cols.ml ? null : left[0]);
      if (ml) {
        const key = team === 'home' ? 'mlHome' : 'mlAway';
        if (ml.signed || ml.v === 100) set(key, ml.v);
        else out[`_${key}`] = Math.abs(ml.v); // sign decided below
      }
    }
  }

  // Spreads are mirror images, so a spread that lost its sign borrows it from the other team's.
  const h = spread.home, a = spread.away;
  if (h?.signed) out.spreadHome = h.v;
  else if (a?.signed) out.spreadHome = -a.v;
  else if (h || a) {
    out.spreadHome = h ? h.v : -a.v;
    // Neither sign was read: the moneyline favorite is the spread favorite
    const fav = out.mlHome != null && out.mlAway != null ? (out.mlHome < out.mlAway ? 'home' : 'away') : null;
    if (fav) out.spreadHome = (fav === 'home' ? -1 : 1) * Math.abs(out.spreadHome);
    if (out.spreadHome !== 0) guessed.add('spreadHome');
  }

  // Moneylines that lost their sign: the favorite (by spread, or the other ML) is negative
  for (const [key, other, side] of [['mlHome', 'mlAway', 1], ['mlAway', 'mlHome', -1]]) {
    const raw = out[`_${key}`]; delete out[`_${key}`];
    if (raw == null || out[key] != null) continue;
    let neg;
    if (out.spreadHome != null && out.spreadHome !== 0) neg = side * out.spreadHome < 0;
    else if (out[other] != null) neg = out[other] > 0;
    else neg = false;
    set(key, neg ? -raw : raw, true);
  }
  return { lines: out, found: summarize(out, teams, guessed), guessed: [...guessed] };
}

/** Best effort: layout parser first, plain-text parser if that finds less. */
export function parseOdds({ text, words }, teams, expect = {}) {
  const byText = parseOddsText(text || '', teams, expect);
  const byLayout = words?.length ? parseOddsWords(words, teams, expect) : null;
  if (!byLayout) return byText;
  return Object.keys(byLayout.lines).length >= Object.keys(byText.lines).length ? byLayout : byText;
}
