require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN;
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(Boolean);
const DEMO_MODE = !FOOTBALL_API_KEY;

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
    `⚽ *Bienvenue sur BAGA BET BOT*, ${name} !\n\nJe fournis des statistiques et analyses sportives.\n\n📊 *Commandes :*\n/matchs — Matchs du jour\n/analyse NomEquipe — Analyse statistique\n/statistiques NomEquipe — Stats équipe\n/premium — Abonnement Premium\n/help — Aide\n\n⚠️ _Données à titre informatif uniquement._`,
    Markup.keyboard([
      ['⚽ Matchs du jour', '📊 Analyse'],
      ['📈 Statistiques', '💎 Premium'],
    ]).resize()
  );
});

// /help
bot.command('help', (ctx) => {
  ctx.replyWithMarkdown(
    `📋 *Commandes BAGA BET BOT*\n\n/start — Accueil\n/matchs — Matchs du jour\n/analyse NomEquipe — Analyse statistique\n/statistiques NomEquipe — Stats équipe\n/profil — Votre profil\n/premium — Abonnement Premium\n/help — Cette aide`
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
    const season = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;
    const [statsRes, fixturesRes] = await Promise.all([
      apiGet('/teams/statistics', { team: team.id, season }),
      apiGet('/fixtures', { team: team.id, season, last: 5 }),
    ]);

    const stats = statsRes?.[0];
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
    const res = await apiGet('/teams/statistics', { team: team.id, season });
    const s = res?.[0];
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

// /premium
bot.command('premium', (ctx) => {
  ctx.replyWithMarkdown(`💎 *BAGA BET Premium*\n\n🔓 *Fonctionnalités exclusives :*\n• Analyses approfondies (xG, passes clés)\n• 20 équipes favorites\n• Statistiques sur 10 saisons\n• Comparaison d'équipes\n• Alertes matchs\n\n📦 *Formules :*\n• Mensuel : 2 500 XOF\n• Trimestriel : 6 000 XOF\n• Annuel : 20 000 XOF\n\n💳 Contactez @BagaBetSupport\n\n⚠️ _Données statistiques uniquement. Aucun résultat garanti._`);
});

// /admin
bot.command('admin', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from?.id)) return ctx.reply('⛔ Accès réservé aux administrateurs.');
  ctx.replyWithMarkdown(`🛡️ *Panneau Admin*\n\nBot actif ✅\nMode : ${DEMO_MODE ? 'Démo' : 'API réelle'}\nDate : ${new Date().toLocaleString('fr-FR')}`);
});

// Raccourcis clavier
bot.hears('⚽ Matchs du jour', (ctx) => ctx.message.text = '/matchs' && bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/matchs' } }));
bot.hears('📊 Analyse', (ctx) => ctx.replyWithMarkdown('Utilisez `/analyse NomEquipe`\nEx : `/analyse PSG`'));
bot.hears('📈 Statistiques', (ctx) => ctx.replyWithMarkdown('Utilisez `/statistiques NomEquipe`\nEx : `/statistiques Bayern`'));
bot.hears('💎 Premium', (ctx) => ctx.replyWithMarkdown(`💎 *BAGA BET Premium*\n\nContactez @BagaBetSupport pour vous abonner.\n\n⚠️ _Données statistiques uniquement._`));

// Message inconnu
bot.on('message', (ctx) => ctx.reply('❓ Commande inconnue. Tapez /help'));

// Erreurs
bot.catch((err, ctx) => {
  console.error(`Erreur [${ctx.updateType}]: ${err.message}`);
  ctx.reply('⚠️ Erreur. Réessayez.').catch(() => {});
});

// Démarrage
bot.launch().then(() => {
  console.log(`✅ BAGA BET BOT démarré - Mode: ${DEMO_MODE ? 'DÉMO' : 'API RÉELLE'}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
