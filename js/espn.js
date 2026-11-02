// ESPN's public site API. It allows browser requests (CORS *), so no server is needed.
// It's unofficial and undocumented: fields can change without notice.

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball';
export const LEAGUES = {
  'mens-college-basketball': "Men's",
  'womens-college-basketball': "Women's",
};

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`ESPN returned ${r.status}`);
  return r.json();
}

/** Accepts an ESPN game URL (any page of the game) or a bare game id. */
export function parseGameInput(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const league = /womens-college-basketball/i.test(s) ? 'womens-college-basketball' : 'mens-college-basketball';
  const m = s.match(/gameId[/=](\d{6,})/i) || s.match(/\/game\/_\/id\/(\d{6,})/i) || s.match(/^(\d{6,})$/) || s.match(/(\d{9,})/);
  return m ? { league, id: m[1] } : null;
}

export const fetchSummary = (league, id) => getJSON(`${BASE}/${league}/summary?event=${id}`);
export const fetchScoreboard = (league, yyyymmdd) =>
  // groups=50 = all of Division I (the default is only featured games)
  getJSON(`${BASE}/${league}/scoreboard?groups=50&limit=500${yyyymmdd ? `&dates=${yyyymmdd}` : ''}`);
export const fetchTeams = (league) => getJSON(`${BASE}/${league}/teams?limit=1000`);
export const fetchTeam = (league, id) => getJSON(`${BASE}/${league}/teams/${id}`);
export const fetchTeamStats = (league, id) => getJSON(`${BASE}/${league}/teams/${id}/statistics`);

export function parseClock(v) {
  if (v == null) return 0;
  const s = String(v);
  if (s.includes(':')) { const [m, sec] = s.split(':'); return (+m || 0) * 60 + (+sec || 0); }
  return +s || 0;
}

/** Flatten ESPN team statistics into {name: number}. */
export function flattenTeamStats(json) {
  const out = {};
  for (const c of json?.results?.stats?.categories || []) for (const s of c.stats || []) out[s.name] = s.value ?? +s.displayValue;
  return out;
}

/** Season numbers the model uses, regressed toward average early in the season. */
export function seasonProfile(json, cfg = { leagueThreePct: 0.34 }) {
  const s = flattenTeamStats(json);
  const gp = s.gamesPlayed || 0;
  const raw3 = s.threePointFieldGoalPct > 1 ? s.threePointFieldGoalPct / 100 : s.threePointFieldGoalPct;
  const threePct = gp && raw3 ? (gp * raw3 + 5 * cfg.leagueThreePct) / (gp + 5) : cfg.leagueThreePct;
  return { gamesPlayed: gp, threePct, avgPoints: s.avgPoints || null, raw: s };
}

/** Turn ESPN's summary JSON into the shape the model and UI use. */
export function normalizeGame(d, league) {
  const comp = d.header.competitions[0];
  const reg = d.format?.regulation || {};
  const periods = reg.periods || 2;
  const periodMin = (reg.clock || 1200) / 60;
  const otMin = (d.format?.overtime?.clock || 300) / 60;
  const L = periods * periodMin;
  const toElapsed = (period, clockSec) =>
    period <= periods
      ? (period - 1) * periodMin + periodMin - clockSec / 60
      : L + (period - periods - 1) * otMin + otMin - clockSec / 60;
  const lengthAt = (period) => (period <= periods ? L : L + (period - periods) * otMin);

  const team = (c) => ({
    id: c.team.id,
    name: c.team.displayName,
    short: c.team.shortDisplayName || c.team.location || c.team.name,
    abbr: c.team.abbreviation,
    color: '#' + (c.team.color || '6b7280'),
    alt: '#' + (c.team.alternateColor || 'd1d5db'),
    logo: c.team.logos?.[0]?.href || c.team.logo || '',
    score: Number(c.score) || 0,
    record: c.record?.[0]?.displayValue || '',
    rank: c.curatedRank?.current && c.curatedRank.current <= 25 ? c.curatedRank.current : null,
  });
  const home = team(comp.competitors.find((c) => c.homeAway === 'home'));
  const away = team(comp.competitors.find((c) => c.homeAway === 'away'));

  const plays = (d.plays || []).map((p) => {
    const period = p.period?.number || 1;
    return {
      id: p.id,
      period,
      clock: p.clock?.displayValue || '',
      t: toElapsed(period, parseClock(p.clock?.displayValue)),
      home: Number(p.homeScore) || 0,
      away: Number(p.awayScore) || 0,
      teamId: p.team?.id,
      text: p.text || '',
      scoring: !!p.scoringPlay,
      shooting: !!p.shootingPlay,
      pa: p.pointsAttempted || 0,
    };
  });
  const last = plays[plays.length - 1];

  const st = comp.status || {};
  const state = st.type?.state || 'pre';
  const period = st.period || last?.period || 1;
  const clockSec = st.displayClock != null ? parseClock(st.displayClock) : parseClock(last?.clock);
  const elapsed = state === 'pre' ? 0 : state === 'post' ? lengthAt(period) : toElapsed(period, clockSec);

  // Betting line (ESPN's pickcenter, usually DraftKings). Spread is stored from the home side.
  let odds = null;
  const pc = (d.pickcenter || [])[0];
  if (pc) {
    let spreadHome = null;
    const det = (pc.details || '').trim();
    const m = det.match(/^(\S+)\s+([+-]?\d+(\.\d+)?)$/);
    if (/^even$/i.test(det)) spreadHome = 0;
    else if (m) {
      const n = Math.abs(+m[2]);
      if (m[1] === home.abbr) spreadHome = -n;
      else if (m[1] === away.abbr) spreadHome = n;
    }
    if (spreadHome == null && typeof pc.spread === 'number') spreadHome = pc.spread;
    odds = {
      provider: pc.provider?.name || 'Sportsbook',
      details: det,
      spreadHome,
      spreadHomeOdds: pc.homeTeamOdds?.spreadOdds ?? null,
      spreadAwayOdds: pc.awayTeamOdds?.spreadOdds ?? null,
      total: typeof pc.overUnder === 'number' ? pc.overUnder : null,
      overOdds: pc.overOdds ?? null,
      underOdds: pc.underOdds ?? null,
      mlHome: pc.homeTeamOdds?.moneyLine ?? null,
      mlAway: pc.awayTeamOdds?.moneyLine ?? null,
    };
  }

  const wp = d.winprobability || [];
  const wpByPlay = {};
  for (const w of wp) wpByPlay[w.playId] = w.homeWinPercentage;

  return {
    id: comp.id,
    league,
    neutral: !!comp.neutralSite,
    date: comp.date,
    venue: d.gameInfo?.venue?.fullName || '',
    home, away, plays, odds,
    regMinutes: L, periods, periodMin, lengthAt,
    status: {
      state,
      detail: st.type?.shortDetail || st.type?.detail || '',
      name: st.type?.name || '',
      period,
      elapsed,
    },
    wpByPlay,
    wpLatest: wp.length ? wp[wp.length - 1].homeWinPercentage : null,
    final: state === 'post' ? { margin: home.score - away.score, total: home.score + away.score } : null,
    espnUrl: `https://www.espn.com/${league}/game/_/gameId/${comp.id}`,
  };
}

/** Pregame expectation: betting line if ESPN has one, else season scoring averages. */
export function pregameBaseline(game, season, cfg) {
  const o = game.odds;
  if (o && isFinite(o.total) && isFinite(o.spreadHome)) {
    return { total: o.total, margin: -o.spreadHome, source: `${o.provider} line (${o.details}, O/U ${o.total})` };
  }
  const hp = season?.home?.avgPoints, ap = season?.away?.avgPoints;
  const hca = game.neutral ? 0 : cfg.homeCourt;
  if (hp && ap) {
    return { total: (hp + ap) * 0.97, margin: (hp - ap) / 2 + hca, source: 'season scoring averages (no betting line found)' };
  }
  const total = game.periods === 4 ? 130 : 142;
  return { total, margin: hca, source: 'league averages (no line or season stats found)' };
}
