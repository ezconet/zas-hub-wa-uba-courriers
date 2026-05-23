const db = require('../db/database');
const waClient = require('../wa/client');

module.exports = async function authRoutes(fastify) {
  // S17 — POST /auth/reconnect: força desconexão → client reconecta e emite novo QR.
  // O qrNotifier (listener de 'qr') cuida de PNG → S3 → email.
  fastify.post('/auth/reconnect', async () => {
    db.setState('health_status', 'reconnecting');
    waClient.reconnect();
    return { status: 'reconnecting' };
  });
};
