const config = require('../config');
const waClient = require('./client');
const euDetector = require('../services/euDetector');
const motoboyRegistration = require('../services/motoboyRegistration');

function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    ''
  );
}

async function handleGroupMessage(msg) {
  const text = extractText(msg).trim().toLowerCase();

  if (text === 'eu') {
    await euDetector.handleEu(msg);
  }
}

function registerHandlers() {
  waClient.events.on('messages', async (messages) => {
    for (const msg of messages) {
      try {
        // Ignorar mensagens próprias
        if (msg.key.fromMe) continue;
        // Ignorar mensagens sem conteúdo
        if (!msg.message) continue;

        const jid = msg.key.remoteJid;

        if (jid === config.WHATSAPP_GROUP_JID) {
          await handleGroupMessage(msg);
        } else if (!jid.endsWith('@g.us')) {
          // Mensagem privada — pode ser resposta de cadastro de motoboy
          const text = extractText(msg);
          await motoboyRegistration.handlePrivateReply(jid, text);
        }
      } catch (err) {
        console.error('[HANDLER] Erro ao processar mensagem:', err.message);
      }
    }
  });

  console.log('[HANDLER] Handlers de mensagem registrados.');
}

module.exports = { registerHandlers };
