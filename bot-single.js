require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(Boolean);
const DEMO_MODE = !FOOTBALL_API_KEY;

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

if (!BOT_TOKEN) { console.error('BOT_TOKEN manquant'); process.exit(1); }

// ── API Football ─────────────────────────────────────────────────
const api = axios.create({
  baseURL: 'https://v3.football.api-sports.io',
  timeout: 10000,
  headers: { 'x-apisports-key': FOOTBALL_API_KEY },
});

async function apiGet(endpoint, params = {}) {
  try {
    const r = await api.get(endpoint, { params });
    return r.data?.response || [];
  } catch (e) {
    console.error(`API [${endpoint}]: ${e.message}`);
    return null;
  }
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
  ctx.replyWithMarkdown(
    `⚽ *Bienvenue sur BAGA BET BOT*, ${name} !\n\nJe fournis des statistiques et analyses sportives.\n\n📊 *Commandes :*\n/matchs — Matchs du jour\n/analyse NomEquipe — Analyse statistique\n/statistiques NomEquipe — Stats équipe\n/premium — Abonnement Premium\n/abonner — Payer par Mobile Money\n/verifier — Vérifier votre paiement\n/help — Aide\n\n⚠️ _Données à titre informatif uniquement._`,
    Markup.keyboard([
      ['⚽ Matchs du jour', '📊 Analyse'],
      ['📈 Statistiques', '💎 Premium'],
    ]).resize()
  );
});

// /help
bot.command('help', (ctx) => {
  ctx.replyWithMarkdown(
    `📋 *Commandes BAGA BET BOT*\n\n/start — Accueil\n/matchs — Matchs du jour\n/analyse NomEquipe — Analyse statistique\n/statistiques NomEquipe — Stats équipe\n/profil — Votre profil\n/premium — Abonnement Premium\n/abonner — Payer par Mobile Money\n/verifier — Vérifier votre paiement\n/help — Cette aide`
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
    console.error(`/matchs: ${e.message}`);
    ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, '⚠️ Erreur. Réessayez dans quelques instants.');
  }
});

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

    const teams = await apiGet('/teams', { search: args });
    if (!teams?.length) return ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, `❌ Équipe "${args}" introuvable.`);

    const team = teams[0].team;

    // Trouver la ligue courante, avec fallback sur saison précédente si pas de données
    let mainLeague = null, season = null;
    for (let yr = new Date().getFullYear(); yr >= new Date().getFullYear() - 2; yr--) {
      const lr = await apiGet('/leagues', { team: team.id, season: yr, type: 'League' });
      if (lr?.[0]?.league) { mainLeague = lr[0].league; season = yr; break; }
    }
    if (!mainLeague) {
      return ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, `❌ Aucune ligue trouvée pour "${args}".`);
    }

    const [statsRes, fixturesRes] = await Promise.all([
      apiGet('/teams/statistics', { team: team.id, season, league: mainLeague.id }),
      apiGet('/fixtures', { team: team.id, season, last: 5 }),
    ]);

    let stats = Array.isArray(statsRes) ? statsRes?.[0] : statsRes;
    // Si pas de matchs joués, essayer saison précédente
    if (!stats?.fixtures?.played?.total && season > new Date().getFullYear() - 2) {
      const prevSeason = season - 1;
      const prevStats = await apiGet('/teams/statistics', { team: team.id, season: prevSeason, league: mainLeague.id });
      const ps = Array.isArray(prevStats) ? prevStats?.[0] : prevStats;
      if (ps?.fixtures?.played?.total) { stats = ps; season = prevSeason; }
    }
    const form = (stats?.form || '').split('').slice(-5).map(r => r==='W'?'✅':r==='D'?'🟡':'❌').join(' ') || 'N/A';
    const avgFor = parseFloat(stats?.goals?.for?.average?.total)?.toFixed(1) || 'N/A';
    const avgAga = parseFloat(stats?.goals?.against?.average?.total)?.toFixed(1) || 'N/A';

    let lastStr = '';
    if (fixturesRes?.length) {
      lastStr = fixturesRes.slice(0, 5).map(m => {
        const isHome = m.teams?.home?.id === team.id;
        const opp = isHome ? m.teams?.away?.name : m.teams?.home?.name;
        const gs = isHome ? m.goals?.home : m.goals?.away;
        const ga = isHome ? m.goals?.away : m.goals?.home;
        const r = gs > ga ? '✅' : gs === ga ? '🟡' : '❌';
        return `${r} vs ${opp} (${gs}-${ga})`;
      }).join('\n');
    }

    const text = `📊 *Analyse — ${team.name}*\n\n🏟️ *Forme récente*\n${form}\n\n⚽ *Derniers résultats*\n${lastStr || 'N/A'}\n\n📈 *Buts*\n• Marqués : ${avgFor}/match\n• Encaissés : ${avgAga}/match\n\n⚠️ _Données statistiques à titre informatif._`;
    await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, text, { parse_mode: 'Markdown' });
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

    const teams = await apiGet('/teams', { search: args });
    if (!teams?.length) return ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, `❌ Équipe "${args}" introuvable.`);

    const team = teams[0].team;
    const season = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;
    const leaguesRes2 = await apiGet('/leagues', { team: team.id, season, type: 'League' });
    const league2 = leaguesRes2?.[0]?.league;
    if (!league2) return ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, `❌ Aucune ligue trouvée pour "${args}" en ${season}.`);
    const res = await apiGet('/teams/statistics', { team: team.id, season, league: league2.id });
    const s = Array.isArray(res) ? res?.[0] : res;
    if (!s) return ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, `❌ Aucune statistique pour "${args}".`);

    const text = `📈 *${team.name}* — Saison ${season}\n🏆 ${s.league?.name}\n\n🎮 *Matchs*\n• Total : ${s.fixtures?.played?.total ?? 'N/A'}\n• Victoires : ${s.fixtures?.wins?.total ?? 'N/A'}\n• Nuls : ${s.fixtures?.draws?.total ?? 'N/A'}\n• Défaites : ${s.fixtures?.loses?.total ?? 'N/A'}\n\n⚽ *Buts*\n• Marqués : ${s.goals?.for?.total?.total ?? 'N/A'} (${s.goals?.for?.average?.total ?? 'N/A'}/match)\n• Encaissés : ${s.goals?.against?.total?.total ?? 'N/A'} (${s.goals?.against?.average?.total ?? 'N/A'}/match)\n\n🧤 Clean sheets : ${s.clean_sheet?.total ?? 'N/A'}\n\n⚠️ _Statistiques à titre informatif._`;
    await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, text, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error(`/statistiques: ${e.message}`);
    ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, '⚠️ Erreur lors de la récupération.');
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
    `💎 *BAGA BET Premium*\n\n🔓 *Fonctionnalités exclusives :*\n• Analyses approfondies (xG, passes clés)\n• 20 équipes favorites\n• Statistiques sur 10 saisons\n• Comparaison d'équipes\n• Alertes matchs\n\n📦 *Choisissez votre formule :*`,
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
    `💎 *S'abonner à BAGA BET Premium*\n\nChoisissez votre formule :`,
    Markup.inlineKeyboard([
      [Markup.button.callback('📅 Mensuel — 2 500 XOF', 'plan_mensuel')],
      [Markup.button.callback('📆 Trimestriel — 6 000 XOF', 'plan_trimestriel')],
      [Markup.button.callback('🗓️ Annuel — 20 000 XOF', 'plan_annuel')],
    ])
  );
});

// /confirmer — utilisateur envoie son numéro après paiement
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
    `🛡️ *Panneau Admin BAGA BET*\n\n` +
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
    `💎 *BAGA BET Premium*\n\nChoisissez votre formule :`,
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

// Serveur HTTP pour satisfaire Render Web Service
const http = require('http');
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || '';
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('BAGA BET BOT actif');
});
server.listen(PORT, () => {
  console.log(`Serveur HTTP sur port ${PORT}`);
  // Auto-ping toutes les 10 minutes pour éviter l'endormissement
  if (RENDER_URL) {
    setInterval(() => {
      http.get(RENDER_URL).on('error', () => {});
      console.log('Ping keep-alive envoyé');
    }, 10 * 60 * 1000);
  }
});

// Démarrage
bot.launch().then(() => {
  console.log(`✅ BAGA BET BOT démarré - Mode: ${DEMO_MODE ? 'DÉMO' : 'API RÉELLE'}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
