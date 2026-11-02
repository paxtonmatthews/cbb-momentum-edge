// Replays finished games through the model at fixed points in time and checks
// how well its projections matched the final score. Runs entirely in the browser.
import { fetchScoreboard, fetchSummary, normalizeGame, pregameBaseline } from './espn.js';
import { CONFIG, analyze } from './model.js';

const $ = (s) => document.querySelector(s);
const CHECKPOINTS = [10, 20, 30, 35, 38];

function datesBetween(from, to) {
  const out = []; const d = new Date(from + 'T12:00:00'); const end = new Date(to + 'T12:00:00');
  while (d <= end && out.length < 60) { out.push(d.toISOString().slice(0, 10).replaceAll('-', '')); d.setDate(d.getDate() + 1); }
  return out;
}

async function loadGames(league, dates, max, log) {
  let ids = [];
  for (const d of dates) {
    try { const sb = await fetchScoreboard(league, d); ids.push(...(sb.events || []).filter((e) => e.status.type.completed).map((e) => e.id)); } catch { /* skip day */ }
    log(`Found ${ids.length} finished games…`);
    if (ids.length >= max) break;
  }
  ids = ids.slice(0, max);
  const games = [];
  for (let i = 0; i < ids.length; i += 8) {
    const res = await Promise.allSettled(ids.slice(i, i + 8).map((id) => fetchSummary(league, id)));
    for (const r of res) {
      if (r.status !== 'fulfilled') continue;
      try {
        const g = normalizeGame(r.value, league);
        if (g.odds && isFinite(g.odds.total) && isFinite(g.odds.spreadHome) && g.plays.length > 100) games.push(g);
      } catch { /* bad game */ }
    }
    log(`Loaded ${Math.min(i + 8, ids.length)}/${ids.length} games (${games.length} with betting lines)…`);
  }
  return games;
}

export function evaluate(games, cfg = CONFIG) {
  const rows = [];
  for (const cp of CHECKPOINTS) {
    const err = { m: [], t: [] }; let n = 0, in80m = 0, in80t = 0, brier = 0, brierE = 0, nE = 0;
    for (const g of games) {
      const scale = g.regMinutes / 40; const at = cp * scale;
      let idx = -1;
      for (let i = 0; i < g.plays.length; i++) { if (g.plays[i].t <= at) idx = i; else break; }
      if (idx < 5) continue;
      const a = analyze(g, { cutoff: idx, pregame: pregameBaseline(g, {}, cfg), season: {}, cfg });
      if (a.rem <= 0) continue;
      const fm = g.final.margin, ft = g.final.total;
      err.m.push(fm - a.proj.margin); err.t.push(ft - a.proj.total);
      if (Math.abs((fm - a.proj.margin) / a.proj.sdM) < 1.2816) in80m++;
      if (Math.abs((ft - a.proj.total) / a.proj.sdT) < 1.2816) in80t++;
      const y = fm > 0 ? 1 : 0; brier += (a.proj.winHome - y) ** 2; n++;
      if (a.espnWP != null) { brierE += (a.espnWP - y) ** 2; nE++; }
    }
    const rmse = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
    rows.push({ cp, n, in80m: in80m / n, in80t: in80t / n, marginRMSE: rmse(err.m), totalRMSE: rmse(err.t), totalBias: mean(err.t), brier: brier / n, brierESPN: nE ? brierE / nE : null });
  }
  return rows;
}

const f = (x, d = 1) => (x == null || !isFinite(x) ? '—' : x.toFixed(d));
const p = (x) => (x == null || !isFinite(x) ? '—' : `${Math.round(x * 100)}%`);

async function run(e) {
  e.preventDefault();
  const btn = $('#run'); btn.disabled = true;
  const log = (s) => { $('#log').textContent = s; };
  try {
    const games = await loadGames($('#league').value, datesBetween($('#from').value, $('#to').value), +$('#max').value, log);
    if (!games.length) { log('No finished games with betting lines in that range.'); return; }
    const rows = evaluate(games);
    log(`Done: ${games.length} games.`);
    $('#results').innerHTML = `<thead><tr><th>Minute</th><th>Games</th><th>Margin in 80% range</th><th>Total in 80% range</th><th>Margin error</th><th>Total error</th><th>Total bias</th><th>Brier (model)</th><th>Brier (ESPN)</th></tr></thead><tbody>` +
      rows.map((r) => `<tr><td>${r.cp}</td><td>${r.n}</td><td>${p(r.in80m)}</td><td>${p(r.in80t)}</td><td>±${f(r.marginRMSE)}</td><td>±${f(r.totalRMSE)}</td><td>${r.totalBias > 0 ? '+' : ''}${f(r.totalBias)}</td><td>${f(r.brier, 3)}</td><td>${f(r.brierESPN, 3)}</td></tr>`).join('') + '</tbody>';
  } catch (err) {
    log(`Failed: ${err.message}`);
  } finally { btn.disabled = false; }
}

if (typeof document !== 'undefined' && $('#bt-form')) $('#bt-form').addEventListener('submit', run);
