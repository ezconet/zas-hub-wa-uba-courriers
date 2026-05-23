const config = require('../config');
const health = require('../services/health');

function healthGroupConfigured(reply) {
  if (!config.WA_HEALTH_GROUP_JID) {
    reply.code(501).send({ error: 'WA_HEALTH_GROUP_JID não configurado' });
    return false;
  }
  return true;
}

module.exports = async function healthRoutes(fastify) {
  // S14 — GET /health/ping
  fastify.get('/health/ping', async (request, reply) => {
    if (!healthGroupConfigured(reply)) return;
    return health.ping();
  });

  // S15 — GET /health/retest (responde em até 30s)
  fastify.get('/health/retest', async (request, reply) => {
    if (!healthGroupConfigured(reply)) return;
    return health.retest();
  });

  // S16 — GET /health/status (público — sem x-api-key)
  fastify.get('/health/status', async () => {
    return health.status();
  });
};
