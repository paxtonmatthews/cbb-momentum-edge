// Live game model. Every number here is explained, with sources, in RESEARCH.md.
// Pure functions only (no DOM, no fetch) so the model is easy to test and tune.

export const CONFIG = {
  marginSD: 11,          // SD of a college game's final margin around its expectation (~10–11.4)
  marginSDFloor: 1,      // extra margin uncertainty in-game (backtest fit)
  totalSD: 13,           // SD of the final total, random-walk part (backtest fit)
  totalSDFloor: 4,       // extra total uncertainty in-game (backtest fit; pregame SD ≈ 17)
  halfDiff: 6,           // extra late-game points; research says 2H ≈ 1H + 8, backtest fits 6 in the final minutes
  foulWindow: 4,         // minutes at the end of regulation where the extra points land
  foulFullMargin: 8,     // margin at or under which teams foul fully
  foulMaxMargin: 18,     // margin at or over which nobody fouls
  foulCloseBoost: 1.3,   // close games get a bit more than the average bonus
  floorFadeMinutes: 1,   // the uncertainty floor fades out only in the final minute
  homeCourt: 3,          // fallback home-court edge in points when no betting line exists
  restoring: 0.009,      // leads shrink slightly: margin drift per minute per point of lead
  threeRegress: 0.7,     // share of in-game 3P "luck" removed before projecting the future
  leagueThreePct: 0.34,  // fallback 3P% when a team has no season stats yet
  paceTrustMinutes: 16,  // how fast we trust in-game scoring pace over the pregame total
  marginTrustMinutes: 40,// how fast we trust in-game margin rate over the pregame spread
  momentumHalfLife: 2,   // minutes; how fast old scoring fades from the momentum meter
  momentumWeight: 0,     // points of projection tilt per full momentum; 0 = research default
  minEV: 0.02,           // below this expected value we say "pass"
  strongEV: 0.05,
  kellyFraction: 0.25,   // quarter-Kelly stake suggestion
  maxStake: 0.05,        // never suggest more than 5% of bankroll on one bet
};

/** American odds for a probability (no vig). */
export function probToAmerican(p) {
  p = clamp(p, 0.005, 0.995);
  return p >= 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);
}

/** The model's own no-vig line: what the market "should" be right now. */
export function fairLines(a) {
  const half = (x) => Math.round(x * 2) / 2;
  return {
    spreadHome: half(-a.proj.margin),
    total: half(a.proj.total),
    mlHome: probToAmerican(a.proj.winHome),
    mlAway: probToAmerican(1 - a.proj.winHome),
  };
}

// ---------- math helpers ----------
export function normCdf(x) {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
export const americanToDecimal = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
export const impliedProb = (a) => 1 / americanToDecimal(a);
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ---------- game state from play-by-play ----------

/**
 * Expected points by minute t, split into normal flow and the late-game fouling bonus.
 * The ~8 extra 2nd-half points mostly arrive in the final minutes (our backtest), so we
 * spread them over the last `foulWindow` minutes instead of the whole half.
 */
export function expectedPointsParts(t, total, L, cfg = CONFIG) {
  const d = cfg.halfDiff * (total / 140);
  const r0 = (total - d) / L;
  const W = cfg.foulWindow;
  const base = r0 * Math.min(t, L) + Math.max(0, t - L) * (total / L); // OT at average pace
  const foul = d * clamp((Math.min(t, L) - (L - W)) / W, 0, 1);
  return { base, foul };
}
export function expectedPointsBy(t, total, L, cfg = CONFIG) {
  const p = expectedPointsParts(t, total, L, cfg);
  return p.base + p.foul;
}
/** Fouling only happens when the game is close: scale the bonus by the current margin. */
export function foulFactor(absMargin, rem, cfg = CONFIG) {
  const close = clamp((cfg.foulMaxMargin - absMargin) / (cfg.foulMaxMargin - cfg.foulFullMargin), 0, 1) * cfg.foulCloseBoost;
  const w = rem / (rem + 6); // far from the end, the margin can still change a lot
  return w * 1 + (1 - w) * close;
}

/** Shooting splits per team from plays (so they work at any replay point). */
export function shootingSplits(plays, teamId) {
  const s = { fga: 0, fgm: 0, tpa: 0, tpm: 0, fta: 0, ftm: 0 };
  for (const p of plays) {
    if (!p.shooting || p.teamId !== teamId) continue;
    if (p.pa === 1) { s.fta++; if (p.scoring) s.ftm++; }
    else { s.fga++; if (p.scoring) s.fgm++; if (p.pa === 3) { s.tpa++; if (p.scoring) s.tpm++; } }
  }
  return s;
}

/** Momentum: time-decayed scoring margin, scaled to -100 (away) .. +100 (home). */
export function momentum(plays, nowT, cfg = CONFIG) {
  let ph = 0, pa = 0, m = 0;
  for (const p of plays) {
    const dh = p.home - ph, da = p.away - pa;
    if (dh || da) m += Math.pow(0.5, (nowT - p.t) / cfg.momentumHalfLife) * (dh - da);
    ph = p.home; pa = p.away;
  }
  return Math.round(Math.tanh(m / 6) * 100);
}

/** Scoring events: [{t, team:'home'|'away', pts, home, away}] */
export function scoringEvents(plays) {
  const ev = []; let ph = 0, pa = 0;
  for (const p of plays) {
    const dh = p.home - ph, da = p.away - pa;
    if (dh > 0) ev.push({ t: p.t, team: 'home', pts: dh, home: p.home, away: p.away });
    if (da > 0) ev.push({ t: p.t, team: 'away', pts: da, home: p.home, away: p.away });
    ph = p.home; pa = p.away;
  }
  return ev;
}

/** Current unanswered run, best run each side, and last-N-minutes split. */
export function runs(plays, nowT, windowMin = 4) {
  const ev = scoringEvents(plays);
  let current = null;
  if (ev.length) {
    const team = ev[ev.length - 1].team; let pts = 0, start = ev[ev.length - 1].t;
    for (let i = ev.length - 1; i >= 0 && ev[i].team === team; i--) { pts += ev[i].pts; start = ev[i].t; }
    current = { team, pts, minutes: nowT - start };
  }
  const best = { home: 0, away: 0 };
  let cur = null, acc = 0;
  for (const e of ev) {
    if (e.team === cur) acc += e.pts; else { cur = e.team; acc = e.pts; }
    best[cur] = Math.max(best[cur], acc);
  }
  const recent = { home: 0, away: 0 };
  for (const e of ev) if (e.t > nowT - windowMin) recent[e.team] += e.pts;
  return { current, best, recent, windowMin };
}

// ---------- projection ----------

/**
 * @param game  normalized game (see espn.js)
 * @param opts  { cutoff: index into plays or null for live, pregame: {total, margin, source},
 *                season: {home:{threePct}, away:{threePct}}, cfg }
 */
export function analyze(game, opts) {
  const cfg = { ...CONFIG, ...(opts.cfg || {}) };
  const replay = opts.cutoff != null && opts.cutoff < game.plays.length - 1;
  const plays = replay ? game.plays.slice(0, opts.cutoff + 1) : game.plays;
  const last = plays[plays.length - 1];
  const L = game.regMinutes;

  let nowT, home, away, period;
  if (replay) { nowT = last.t; home = last.home; away = last.away; period = last.period; }
  else { nowT = game.status.elapsed; home = game.home.score; away = game.away.score; period = game.status.period; }
  const length = game.lengthAt(Math.max(period || 1, 1));
  const rem = game.status.state === 'post' && !replay ? 0 : Math.max(0, length - nowT);
  const e = Math.max(nowT, 0);

  const { total: T0, margin: M0 } = opts.pregame;
  const curTotal = home + away, curMargin = home - away;

  // 3-point luck: makes above/below the team's normal 3P% don't carry forward.
  const split = { home: shootingSplits(plays, game.home.id), away: shootingSplits(plays, game.away.id) };
  const luck = {};
  for (const side of ['home', 'away']) {
    const p3 = opts.season?.[side]?.threePct ?? cfg.leagueThreePct;
    const s = split[side];
    luck[side] = cfg.threeRegress * (s.tpm - s.tpa * p3) * 3;
  }
  const adjTotal = curTotal - luck.home - luck.away;
  const adjMargin = curMargin - (luck.home - luck.away);

  // Total: compare luck-adjusted scoring to what the pregame total expected by now.
  const now = expectedPointsParts(e, T0, L, cfg), end = expectedPointsParts(e + rem, T0, L, cfg);
  const expSoFar = now.base + now.foul;
  const ratio = expSoFar > 3 ? adjTotal / expSoFar : 1;
  const wPace = e / (e + cfg.paceTrustMinutes);
  const paceRatio = wPace * ratio + (1 - wPace);
  const foulPts = (end.foul - now.foul) * foulFactor(Math.abs(curMargin), rem, cfg);
  const projTotal = curTotal + (end.base - now.base) * paceRatio + foulPts;

  // Margin: Brownian motion with drift (Stern 1994). Drift = blend of pregame spread and in-game rate.
  const pgRate = M0 / L;
  const inRate = e > 0.5 ? adjMargin / e : pgRate;
  const wM = e / (e + cfg.marginTrustMinutes);
  const driftRate = wM * inRate + (1 - wM) * pgRate;
  const restore = -Math.sign(curMargin) * Math.min(Math.abs(curMargin) * cfg.restoring * rem, Math.abs(curMargin) * 0.35);
  const mom = momentum(plays, nowT, cfg);
  const tilt = cfg.momentumWeight * (mom / 100) * Math.min(rem, 3) / 3;
  const projMargin = curMargin + driftRate * rem + restore + tilt;

  // Uncertainty = random-walk part (shrinks with sqrt of time left) + a floor for
  // late-game chaos and model error. Both fitted to a 399-game backtest (RESEARCH.md).
  const frac = Math.sqrt(Math.max(rem, 0) / L);
  const fade = Math.min(1, rem / cfg.floorFadeMinutes);
  const sdM = Math.max(cfg.marginSD * frac + cfg.marginSDFloor * fade, 0.01);
  const sdT = Math.max(cfg.totalSD * frac + cfg.totalSDFloor * fade, 0.01);
  const winHome = rem === 0 ? (curMargin > 0 ? 1 : curMargin < 0 ? 0 : 0.5) : normCdf(projMargin / sdM);

  const espnWP = replay ? game.wpByPlay[last.id] : game.wpLatest;

  return {
    replay, nowT, rem, period, length, L, home, away, curTotal, curMargin,
    split, luck, mom, runs: runs(plays, nowT), plays,
    pregame: opts.pregame,
    proj: {
      total: projTotal, margin: projMargin, sdM, sdT, winHome,
      homeScore: (projTotal + projMargin) / 2, awayScore: (projTotal - projMargin) / 2,
      paceRatio, driftRate, restore, tilt,
    },
    espnWP,
  };
}

// ---------- bets ----------

/**
 * lines: {spreadHome, spreadHomeOdds, spreadAwayOdds, total, overOdds, underOdds, mlHome, mlAway}
 * Returns every option ranked by expected value, plus the recommendation.
 */
export function evaluateBets(a, lines, names, cfg = CONFIG) {
  const { margin, total, sdM, sdT, winHome } = a.proj;
  const opts = [];
  const add = (market, side, label, line, odds, p) => {
    if (odds == null || !isFinite(odds) || p == null || !isFinite(p)) return;
    const dec = americanToDecimal(odds);
    const ev = p * dec - 1;
    const b = dec - 1;
    const kelly = Math.min(cfg.maxStake, Math.max(0, (b * p - (1 - p)) / b) * cfg.kellyFraction);
    opts.push({ market, side, label, line, odds, p, implied: 1 / dec, ev, kelly });
  };
  if (a.rem <= 0) return { options: [], best: null, verdict: 'final' };

  if (isFinite(lines.spreadHome)) {
    const pHome = normCdf((margin + lines.spreadHome) / sdM);
    add('spread', 'home', `${names.home} ${fmtLine(lines.spreadHome)}`, lines.spreadHome, lines.spreadHomeOdds ?? -110, pHome);
    add('spread', 'away', `${names.away} ${fmtLine(-lines.spreadHome)}`, -lines.spreadHome, lines.spreadAwayOdds ?? -110, 1 - pHome);
  }
  if (isFinite(lines.total)) {
    const pOver = normCdf((total - lines.total) / sdT);
    add('total', 'over', `Over ${lines.total}`, lines.total, lines.overOdds ?? -110, pOver);
    add('total', 'under', `Under ${lines.total}`, lines.total, lines.underOdds ?? -110, 1 - pOver);
  }
  if (isFinite(lines.mlHome)) add('moneyline', 'home', `${names.home} ML`, null, lines.mlHome, winHome);
  if (isFinite(lines.mlAway)) add('moneyline', 'away', `${names.away} ML`, null, lines.mlAway, 1 - winHome);

  opts.sort((x, y) => y.ev - x.ev);
  const best = opts[0] || null;
  let verdict = 'none';
  if (best) verdict = best.ev >= cfg.strongEV ? 'strong' : best.ev >= cfg.minEV ? 'lean' : 'pass';
  return { options: opts, best, verdict };
}

/** Grade a bet against the final score (used when replaying finished games). */
export function gradeBet(bet, finalMargin, finalTotal) {
  let x;
  if (bet.market === 'spread') x = bet.side === 'home' ? finalMargin + bet.line : -finalMargin + bet.line;
  else if (bet.market === 'total') x = bet.side === 'over' ? finalTotal - bet.line : bet.line - finalTotal;
  else x = bet.side === 'home' ? finalMargin : -finalMargin;
  return x > 0 ? 'win' : x < 0 ? 'loss' : 'push';
}

export const fmtLine = (x) => (x > 0 ? `+${x}` : x === 0 ? 'PK' : `${x}`);
export const fmtOdds = (x) => (x > 0 ? `+${x}` : `${x}`);

/** Plain-English reasons behind the projection. */
export function explain(a, names) {
  const r = [];
  const lead = a.curMargin > 0 ? names.home : names.away;
  const pace = (a.proj.paceRatio - 1) * 100;
  if (Math.abs(pace) >= 3) r.push(`Scoring is running ${Math.abs(pace).toFixed(0)}% ${pace > 0 ? 'above' : 'below'} the pregame total's pace (after removing 3-point luck), so the projected total moves ${pace > 0 ? 'up' : 'down'}.`);
  for (const side of ['home', 'away']) {
    const l = a.luck[side];
    if (Math.abs(l) >= 3) r.push(`${names[side]} ${l > 0 ? 'are shooting hot' : 'are shooting cold'} from three (${a.split[side].tpm}/${a.split[side].tpa}). About ${Math.abs(l).toFixed(0)} points of that is treated as luck that won't repeat.`);
  }
  if (Math.abs(a.proj.restore) >= 0.5) r.push(`Leads tend to shrink a little (trailing teams press, leaders slow down). This takes ${Math.abs(a.proj.restore).toFixed(1)} points off ${lead}'s lead.`);
  const cr = a.runs.current;
  if (cr && cr.pts >= 7) r.push(`${names[cr.team]} are on a ${cr.pts}-0 run. Research shows runs predict very little, so the model doesn't chase it. If the live line moved a lot, value often sits on the other side.`);
  if (a.pregame.source) r.push(`Baseline: ${a.pregame.source} (total ${a.pregame.total.toFixed(1)}, ${names.home} by ${a.pregame.margin.toFixed(1)}).`);
  return r;
}
