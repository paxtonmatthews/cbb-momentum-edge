import { fetchTeams, fetchTeam, fetchTeamStats } from './espn.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let teams = [];

async function loadTeams() {
  const league = $('#league').value;
  $('#teams').innerHTML = '<p class="muted">Loading…</p>';
  try {
    const d = await fetchTeams(league);
    teams = (d.sports?.[0]?.leagues?.[0]?.teams || []).map((t) => t.team).sort((a, b) => a.displayName.localeCompare(b.displayName));
    renderList();
  } catch (e) {
    $('#teams').innerHTML = `<p class="error">Couldn't load teams (${esc(e.message)}).</p>`;
  }
}

function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  const list = teams.filter((t) => !q || `${t.displayName} ${t.abbreviation} ${t.location}`.toLowerCase().includes(q));
  $('#count').textContent = `(${list.length})`;
  $('#teams').innerHTML = list.map((t) => `<button class="teamcard" data-id="${t.id}">
    <img src="${esc(t.logos?.[0]?.href || '')}" alt="" width="28" height="28" loading="lazy"><span>${esc(t.displayName)}</span></button>`).join('') || '<p class="muted">No matches.</p>';
}

const PICK = [
  ['avgPoints', 'Points / game'], ['fieldGoalPct', 'FG %'], ['threePointFieldGoalPct', '3P %'],
  ['avgThreePointFieldGoalsAttempted', '3PA / game'], ['freeThrowPct', 'FT %'], ['avgFreeThrowsAttempted', 'FTA / game'],
  ['avgOffensiveRebounds', 'Off. reb / game'], ['avgDefensiveRebounds', 'Def. reb / game'], ['avgAssists', 'Assists / game'],
  ['avgTurnovers', 'Turnovers / game'], ['avgSteals', 'Steals / game'], ['avgBlocks', 'Blocks / game'],
  ['assistTurnoverRatio', 'Ast / TO'], ['gamesPlayed', 'Games'],
];

async function showTeam(id) {
  const league = $('#league').value;
  const el = $('#team');
  el.hidden = false;
  el.innerHTML = '<p class="muted">Loading team…</p>';
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const [info, stats] = await Promise.all([fetchTeam(league, id), fetchTeamStats(league, id).catch(() => null)]);
    const t = info.team;
    const flat = {};
    for (const c of stats?.results?.stats?.categories || []) for (const s of c.stats || []) flat[s.name] = s.displayValue;
    const rec = t.record?.items?.[0]?.summary;
    const season = stats?.season?.displayName || stats?.requestedSeason?.displayName || '';
    const cells = PICK.filter(([k]) => flat[k] != null).map(([k, label]) => `<div class="stat"><b>${esc(flat[k])}</b><span>${label}</span></div>`).join('');
    el.innerHTML = `
      <div class="card-head">
        <div class="team"><img src="${esc(t.logos?.[0]?.href || '')}" alt="" width="56" height="56">
          <div><h2>${esc(t.displayName)}</h2><div class="muted small">${esc(t.standingSummary || '')}${rec ? ` · ${esc(rec)}` : ''}</div></div></div>
        <a href="https://www.espn.com/${league}/team/schedule/_/id/${t.id}" target="_blank" rel="noopener">Schedule on ESPN ↗</a>
      </div>
      <p class="muted small">Season stats ${esc(season)}</p>
      ${cells ? `<div class="statgrid">${cells}</div>` : '<p class="muted">No season stats yet.</p>'}`;
  } catch (e) {
    el.innerHTML = `<p class="error">Couldn't load this team (${esc(e.message)}).</p>`;
  }
}

$('#search').addEventListener('input', renderList);
$('#league').addEventListener('change', () => { $('#team').hidden = true; loadTeams(); });
$('#teams').addEventListener('click', (e) => { const b = e.target.closest('.teamcard'); if (b) showTeam(b.dataset.id); });
loadTeams();
