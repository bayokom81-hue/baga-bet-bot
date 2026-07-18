require('dotenv').config();
const { Telegraf } = require('telegraf');
const config = require('./config');
const logger = require('./utils/logger');
const { connectDB, disconnectDB } = require('./database/client');

// Middlewares
const logMiddleware  = require('./middleware/logger');
const authMiddleware = require('./middleware/auth');

// Commandes
const startCommand         = require('./commands/start');
const helpCommand          = require('./commands/help');
const matchsCommand        = require('./commands/matchs');
const analyseCommand       = require('./commands/analyse');
const statistiquesCommand  = require('./commands/statistiques');
const favorisCommand       = require('./commands/favoris');
const profilCommand        = require('./commands/profil');
const premiumCommand       = require('./commands/premium');
const adminCommand         = require('./commands/admin');

async function main() {
  if (!config.bot.token) {
    logger.error('BOT_TOKEN manquant dans .env');
    process.exit(1);
  }

  // Connexion base de données (optionnelle en mode démo)
  try {
    await connectDB();
  } catch (e) {
    logger.warn('Base de données non disponible — mode démo sans persistance activé');
  }

  const bot = new Telegraf(config.bot.token);

  // ── Middlewares globaux ──
  bot.use(logMiddleware);
  bot.use(authMiddleware);

  // ── Commandes ──
  bot.command('start',        startCommand);
  bot.command('help',         helpCommand);
  bot.command('matchs',       matchsCommand);
  bot.command('analyse',      analyseCommand);
  bot.command('statistiques', statistiquesCommand);
  bot.command('favoris',      favorisCommand);
  bot.command('profil',       profilCommand);
  bot.command('premium',      premiumCommand);
  bot.command('admin',        adminCommand);

  // ── Gestion des actions (boutons inline) ──
  bot.action(/^fav_add_(.+)$/, require('./commands/favoris').addAction);
  bot.action(/^fav_del_(.+)$/, require('./commands/favoris').delAction);

  // ── Raccourcis clavier ──
  bot.hears('⚽ Matchs du jour', (ctx) => matchsCommand(ctx));
  bot.hears('📊 Analyse',        (ctx) => ctx.replyWithMarkdown('Utilisez `/analyse NomEquipe`'));
  bot.hears('📈 Statistiques',   (ctx) => ctx.replyWithMarkdown('Utilisez `/statistiques NomEquipe`'));
  bot.hears('⭐ Favoris',         (ctx) => favorisCommand(ctx));
  bot.hears('👤 Mon profil',      (ctx) => profilCommand(ctx));
  bot.hears('💎 Premium',         (ctx) => premiumCommand(ctx));

  // Sous-commandes favoris textuelles
  bot.hears(/^\/favoris ajouter (.+)$/i, (ctx) => {
    require('./commands/favoris').addFavorite(ctx);
  });

  // ── Message non reconnu ──
  bot.on('message', (ctx) => {
    ctx.reply(
      '❓ Commande inconnue. Tapez /help pour voir les commandes disponibles.'
    );
  });

  // ── Gestion des erreurs globales ──
  bot.catch((err, ctx) => {
    logger.error(`Erreur bot [${ctx.updateType}]: ${err.message}`);
    ctx.reply('⚠️ Une erreur est survenue. Veuillez réessayer.').catch(() => {});
  });

  // ── Lancement en mode polling ──
  await bot.launch();
  logger.info(`✅ BAGA BET BOT démarré (mode: ${config.env})`);

  // Arrêt propre
  process.once('SIGINT',  () => { bot.stop('SIGINT');  disconnectDB(); });
  process.once('SIGTERM', () => { bot.stop('SIGTERM'); disconnectDB(); });
}

main().catch((err) => {
  logger.error(`Erreur fatale: ${err.message}`);
  process.exit(1);
});
