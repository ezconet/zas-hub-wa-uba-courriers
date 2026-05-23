const db = require('../db/database');

module.exports = async function controlRoutes(fastify) {
  // S13 — POST /dispatch/enable
  fastify.post('/dispatch/enable', async () => {
    db.setState('dispatch_enabled', 'true');
    return { enabled: true };
  });

  // S13 — POST /dispatch/disable
  fastify.post('/dispatch/disable', async () => {
    db.setState('dispatch_enabled', 'false');
    return { enabled: false };
  });

  // S13 — GET /dispatch/status
  fastify.get('/dispatch/status', async () => {
    return { enabled: db.getState('dispatch_enabled') === 'true' };
  });
};
