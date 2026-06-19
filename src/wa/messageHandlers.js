const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const config = require('../config');
const waClient = require('./client');
const db = require('../db/database');
const euDetector = require('../services/euDetector');
const health = require('../services/health');
const webhook = require('../services/webhook');

// Logger silencioso para downloadMediaMessage (mesma forma pino-like usada no client.js).
const silentLogger = {
  level: 'silent',
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger; },
};

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
        if (!msg.message) continue;

        const jid = msg.key.remoteJid;

        // RECEIPT: imagem do recebedor → baixa e encaminha pro Hub (OCR).
        // ANTES do guard fromMe: o operador encaminha o comprovante pela MESMA conta
        // pareada na API → a msg chega com fromMe=true. Só dispara em imageMessage,
        // então nosso announce/confirmação (texto) não entra aqui — sem loop.
        if (config.RECEIPT_ENABLED && jid === config.RECEIPT_LISTEN_JID) {
          const img = msg.message?.imageMessage;
          if (img) {
            try {
              const buf = await downloadMediaMessage(msg, 'buffer', {}, {
                logger: silentLogger,
                reuploadRequest: (m) => waClient.sock.updateMediaMessage(m),
              });
              await webhook.sendReceipt({
                restaurantId: config.RECEIPT_RESTAURANT_ID,
                jid,
                msgId: msg.key.id,
                imageBase64: buf.toString('base64'),
                mime: img.mimetype || 'image/jpeg',
              });
              console.log('[RECEIPT] comprovante enviado ao Hub', msg.key.id);
              // Confirma no grupo (não-fatal: falha aqui não quebra o encaminhamento).
              await waClient
                .sendText(jid, 'Comprovante recebido e sendo processado ✅')
                .catch((e) => console.error('[RECEIPT] falha ao confirmar no grupo:', e.message));
            } catch (err) {
              console.error('[RECEIPT] falha ao baixar/enviar comprovante:', err.message);
            }
            continue; // imagem tratada — não cai no fluxo de "eu"
          }
        }

        // R13: do "eu" pra baixo, ignorar mensagens próprias (evita loop ao enviar no grupo).
        if (msg.key.fromMe) continue;

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

  // Diagnóstico: loga TODA msg do grupo de receipt, inclusive não-decifrada (stub).
  // rawUpsert vê tudo (notify/append/undecrypted). Liga com RECEIPT_DEBUG=true.
  if (config.RECEIPT_DEBUG) {
    waClient.events.on('rawUpsert', (upsert) => {
      for (const m of (upsert?.messages || [])) {
        if (m.key?.remoteJid === config.RECEIPT_LISTEN_JID) {
          console.log(
            `[RECEIPT-DBG] type=${upsert.type} decrypted=${!!m.message}`,
            `keys=${JSON.stringify(Object.keys(m.message || {}))}`,
            `stub=${m.messageStubType} fromMe=${m.key.fromMe}`,
          );
        }
      }
    });
    console.log('[RECEIPT-DBG] tap ativo no JID', config.RECEIPT_LISTEN_JID);
  }

  console.log('[HANDLER] Handlers de mensagem registrados.');
}

module.exports = { registerHandlers };
