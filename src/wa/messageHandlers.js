const config = require('../config');
const waClient = require('./client');
const db = require('../db/database');
const euDetector = require('../services/euDetector');
const health = require('../services/health');

function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    ''
  );
}

function dispatchEnabled() {
  return db.getState('dispatch_enabled') === 'true';
}

function registerHandlers() {
  waClient.events.on('messages', async (messages) => {
    for (const msg of messages) {
      try {
        // R13: ignorar mensagens próprias (evita loop ao enviar no grupo)
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;

        const jid = msg.key.remoteJid;
        const text = extractText(msg).trim().toLowerCase();
        if (text !== 'eu') continue;

        // Health check manual: "eu" no grupo de validação resolve o reteste (S15).
        // Escuta separada do dispatch — independe de dispatch_enabled.
        // Guard: se health == grupo de dispatch, NÃO trata como health (senão engole
        // todo "eu" de dispatch). Dispatch tem prioridade; grupos devem ser distintos.
        if (
          config.WA_HEALTH_GROUP_JID &&
          config.WA_HEALTH_GROUP_JID !== config.WA_GROUP_JID &&
          jid === config.WA_HEALTH_GROUP_JID
        ) {
          health.notifyHealthEu();
          continue;
        }

        if (jid !== config.WA_GROUP_JID) continue;

        // S10/regra: dispatch_enabled = false → ignora escuta de "eu"
        if (!dispatchEnabled()) {
          console.log('[HANDLER] "eu" ignorado: dispatch desabilitado.');
          continue;
        }

        await euDetector.handleEu(msg);
      } catch (err) {
        console.error('[HANDLER] Erro ao processar mensagem:', err.message);
      }
    }
  });

  console.log('[HANDLER] Handlers de mensagem registrados.');
}

module.exports = { registerHandlers };
