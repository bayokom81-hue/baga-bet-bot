// Calibration automatique des poids des modèles selon les résultats du backtesting
// Lit les prédictions historiques, calcule les poids optimaux, les stocke dans Supabase

const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

// Poids par défaut (avant accumulation de données)
const DEFAULT_WEIGHTS = { poisson: 0.55, elo: 0.35, groq: 0.10 };
const MIN_MATCHES_TO_CALIBRATE = 20; // seuil minimum avant d'ajuster

let cachedWeights = null;
let weightsCachedAt = 0;
const WEIGHTS_CACHE_TTL = 6 * 60 * 60 * 1000; // 6h

// ── Helpers Supabase ───────────────────────────────────────────────

async function sbGet(key) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const r = await axios.get(
      `${SUPABASE_URL}/rest/v1/bot_data?key=eq.${key}&select=value`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, timeout: 10000 }
    );
    return r.data?.[0]?.value || null;
  } catch (e) { return null; }
}

async function sbSet(key, value) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await axios.post(
      `${SUPABASE_URL}/rest/v1/bot_data`,
      { key, value, updated_at: new Date().toISOString() },
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        },
        timeout: 10000,
      }
    );
  } catch (e) { console.error('calibration sbSet:', e.message); }
}

async function sbQuery(table, filters = '', select = '*') {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  try {
    const r = await axios.get(
      `${SUPABASE_URL}/rest/v1/${table}?${filters}&select=${select}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, timeout: 10000 }
    );
    return r.data || [];
  } catch (e) { return []; }
}

// ── Obtenir les poids courants (avec cache) ────────────────────────

async function getCurrentWeights() {
  // Cache mémoire valide
  if (cachedWeights && Date.now() - weightsCachedAt < WEIGHTS_CACHE_TTL) {
    return cachedWeights;
  }
  // Charger depuis Supabase
  const stored = await sbGet('model_weights');
  if (stored && typeof stored === 'object' && stored.poisson) {
    cachedWeights = stored;
    weightsCachedAt = Date.now();
    return stored;
  }
  return DEFAULT_WEIGHTS;
}

// ── Calibration : ajuster les poids selon les performances ─────────

async function calibrateWeights() {
  // Récupérer les 60 derniers matchs résolus
  const rows = await sbQuery(
    'predictions',
    `actual_result=not.is.null&order=match_date.desc&limit=60`,
    'correct,brier_score,p_home,p_draw,p_away,actual_result,model_weights'
  );

  if (rows.length < MIN_MATCHES_TO_CALIBRATE) {
    console.log(`[calibration] Seulement ${rows.length} matchs résolus, calibration reportée (min ${MIN_MATCHES_TO_CALIBRATE})`);
    return getCurrentWeights();
  }

  // Calculer le Brier score actuel
  const avgBrier = rows.reduce((a, r) => a + (r.brier_score || 0.5), 0) / rows.length;
  const accuracy = rows.filter(r => r.correct).length / rows.length;

  // Analyser les patterns d'erreur
  // Si le modèle surestime les victoires à domicile → réduire poids Poisson
  // Si le modèle sous-estime les nuls → augmenter légèrement le composant Elo
  const predictedHome = rows.filter(r => r.p_home > r.p_draw && r.p_home > r.p_away);
  const predictedDraw = rows.filter(r => r.p_draw > r.p_home && r.p_draw > r.p_away);
  const actualHomeWin = rows.filter(r => r.actual_result === '1').length / rows.length;
  const actualDraw = rows.filter(r => r.actual_result === 'N').length / rows.length;

  const homeAccuracy = predictedHome.filter(r => r.correct).length / Math.max(predictedHome.length, 1);
  const drawAccuracy = predictedDraw.filter(r => r.correct).length / Math.max(predictedDraw.length, 1);

  // Ajustement progressif (±5% max par calibration)
  const current = await getCurrentWeights();
  let { poisson, elo, groq } = current;

  // Si homeAccuracy faible → Poisson surestime l'avantage domicile → réduire
  if (homeAccuracy < 0.45 && poisson > 0.35) poisson = parseFloat((poisson - 0.03).toFixed(2));
  if (homeAccuracy > 0.65 && poisson < 0.65) poisson = parseFloat((poisson + 0.03).toFixed(2));

  // Si drawAccuracy faible → Elo capture mieux l'équilibre → augmenter
  if (drawAccuracy < 0.30 && elo < 0.50) elo = parseFloat((elo + 0.02).toFixed(2));
  if (drawAccuracy > 0.50 && elo > 0.25) elo = parseFloat((elo - 0.02).toFixed(2));

  // Normaliser pour que la somme = 1
  const total = poisson + elo + groq;
  const newWeights = {
    poisson: parseFloat((poisson / total).toFixed(3)),
    elo: parseFloat((elo / total).toFixed(3)),
    groq: parseFloat((1 - poisson / total - elo / total).toFixed(3)),
  };

  // Sauvegarder dans Supabase
  await sbSet('model_weights', newWeights);
  cachedWeights = newWeights;
  weightsCachedAt = Date.now();

  console.log(`[calibration] Poids mis à jour : Poisson=${newWeights.poisson} Elo=${newWeights.elo} Groq=${newWeights.groq} | Précision=${(accuracy*100).toFixed(1)}% | Brier=${avgBrier.toFixed(4)}`);
  return newWeights;
}

// ── Combiner les probabilités avec les poids courants ─────────────

async function combineProbabilities(poissonProbs, eloProbs) {
  const w = await getCurrentWeights();

  const pHome = poissonProbs.pHome * w.poisson + eloProbs.pHome * w.elo + 33.3 * w.groq;
  const pDraw = poissonProbs.pDraw * w.poisson + eloProbs.pDraw * w.elo + 33.3 * w.groq;
  const pAway = poissonProbs.pAway * w.poisson + eloProbs.pAway * w.elo + 33.3 * w.groq;

  // Normaliser
  const total = pHome + pDraw + pAway;
  return {
    pHome: parseFloat((pHome / total * 100).toFixed(1)),
    pDraw: parseFloat((pDraw / total * 100).toFixed(1)),
    pAway: parseFloat((pAway / total * 100).toFixed(1)),
    weights: w,
  };
}

module.exports = { getCurrentWeights, calibrateWeights, combineProbabilities, DEFAULT_WEIGHTS };
