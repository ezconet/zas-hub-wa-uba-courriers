const db = require('../db/database');
const waClient = require('../wa/client');

module.exports = async function authRoutes(fastify) {
  // S17 — POST /auth/reconnect: força desconexão → client reconecta e emite novo QR.
  // O qrNotifier (listener de 'qr') cuida de PNG → S3 → email.
  // Body { wipe: true } → apaga auth antes (forceRepair) → Baileys gera QR novo
  // (re-pareamento). Sem wipe → reconexão soft, reusa credenciais.
  fastify.post('/auth/reconnect', async (req) => {
    const wipe = req.body && req.body.wipe === true;
    db.setState('health_status', 'reconnecting');
    if (wipe) {
      waClient.forceRepair();
      return { status: 'reconnecting', wiped: true };
    }
    waClient.reconnect();
    return { status: 'reconnecting', wiped: false };
  });

  // S17 — GET /auth/reconnect: versão browser-clickable p/ celular.
  // Auth via ?key= (fallback no middleware global). ?wipe=1 → apaga auth + QR novo.
  // Ex: https://<host>/auth/reconnect?key=SECRET&wipe=1
  fastify.get('/auth/reconnect', async (req) => {
    const wipe = req.query && (req.query.wipe === '1' || req.query.wipe === 'true');
    db.setState('health_status', 'reconnecting');
    if (wipe) {
      waClient.forceRepair();
      return { status: 'reconnecting', wiped: true };
    }
    waClient.reconnect();
    return { status: 'reconnecting', wiped: false };
  });
};
