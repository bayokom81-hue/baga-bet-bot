// Backtesting : enregistre chaque prédiction, la résout après le match, calcule les stats

const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY || '';

// ── Helpers Supabase ───────────────────────────────────────────────

async function sbInsert(table, rows) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !rows.length) return;
  try {
    await axios.post(`${SUPABASE_URL}/rest/v1/${table}`, rows, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      timeout: 15000,
    });
  } catch (e) { console.error(`sbInsert(${table}):`, e.message); }
}

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

async function sbUpdate(table, filters, data) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await axios.patch(
      `${SUPABASE_URL}/rest/v1/${table}?${filters}`,
      data,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        timeout: 10000,
      }
    );
  } catch (e) { console.error(`sbUpdate(${table}):`, e.message); }
}

// ── Enregistrer les prédictions d'un coupon ────────────────────────

async function savePredictions(couponMatches, matchDate) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  const date = matchDate || new Date().toISOString().substring(0, 10);

  const rows = couponMatches
    .filter(m => m.confidence && m.hasStats) // uniquement les matchs avec vraies probas
    .map(m => ({
      home_team: m.home,
      away_team: m.away,
      match_date: date,
      competition: m.league || '',
      lambda_home: m.lambdaHome || null,
      lambda_away: m.lambdaAway || null,
      p_home: m.prono === '1' ? m.confidence : (100 - m.confidence) / 2,
      p_draw: m.prono === 'N' ? m.confidence : (100 - m.confidence) / 3,
      p_away: m.prono === '2' ? m.confidence : (100 - m.confidence) / 2,
      p_over25: m.over25 || null,
      p_btts: m.btts || null,
      predicted_score: m.predictedScore || null,
      elo_home: m.eloHome || null,
      elo_away: m.eloAway || null,
      model_weights: { poisson: 0.55, elo: 0.35, groq: 0.10 },
    }));

  if (!rows.length) return;
  await sbInsert('predictions', rows);
  console.log(`[backtest] ${rows.length} prédictions enregistrées pour ${date}`);
}

// ── Résoudre les prédictions avec les vrais résultats ──────────────

async function resolveOldPredictions() {
  if (!FOOTBALL_DATA_KEY) return { resolved: 0 };

  // Chercher les prédictions non résolues des 7 derniers jours
  const since = new Date();
  since.setDate(since.getDate() - 7);
  const sinceStr = since.toISOString().substring(0, 10);

  const unresolved = await sbQuery(
    'predictions',
    `actual_score=is.null&match_date=gte.${sinceStr}`,
    'id,home_team,away_team,match_date,p_home,p_draw,p_away'
  );

  if (!unresolved.length) return { resolved: 0 };

  // Récupérer les matchs terminés sur la période
  const r = await axios.get(
    `https://api.football-data.org/v4/matches?dateFrom=${sinceStr}&dateTo=${new Date().toISOString().substring(0, 10)}&status=FINISHED`,
    { headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY }, timeout: 15000 }
  ).catch(e => { console.error('[backtest] FD resolve:', e.message); return { data: { matches: [] } }; });

  const finished = r.data?.matches || [];
  let resolved = 0;

  for (const pred of unresolved) {
    const match = finished.find(m =>
      m.utcDate?.substring(0, 10) === pred.match_date &&
      (m.homeTeam?.name?.includes(pred.home_team) || pred.home_team?.includes(m.homeTeam?.name?.split(' ')[0])) &&
      (m.awayTeam?.name?.includes(pred.away_team) || pred.away_team?.includes(m.awayTeam?.name?.split(' ')[0]))
    );

    if (!match?.score?.fullTime) continue;

    const hg = match.score.fullTime.home;
    const ag = match.score.fullTime.away;
    const actualResult = hg > ag ? '1' : hg === ag ? 'N' : '2';
    const actualScore = `${hg}-${ag}`;

    // Trouver le pronostic prédit (le plus probable)
    const probs = { '1': pred.p_home, 'N': pred.p_draw, '2': pred.p_away };
    const predicted = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
    const correct = predicted === actualResult;

    // Brier score : mesure de calibration (0 = parfait, 2 = pire)
    const brierScore = parseFloat((
      Math.pow((pred.p_home / 100) - (actualResult === '1' ? 1 : 0), 2) +
      Math.pow((pred.p_draw / 100) - (actualResult === 'N' ? 1 : 0), 2) +
      Math.pow((pred.p_away / 100) - (actualResult === '2' ? 1 : 0), 2)
    ).toFixed(4));

    await sbUpdate('predictions', `id=eq.${pred.id}`, {
      actual_score: actualScore,
      actual_result: actualResult,
      correct,
      brier_score: brierScore,
      resolved_at: new Date().toISOString(),
    });

    resolved++;
    console.log(`[backtest] ${pred.home_team} vs ${pred.away_team} → ${actualScore} | prédit:${predicted} réel:${actualResult} | ${correct ? '✓' : '✗'} | Brier:${brierScore}`);
  }

  return { resolved };
}

// ── Calculer les statistiques de performance ───────────────────────

async function getBacktestStats(days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().substring(0, 10);

  const rows = await sbQuery(
    'predictions',
    `match_date=gte.${sinceStr}&actual_result=not.is.null`,
    'correct,brier_score,p_home,p_draw,p_away,actual_result,match_date,competition'
  );

  if (!rows.length) return { total: 0, message: 'Pas encore de données de backtesting.' };

  const total = rows.length;
  const correct = rows.filter(r => r.correct).length;
  const accuracy = parseFloat(((correct / total) * 100).toFixed(1));

  const avgBrier = parseFloat((rows.reduce((a, r) => a + (r.brier_score || 0), 0) / total).toFixed(4));

  // Distribution par résultat réel
  const dist = { '1': 0, 'N': 0, '2': 0 };
  const correctByResult = { '1': 0, 'N': 0, '2': 0 };
  for (const r of rows) {
    if (r.actual_result) {
      dist[r.actual_result] = (dist[r.actual_result] || 0) + 1;
      if (r.correct) correctByResult[r.actual_result] = (correctByResult[r.actual_result] || 0) + 1;
    }
  }

  // Performance par compétition (top 5)
  const byComp = {};
  for (const r of rows) {
    const c = r.competition || 'Autre';
    if (!byComp[c]) byComp[c] = { total: 0, correct: 0 };
    byComp[c].total++;
    if (r.correct) byComp[c].correct++;
  }
  const topComps = Object.entries(byComp)
    .map(([name, s]) => ({ name, total: s.total, accuracy: parseFloat(((s.correct / s.total) * 100).toFixed(1)) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  // Calibration : est-ce que les 60%+ sont vrais ~60% du temps ?
  const highConf = rows.filter(r => Math.max(r.p_home, r.p_draw, r.p_away) >= 60);
  const highConfAccuracy = highConf.length > 0
    ? parseFloat(((highConf.filter(r => r.correct).length / highConf.length) * 100).toFixed(1))
    : null;

  return {
    total, correct, accuracy,
    avgBrierScore: avgBrier,
    distribution: dist,
    correctByResult,
    topComps,
    highConfPredictions: highConf.length,
    highConfAccuracy,
    period: `${days} jours`,
    since: sinceStr,
  };
}

module.exports = { savePredictions, resolveOldPredictions, getBacktestStats };
