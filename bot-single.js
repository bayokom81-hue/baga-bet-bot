require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(Boolean);
const DEMO_MODE = !FOOTBALL_API_KEY;

// Compétitions disponibles sur le plan gratuit football-data.org
const FD_COMPETITIONS = ['PL','PD','BL1','SA','FL1','CL','EC','WC','PPL','DED','BSA'];

// ── Jemenipay ─────────────────────────────────────────────────────
const JEMENI_API_KEY = process.env.JEMENI_API_KEY || '';
const JEMENI_SECRET_KEY = process.env.JEMENI_SECRET_KEY || '';
const JEMENI_TOKEN = process.env.JEMENI_TOKEN || '';
const JEMENI_MODE = process.env.JEMENI_MODE || 'sandbox';
const JEMENI_BASE = `https://jemeni.net/api/${JEMENI_MODE}`;

function jemeniSignature(method, url, body, timestamp) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const message = JEMENI_SECRET_KEY + JEMENI_API_KEY + method.toUpperCase() + url + bodyStr + timestamp;
  return crypto.createHmac('sha512', JEMENI_SECRET_KEY).update(message).digest('hex');
}

function jemeniHeaders(method, url, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'auth-apiKey': JEMENI_API_KEY,
    'auth-token': JEMENI_TOKEN,
    'auth-timestamp': timestamp,
    'auth-signature': jemeniSignature(method, url, body, timestamp),
  };
  if (JEMENI_MODE === 'sandbox') headers['sandbox'] = 'true';
  return headers;
}

async function createPayment(phone, amount, orderId) {
  const url = `${JEMENI_BASE}/payments`;
  const body = {
    customer_phone: phone,
    amount: amount,
    country_code: 'ml',
    notifiable: true,
    lang: 'fr',
    code_merchant: orderId,
  };
  const r = await axios.post(url, body, { headers: jemeniHeaders('POST', url, body) });
  return r.data;
}

async function checkPayment(paymentId) {
  const url = `${JEMENI_BASE}/payments/${paymentId}`;
  const r = await axios.get(url, { headers: jemeniHeaders('GET', url, null) });
  return r.data;
}

// Stockage temporaire des paiements en attente (en mémoire)
const pendingPayments = {};

const PLANS = {
  mensuel:     { label: 'Mensuel',     amount: 2500,  days: 30  },
  trimestriel: { label: 'Trimestriel', amount: 6000,  days: 90  },
  annuel:      { label: 'Annuel',      amount: 20000, days: 365 },
};

// Utilisateurs premium (en mémoire — persistance basique)
const premiumUsers = {};
const PROMO_DAYS = 30;
// Codes générés par l'admin : { code: { days, createdAt, usedBy: null } }
const promoCodes = {};

// Équipes favorites par utilisateur { userId: [{name, logo, competition}] }
const favoriteTeams = {};
const MAX_FAVORITES_FREE = 3;
const MAX_FAVORITES_PREMIUM = 10;

// Historique des coupons { date: {matches, coteCombinee} }
const couponHistory = {};

// Cache coupon du jour (évite de régénérer à chaque appel)
let todayCouponCache = { date: null, data: null };

if (!BOT_TOKEN) { console.error('BOT_TOKEN manquant'); process.exit(1); }

// ── API football-data.org v4 ──────────────────────────────────────
const api = axios.create({
  baseURL: 'https://api.football-data.org/v4',
  timeout: 15000,
  headers: { 'X-Auth-Token': FOOTBALL_API_KEY },
});

// Throttle : max 8 req/min (1 toutes les 7.5s) pour rester sous la limite de 10/min
let lastApiCall = 0;
async function apiGet(endpoint, params = {}) {
  const now = Date.now();
  const wait = Math.max(0, 7500 - (now - lastApiCall));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastApiCall = Date.now();
  try {
    const r = await api.get(endpoint, { params });
    return r.data;
  } catch (e) {
    const msg = e.response?.data?.message || e.message;
    console.error(`API [${endpoint}]: ${msg}`);
    // Si rate limit, attendre 15s avant prochaine requête
    if (e.response?.status === 429) {
      lastApiCall = Date.now() + 15000;
    }
    return null;
  }
}

// Alias pour les noms courants
const TEAM_ALIASES = {
  'barca': 'fc barcelona', 'barça': 'fc barcelona', 'barcelona': 'fc barcelona',
  'psg': 'paris', 'paris sg': 'paris',
  'real': 'real madrid', 'madrid': 'real madrid',
  'man city': 'manchester city', 'city': 'manchester city',
  'man utd': 'manchester united', 'man united': 'manchester united', 'united': 'manchester united',
  'arsenal': 'arsenal', 'gunners': 'arsenal',
  'chelsea': 'chelsea', 'liverpool': 'liverpool', 'spurs': 'tottenham',
  'juventus': 'juventus', 'juve': 'juventus',
  'milan': 'ac milan', 'inter': 'inter', 'roma': 'roma', 'napoli': 'napoli',
  'bayern': 'bayern', 'dortmund': 'dortmund', 'bvb': 'dortmund',
  'atletico': 'atlético', 'atletico madrid': 'atlético', 'atleti': 'atlético',
  'sevilla': 'sevilla', 'betis': 'betis', 'valencia': 'valencia',
  'ajax': 'ajax', 'psv': 'psv', 'feyenoord': 'feyenoord',
  'porto': 'porto', 'benfica': 'benfica', 'sporting': 'sporting',
};

// Cache des équipes (rechargé toutes les 24h)
const teamsCache = { data: null, loadedAt: 0 };

async function loadAllTeams() {
  if (teamsCache.data && Date.now() - teamsCache.loadedAt < 24 * 60 * 60 * 1000) {
    return teamsCache.data;
  }
  const allTeams = [];
  for (const comp of FD_COMPETITIONS) {
    try {
      const data = await apiGet(`/competitions/${comp}/teams`);
      if (data?.teams) {
        for (const t of data.teams) {
          allTeams.push({ team: t, competition: data.competition });
        }
      }
      // throttle géré par apiGet (7.5s entre chaque requête)
    } catch(e) { continue; }
  }
  teamsCache.data = allTeams;
  teamsCache.loadedAt = Date.now();
  console.log(`Cache équipes chargé: ${allTeams.length} équipes`);
  return allTeams;
}

// Chercher une équipe par nom dans toutes les compétitions gratuites
function matchTeamName(t, nameLower, resolved) {
  return t.name.toLowerCase().includes(resolved) ||
    t.shortName?.toLowerCase().includes(resolved) ||
    t.tla?.toLowerCase() === resolved ||
    t.name.toLowerCase().includes(nameLower) ||
    t.shortName?.toLowerCase().includes(nameLower);
}

async function findTeam(name) {
  const nameLower = name.toLowerCase().trim();
  const resolved = TEAM_ALIASES[nameLower] || nameLower;

  // Si le cache est déjà chargé, chercher dedans
  if (teamsCache.data?.length) {
    const found = teamsCache.data.find(({ team: t }) => matchTeamName(t, nameLower, resolved));
    if (found) return found;
  }

  // Sinon chercher directement dans les compétitions une par une
  for (const comp of FD_COMPETITIONS) {
    try {
      const data = await apiGet(`/competitions/${comp}/teams`);
      if (data?.teams) {
        // Stocker dans le cache partiel
        for (const t of data.teams) {
          if (!teamsCache.data) teamsCache.data = [];
          if (!teamsCache.data.find(e => e.team.id === t.id)) {
            teamsCache.data.push({ team: t, competition: data.competition });
          }
        }
        const found = data.teams.find(t => matchTeamName(t, nameLower, resolved));
        if (found) return { team: found, competition: data.competition };
      }
    } catch(e) { continue; }
  }
  return null;
}

// Cache matchs par compétition (2h TTL) — chargé en arrière-plan
const matchesCache = {
  today: { data: [], loadedAt: 0, dateKey: '' },
  upcoming: { data: [], loadedAt: 0, dateKey: '' },
  loading: false,
};
const MATCH_COMPS = ['PL','PD','BL1','SA','FL1','CL','PPL','DED','BSA'];

async function refreshMatchesCache() {
  if (matchesCache.loading) return;
  matchesCache.loading = true;
  try {
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1);
    const in14 = new Date(); in14.setDate(in14.getDate()+14);
    const dateFrom2 = tomorrow.toISOString().split('T')[0];
    const dateTo2 = in14.toISOString().split('T')[0];

    const todayAll = [], upcomingAll = [];
    for (const comp of MATCH_COMPS) {
      const data = await apiGet(`/competitions/${comp}/matches`, { dateFrom: today, dateTo: dateTo2 });
      if (data?.matches?.length) {
        for (const m of data.matches) {
          const d = m.utcDate?.split('T')[0];
          if (d === today) todayAll.push(m);
          else if (d > today) upcomingAll.push(m);
        }
      }
    }
    matchesCache.today = { data: todayAll, loadedAt: Date.now(), dateKey: today };
    matchesCache.upcoming = { data: upcomingAll, loadedAt: Date.now(), dateKey: today };
    console.log(`Cache matchs: ${todayAll.length} aujourd'hui, ${upcomingAll.length} à venir`);
  } catch(e) {
    console.error('refreshMatchesCache:', e.message);
  } finally {
    matchesCache.loading = false;
  }
}

async function getTodayMatches() {
  const today = new Date().toISOString().split('T')[0];
  const ttl = 2 * 60 * 60 * 1000;
  if (matchesCache.today.dateKey === today && Date.now() - matchesCache.today.loadedAt < ttl) {
    return matchesCache.today.data;
  }
  // Cache périmé — retourner ce qu'on a et relancer en arrière-plan
  if (!matchesCache.loading) refreshMatchesCache();
  return matchesCache.today.data;
}

async function getUpcomingMatches() {
  const today = new Date().toISOString().split('T')[0];
  const ttl = 2 * 60 * 60 * 1000;
  if (matchesCache.upcoming.dateKey === today && Date.now() - matchesCache.upcoming.loadedAt < ttl) {
    return matchesCache.upcoming.data;
  }
  if (!matchesCache.loading) refreshMatchesCache();
  return matchesCache.upcoming.data;
}

// ── Données démo ──────────────────────────────────────────────────
const DEMO_MATCHES = [
  { fixture: { date: new Date().toISOString(), status: { short: 'NS' } }, league: { name: 'Ligue 1' }, teams: { home: { name: 'Paris Saint-Germain' }, away: { name: 'Olympique Lyonnais' } }, goals: { home: null, away: null } },
  { fixture: { date: new Date().toISOString(), status: { short: '1H' } }, league: { name: 'La Liga' }, teams: { home: { name: 'Real Madrid' }, away: { name: 'FC Barcelone' } }, goals: { home: 2, away: 1 } },
  { fixture: { date: new Date().toISOString(), status: { short: 'FT' } }, league: { name: 'Premier League' }, teams: { home: { name: 'Manchester City' }, away: { name: 'Arsenal' } }, goals: { home: 3, away: 1 } },
  { fixture: { date: new Date().toISOString(), status: { short: 'NS' } }, league: { name: 'Bundesliga' }, teams: { home: { name: 'Bayern Munich' }, away: { name: 'Borussia Dortmund' } }, goals: { home: null, away: null } },
  { fixture: { date: new Date().toISOString(), status: { short: 'FT' } }, league: { name: 'Serie A' }, teams: { home: { name: 'Juventus' }, away: { name: 'AC Milan' } }, goals: { home: 1, away: 1 } },
];

const STATUS_EMOJI = { NS:'🕐', '1H':'⚽', HT:'⏸️', '2H':'⚽', FT:'✅', PST:'📅', CANC:'❌' };
const PRIORITY = ['Ligue 1','La Liga','Premier League','Bundesliga','Serie A','Champions League','Europa League'];

// ── Bot ───────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// /start
bot.command('start', (ctx) => {
  const name = ctx.from?.first_name || 'ami';
  const appUrl = RENDER_URL || `https://baga-bet-bot-1.onrender.com`;
  ctx.reply(
    `⚽ Bienvenue sur BetAnalyse BOT, ${name} !\n\nStatistiques et analyses sportives en temps réel.\n\n👇 Ouvre l'application :`,
    Markup.inlineKeyboard([
      [Markup.button.webApp('🚀 Ouvrir BetAnalyse', appUrl)],
    ])
  );
});

// /help
bot.command('help', (ctx) => {
  ctx.replyWithMarkdown(
    `📋 *Commandes BetAnalyse BOT*\n\n/start — Accueil\n/matchs — Matchs du jour\n/analyse NomEquipe — Analyse statistique\n/statistiques NomEquipe — Stats équipe\n/profil — Votre profil\n/premium — Abonnement Premium\n/abonner — Payer par Mobile Money\n/verifier — Vérifier votre paiement\n/help — Cette aide`
  );
});

// /matchs
bot.command('matchs', async (ctx) => {
  const loading = await ctx.reply('⏳ Chargement des matchs...');
  try {
    let matches;
    if (DEMO_MODE) {
      matches = DEMO_MATCHES;
    } else {
      matches = await getTodayMatches();
    }

    if (!matches || !matches.length) {
      return ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, '📭 Aucun match trouvé pour aujourd\'hui.');
    }

    // football-data.org format: m.competition.name, m.homeTeam.name, m.awayTeam.name, m.score, m.status
    const byLeague = {};
    for (const m of matches.slice(0, 30)) {
      const l = m.competition?.name || m.league?.name || 'Autre';
      if (!byLeague[l]) byLeague[l] = [];
      byLeague[l].push(m);
    }

    const FD_STATUS = { 'SCHEDULED':'🕐', 'LIVE':'⚽', 'IN_PLAY':'⚽', 'PAUSED':'⏸️', 'FINISHED':'✅', 'POSTPONED':'📅', 'CANCELLED':'❌', 'SUSPENDED':'⏸️', 'NS':'🕐', '1H':'⚽', HT:'⏸️', '2H':'⚽', FT:'✅' };

    let text = `📅 *Matchs du ${new Date().toLocaleDateString('fr-FR')}* (${matches.length} matchs)\n\n`;
    for (const [league, games] of Object.entries(byLeague)) {
      text += `🏆 *${league}*\n`;
      for (const g of games) {
        const st = FD_STATUS[g.status || g.fixture?.status?.short] || '⚪';
        const home = g.homeTeam?.name || g.teams?.home?.name || '?';
        const away = g.awayTeam?.name || g.teams?.away?.name || '?';
        const isScheduled = ['SCHEDULED','NS'].includes(g.status || g.fixture?.status?.short);
        const score = isScheduled
          ? new Date(g.utcDate || g.fixture?.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Abidjan' })
          : `${g.score?.fullTime?.home ?? g.goals?.home ?? '-'} - ${g.score?.fullTime?.away ?? g.goals?.away ?? '-'}`;
        text += `${st} ${home} vs ${away} | ${score}\n`;
      }
      text += '\n';
    }
    text += `_Pour analyser : /analyse NomEquipe_`;

    await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, text, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(`/matchs: ${e.message}`);
    ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, '⚠️ Erreur. Réessayez dans quelques instants.');
  }
});

// ── Prédiction IA ─────────────────────────────────────────────────

function computePredictionScore(stats) {
  // Score règles : retourne { home, draw, away } en pourcentages
  const form = stats.form || [];
  const formScore = (team) => {
    return team.reduce((s, r) => s + (r === 'W' ? 3 : r === 'D' ? 1 : 0), 0);
  };

  const homeForm = formScore(stats.homeForm || []);
  const awayForm = formScore(stats.awayForm || []);
  const homeGoalsFor = parseFloat(stats.homeGoalsFor) || 1;
  const homeGoalsAgainst = parseFloat(stats.homeGoalsAgainst) || 1;
  const awayGoalsFor = parseFloat(stats.awayGoalsFor) || 1;
  const awayGoalsAgainst = parseFloat(stats.awayGoalsAgainst) || 1;

  // Attaque vs Défense
  const homeAttack = homeGoalsFor / Math.max(awayGoalsAgainst, 0.5);
  const awayAttack = awayGoalsFor / Math.max(homeGoalsAgainst, 0.5);

  // H2H bonus
  let h2hHome = 0, h2hAway = 0;
  for (const m of (stats.h2h || [])) {
    if (m.goalsFor > m.goalsAgainst) h2hHome += 1;
    else if (m.goalsFor < m.goalsAgainst) h2hAway += 1;
  }

  // Score brut
  let rawHome = homeForm * 1.2 + homeAttack * 3 + h2hHome * 1.5 + 3; // +3 avantage domicile
  let rawDraw = 5;
  let rawAway = awayForm * 1.0 + awayAttack * 3 + h2hAway * 1.5;

  const total = rawHome + rawDraw + rawAway;
  return {
    home: Math.round((rawHome / total) * 100),
    draw: Math.round((rawDraw / total) * 100),
    away: Math.round((rawAway / total) * 100),
  };
}

async function generateAIText(homeTeam, awayTeam, pct, stats) {
  if (!GROQ_API_KEY) return null;
  const prompt = `Tu es un analyste football expert. Donne une courte analyse de prédiction (4-5 phrases max) pour ce match en français :

Match : ${homeTeam} vs ${awayTeam}
Probabilités calculées : Victoire ${homeTeam} ${pct.home}% | Nul ${pct.draw}% | Victoire ${awayTeam} ${pct.away}%
Forme ${homeTeam} (5 derniers) : ${(stats.homeForm||[]).join(' ')}
Forme ${awayTeam} (5 derniers) : ${(stats.awayForm||[]).join(' ')}
Buts/match ${homeTeam} : ${stats.homeGoalsFor} marqués, ${stats.homeGoalsAgainst} encaissés
Buts/match ${awayTeam} : ${stats.awayGoalsFor} marqués, ${stats.awayGoalsAgainst} encaissés

Sois direct, concis et professionnel. Commence par "🔮 Analyse :" et termine par une recommandation claire.`;

  try {
    const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama3-8b-8192',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 250,
      temperature: 0.7,
    }, {
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    return r.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch(e) {
    return null;
  }
}

// Helper: analyse d'équipe avec football-data.org
async function getTeamAnalysis(teamName) {
  const result = await findTeam(teamName);
  if (!result) return null;
  const { team, competition } = result;

  // Derniers 5 matchs de l'équipe
  const matchesData = await apiGet(`/teams/${team.id}/matches`, { limit: 5, status: 'FINISHED' });
  const lastMatches = matchesData?.matches || [];

  let wins = 0, draws = 0, losses = 0, gf = 0, ga = 0;
  const form = [];
  for (const m of lastMatches) {
    const isHome = m.homeTeam?.id === team.id;
    const gs = isHome ? m.score?.fullTime?.home : m.score?.fullTime?.away;
    const gc = isHome ? m.score?.fullTime?.away : m.score?.fullTime?.home;
    gf += gs || 0; ga += gc || 0;
    if (gs > gc) { wins++; form.push('W'); }
    else if (gs === gc) { draws++; form.push('D'); }
    else { losses++; form.push('L'); }
  }
  const played = lastMatches.length;
  const avgFor = played ? (gf / played).toFixed(1) : 'N/A';
  const avgAga = played ? (ga / played).toFixed(1) : 'N/A';

  return { team, competition, lastMatches, form, wins, draws, losses, avgFor, avgAga, played };
}

// Analyse premium : H2H + forme domicile/extérieur
async function getTeamAnalysisPremium(teamName) {
  const base = await getTeamAnalysis(teamName);
  if (!base) return null;
  const { team } = base;

  // Prochain match
  const nextData = await apiGet(`/teams/${team.id}/matches`, { limit: 1, status: 'SCHEDULED' });
  const nextMatch = nextData?.matches?.[0] || null;

  // Forme domicile vs extérieur (10 derniers)
  const extData = await apiGet(`/teams/${team.id}/matches`, { limit: 10, status: 'FINISHED' });
  const allMatches = extData?.matches || [];
  let homeW=0,homeD=0,homeL=0,awayW=0,awayD=0,awayL=0;
  for (const m of allMatches) {
    const isHome = m.homeTeam?.id === team.id;
    const gs = isHome ? m.score?.fullTime?.home : m.score?.fullTime?.away;
    const gc = isHome ? m.score?.fullTime?.away : m.score?.fullTime?.home;
    if (isHome) { if(gs>gc)homeW++;else if(gs===gc)homeD++;else homeL++; }
    else        { if(gs>gc)awayW++;else if(gs===gc)awayD++;else awayL++; }
  }

  // H2H — si prochain match connu, chercher les confrontations passées
  let h2h = [];
  if (nextMatch) {
    const oppId = nextMatch.homeTeam?.id === team.id ? nextMatch.awayTeam?.id : nextMatch.homeTeam?.id;
    const h2hData = await apiGet(`/teams/${team.id}/matches`, { limit: 5, status: 'FINISHED' });
    h2h = (h2hData?.matches || []).filter(m =>
      (m.homeTeam?.id === team.id && m.awayTeam?.id === oppId) ||
      (m.awayTeam?.id === team.id && m.homeTeam?.id === oppId)
    ).slice(0, 5).map(m => {
      const isHome = m.homeTeam?.id === team.id;
      const gs = isHome ? m.score?.fullTime?.home : m.score?.fullTime?.away;
      const gc = isHome ? m.score?.fullTime?.away : m.score?.fullTime?.home;
      return { opponent: isHome ? m.awayTeam?.name : m.homeTeam?.name, goalsFor: gs, goalsAgainst: gc, isHome };
    });
  }

  return {
    ...base,
    homeRecord: { w: homeW, d: homeD, l: homeL },
    awayRecord: { w: awayW, d: awayD, l: awayL },
    nextMatch: nextMatch ? {
      opponent: nextMatch.homeTeam?.id === team.id ? nextMatch.awayTeam?.name : nextMatch.homeTeam?.name,
      opponentLogo: nextMatch.homeTeam?.id === team.id ? nextMatch.awayTeam?.crest : nextMatch.homeTeam?.crest,
      isHome: nextMatch.homeTeam?.id === team.id,
      date: nextMatch.utcDate ? new Date(nextMatch.utcDate).toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long', timeZone:'Africa/Abidjan' }) : '',
      time: nextMatch.utcDate ? new Date(nextMatch.utcDate).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit', timeZone:'Africa/Abidjan' }) : '',
      competition: nextMatch.competition?.name,
    } : null,
    h2h,
  };
}

// Génère le coupon du jour (avec cache) — premium = 8 matchs, gratuit = 4
function generateCoupon(rawMatches, isPremium) {
  const today = new Date().toLocaleDateString('fr-FR');
  if (todayCouponCache.date === today && todayCouponCache.data) {
    const cached = todayCouponCache.data;
    if (!isPremium) return { ...cached, matches: cached.matches.slice(0, 4), coteCombinee: cached.matches.slice(0,4).reduce((a,m) => a*m.cote, 1).toFixed(2) };
    return cached;
  }
  const PRIORITY_COMPS = ['Premier League','Primera Division','Bundesliga','Serie A','Ligue 1','UEFA Champions League'];
  const sorted = [
    ...rawMatches.filter(m => PRIORITY_COMPS.includes(m.competition?.name)),
    ...rawMatches.filter(m => !PRIORITY_COMPS.includes(m.competition?.name)),
  ].slice(0, 10);
  const PRONOSTICS = ['1','N','2'];
  const LABELS = { '1':'Domicile gagne','N':'Match nul','2':'Extérieur gagne' };
  const COTES = { '1':[1.5,1.6,1.7,1.8,2.0,2.2],'N':[3.0,3.2,3.4,3.5],'2':[1.8,2.0,2.2,2.5,3.0] };
  const STARS = [3,3,2,2,2,1];
  let coteCombinee = 1;
  const couponMatches = sorted.map(m => {
    const prono = PRONOSTICS[Math.floor(Math.random()*3)];
    const cote = COTES[prono][Math.floor(Math.random()*COTES[prono].length)];
    const stars = STARS[Math.floor(Math.random()*STARS.length)];
    coteCombinee *= cote;
    return {
      home: m.homeTeam?.name, homeLogo: m.homeTeam?.crest,
      away: m.awayTeam?.name, awayLogo: m.awayTeam?.crest,
      league: m.competition?.name,
      time: m.utcDate ? new Date(m.utcDate).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',timeZone:'Africa/Abidjan'}) : '--:--',
      prono, label: LABELS[prono], cote, stars,
    };
  });
  const data = { matches: couponMatches, coteCombinee: coteCombinee.toFixed(2), date: today };
  todayCouponCache = { date: today, data };
  couponHistory[today] = data;
  if (!isPremium) return { ...data, matches: couponMatches.slice(0,4), coteCombinee: couponMatches.slice(0,4).reduce((a,m)=>a*m.cote,1).toFixed(2) };
  return data;
}

// /analyse
bot.command('analyse', async (ctx) => {
  const args = ctx.message?.text?.split(' ').slice(1).join(' ').trim();
  if (!args) return ctx.replyWithMarkdown('📊 Usage : `/analyse NomEquipe`\nEx : `/analyse PSG`');

  const loading = await ctx.reply(`🔍 Analyse de "${args}"...`);
  try {
    if (DEMO_MODE) {
      const text = `📊 *Analyse — ${args}*\n\n🏟️ *Forme récente*\n✅ 🟡 ✅ ✅ ❌\n\n⚽ *Derniers résultats*\n✅ vs Équipe A (2-0)\n🟡 vs Équipe B (1-1)\n✅ vs Équipe C (3-1)\n✅ vs Équipe D (2-1)\n❌ vs Équipe E (0-1)\n\n📈 *Buts*\n• Marqués : 2.2/match\n• Encaissés : 0.9/match\n\n⚠️ _Données simulées — mode démo_`;
      return ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, text, { parse_mode: 'Markdown' });
    }

    const data = await getTeamAnalysis(args);
    if (!data) return ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, `❌ Équipe "${args}" introuvable dans les ligues disponibles.`);

    const { team, competition, lastMatches, form, avgFor, avgAga } = data;
    const formStr = form.map(r => r==='W'?'✅':r==='D'?'🟡':'❌').join(' ') || 'N/A';
    const lastStr = lastMatches.slice(0,5).map(m => {
      const isHome = m.homeTeam?.id === team.id;
      const opp = isHome ? m.awayTeam?.name : m.homeTeam?.name;
      const gs = isHome ? m.score?.fullTime?.home : m.score?.fullTime?.away;
      const gc = isHome ? m.score?.fullTime?.away : m.score?.fullTime?.home;
      const r = gs > gc ? '✅' : gs === gc ? '🟡' : '❌';
      return `${r} vs ${opp} (${gs}-${gc})`;
    }).join('\n');

    const text = `📊 *Analyse — ${team.name}*\n🏆 ${competition?.name || ''}\n\n🏟️ *Forme récente (5 derniers)*\n${formStr}\n\n⚽ *Derniers résultats*\n${lastStr || 'N/A'}\n\n📈 *Buts (5 derniers matchs)*\n• Marqués : ${avgFor}/match\n• Encaissés : ${avgAga}/match\n\n⚠️ _Données statistiques à titre informatif._`;
    const userId = ctx.from?.id;
    const favs = favoriteTeams[userId] || [];
    const isFav = favs.some(f => f.name === team.name);
    await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, text, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback(isFav ? '💔 Retirer des favoris' : '❤️ Ajouter aux favoris', `fav_${isFav ? 'remove' : 'add'}_${team.id}_${team.name.substring(0,20)}_${competition?.name?.substring(0,15) || ''}_${team.crest || ''}`)]
      ]).reply_markup
    });
  } catch (e) {
    console.error(`/analyse: ${e.message}`);
    ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, '⚠️ Erreur lors de l\'analyse.');
  }
});

// /statistiques
bot.command('statistiques', async (ctx) => {
  const args = ctx.message?.text?.split(' ').slice(1).join(' ').trim();
  if (!args) return ctx.replyWithMarkdown('📈 Usage : `/statistiques NomEquipe`\nEx : `/statistiques Bayern`');

  const loading = await ctx.reply(`📊 Statistiques de "${args}"...`);
  try {
    if (DEMO_MODE) {
      const text = `📈 *${args}* — Saison démo\n\n🎮 *Matchs*\n• Total : 38 | Victoires : 24 | Nuls : 8 | Défaites : 6\n\n⚽ *Buts*\n• Marqués : 72 (1.9/match)\n• Encaissés : 38 (1.0/match)\n\n🧤 Clean sheets : 14\n\n⚠️ _Données simulées — mode démo_`;
      return ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, text, { parse_mode: 'Markdown' });
    }

    const data = await getTeamAnalysis(args);
    if (!data) return ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, `❌ Équipe "${args}" introuvable.`);

    const { team, competition, wins, draws, losses, avgFor, avgAga, played } = data;
    const text = `📈 *${team.name}*\n🏆 ${competition?.name || ''}\n\n🎮 *5 derniers matchs*\n• Joués : ${played}\n• Victoires : ${wins}\n• Nuls : ${draws}\n• Défaites : ${losses}\n\n⚽ *Buts*\n• Marqués : ${avgFor}/match\n• Encaissés : ${avgAga}/match\n\n⚠️ _Statistiques à titre informatif._`;
    await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, text, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(`/statistiques: ${e.message}`);
    ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, '⚠️ Erreur lors de la récupération.');
  }
});

// ── Handler bouton favoris ────────────────────────────────────────
bot.action(/^fav_(add|remove)_(\d+)_(.+)_(.*)_(.*)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const [, action, teamId, teamName, compName, logo] = ctx.match;
  const userId = ctx.from?.id;
  const isPremium = !!premiumUsers[userId];
  const maxFav = isPremium ? MAX_FAVORITES_PREMIUM : MAX_FAVORITES_FREE;

  if (!favoriteTeams[userId]) favoriteTeams[userId] = [];

  if (action === 'add') {
    if (favoriteTeams[userId].length >= maxFav) {
      return ctx.answerCbQuery(`❌ Limite atteinte (${maxFav} équipes). ${isPremium ? '' : 'Passez Premium pour en ajouter plus !'}`, { show_alert: true });
    }
    if (!favoriteTeams[userId].some(f => f.name === teamName)) {
      favoriteTeams[userId].push({ name: teamName, competition: compName, logo });
    }
    ctx.answerCbQuery(`❤️ ${teamName} ajouté aux favoris !`, { show_alert: true });
  } else {
    favoriteTeams[userId] = favoriteTeams[userId].filter(f => f.name !== teamName);
    ctx.answerCbQuery(`💔 ${teamName} retiré des favoris.`, { show_alert: true });
  }
});

// /favoris
bot.command('favoris', async (ctx) => {
  const userId = ctx.from?.id;
  const favs = favoriteTeams[userId] || [];
  if (!favs.length) {
    return ctx.replyWithMarkdown(`⭐ *Vos équipes favorites*\n\nAucune équipe favorite.\nFaites une analyse et cliquez ❤️ pour ajouter.`);
  }
  const appUrl = RENDER_URL || 'https://baga-bet-bot-1.onrender.com';
  let text = `⭐ *Vos équipes favorites (${favs.length})*\n\n`;
  favs.forEach((f, i) => { text += `${i+1}. ${f.name} — ${f.competition || ''}\n`; });
  text += `\n_Tapez /analyse NomEquipe pour une analyse rapide_`;
  await ctx.replyWithMarkdown(text, Markup.inlineKeyboard([
    [Markup.button.webApp('📊 Voir dans l\'app', appUrl)]
  ]));
});

// /coupon — génère un coupon du jour
bot.command('coupon', async (ctx) => {
  const loading = await ctx.reply('🎯 Génération du coupon du jour...');
  try {
    const matches = await getTodayMatches();
    if (!matches?.length) {
      return ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, '📭 Aucun match aujourd\'hui pour générer un coupon.');
    }
    // Prendre les 4 premiers matchs des ligues prioritaires
    const PRIORITY_COMPS = ['Premier League','Primera Division','Bundesliga','Serie A','Ligue 1','UEFA Champions League'];
    const sorted = [
      ...matches.filter(m => PRIORITY_COMPS.includes(m.competition?.name)),
      ...matches.filter(m => !PRIORITY_COMPS.includes(m.competition?.name)),
    ].slice(0, 4);

    const PRONOSTICS = ['1','N','2'];
    const LABELS = { '1': 'Victoire domicile', 'N': 'Match nul', '2': 'Victoire extérieur' };
    const COTES = { '1': [1.5, 1.6, 1.7, 1.8, 2.0, 2.2], 'N': [3.0, 3.2, 3.4, 3.5], '2': [1.8, 2.0, 2.2, 2.5, 3.0] };
    const CONFIANCE = ['⭐⭐⭐ Haute', '⭐⭐ Moyenne', '⭐ Faible'];

    let text = `🎯 *Coupon BetAnalyse — ${new Date().toLocaleDateString('fr-FR')}*\n\n`;
    let coteCombinee = 1;

    for (const m of sorted) {
      const home = m.homeTeam?.name || '?';
      const away = m.awayTeam?.name || '?';
      const pronoIdx = Math.floor(Math.random() * 3);
      const prono = PRONOSTICS[pronoIdx];
      const cotesArr = COTES[prono];
      const cote = cotesArr[Math.floor(Math.random() * cotesArr.length)];
      const conf = CONFIANCE[Math.floor(Math.random() * 3)];
      coteCombinee *= cote;
      const time = m.utcDate ? new Date(m.utcDate).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Abidjan' }) : '--:--';
      text += `⚽ *${home} vs ${away}*\n`;
      text += `🏆 ${m.competition?.name} | 🕐 ${time}\n`;
      text += `📌 Pronostic : *${prono}* — ${LABELS[prono]}\n`;
      text += `💰 Cote : *${cote}* | ${conf}\n\n`;
    }
    text += `━━━━━━━━━━━━━━━━━\n`;
    text += `💎 *Cote combinée : ${coteCombinee.toFixed(2)}*\n`;
    text += `⚠️ _Pronostics à titre indicatif. Pariez responsablement._`;

    ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, text, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('/coupon:', e.message);
    ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, '⚠️ Erreur lors de la génération du coupon.');
  }
});

// /profil
bot.command('profil', (ctx) => {
  const u = ctx.from;
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'N/A';
  ctx.replyWithMarkdown(`👤 *Mon Profil*\n\n*Nom :* ${name}\n*Username :* @${u.username || 'non renseigné'}\n*ID :* \`${u.id}\`\n\n🏷️ *Plan :* 🆓 Gratuit\n\n_Passez à Premium pour plus de fonctionnalités !_`);
});

// Numéro de paiement manuel de l'admin
const PAYMENT_PHONE = process.env.PAYMENT_PHONE || '79281868';

// /premium
bot.command('premium', (ctx) => {
  const userId = ctx.from?.id;
  if (premiumUsers[userId]) {
    const exp = new Date(premiumUsers[userId].expiresAt).toLocaleDateString('fr-FR');
    return ctx.replyWithMarkdown(`💎 *Vous êtes déjà Premium !*\n\n✅ Abonnement actif jusqu'au *${exp}*\n\nMerci de votre confiance 🙏`);
  }
  ctx.replyWithMarkdown(
    `💎 *BetAnalyse Premium*\n\n🔓 *Fonctionnalités exclusives :*\n• Analyses approfondies (xG, passes clés)\n• 20 équipes favorites\n• Statistiques sur 10 saisons\n• Comparaison d'équipes\n• Alertes matchs\n\n📦 *Choisissez votre formule :*`,
    Markup.inlineKeyboard([
      [Markup.button.callback('📅 Mensuel — 2 500 XOF', 'plan_mensuel')],
      [Markup.button.callback('📆 Trimestriel — 6 000 XOF', 'plan_trimestriel')],
      [Markup.button.callback('🗓️ Annuel — 20 000 XOF', 'plan_annuel')],
    ])
  );
});

// Sélection de plan → instructions paiement manuel
bot.action(/^plan_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const planKey = ctx.match[1];
  const plan = PLANS[planKey];
  if (!plan) return ctx.reply('❌ Plan invalide.');

  const userId = ctx.from.id;
  const orderId = `BAGA-${userId}-${Date.now()}`;
  pendingPayments[userId] = { step: 'awaiting_confirmation_manual', planKey, orderId };

  await ctx.replyWithMarkdown(
    `💎 *${plan.label} — ${plan.amount.toLocaleString()} XOF*\n\n` +
    `📱 *Envoyez ${plan.amount.toLocaleString()} XOF par Mobile Money à :*\n\n` +
    `┌─────────────────────────\n` +
    `│ 📞 *${PAYMENT_PHONE}*\n` +
    `│ 👤 Mamadou Bayoko\n` +
    `│ 💰 *${plan.amount.toLocaleString()} XOF*\n` +
    `│ 📝 Ref : \`${orderId}\`\n` +
    `└─────────────────────────\n\n` +
    `✅ *Étapes :*\n` +
    `1️⃣ Envoyez le montant au numéro ci-dessus\n` +
    `2️⃣ Tapez /confirmer suivi de votre numéro\n` +
    `   _Ex: /confirmer 76123456_\n\n` +
    `⏱️ Activation sous 24h après vérification.`
  );
});

// Commande /abonner (raccourci)
bot.command('abonner', (ctx) => {
  const userId = ctx.from?.id;
  if (premiumUsers[userId]) {
    const exp = new Date(premiumUsers[userId].expiresAt).toLocaleDateString('fr-FR');
    return ctx.replyWithMarkdown(`💎 *Vous êtes déjà Premium !*\n\n✅ Abonnement actif jusqu'au *${exp}*`);
  }
  ctx.replyWithMarkdown(
    `💎 *S'abonner à BetAnalyse Premium*\n\nChoisissez votre formule :`,
    Markup.inlineKeyboard([
      [Markup.button.callback('📅 Mensuel — 2 500 XOF', 'plan_mensuel')],
      [Markup.button.callback('📆 Trimestriel — 6 000 XOF', 'plan_trimestriel')],
      [Markup.button.callback('🗓️ Annuel — 20 000 XOF', 'plan_annuel')],
    ])
  );
});

// /confirmer — utilisateur envoie son numéro après paiement
// Commande admin : générer un code unique
bot.command('gencode', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from?.id)) return ctx.reply('⛔ Accès réservé aux administrateurs.');
  const days = parseInt(ctx.message?.text?.split(' ')[1]) || PROMO_DAYS;
  const code = 'BB' + Math.random().toString(36).substring(2, 8).toUpperCase();
  promoCodes[code] = { days, createdAt: new Date().toISOString(), usedBy: null };
  ctx.replyWithMarkdown(`✅ *Code généré*\n\n\`${code}\`\n\n📅 Valide pour *${days} jours* de Premium\n🔢 Usage unique\n\nEnvoyez ce code à votre client 1xbet.`);
});

// Commande admin : liste des codes
bot.command('codes', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from?.id)) return ctx.reply('⛔ Accès réservé aux administrateurs.');
  const all = Object.entries(promoCodes);
  if (!all.length) return ctx.reply('Aucun code généré.');
  const unused = all.filter(([,v]) => !v.usedBy);
  const used = all.filter(([,v]) => v.usedBy);
  let msg = `📋 *Codes promo*\n\n✅ *Disponibles (${unused.length})*\n`;
  for (const [c, v] of unused) msg += `• \`${c}\` — ${v.days}j\n`;
  if (used.length) {
    msg += `\n🔒 *Utilisés (${used.length})*\n`;
    for (const [c, v] of used) msg += `• \`${c}\` — par \`${v.usedBy}\`\n`;
  }
  ctx.replyWithMarkdown(msg);
});

// Utilisateur : activer un code promo
bot.command('promo', async (ctx) => {
  const userId = String(ctx.from?.id);
  const code = ctx.message?.text?.split(' ')[1]?.trim()?.toUpperCase();

  if (!code) {
    return ctx.replyWithMarkdown(`🎁 *Code Promo*\n\nVous avez reçu un code promo ?\nActivez-le avec :\n\`/promo VOTRE_CODE\``);
  }
  const entry = promoCodes[code];
  if (!entry) return ctx.replyWithMarkdown('❌ Code invalide ou inexistant.\n\nVérifiez le code envoyé par l\'administrateur.');
  if (entry.usedBy) return ctx.replyWithMarkdown('⚠️ Ce code a déjà été utilisé.\n\nChaque code est à usage unique.');

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + entry.days);
  if (premiumUsers[userId]) {
    const exp = new Date(premiumUsers[userId].expiresAt);
    exp.setDate(exp.getDate() + entry.days);
    premiumUsers[userId].expiresAt = exp.toISOString();
  } else {
    premiumUsers[userId] = { plan: 'promo_1xbet', expiresAt: expiresAt.toISOString() };
  }
  entry.usedBy = userId;
  entry.usedAt = new Date().toISOString();

  const userName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
  const userHandle = ctx.from.username ? `@${ctx.from.username}` : `ID: ${userId}`;
  const exp = new Date(premiumUsers[userId].expiresAt);
  const notifMsg = `🎁 *Code promo utilisé*\n\n🔑 Code : \`${code}\`\n👤 ${userName} (${userHandle})\n🆔 \`${userId}\`\n📅 Premium jusqu'au ${exp.toLocaleDateString('fr-FR')}\n📱 Via : Bot`;
  for (const adminId of ADMIN_IDS) {
    bot.telegram.sendMessage(adminId, notifMsg, { parse_mode: 'Markdown' }).catch(() => {});
  }
  ctx.replyWithMarkdown(`🎉 *Premium activé !*\n\n✅ Accès Premium pour *${entry.days} jours*\n📅 Expire le : ${exp.toLocaleDateString('fr-FR')}\n\n💎 Fonctionnalités débloquées :\n• Analyses H2H illimitées\n• Coupon 8-10 matchs\n• 10 équipes favorites\n• Historique des coupons\n• Alertes matchs`);
});

bot.command('confirmer', async (ctx) => {
  const userId = ctx.from?.id;
  const phone = ctx.message?.text?.split(' ')[1]?.trim();

  if (!phone || !/^\d{8,9}$/.test(phone)) {
    return ctx.replyWithMarkdown('❌ Usage : `/confirmer VotreNuméro`\nEx : `/confirmer 76123456`');
  }

  const pending = pendingPayments[userId];
  if (!pending) {
    return ctx.reply('❌ Aucune commande en attente. Utilisez /abonner pour commencer.');
  }

  const plan = PLANS[pending.planKey];
  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');

  // Notifier l'admin
  for (const adminId of ADMIN_IDS) {
    try {
      await ctx.telegram.sendMessage(adminId,
        `🔔 *Nouvelle demande Premium*\n\n` +
        `👤 ${name} (@${ctx.from.username || 'N/A'}) — ID: \`${userId}\`\n` +
        `📦 Plan : *${plan.label} — ${plan.amount.toLocaleString()} XOF*\n` +
        `📱 Numéro déclaré : *${phone}*\n` +
        `🔑 Ref : \`${pending.orderId}\`\n\n` +
        `✅ Pour activer : /activer ${userId} ${pending.planKey}\n` +
        `❌ Pour refuser : /refuser ${userId}`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) { console.error('Notif admin:', e.message); }
  }

  pendingPayments[userId] = { ...pending, phone, step: 'waiting_admin' };

  await ctx.replyWithMarkdown(
    `✅ *Demande reçue !*\n\n` +
    `📱 Numéro déclaré : *${phone}*\n` +
    `📦 Plan : *${plan.label}*\n` +
    `💰 Montant : *${plan.amount.toLocaleString()} XOF*\n\n` +
    `⏳ Votre abonnement sera activé sous *24h* après vérification du paiement.\n\n` +
    `Pour toute question : @BagaBetSupport`
  );
});

// /verifier — vérifier le statut du paiement
bot.command('verifier', async (ctx) => {
  const userId = ctx.from?.id;
  const pending = pendingPayments[userId];

  if (!pending || pending.step !== 'awaiting_confirmation') {
    return ctx.reply('❌ Aucun paiement en attente. Utilisez /abonner pour commencer.');
  }

  const loading = await ctx.reply('🔍 Vérification du paiement...');
  try {
    const result = await checkPayment(pending.paymentId);
    const state = result?.data?.state;
    const status = result?.data?.payment?.status;

    if (status === 'completed' || state === 2) {
      const plan = PLANS[pending.planKey];
      const expiresAt = new Date(Date.now() + plan.days * 24 * 60 * 60 * 1000);
      premiumUsers[userId] = { plan: pending.planKey, expiresAt: expiresAt.toISOString(), orderId: pending.orderId };
      delete pendingPayments[userId];

      await ctx.telegram.editMessageText(
        ctx.chat.id, loading.message_id, null,
        `🎉 *Paiement confirmé !*\n\n💎 *Vous êtes maintenant Premium ${plan.label} !*\n📅 Valable jusqu'au : *${expiresAt.toLocaleDateString('fr-FR')}*\n\nMerci de votre confiance 🙏\nTapez /help pour voir toutes vos fonctionnalités.`,
        { parse_mode: 'Markdown' }
      );
    } else if (state === 0 || state === 1) {
      await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, `⏳ Paiement en attente de confirmation.\n\nConfirmez sur votre téléphone puis retapez /verifier`);
    } else {
      delete pendingPayments[userId];
      await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, `❌ Paiement échoué ou annulé.\n\nRéessayez avec /abonner`);
    }
  } catch (e) {
    console.error('checkPayment:', e.response?.data || e.message);
    await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, '⚠️ Erreur de vérification. Réessayez dans quelques instants.');
  }
});

// /activer [userId] [planKey] — admin active le premium
bot.command('activer', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from?.id)) return ctx.reply('⛔ Accès réservé aux administrateurs.');
  const parts = ctx.message?.text?.split(' ');
  const targetId = parseInt(parts[1]);
  const planKey = parts[2] || 'mensuel';
  if (!targetId) return ctx.reply('Usage : /activer [userId] [mensuel|trimestriel|annuel]');

  const plan = PLANS[planKey] || PLANS.mensuel;
  const expiresAt = new Date(Date.now() + plan.days * 24 * 60 * 60 * 1000);
  premiumUsers[targetId] = { plan: planKey, expiresAt: expiresAt.toISOString() };
  delete pendingPayments[targetId];

  try {
    await ctx.telegram.sendMessage(targetId,
      `🎉 *Félicitations ! Votre abonnement Premium est activé !*\n\n` +
      `💎 Plan : *${plan.label}*\n` +
      `📅 Valable jusqu'au : *${expiresAt.toLocaleDateString('fr-FR')}*\n\n` +
      `Merci de votre confiance ! 🙏\nTapez /help pour voir toutes vos fonctionnalités.`,
      { parse_mode: 'Markdown' }
    );
    ctx.reply(`✅ Premium activé pour l'utilisateur ${targetId} — Plan ${plan.label}`);
  } catch (e) {
    ctx.reply(`✅ Premium activé mais impossible de notifier l'utilisateur (${e.message})`);
  }
});

// /refuser [userId] — admin refuse la demande
bot.command('refuser', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from?.id)) return ctx.reply('⛔ Accès réservé aux administrateurs.');
  const targetId = parseInt(ctx.message?.text?.split(' ')[1]);
  if (!targetId) return ctx.reply('Usage : /refuser [userId]');

  delete pendingPayments[targetId];
  try {
    await ctx.telegram.sendMessage(targetId,
      `❌ *Votre demande Premium n'a pas pu être validée.*\n\n` +
      `Le paiement n'a pas été retrouvé. Vérifiez et réessayez avec /abonner.\n` +
      `Pour toute question : @BagaBetSupport`,
      { parse_mode: 'Markdown' }
    );
    ctx.reply(`✅ Demande refusée pour l'utilisateur ${targetId}`);
  } catch (e) {
    ctx.reply(`✅ Refus enregistré mais impossible de notifier l'utilisateur`);
  }
});

// /admin
bot.command('admin', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from?.id)) return ctx.reply('⛔ Accès réservé aux administrateurs.');
  const nbPremium = Object.keys(premiumUsers).length;
  const nbPending = Object.keys(pendingPayments).length;
  ctx.replyWithMarkdown(
    `🛡️ *Panneau Admin BetAnalyse*\n\n` +
    `Bot actif ✅\nMode : ${DEMO_MODE ? 'Démo' : 'API réelle'}\n` +
    `Date : ${new Date().toLocaleString('fr-FR')}\n\n` +
    `💎 Abonnés Premium : *${nbPremium}*\n` +
    `⏳ Demandes en attente : *${nbPending}*\n\n` +
    `*Commandes admin :*\n` +
    `/activer [userId] [plan] — Activer Premium\n` +
    `/refuser [userId] — Refuser demande`
  );
});

// Raccourcis clavier
bot.hears(['⚽ Matchs du jour', 'Matchs du jour'], async (ctx) => {
  const loading = await ctx.reply('⏳ Chargement des matchs...');
  try {
    let matches;
    if (DEMO_MODE) {
      matches = DEMO_MATCHES;
    } else {
      const today = new Date().toISOString().split('T')[0];
      matches = await apiGet('/fixtures', { date: today });
    }
    if (!matches || !matches.length) {
      return ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, '📭 Aucun match trouvé pour aujourd\'hui.');
    }
    const sorted = [
      ...matches.filter(m => PRIORITY.some(p => m.league?.name?.includes(p))),
      ...matches.filter(m => !PRIORITY.some(p => m.league?.name?.includes(p))),
    ].slice(0, 25);
    const byLeague = {};
    for (const m of sorted) {
      const l = m.league?.name || 'Autre';
      if (!byLeague[l]) byLeague[l] = [];
      byLeague[l].push(m);
    }
    let text = `📅 *Matchs du ${new Date().toLocaleDateString('fr-FR')}*${!DEMO_MODE ? ` (${matches.length} au total)` : ' (démo)'}\n\n`;
    for (const [league, games] of Object.entries(byLeague)) {
      text += `🏆 *${league}*\n`;
      for (const g of games) {
        const st = STATUS_EMOJI[g.fixture?.status?.short] || '⚪';
        const home = g.teams?.home?.name || '?';
        const away = g.teams?.away?.name || '?';
        const score = g.fixture?.status?.short === 'NS'
          ? new Date(g.fixture.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
          : `${g.goals?.home ?? '-'} - ${g.goals?.away ?? '-'}`;
        text += `${st} ${home} vs ${away} | ${score}\n`;
      }
      text += '\n';
    }
    text += `_Pour analyser : /analyse NomEquipe_`;
    await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, text, { parse_mode: 'Markdown' });
  } catch (e) {
    ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, '⚠️ Erreur. Réessayez dans quelques instants.');
  }
});

bot.hears(['📊 Analyse', 'Analyse'], (ctx) => ctx.replyWithMarkdown('Utilisez `/analyse NomEquipe`\nEx : `/analyse PSG`'));
bot.hears(['📈 Statistiques', 'Statistiques'], (ctx) => ctx.replyWithMarkdown('Utilisez `/statistiques NomEquipe`\nEx : `/statistiques Bayern`'));
bot.hears(['💎 Premium', 'Premium'], async (ctx) => {
  const userId = ctx.from?.id;
  if (premiumUsers[userId]) {
    const exp = new Date(premiumUsers[userId].expiresAt).toLocaleDateString('fr-FR');
    return ctx.replyWithMarkdown(`💎 *Vous êtes déjà Premium !*\n\n✅ Abonnement actif jusqu'au *${exp}*`);
  }
  ctx.replyWithMarkdown(
    `💎 *BetAnalyse Premium*\n\nChoisissez votre formule :`,
    Markup.inlineKeyboard([
      [Markup.button.callback('📅 Mensuel — 2 500 XOF', 'plan_mensuel')],
      [Markup.button.callback('📆 Trimestriel — 6 000 XOF', 'plan_trimestriel')],
      [Markup.button.callback('🗓️ Annuel — 20 000 XOF', 'plan_annuel')],
    ])
  );
});

// Réception du numéro de téléphone pour paiement
bot.on('message', async (ctx) => {
  const userId = ctx.from?.id;
  const pending = pendingPayments[userId];

  if (pending?.step === 'awaiting_phone') {
    const phone = ctx.message?.text?.trim().replace(/\s+/g, '');
    if (!/^\d{8,9}$/.test(phone)) {
      return ctx.reply('❌ Numéro invalide. Entrez 8 à 9 chiffres sans indicatif.\nEx: 76123456');
    }

    const plan = PLANS[pending.planKey];
    const orderId = `BAGA-${userId}-${Date.now()}`;

    const loading = await ctx.reply(`⏳ Initiation du paiement de ${plan.amount.toLocaleString()} XOF...`);

    try {
      const result = await createPayment(phone, plan.amount, orderId);

      if (result?.status === 'success' && result?.data?.id) {
        const paymentId = result.data.id;
        pendingPayments[userId] = { step: 'awaiting_confirmation', planKey: pending.planKey, paymentId, orderId };

        await ctx.telegram.editMessageText(
          ctx.chat.id, loading.message_id, null,
          `✅ *Demande de paiement envoyée !*\n\n📱 Vérifiez votre téléphone *+223${phone}*\nConfirmez le paiement de *${plan.amount.toLocaleString()} XOF* sur votre appli Mobile Money.\n\nUne fois confirmé, tapez /verifier pour activer votre abonnement.`,
          { parse_mode: 'Markdown' }
        );
      } else {
        delete pendingPayments[userId];
        await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, `❌ Erreur lors de l'initiation du paiement. Réessayez avec /abonner`);
      }
    } catch (e) {
      console.error('Jemenipay createPayment:', e.response?.data || e.message);
      delete pendingPayments[userId];
      await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, `⚠️ Erreur de paiement : ${e.response?.data?.message || e.message}\n\nRéessayez avec /abonner`);
    }
    return;
  }

  ctx.reply('❓ Commande inconnue. Tapez /help');
});

// Erreurs
bot.catch((err, ctx) => {
  console.error(`Erreur [${ctx.updateType}]: ${err.message}`);
  ctx.reply('⚠️ Erreur. Réessayez.').catch(() => {});
});

// Serveur HTTP — Mini App + API
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || '';

async function handleApi(req, res, urlObj) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if (urlObj.pathname === '/api/cache-status') {
      return res.end(JSON.stringify({
        ok: true,
        loading: matchesCache.loading,
        today: { count: matchesCache.today.data.length, age: matchesCache.today.loadedAt ? Math.round((Date.now()-matchesCache.today.loadedAt)/1000)+'s' : 'jamais' },
        upcoming: { count: matchesCache.upcoming.data.length, age: matchesCache.upcoming.loadedAt ? Math.round((Date.now()-matchesCache.upcoming.loadedAt)/1000)+'s' : 'jamais' },
      }));
    } else if (urlObj.pathname === '/api/matchs') {
      const rawMatches = await getTodayMatches();
      const loading = matchesCache.loading && matchesCache.today.data.length === 0;
      const formatMatch = m => ({
        id: m.id,
        date: m.utcDate ? new Date(m.utcDate).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Abidjan' }) : '',
        time: m.utcDate ? new Date(m.utcDate).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Abidjan' }) : '--:--',
        home: m.homeTeam?.name,
        away: m.awayTeam?.name,
        homeLogo: m.homeTeam?.crest,
        awayLogo: m.awayTeam?.crest,
        league: m.competition?.name,
        leagueLogo: m.competition?.emblem,
        status: m.status,
        scoreHome: m.score?.fullTime?.home,
        scoreAway: m.score?.fullTime?.away,
      });
      const matches = rawMatches.slice(0, 40).map(formatMatch);
      res.end(JSON.stringify({ ok: true, matches, loading }));
    } else if (urlObj.pathname === '/api/matchs-a-venir') {
      const rawMatches = await getUpcomingMatches();
      const matches = rawMatches.slice(0, 60).map(m => ({
        id: m.id,
        date: m.utcDate ? new Date(m.utcDate).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Abidjan' }) : '',
        time: m.utcDate ? new Date(m.utcDate).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Abidjan' }) : '--:--',
        home: m.homeTeam?.name,
        away: m.awayTeam?.name,
        homeLogo: m.homeTeam?.crest,
        awayLogo: m.awayTeam?.crest,
        league: m.competition?.name,
        leagueLogo: m.competition?.emblem,
        status: m.status,
      }));
      res.end(JSON.stringify({ ok: true, matches }));
    } else if (urlObj.pathname === '/api/analyse') {
      const teamName = urlObj.searchParams.get('team');
      if (!teamName) return res.end(JSON.stringify({ ok: false, error: 'Paramètre team manquant' }));
      const data = await getTeamAnalysis(teamName);
      if (!data) return res.end(JSON.stringify({ ok: false, error: `Équipe "${teamName}" introuvable` }));
      const { team, competition, lastMatches, form, wins, draws, losses, avgFor, avgAga, played } = data;
      const lastMatchesMapped = lastMatches.slice(0, 5).map(m => {
        const isHome = m.homeTeam?.id === team.id;
        return {
          opponent: isHome ? m.awayTeam?.name : m.homeTeam?.name,
          opponentLogo: isHome ? m.awayTeam?.crest : m.homeTeam?.crest,
          goalsFor: isHome ? m.score?.fullTime?.home : m.score?.fullTime?.away,
          goalsAgainst: isHome ? m.score?.fullTime?.away : m.score?.fullTime?.home,
          isHome,
        };
      });
      // Si premium, enrichir avec H2H + domicile/extérieur
      const userId = urlObj.searchParams.get('userId');
      const isPremium = userId ? !!premiumUsers[userId] : false;
      let extra = {};
      let pData = null;
      if (isPremium) {
        pData = await getTeamAnalysisPremium(teamName);
        if (pData) extra = { homeRecord: pData.homeRecord, awayRecord: pData.awayRecord, nextMatch: pData.nextMatch, h2h: pData.h2h };
      }
      // Prédiction IA (règles + LLM si prochain match connu)
      const nextOpp = pData?.nextMatch?.opponent || 'Adversaire inconnu';
      const predStats = {
        homeForm: form,
        awayForm: [],
        homeGoalsFor: avgFor, homeGoalsAgainst: avgAga,
        awayGoalsFor: 1.2, awayGoalsAgainst: 1.3,
        h2h: extra.h2h || [],
      };
      const predPct = computePredictionScore(predStats);
      let aiText = null;
      if (isPremium && pData?.nextMatch) {
        aiText = await generateAIText(team.name, nextOpp, predPct, predStats);
      }
      res.end(JSON.stringify({
        ok: true,
        isPremium,
        team: { name: team.name, logo: team.crest },
        league: { name: competition?.name, logo: competition?.emblem },
        season: new Date().getFullYear(),
        form,
        played, wins, draws, loses: losses,
        goalsFor: avgFor, goalsAgainst: avgAga,
        lastMatches: lastMatchesMapped,
        prediction: { pct: predPct, aiText, opponent: pData?.nextMatch ? nextOpp : null },
        ...extra,
      }));
    } else if (urlObj.pathname === '/api/favoris') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          try {
            const { userId, team, action } = JSON.parse(body);
            if (!userId) return res.end(JSON.stringify({ ok: false, error: 'userId manquant' }));
            if (!favoriteTeams[userId]) favoriteTeams[userId] = [];
            const isPremium = !!premiumUsers[userId];
            const maxFav = isPremium ? MAX_FAVORITES_PREMIUM : MAX_FAVORITES_FREE;
            if (action === 'add') {
              if (favoriteTeams[userId].length >= maxFav) {
                return res.end(JSON.stringify({ ok: false, error: `Limite ${maxFav} équipes atteinte`, needPremium: !isPremium }));
              }
              if (!favoriteTeams[userId].some(f => f.name === team.name)) {
                favoriteTeams[userId].push(team);
              }
            } else {
              favoriteTeams[userId] = favoriteTeams[userId].filter(f => f.name !== team.name);
            }
            res.end(JSON.stringify({ ok: true, favorites: favoriteTeams[userId] }));
          } catch(e) { res.end(JSON.stringify({ ok: false, error: e.message })); }
        });
      } else {
        const userId = urlObj.searchParams.get('userId');
        res.end(JSON.stringify({ ok: true, favorites: favoriteTeams[userId] || [] }));
      }
    } else if (urlObj.pathname === '/api/coupon') {
      const userId = urlObj.searchParams.get('userId');
      const isPremium = userId ? !!premiumUsers[userId] : false;
      const rawMatches = await getTodayMatches();
      if (!rawMatches?.length) return res.end(JSON.stringify({ ok: true, matches: [], isPremium }));
      const coupon = generateCoupon(rawMatches, isPremium);
      res.end(JSON.stringify({ ok: true, isPremium, ...coupon }));
    } else if (urlObj.pathname === '/api/coupon/historique') {
      const userId = urlObj.searchParams.get('userId');
      const isPremium = userId ? !!premiumUsers[userId] : false;
      if (!isPremium) return res.end(JSON.stringify({ ok: false, needPremium: true, error: 'Fonctionnalité Premium' }));
      const history = Object.entries(couponHistory)
        .sort((a, b) => b[0].localeCompare(a[0]))
        .slice(0, 7)
        .map(([date, data]) => ({ date, ...data }));
      res.end(JSON.stringify({ ok: true, history }));
    } else if (urlObj.pathname === '/api/promo') {
      const userId = urlObj.searchParams.get('userId');
      const code = urlObj.searchParams.get('code')?.toUpperCase();
      if (!userId) return res.end(JSON.stringify({ ok: false, error: 'userId requis' }));
      if (!code) return res.end(JSON.stringify({ ok: false, error: 'Code requis' }));
      const entry = promoCodes[code];
      if (!entry) return res.end(JSON.stringify({ ok: false, error: 'Code invalide' }));
      if (entry.usedBy) return res.end(JSON.stringify({ ok: false, error: 'Code déjà utilisé' }));
      const extended = !!premiumUsers[userId];
      if (extended) {
        const exp = new Date(premiumUsers[userId].expiresAt);
        exp.setDate(exp.getDate() + entry.days);
        premiumUsers[userId].expiresAt = exp.toISOString();
      } else {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + entry.days);
        premiumUsers[userId] = { plan: 'promo_1xbet', expiresAt: expiresAt.toISOString() };
      }
      entry.usedBy = userId;
      entry.usedAt = new Date().toISOString();
      const finalExp = new Date(premiumUsers[userId].expiresAt);
      const notifMsg2 = `🎁 *Code promo utilisé*\n\n🔑 Code : \`${code}\`\n🆔 \`${userId}\`\n📅 Premium jusqu'au ${finalExp.toLocaleDateString('fr-FR')}\n📱 Via : Mini App`;
      for (const adminId of ADMIN_IDS) {
        bot.telegram.sendMessage(adminId, notifMsg2, { parse_mode: 'Markdown' }).catch(() => {});
      }
      res.end(JSON.stringify({ ok: true, extended, expiresAt: finalExp.toISOString() }));
    } else if (urlObj.pathname === '/api/profil') {
      const userId = urlObj.searchParams.get('userId');
      const prem = userId ? premiumUsers[userId] : null;
      if (prem) {
        res.end(JSON.stringify({ ok: true, isPremium: true, plan: prem.plan || 'mensuel', expiresAt: prem.expiresAt }));
      } else {
        res.end(JSON.stringify({ ok: true, isPremium: false }));
      }
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ ok: false, error: 'Route inconnue' }));
    }
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  if (urlObj.pathname.startsWith('/api/')) {
    return handleApi(req, res, urlObj);
  }
  // Servir la Mini App
  const filePath = path.join(__dirname, 'webapp.html');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(filePath));
  } else {
    res.writeHead(200);
    res.end('BetAnalyse BOT actif');
  }
});

server.listen(PORT, () => {
  console.log(`Serveur HTTP sur port ${PORT}`);
  if (RENDER_URL) {
    setInterval(() => {
      http.get(RENDER_URL).on('error', () => {});
      console.log('Ping keep-alive envoyé');
    }, 10 * 60 * 1000);
  }
});

// ── Alertes matchs favoris ────────────────────────────────────────
async function sendFavoriteAlerts() {
  const usersWithFavs = Object.entries(favoriteTeams).filter(([, favs]) => favs.length > 0);
  if (!usersWithFavs.length) return;

  const todayMatches = await getTodayMatches();
  if (!todayMatches?.length) return;

  for (const [userId, favs] of usersWithFavs) {
    const alerts = [];
    for (const fav of favs) {
      const match = todayMatches.find(m =>
        m.homeTeam?.name?.toLowerCase().includes(fav.name.toLowerCase()) ||
        m.awayTeam?.name?.toLowerCase().includes(fav.name.toLowerCase())
      );
      if (match) {
        const time = match.utcDate ? new Date(match.utcDate).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit', timeZone:'Africa/Abidjan' }) : '--:--';
        const isHome = match.homeTeam?.name?.toLowerCase().includes(fav.name.toLowerCase());
        const opp = isHome ? match.awayTeam?.name : match.homeTeam?.name;
        alerts.push(`⚽ *${fav.name}* ${isHome ? 'vs' : '@'} *${opp}* à *${time}*\n🏆 ${match.competition?.name}`);
      }
    }
    if (alerts.length) {
      const text = `🔔 *Alerte matchs du jour !*\n\n${alerts.join('\n\n')}\n\n_Bonne chance ! 🍀_`;
      try {
        await bot.telegram.sendMessage(parseInt(userId), text, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error(`Alerte userId ${userId}: ${e.message}`);
      }
    }
  }
}

// Planifier les alertes à 9h00 (Africa/Abidjan = UTC+0)
function scheduleDailyAlerts() {
  const now = new Date();
  const next9h = new Date(now);
  next9h.setUTCHours(9, 0, 0, 0);
  if (next9h <= now) next9h.setUTCDate(next9h.getUTCDate() + 1);
  const msUntil9h = next9h - now;
  setTimeout(() => {
    sendFavoriteAlerts();
    setInterval(sendFavoriteAlerts, 24 * 60 * 60 * 1000);
  }, msUntil9h);
  console.log(`Alertes planifiées dans ${Math.round(msUntil9h/60000)} min`);
}

// Démarrage
bot.launch().then(() => {
  console.log(`✅ BetAnalyse BOT démarré - Mode: ${DEMO_MODE ? 'DÉMO' : 'API RÉELLE'}`);
  scheduleDailyAlerts();
  // Pré-charger les matchs en arrière-plan (pas de blocage)
  if (!DEMO_MODE) {
    setTimeout(() => refreshMatchesCache(), 2000);
    // Rafraîchir toutes les 2h
    setInterval(() => refreshMatchesCache(), 2 * 60 * 60 * 1000);
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
