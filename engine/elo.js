// Système de rating Elo adapté au football

const DEFAULT_ELO = 1500;
const K_FACTOR = 32;
const HOME_ADVANTAGE = 50; // points Elo d'avantage domicile

/**
 * Probabilité attendue de victoire de A contre B (avec avantage domicile si A joue à domicile).
 */
function expectedScore(eloA, eloB, isHome = false) {
  const advantage = isHome ? HOME_ADVANTAGE : 0;
  return 1 / (1 + Math.pow(10, (eloB - eloA - advantage) / 400));
}

/**
 * Calcule les nouveaux ratings Elo après un match.
 * @param {number} eloHome - Elo de l'équipe à domicile avant le match
 * @param {number} eloAway - Elo de l'équipe extérieure avant le match
 * @param {number} homeGoals
 * @param {number} awayGoals
 */
function updateElo(eloHome, eloAway, homeGoals, awayGoals) {
  const E = expectedScore(eloHome, eloAway, true);
  const S = homeGoals > awayGoals ? 1 : homeGoals === awayGoals ? 0.5 : 0;

  // Facteur K ajusté selon l'écart de buts (matchs plus décisifs = mise à jour plus forte)
  const goalDiff = Math.abs(homeGoals - awayGoals);
  const kAdjusted = goalDiff >= 3 ? K_FACTOR * 1.5 : goalDiff === 2 ? K_FACTOR * 1.25 : K_FACTOR;

  const newHome = Math.round(eloHome + kAdjusted * (S - E));
  const newAway = Math.round(eloAway + kAdjusted * (1 - S - (1 - E)));

  return { newHome, newAway, change: newHome - eloHome };
}

/**
 * Convertit le rating Elo en probabilités 1X2.
 */
function eloProbabilities(eloHome, eloAway) {
  const eHome = expectedScore(eloHome, eloAway, true);
  const eAway = expectedScore(eloAway, eloHome, false);

  // Estimation du nul basée sur la proximité des ratings
  const diff = Math.abs(eloHome - eloAway);
  const drawBase = diff < 50 ? 0.28 : diff < 100 ? 0.25 : diff < 200 ? 0.22 : 0.18;

  const pHome = eHome * (1 - drawBase);
  const pAway = eAway * (1 - drawBase);
  const pDraw = 1 - pHome - pAway;

  return {
    pHome: parseFloat((pHome * 100).toFixed(1)),
    pDraw: parseFloat((Math.max(0, pDraw) * 100).toFixed(1)),
    pAway: parseFloat((pAway * 100).toFixed(1)),
    eloHome,
    eloAway,
    eloDiff: eloHome - eloAway,
  };
}

/**
 * Classe de force d'une équipe basée sur son Elo.
 */
function eloClass(elo) {
  if (elo >= 1800) return 'Elite';
  if (elo >= 1650) return 'Forte';
  if (elo >= 1500) return 'Moyenne';
  if (elo >= 1350) return 'Faible';
  return 'Très faible';
}

module.exports = { updateElo, eloProbabilities, expectedScore, eloClass, DEFAULT_ELO };
