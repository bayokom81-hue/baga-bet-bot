// Collecte des statistiques historiques depuis football-data.org
// Stockage dans Supabase : match_stats + team_ratings (avec mise à jour Elo)

const axios = require('axios');
const { updateElo, DEFAULT_ELO } = require('./elo');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY || '';

// Ligues couvertes par football-data.org (tier gratuit)
const FD_COMPETITIONS = [
  'PL', 'PD', 'BL1', 'SA', 'FL1',  // Big 5
  'CL', 'EL',                        // Coupes Europe
  'ELC', 'BSA', 'CLI',               // Championship, Brasileirão, Libertadores
  'DED', 'PPL',                      // Eredivisie, Primeira Liga
];

// ── Helpers Supabase ───────────────────────────────────────────────

async function sbQuery(table, filters = '', select = '*') {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  try {
    const r = await axios.get(
      `${SUPABASE_URL}/rest/v1/${table}?${filters}&select=${select}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, timeout: 10000 }
    );
    return r.data || [];
  } catch (e) { console.error(`sbQuery(${table}):`, e.message); return []; }
}

async function sbUpsert(table, rows) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !rows.length) return;
  try {
    await axios.post(
      `${SUPABASE_URL}/rest/v1/${table}`,
      rows,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        },
        timeout: 15000,
      }
    );
  } catch (e) { console.error(`sbUpsert(${table}):`, e.message); }
}

// ── Récupération des matchs terminés depuis football-data.org ──────

async function fetchFinishedMatches(dateFrom, dateTo) {
  if (!FOOTBALL_DATA_KEY) return [];
  try {
    const r = await axios.get(
      `https://api.football-data.org/v4/matches?dateFrom=${dateFrom}&dateTo=${dateTo}&status=FINISHED`,
      { headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY }, timeout: 15000 }
    );
    return r.data?.matches || [];
  } catch (e) { console.error('FD fetchFinished:', e.message); return []; }
}

// ── Récupération des stats d'une équipe depuis Supabase ─────────────

async function getTeamStats(team) {
  const rows = await sbQuery('team_ratings', `team=eq.${encodeURIComponent(team)}`, '*');
  if (rows.length > 0) return rows[0];
  return {
    team,
    elo: DEFAULT_ELO,
    matches_played: 0,
    goals_scored_total: 0,
    goals_conceded_total: 0,
    home_goals_scored: 0,
    home_goals_conceded: 0,
    away_goals_scored: 0,
    away_goals_conceded: 0,
    wins: 0,
    draws: 0,
    losses: 0,
  };
}

// ── Traitement d'un match terminé ──────────────────────────────────

async function processMatch(match) {
  const { homeTeam, awayTeam, score, competition, utcDate } = match;
  if (!score?.fullTime) return;

  const homeGoals = score.fullTime.home;
  const awayGoals = score.fullTime.away;
  if (homeGoals == null || awayGoals == null) return;

  const matchDate = utcDate?.substring(0, 10);
  const homeName = homeTeam.name;
  const awayName = awayTeam.name;

  // Vérifier si ce match est déjà en base (éviter les doublons)
  const existing = await sbQuery(
    'match_stats',
    `home_team=eq.${encodeURIComponent(homeName)}&away_team=eq.${encodeURIComponent(awayName)}&match_date=eq.${matchDate}`,
    'id'
  );
  if (existing.length > 0) return; // déjà traité

  const [homeStats, awayStats] = await Promise.all([
    getTeamStats(homeName),
    getTeamStats(awayName),
  ]);

  const homeEloBefore = homeStats.elo;
  const awayEloBefore = awayStats.elo;

  // Mise à jour Elo
  const { newHome, newAway } = updateElo(homeEloBefore, awayEloBefore, homeGoals, awayGoals);

  const result = homeGoals > awayGoals ? 'home' : homeGoals === awayGoals ? 'draw' : 'away';

  // Insérer le match dans match_stats
  await sbUpsert('match_stats', [{
    home_team: homeName,
    away_team: awayName,
    home_goals: homeGoals,
    away_goals: awayGoals,
    competition: competition?.name || '',
    match_date: matchDate,
    home_elo_before: homeEloBefore,
    away_elo_before: awayEloBefore,
  }]);

  // Mettre à jour team_ratings pour les deux équipes
  const homeUpdate = {
    team: homeName,
    elo: newHome,
    matches_played: homeStats.matches_played + 1,
    goals_scored_total: homeStats.goals_scored_total + homeGoals,
    goals_conceded_total: homeStats.goals_conceded_total + awayGoals,
    home_goals_scored: homeStats.home_goals_scored + homeGoals,
    home_goals_conceded: homeStats.home_goals_conceded + awayGoals,
    away_goals_scored: homeStats.away_goals_scored,
    away_goals_conceded: homeStats.away_goals_conceded,
    wins: homeStats.wins + (result === 'home' ? 1 : 0),
    draws: homeStats.draws + (result === 'draw' ? 1 : 0),
    losses: homeStats.losses + (result === 'away' ? 1 : 0),
    updated_at: new Date().toISOString(),
  };

  const awayUpdate = {
    team: awayName,
    elo: newAway,
    matches_played: awayStats.matches_played + 1,
    goals_scored_total: awayStats.goals_scored_total + awayGoals,
    goals_conceded_total: awayStats.goals_conceded_total + homeGoals,
    home_goals_scored: awayStats.home_goals_scored,
    home_goals_conceded: awayStats.home_goals_conceded,
    away_goals_scored: awayStats.away_goals_scored + awayGoals,
    away_goals_conceded: awayStats.away_goals_conceded + homeGoals,
    wins: awayStats.wins + (result === 'away' ? 1 : 0),
    draws: awayStats.draws + (result === 'draw' ? 1 : 0),
    losses: awayStats.losses + (result === 'home' ? 1 : 0),
    updated_at: new Date().toISOString(),
  };

  await sbUpsert('team_ratings', [homeUpdate, awayUpdate]);
  console.log(`[stats] ${homeName} ${homeGoals}-${awayGoals} ${awayName} | Elo: ${homeEloBefore}→${newHome} / ${awayEloBefore}→${newAway}`);
}

// ── Collecte principale : derniers N jours ─────────────────────────

async function collectRecentMatches(daysBack = 7) {
  if (!FOOTBALL_DATA_KEY) {
    console.log('[stats] FOOTBALL_DATA_KEY manquant, collecte ignorée');
    return { processed: 0 };
  }

  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - daysBack);

  const dateFrom = from.toISOString().substring(0, 10);
  const dateTo = now.toISOString().substring(0, 10);

  console.log(`[stats] Collecte matchs terminés ${dateFrom} → ${dateTo}`);

  const matches = await fetchFinishedMatches(dateFrom, dateTo);
  console.log(`[stats] ${matches.length} matchs terminés trouvés`);

  let processed = 0;
  for (const match of matches) {
    await processMatch(match);
    processed++;
  }

  console.log(`[stats] ${processed} matchs traités`);
  return { processed, dateFrom, dateTo };
}

// ── Récupérer les stats d'une équipe pour le moteur Poisson ─────────

async function getTeamStatsForPrediction(teamName) {
  const stats = await getTeamStats(teamName);
  const m = stats.matches_played || 0;
  return {
    team: stats.team,
    elo: stats.elo,
    matches: m,
    goalsScored: m > 0 ? stats.goals_scored_total / m : 1.35,
    goalsConceded: m > 0 ? stats.goals_conceded_total / m : 1.35,
    homeGoalsScored: stats.home_goals_scored || 0,
    awayGoalsScored: stats.away_goals_scored || 0,
    form: m > 0 ? `${stats.wins}V-${stats.draws}N-${stats.losses}D` : 'Inconnu',
    hasData: m >= 3,
  };
}

module.exports = { collectRecentMatches, getTeamStatsForPrediction, getTeamStats };
