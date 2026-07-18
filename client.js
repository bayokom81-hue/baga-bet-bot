// Base de données désactivée — mode sans persistance
const logger = require('../utils/logger');

const mockPrisma = new Proxy({}, {
  get: (_, prop) => new Proxy(() => {}, {
    get: () => () => Promise.resolve(null),
    apply: () => Promise.resolve(null),
  }),
});

async function connectDB() {
  logger.warn('Mode sans base de données — les données ne sont pas sauvegardées');
}

async function disconnectDB() {}

module.exports = { prisma: mockPrisma, connectDB, disconnectDB };
