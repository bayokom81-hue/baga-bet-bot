// Moteur de distribution de Poisson pour prédiction de matchs de football

function factorial(n) {
  if (n <= 1) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function poissonProb(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

/**
 * Calcule toutes les probabilités d'un match à partir des lambda (buts attendus).
 * @param {number} lambdaHome - buts attendus équipe domicile
 * @param {number} lambdaAway - buts attendus équipe extérieure
 * @param {number} maxGoals - nombre max de buts considérés (défaut: 6)
 */
function matchProbabilities(lambdaHome, lambdaAway, maxGoals = 6) {
  let pHome = 0, pDraw = 0, pAway = 0;
  let pOver15 = 0, pOver25 = 0, pOver35 = 0, pUnder35 = 0, pBtts = 0;
  const scoreMatrix = [];

  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = poissonProb(lambdaHome, h) * poissonProb(lambdaAway, a);
      scoreMatrix.push({ h, a, p });

      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;

      const total = h + a;
      if (total > 1.5) pOver15 += p;
      if (total > 2.5) pOver25 += p;
      if (total > 3.5) pOver35 += p;
      if (total <= 3.5) pUnder35 += p;
      if (h > 0 && a > 0) pBtts += p;
    }
  }

  // Score le plus probable
  const topScore = scoreMatrix.sort((a, b) => b.p - a.p)[0];
  const top5Scores = scoreMatrix.slice(0, 5).map(s => ({
    score: `${s.h}-${s.a}`,
    prob: (s.p * 100).toFixed(1) + '%',
  }));

  return {
    lambdaHome,
    lambdaAway,
    pHome: parseFloat((pHome * 100).toFixed(1)),
    pDraw: parseFloat((pDraw * 100).toFixed(1)),
    pAway: parseFloat((pAway * 100).toFixed(1)),
    pOver15: parseFloat((pOver15 * 100).toFixed(1)),
    pOver25: parseFloat((pOver25 * 100).toFixed(1)),
    pOver35: parseFloat((pOver35 * 100).toFixed(1)),
    pUnder35: parseFloat((pUnder35 * 100).toFixed(1)),
    pBtts: parseFloat((pBtts * 100).toFixed(1)),
    predictedScore: `${topScore.h}-${topScore.a}`,
    top5Scores,
  };
}

/**
 * Calcule les lambda à partir des statistiques des équipes.
 * @param {object} homeStats - { goalsScored, goalsConceded, matches }
 * @param {object} awayStats - { goalsScored, goalsConceded, matches }
 * @param {number} leagueAvg - moyenne de buts par match dans la ligue (défaut: 2.7)
 * @param {number} homeAdvantage - facteur avantage domicile (défaut: 1.15)
 */
function calculateLambdas(homeStats, awayStats, leagueAvg = 2.7, homeAdvantage = 1.15) {
  const safeDiv = (a, b) => b > 0 ? a / b : 1;

  const homeAttack = safeDiv(homeStats.goalsScored, homeStats.matches) / (leagueAvg / 2);
  const homeDefense = safeDiv(homeStats.goalsConceded, homeStats.matches) / (leagueAvg / 2);
  const awayAttack = safeDiv(awayStats.goalsScored, awayStats.matches) / (leagueAvg / 2);
  const awayDefense = safeDiv(awayStats.goalsConceded, awayStats.matches) / (leagueAvg / 2);

  const lambdaHome = homeAttack * awayDefense * (leagueAvg / 2) * homeAdvantage;
  const lambdaAway = awayAttack * homeDefense * (leagueAvg / 2);

  return {
    lambdaHome: Math.max(0.1, parseFloat(lambdaHome.toFixed(3))),
    lambdaAway: Math.max(0.1, parseFloat(lambdaAway.toFixed(3))),
    homeAttack: parseFloat(homeAttack.toFixed(3)),
    homeDefense: parseFloat(homeDefense.toFixed(3)),
    awayAttack: parseFloat(awayAttack.toFixed(3)),
    awayDefense: parseFloat(awayDefense.toFixed(3)),
  };
}

module.exports = { matchProbabilities, calculateLambdas, poissonProb };
