import {
  parseGameInput, fetchSummary, fetchScoreboard, fetchTeamStats, normalizeGame, seasonProfile, pregameBaseline,
} from './espn.js';
import {
  CONFIG, analyze, evaluateBets, gradeBet, explain, fairLines, fmtLine, fmtOdds,
} from './model.js';
import { readImage, parseOdds } from './oddsocr.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x, d = 0) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const num = (x, d = 1) => (x == null || !isFinite(x) ? '—' : x.toFixed(d));
const REFRESH_MS = 20000;

const state = {
  league: 'mens-college-basketball', id: null, game: null, season: {}, pregame: null,
  cutoff: null, lineOverrides: {}, cfg: {}, timer: null, loading: false,
};

// ---------------- loading ----------------

async function loadGame(league, id, { keepInputs = false } = {}) {
  clearTimeout(state.timer);
  const isNew = state.id !== id;
  state.league = league; state.id = id;
  if (isNew && !keepInputs) { state.lineOverrides = {}; state.cutoff = null; }
  showError('');
  try {
    const raw = await fetchSummary(league, id);
    const game = normalizeGame(raw, league);
    if (isNew || !state.season.home) {
      const [h, a] = await Promise.allSettled([fetchTeamStats(league, game.home.id), fetchTeamStats(league, game.away.id)]);
      state.season = {
        home: h.status === 'fulfilled' ? seasonProfile(h.value) : null,
        away: a.status === 'fulfilled' ? seasonProfile(a.value) : null,
      };
    }
    state.game = game;
    state.pregame = pregameBaseline(game, state.season, cfg());
    const url = new URL(location.href);
    url.searchParams.set('game', id); url.searchParams.set('league', league);
    history.replaceState(null, '', url);
    document.title = `${game.away.abbr} @ ${game.home.abbr} · Momentum Edge`;
    $('#game').hidden = false;
    if (isNew) { renderLinesForm(); renderSettings(); }
    render();
    if (isNew) $('#game').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    showError(`Couldn't load that game (${err.message}). Check the link and try again.`);
  }
  scheduleRefresh();
}

function scheduleRefresh() {
  clearTimeout(state.timer);
  const g = state.game;
  if (g && g.status.state === 'in' && $('#autorefresh').checked && state.cutoff == null) {
    state.timer = setTimeout(() => loadGame(state.league, state.id, { keepInputs: true }), REFRESH_MS);
  }
}

function showError(msg) { const e = $('#form-error'); e.textContent = msg; e.hidden = !msg; }
const cfg = () => ({ ...CONFIG, ...state.cfg });

// ---------------- lines ----------------

const LINE_FIELDS = [
  ['spreadHome', (g) => `${g.home.short} spread`],
  ['spreadHomeOdds', (g) => `${g.home.short} spread odds`],
  ['spreadAwayOdds', (g) => `${g.away.short} spread odds`],
  ['total', () => 'Total (O/U)'],
  ['overOdds', () => 'Over odds'],
  ['underOdds', () => 'Under odds'],
  ['mlHome', (g) => `${g.home.short} moneyline`],
  ['mlAway', (g) => `${g.away.short} moneyline`],
  ['ttHome', (g) => `${g.home.short} team total`],
  ['ttHomeOverOdds', (g) => `${g.home.short} TT over odds`],
  ['ttHomeUnderOdds', (g) => `${g.home.short} TT under odds`],
  ['ttAway', (g) => `${g.away.short} team total`],
  ['ttAwayOverOdds', (g) => `${g.away.short} TT over odds`],
  ['ttAwayUnderOdds', (g) => `${g.away.short} TT under odds`],
];

function espnLines() {
  const o = state.game.odds || {};
  const out = {};
  for (const [k] of LINE_FIELDS) out[k] = o[k] ?? null;
  return out;
}
// Once a game has started, ESPN's (pregame) numbers are stale: only lines the user
// typed or uploaded are used, and the pregame numbers show as hints.
const started = () => state.game.status.state !== 'pre';
const baseLines = () => (started() ? {} : espnLines());

function currentLines() {
  const l = { ...baseLines(), ...state.lineOverrides };
  for (const k in l) l[k] = l[k] == null || l[k] === '' ? NaN : +l[k];
  return l;
}

function renderLinesForm() {
  const g = state.game, base = baseLines(), espn = espnLines();
  $('#lines').innerHTML = LINE_FIELDS.map(([k, label]) => {
    const v = state.lineOverrides[k] ?? base[k] ?? '';
    const hint = started() && espn[k] != null ? `pregame ${espn[k]}` : '';
    return `<label><span>${esc(label(g))}</span><input name="${k}" type="number" step="0.5" value="${esc(v)}" placeholder="${esc(hint)}" inputmode="decimal"></label>`;
  }).join('');
}

function renderSettings() {
  const fields = [
    ['momentumWeight', 'Momentum weight (pts)', 0.5],
    ['marginSD', 'Margin SD (pts)', 0.5],
    ['totalSD', 'Total SD (pts)', 0.5],
    ['threeRegress', '3P luck removed (0–1)', 0.05],
    ['restoring', 'Lead shrink rate', 0.001],
    ['minEV', 'Min edge to bet', 0.005],
  ];
  $('#settings').innerHTML = fields.map(([k, label, step]) =>
    `<label><span>${label}</span><input name="${k}" type="number" step="${step}" value="${cfg()[k]}"></label>`).join('');
}

// ---------------- render ----------------

function render() {
  const g = state.game; if (!g) return;
  const c = cfg();
  const a = analyze(g, { cutoff: state.cutoff, pregame: state.pregame, season: state.season, cfg: c });
  state.lastA = a;
  const names = { home: g.home.short, away: g.away.short };
  const lines = currentLines();
  const bets = evaluateBets(a, lines, names, c);
  // After tip-off, ESPN's line is the pregame number. Comparing a live projection to it
  // produces fake edges, so we only pick a bet once the user enters live lines.
  const stale = Object.keys(state.lineOverrides).length === 0 && a.nowT > 0 && a.rem > 0;

  renderScorebug(g, a);
  if (stale) renderFairLine(g, a); else renderBestBet(g, a, bets);
  renderMomentum(g, a);
  renderChart(g, a);
  renderReplay(g, a);
  renderProjection(g, a);
  renderOptions(g, stale ? { options: [], stale: true } : bets);
  renderWhy(g, a, names);
  renderShooting(g, a);
  renderLinesNote(g, a);
}

function teamBlock(t, side) {
  return `<div class="team ${side}">
    ${t.logo ? `<img src="${esc(t.logo)}" alt="" width="48" height="48">` : ''}
    <div><div class="tname">${t.rank ? `<span class="rank">${t.rank}</span>` : ''}${esc(t.name)}</div>
    <div class="muted small">${esc(t.record)}</div></div></div>`;
}

function renderScorebug(g, a) {
  const live = g.status.state === 'in' && !a.replay;
  const status = a.replay ? `Replay · ${clockLabel(g, a)}` : g.status.detail;
  $('#scorebug').innerHTML = `
    ${teamBlock(g.away, 'away')}
    <div class="score">
      <div class="nums"><span>${a.away}</span><span class="dash">–</span><span>${a.home}</span></div>
      <div class="status ${live ? 'live' : ''}">${live ? '<span class="dot"></span>' : ''}${esc(status)}</div>
      <a class="small" href="${g.espnUrl}" target="_blank" rel="noopener">ESPN game page ↗</a>
    </div>
    ${teamBlock(g.home, 'home')}`;
}

function clockLabel(g, a) {
  const p = a.plays[a.plays.length - 1];
  if (!p) return 'Pregame';
  const per = p.period <= g.periods ? (g.periods === 2 ? `${p.period === 1 ? '1st' : '2nd'} half` : `Q${p.period}`) : `OT${p.period - g.periods > 1 ? p.period - g.periods : ''}`;
  return `${p.clock} ${per}`;
}

function renderBestBet(g, a, bets) {
  const el = $('#bestbet');
  if (bets.verdict === 'final') {
    const winner = a.curMargin > 0 ? g.home.short : g.away.short;
    el.innerHTML = `<div class="eyebrow">Best bet</div><div class="pick">Final</div><p class="muted">${esc(winner)} won by ${Math.abs(a.curMargin)}. Drag the replay slider to see what the model said during the game.</p>`;
    return;
  }
  const b = bets.best;
  if (!b) {
    el.innerHTML = `<div class="eyebrow">Best bet</div><div class="pick">Need a line</div><p class="muted">ESPN has no betting line for this game. Enter your sportsbook's spread, total, or moneyline in the Lines box.</p>`;
    return;
  }
  const badge = { strong: ['Strong edge', 'good'], lean: ['Lean', 'warn'], pass: ['No edge — pass', 'muted'] }[bets.verdict];
  let graded = '';
  if (a.replay && g.final && bets.verdict !== 'pass') {
    const r = gradeBet(b, { home: g.home.score, away: g.away.score });
    graded = `<div class="grade ${r}">Result: ${r.toUpperCase()} <span class="muted">(final ${g.away.abbr} ${g.away.score} – ${g.home.abbr} ${g.home.score})</span></div>`;
  }
  const pre = g.status.state === 'pre' && !a.replay ? `<p class="note">The game hasn't started, so the model just mirrors the pregame line. Come back after tip-off.</p>` : '';
  el.innerHTML = `
    <div class="eyebrow">Best bet <span class="badge ${badge[1]}">${badge[0]}</span></div>
    <div class="pick">${esc(b.label)} <span class="odds">${fmtOdds(b.odds)}</span></div>
    <div class="stats3">
      <div><b>${pct(b.p, 1)}</b><span>model chance</span></div>
      <div><b>${pct(b.implied, 1)}</b><span>line implies</span></div>
      <div><b class="${b.ev > 0 ? 'pos' : 'neg'}">${b.ev > 0 ? '+' : ''}${pct(b.ev, 1)}</b><span>expected value</span></div>
    </div>
    ${bets.verdict !== 'pass' ? `<p class="small">Suggested stake: <b>${pct(b.kelly, 1)}</b> of bankroll (quarter-Kelly).</p>` : `<p class="small muted">The best option isn't clearly better than the sportsbook's cut. Waiting is a bet too.</p>`}
    ${graded}${pre}`;
}

function renderFairLine(g, a) {
  const f = fairLines(a);
  const fav = f.spreadHome <= 0 ? g.home : g.away;
  $('#bestbet').innerHTML = `
    <div class="eyebrow">Fair live line <span class="badge muted">model</span></div>
    <div class="pick">${esc(fav.short)} ${fmtLine(-Math.abs(f.spreadHome))} · O/U ${f.total}</div>
    <div class="stats3">
      <div><b>${fmtOdds(f.mlAway)}</b><span>${esc(g.away.abbr)} fair ML</span></div>
      <div><b>${f.total}</b><span>fair total</span></div>
      <div><b>${fmtOdds(f.mlHome)}</b><span>${esc(g.home.abbr)} fair ML</span></div>
      <div><b>${f.ttAway}</b><span>${esc(g.away.abbr)} team total</span></div>
      <div><b>${fmtLine(f.spreadHome)}</b><span>${esc(g.home.abbr)} fair spread</span></div>
      <div><b>${f.ttHome}</b><span>${esc(g.home.abbr)} team total</span></div>
    </div>
    <p class="small">This is where the line <i>should</i> be right now. Type your sportsbook's live line into <a href="#lines" id="goto-lines">Lines</a> and the model will name the best bet. If the book's number is far from this one, that's where the value is.</p>`;
  $('#goto-lines').addEventListener('click', (e) => { e.preventDefault(); const i = $('#lines input'); i.scrollIntoView({ behavior: 'smooth', block: 'center' }); i.focus({ preventScroll: true }); });
}

function renderMomentum(g, a) {
  const m = a.mom; // + = home
  const leader = m > 0 ? g.home : g.away;
  const pos = 50 + m / 2;
  const r = a.runs;
  const cur = r.current;
  $('#momentum').innerHTML = `
    <div class="eyebrow">Momentum</div>
    <div class="pick" style="color:${Math.abs(m) < 10 ? 'inherit' : 'var(--accent)'}">${Math.abs(m) < 10 ? 'Even' : `${esc(leader.short)} ${Math.abs(m)}`}</div>
    <div class="meter" role="img" aria-label="Momentum ${m} toward ${esc(leader.short)}">
      <div class="meter-fill" style="left:${Math.min(50, pos)}%;width:${Math.abs(pos - 50)}%;background:${m > 0 ? g.home.color : g.away.color}"></div>
      <div class="meter-mid"></div>
    </div>
    <div class="meter-labels small"><span>${esc(g.away.abbr)}</span><span>${esc(g.home.abbr)}</span></div>
    <ul class="facts">
      ${cur ? `<li>Current run: <b>${esc(g[cur.team].short)} ${cur.pts}-0</b> over ${num(cur.minutes, 1)} min</li>` : ''}
      <li>Last ${r.windowMin} min: <b>${esc(g.away.abbr)} ${r.recent.away} – ${esc(g.home.abbr)} ${r.recent.home}</b></li>
      <li>Biggest runs: ${esc(g.away.abbr)} ${r.best.away}-0 · ${esc(g.home.abbr)} ${r.best.home}-0</li>
    </ul>
    <p class="hint">Momentum shows what just happened. Studies find runs barely predict what comes next, so it doesn't move the projection unless you turn it on in settings.</p>`;
}

function renderChart(g, a) {
  const all = g.plays;
  const W = 800, H = 220, P = 26;
  const lastP = all[all.length - 1];
  const maxT = Math.max(g.regMinutes, lastP ? g.lengthAt(lastP.period) : g.regMinutes);
  const pts = [[0, 0]];
  for (const p of all) { const m = p.home - p.away; if (m !== pts[pts.length - 1][1]) pts.push([p.t, m]); }
  const maxAbs = Math.max(10, ...pts.map((p) => Math.abs(p[1]))) + 2;
  const x = (t) => P + (t / maxT) * (W - 2 * P);
  const y = (m) => H / 2 - (m / maxAbs) * (H / 2 - 14);
  let d = `M${x(0)},${y(0)}`;
  for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i][0]).toFixed(1)} V${y(pts[i][1]).toFixed(1)}`;
  const endT = all.length ? Math.max(lastP.t, a.replay ? 0 : a.nowT) : 0;
  d += ` H${x(endT).toFixed(1)}`;
  const area = `${d} V${y(0)} H${x(0)} Z`;
  const cutX = x(a.nowT);
  const marks = [];
  for (let k = 1; k < g.periods; k++) marks.push(k * g.periodMin);
  for (let t = g.regMinutes; t < maxT; t += 5) marks.push(t);
  const grid = marks.map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="8" y2="${H - 8}" class="gridline"/>`).join('');
  $('#chart').innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Score margin over the game">
    <defs>
      <clipPath id="above"><rect x="0" y="0" width="${W}" height="${y(0)}"/></clipPath>
      <clipPath id="below"><rect x="0" y="${y(0)}" width="${W}" height="${H}"/></clipPath>
      <clipPath id="played"><rect x="0" y="0" width="${cutX}" height="${H}"/></clipPath>
    </defs>
    ${grid}
    <line x1="${P}" x2="${W - P}" y1="${y(0)}" y2="${y(0)}" class="zero"/>
    <g opacity="0.18">
      <path d="${area}" fill="${g.home.color}" clip-path="url(#above)"/>
      <path d="${area}" fill="${g.away.color}" clip-path="url(#below)"/>
    </g>
    <g clip-path="url(#played)">
      <path d="${area}" fill="${g.home.color}" clip-path="url(#above)" opacity="0.75"/>
      <path d="${area}" fill="${g.away.color}" clip-path="url(#below)" opacity="0.75"/>
      <path d="${d}" fill="none" class="worm"/>
    </g>
    <line x1="${cutX}" x2="${cutX}" y1="6" y2="${H - 6}" class="cut"/>
    <text x="${P + 4}" y="20" class="lbl">${esc(g.home.abbr)} ahead ▲</text>
    <text x="${P + 4}" y="${H - 10}" class="lbl">${esc(g.away.abbr)} ahead ▼</text>
    <text x="${W - P}" y="20" class="lbl" text-anchor="end">±${Math.round(maxAbs - 2)}</text>
  </svg>`;
}

function renderReplay(g, a) {
  const r = $('#replay');
  r.max = Math.max(0, g.plays.length - 1);
  r.value = state.cutoff ?? r.max;
  r.disabled = g.plays.length < 2;
  $('#replay-label').textContent = a.replay ? clockLabel(g, a) : (g.status.state === 'post' ? 'Final' : 'Live');
  $('#replay-live').hidden = !a.replay;
}

function renderProjection(g, a) {
  const p = a.proj;
  const z = 1.2816; // 80% range
  const mm = (m) => (m >= 0 ? `${g.home.short} by ${num(m)}` : `${g.away.short} by ${num(-m)}`);
  $('#projection').innerHTML = `
    <h2>Projection</h2>
    <div class="projscore">
      <div><span class="muted small">${esc(g.away.abbr)}</span><b>${num(p.awayScore, 0)}</b></div>
      <div class="muted">final</div>
      <div><span class="muted small">${esc(g.home.abbr)}</span><b>${num(p.homeScore, 0)}</b></div>
    </div>
    <table class="table compact">
      <tr><td>Margin</td><td>${mm(p.margin)} <span class="muted small">(80%: ${num(p.margin - z * p.sdM, 0)} to ${num(p.margin + z * p.sdM, 0)})</span></td></tr>
      <tr><td>Total</td><td>${num(p.total)} <span class="muted small">(80%: ${num(p.total - z * p.sdT, 0)}–${num(p.total + z * p.sdT, 0)})</span></td></tr>
      <tr><td>Win chance</td><td>${esc(g.home.abbr)} ${pct(p.winHome)} · ${esc(g.away.abbr)} ${pct(1 - p.winHome)}</td></tr>
      <tr><td>ESPN win prob.</td><td>${a.espnWP == null ? '—' : `${esc(g.home.abbr)} ${pct(a.espnWP)}`}</td></tr>
      <tr><td>Time left</td><td>${num(a.rem, 1)} min</td></tr>
      <tr><td>Pregame baseline</td><td class="small">${esc(a.pregame.source)}</td></tr>
    </table>`;
}

function renderOptions(g, bets) {
  const t = $('#options');
  if (!bets.options.length) {
    t.innerHTML = `<tr><td class="muted">${bets.stale ? 'Enter live lines to rank bets. Pregame lines are out of date once the game starts.' : 'No open bets (game final or no lines entered).'}</td></tr>`;
    return;
  }
  t.innerHTML = `<thead><tr><th>Bet</th><th>Odds</th><th>Model</th><th>Implied</th><th>Edge</th><th>¼ Kelly</th></tr></thead><tbody>` +
    bets.options.map((o, i) => `<tr class="${i === 0 && bets.verdict !== 'pass' ? 'best' : ''}">
      <td>${esc(o.label)}</td><td>${fmtOdds(o.odds)}</td><td>${pct(o.p, 1)}</td><td>${pct(o.implied, 1)}</td>
      <td class="${o.ev > 0 ? 'pos' : 'neg'}">${o.ev > 0 ? '+' : ''}${pct(o.ev, 1)}</td><td>${o.kelly > 0 ? pct(o.kelly, 1) : '—'}</td></tr>`).join('') + '</tbody>';
}

function renderWhy(g, a, names) {
  const items = explain(a, names);
  $('#why').innerHTML = `<h2>Why</h2>${items.length ? `<ul class="facts">${items.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '<p class="muted">Nothing unusual yet. The projection is close to the pregame line.</p>'}`;
}

function renderShooting(g, a) {
  const row = (side) => {
    const s = a.split[side], t = g[side], sea = state.season[side];
    const f = (m, at) => `${m}/${at} <span class="muted small">${at ? pct(m / at) : ''}</span>`;
    return `<tr><td><b>${esc(t.abbr)}</b></td><td>${f(s.fgm, s.fga)}</td><td>${f(s.tpm, s.tpa)}</td><td>${f(s.ftm, s.fta)}</td>
      <td>${sea ? pct(sea.threePct, 1) : '—'}</td><td class="${a.luck[side] > 0 ? 'pos' : 'neg'}">${a.luck[side] > 0 ? '+' : ''}${num(a.luck[side])}</td></tr>`;
  };
  $('#shooting').innerHTML = `<h2>Shooting</h2>
    <div class="table-wrap"><table class="table compact"><thead><tr><th></th><th>FG</th><th>3P</th><th>FT</th><th>Season 3P</th><th>3P luck</th></tr></thead>
    <tbody>${row('away')}${row('home')}</tbody></table></div>
    <p class="hint">"3P luck" is points from threes above or below the team's normal rate. The model expects most of it not to continue.</p>`;
}

function renderLinesNote(g, a) {
  const o = g.odds;
  const edited = Object.keys(state.lineOverrides).length > 0;
  let msg = '';
  if (edited) msg = 'Using only the lines you entered or uploaded. Leave a box empty to skip that bet.';
  else if (started()) msg = `Upload a screenshot of your book's live odds, or type them in. ${o ? 'Gray hints are the pregame line, which is out of date now.' : ''}`;
  else if (!o) msg = 'ESPN has no line for this game. Upload a screenshot of your book or type the line in.';
  else msg = `${o.provider} pregame line from ESPN.`;
  $('#lines-note').textContent = msg;
}

// ---------------- games list ----------------

const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

async function loadGames() {
  const league = $('#league').value;
  const date = $('#date').value ? $('#date').value.replaceAll('-', '') : ymd(new Date());
  const el = $('#games');
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const sb = await fetchScoreboard(league, date);
    const order = { in: 0, pre: 1, post: 2 };
    const evs = (sb.events || []).sort((x, y) => (order[x.status.type.state] - order[y.status.type.state]) || x.date.localeCompare(y.date));
    if (!evs.length) { el.innerHTML = '<p class="muted">No Division I games on this date. Try another day.</p>'; return; }
    el.innerHTML = evs.map((e) => {
      const c = e.competitions[0];
      const h = c.competitors.find((t) => t.homeAway === 'home'), aw = c.competitors.find((t) => t.homeAway === 'away');
      const st = e.status.type.state;
      const line = (t) => `<div class="gl"><img src="${esc(t.team.logo || '')}" alt="" width="20" height="20" loading="lazy"><span>${t.curatedRank?.current <= 25 ? `<span class="rank">${t.curatedRank.current}</span>` : ''}${esc(t.team.shortDisplayName)}</span>${st !== 'pre' ? `<b>${esc(t.score)}</b>` : ''}</div>`;
      const when = st === 'pre' ? new Date(e.date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : e.status.type.shortDetail;
      return `<button class="gamecard ${st}" data-id="${e.id}" data-league="${league}">
        <div class="gs ${st === 'in' ? 'live' : ''}">${st === 'in' ? '<span class="dot"></span>' : ''}${esc(when)}</div>${line(aw)}${line(h)}</button>`;
    }).join('');
  } catch (err) {
    el.innerHTML = `<p class="error">Couldn't load games (${esc(err.message)}).</p>`;
  }
}

// ---------------- sportsbook screenshot ----------------

async function readScreenshot(file) {
  if (!state.game || !file || !file.type.startsWith('image/')) return;
  const box = $('#shot-status');
  box.hidden = false;
  box.innerHTML = '<span class="muted">Loading text reader… (the first time downloads it, about 10 MB)</span>';
  try {
    const ocr = await readImage(file, (p) => { box.innerHTML = `<span class="muted">Reading odds… ${Math.round(p * 100)}%</span>`; });
    const text = ocr.text;
    const p = state.lastA?.proj;
    const { lines, found, guessed } = parseOdds(ocr, state.game, p ? { total: p.total, home: p.homeScore, away: p.awayScore } : {});
    const keys = Object.keys(lines);
    // A new screenshot replaces the previous lines
    state.lineOverrides = {};
    for (const k of keys) state.lineOverrides[k] = lines[k];
    renderLinesForm();
    for (const k of keys) $(`#lines input[name="${k}"]`)?.classList.add(guessed.includes(k) ? 'guess' : 'filled');
    render();
    box.innerHTML = keys.length
      ? `<b class="pos">Found ${keys.length} numbers.</b> Check them against your book before betting. Green = read clearly${guessed.length ? ', <span style="color:var(--warn)">yellow / ? = sign was unclear and guessed</span>' : ''}.
         <ul>${found.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
         <details><summary class="muted">Text the reader saw</summary><pre>${esc(text)}</pre></details>`
      : `<b class="neg">Couldn't find odds in that image.</b> Try a tighter crop showing both team names and their lines.
         <details><summary class="muted">Text the reader saw</summary><pre>${esc(text)}</pre></details>`;
  } catch (err) {
    box.innerHTML = `<span class="error">${esc(err.message)}</span>`;
  }
}

$('#shot-input').addEventListener('change', (e) => { readScreenshot(e.target.files[0]); e.target.value = ''; });
const drop = $('#shot-drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); readScreenshot(e.dataTransfer.files[0]); });
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item && state.game) { e.preventDefault(); readScreenshot(item.getAsFile()); }
});

// ---------------- events ----------------

$('#game-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const parsed = parseGameInput($('#game-input').value);
  if (!parsed) { showError("That doesn't look like an ESPN game link. It should contain gameId/ followed by numbers."); return; }
  loadGame(parsed.league, parsed.id);
});
$('#games').addEventListener('click', (e) => {
  const b = e.target.closest('.gamecard'); if (!b) return;
  $('#game-input').value = `https://www.espn.com/${b.dataset.league}/game/_/gameId/${b.dataset.id}`;
  loadGame(b.dataset.league, b.dataset.id);
});
$('#league').addEventListener('change', loadGames);
$('#date').addEventListener('change', loadGames);
$('#replay').addEventListener('input', (e) => {
  const v = +e.target.value, max = +e.target.max;
  state.cutoff = v >= max ? null : v;
  render(); scheduleRefresh();
});
$('#replay-live').addEventListener('click', () => { state.cutoff = null; render(); scheduleRefresh(); });
$('#autorefresh').addEventListener('change', scheduleRefresh);
$('#lines').addEventListener('input', (e) => {
  const k = e.target.name; if (!k) return;
  const base = baseLines()[k] ?? null;
  const v = e.target.value;
  if (v === '' && base == null) delete state.lineOverrides[k];
  else if (v !== '' && +v === base) delete state.lineOverrides[k];
  else state.lineOverrides[k] = v === '' ? null : +v;
  render();
});
$('#lines-reset').addEventListener('click', () => { state.lineOverrides = {}; renderLinesForm(); render(); });
$('#settings').addEventListener('input', (e) => {
  const k = e.target.name; if (!k) return;
  if (e.target.value === '') delete state.cfg[k]; else state.cfg[k] = +e.target.value;
  if (state.game) state.pregame = pregameBaseline(state.game, state.season, cfg());
  render();
});

// ---------------- boot ----------------

(function boot() {
  const q = new URLSearchParams(location.search);
  const today = new Date();
  $('#date').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (q.get('league')) $('#league').value = q.get('league');
  loadGames();
  const id = q.get('game');
  if (id) {
    const league = q.get('league') || 'mens-college-basketball';
    $('#game-input').value = `https://www.espn.com/${league}/game/_/gameId/${id}`;
    loadGame(league, id);
  }
})();
