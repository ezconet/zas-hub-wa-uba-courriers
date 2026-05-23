const config = require('../config');
const db = require('../db/database');
const waClient = require('../wa/client');

// 30s aguardando "eu" no grupo de validação (override por env, p/ testes)
const RETEST_WINDOW_MS = parseInt(process.env.RETEST_WINDOW_MS || '30000', 10);

// Reteste em andamento: { resolve, timer }. Resolvido por notifyHealthEu ou timeout.
let retestPending = null;

// S14 — envia aviso de teste no grupo de validação e marca aguardando teste manual.
async function ping() {
  await waClient.sendText(
    config.WA_HEALTH_GROUP_JID,
    "🔍 Teste de conectividade. Responda 'eu' pra validar.",
  );
  db.setState('health_status', 'awaiting_manual_test');
  return { status: 'awaiting_manual_test' };
}

// S15 — reteste com timer de 30s. Recebeu "eu" → healthy; senão → degraded + reconexão.
async function retest() {
  await waClient.sendText(
    config.WA_HEALTH_GROUP_JID,
    "🔁 Reteste iniciado. Responda 'eu' em 30s.",
  );

  const got = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      retestPending = null;
      resolve(false);
    }, RETEST_WINDOW_MS);
    retestPending = { resolve, timer };
  });

  if (got) {
    db.setState('health_status', 'healthy');
    await waClient.sendText(config.WA_HEALTH_GROUP_JID, '✅ eco ok').catch(() => {});
    return { status: 'healthy' };
  }

  // Não recebeu em 30s → degradado → dispara reconexão (S17 mínimo: força reconnect).
  db.setState('health_status', 'degraded');
  waClient.reconnect();
  return { status: 'degraded', action: 'reconnecting' };
}

// Chamado pelo messageHandler quando "eu" chega no WA_HEALTH_GROUP_JID.
function notifyHealthEu() {
  if (!retestPending) return;
  clearTimeout(retestPending.timer);
  const { resolve } = retestPending;
  retestPending = null;
  resolve(true);
}

// S16
function status() {
  return {
    status: db.getState('health_status'),
    waConnected: waClient.isConnected(),
    dispatchEnabled: db.getState('dispatch_enabled') === 'true',
    lastConnectedAt: db.getState('last_connected_at'),
  };
}

module.exports = { ping, retest, notifyHealthEu, status };
