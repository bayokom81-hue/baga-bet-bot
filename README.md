# BAGA BET BOT 🤖⚽

Bot Telegram professionnel d'analyse statistique sportive.

> ⚠️ Ce bot fournit uniquement des données statistiques à titre informatif.
> Il ne garantit aucun résultat et ne constitue pas un conseil en paris sportifs.

---

## Prérequis

- Node.js >= 18
- PostgreSQL (ou Docker)
- Un token Telegram Bot (`@BotFather`)
- (Optionnel) Clé API-Football pour les données réelles

---

## Installation

### 1. Cloner et installer

```bash
cd telegram-bot
npm install
```

### 2. Configurer l'environnement

```bash
cp .env.example .env
```

Remplissez `.env` :

```env
BOT_TOKEN=votre_token_botfather
DATABASE_URL=postgresql://user:password@localhost:5432/bagabet_bot
ADMIN_IDS=votre_id_telegram
FOOTBALL_API_KEY=votre_cle_api  # optionnel
```

### 3. Obtenir votre token Telegram

1. Ouvrez Telegram et cherchez `@BotFather`
2. Envoyez `/newbot`
3. Suivez les instructions
4. Copiez le token dans `.env`

### 4. Base de données

**Avec PostgreSQL local :**
```bash
npx prisma migrate dev --name init
npx prisma generate
```

**Avec Docker :**
```bash
docker compose up -d postgres
npx prisma migrate dev --name init
```

---

## Lancement

```bash
# Développement (rechargement auto)
npm run dev

# Production
npm start
```

---

## Commandes disponibles

| Commande | Description |
|----------|-------------|
| `/start` | Message de bienvenue |
| `/help` | Liste des commandes |
| `/matchs` | Matchs du jour |
| `/analyse NomEquipe` | Analyse statistique |
| `/statistiques NomEquipe` | Stats détaillées |
| `/favoris` | Gérer les favoris |
| `/profil` | Votre profil |
| `/premium` | Abonnement Premium |
| `/admin stats` | Stats admin |
| `/admin users` | Liste utilisateurs |
| `/admin broadcast msg` | Diffusion |
| `/admin logs` | Journaux |

---

## Mode démo (sans clé API)

Sans `FOOTBALL_API_KEY`, le bot fonctionne avec des données simulées.
Pour les données réelles, créez un compte sur [api-football.com](https://www.api-football.com/).

---

## Déploiement Docker

```bash
docker compose up -d
```

`docker-compose.yml` exemple :
```yaml
version: '3.8'
services:
  bot:
    build: .
    env_file: .env
    depends_on:
      - postgres
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: bagabet_bot
      POSTGRES_USER: bagabet
      POSTGRES_PASSWORD: secret
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

---

## Structure du projet

```
telegram-bot/
├── index.js           # Point d'entrée
├── config/            # Configuration centralisée
├── commands/          # Handlers de commandes
├── services/          # Logique métier (API, users)
├── database/          # Prisma client + schéma
├── middleware/        # Auth, logs, admin
├── utils/             # Logger, helpers
└── logs/              # Fichiers de logs
```

---

## Licence

MIT — BAGA BET 2026
