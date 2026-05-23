const cron = require('node-cron');
const db = require('../db/database');
const config = require('../config');

async function checkExpiredOrders() {
  const pendingOrders = db.getPendingOrders();
  if (pendingOrders.length === 0) return;

  const now = new Date();

  for (const order of pendingOrders) {
    const announcedAt = new Date(order.announced_at);
    const ageMinutes = (now - announcedAt) / 1000 / 60;

    if (ageMinutes > config.EXPIRY_MINUTES) {
      db.setOrderExpired(order.id_pedido, now.toISOString());
      console.log(
        `[EXPIRY] Pedido ${order.display_id} expirou após ${Math.round(ageMinutes)} minutos sem aceite.`
      );
    }
  }
}

function startExpiryManager() {
  console.log(`[EXPIRY] Iniciando gerenciador de expiração: ${config.EXPIRY_CHECK_CRON}`);

  cron.schedule(config.EXPIRY_CHECK_CRON, () => {
    checkExpiredOrders().catch(err =>
      console.error('[EXPIRY] Erro ao verificar pedidos expirados:', err.message)
    );
  });
}

module.exports = { startExpiryManager, checkExpiredOrders };
