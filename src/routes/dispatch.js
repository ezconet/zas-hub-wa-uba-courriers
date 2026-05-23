const config = require('../config');
const db = require('../db/database');
const waClient = require('../wa/client');
const log = require('../utils/logger').createLogger('DISPATCH');

// S20: a API não espaça envios. O caller (ZasHub) deve dar ~500ms entre announces
// consecutivos — WhatsApp trata rajadas como spam e pode bloquear o número (R04).

function dispatchEnabled() {
  return db.getState('dispatch_enabled') === 'true';
}

// 423 Locked = dispatch desabilitado globalmente
function disabled(reply) {
  return reply.code(423).send({ error: 'dispatch disabled' });
}

module.exports = async function dispatchRoutes(fastify) {
  // S07 — POST /group/announce { orderId, text }
  fastify.post('/group/announce', async (request, reply) => {
    if (!dispatchEnabled()) return disabled(reply);

    const { orderId, text } = request.body || {};
    if (!orderId || !text) {
      return reply.code(400).send({ error: 'orderId e text obrigatórios' });
    }

    // R02: enviar PRIMEIRO. Se o envio WA falhar → não salvar no DB,
    // não retornar sucesso. Próximo ciclo do ZasHub reenvia.
    const result = await waClient.sendText(config.WA_GROUP_JID, text);
    const msgId = result?.key?.id;
    if (!msgId) {
      return reply.code(502).send({ error: 'envio WA sem msgId' });
    }

    db.insertGroupMsg(msgId, orderId);
    // Announce = rodada nova: reabre escuta de "eu" caso o pedido tenha sido
    // disparado antes (ex: vencedor recusou e ZasHub re-anuncia).
    db.clearEuDispatched(orderId);
    log.info(`announce pedido=${orderId} msgId=${msgId}`);
    return { msgId };
  });

  // S08 — POST /group/react { euMsgId, emoji, euJid? }
  // euJid = participante que mandou o "eu" (vem no webhook eu-received). Necessário
  // pra reagir em msg de membro de grupo: sem participant a key não localiza a msg.
  fastify.post('/group/react', async (request, reply) => {
    if (!dispatchEnabled()) return disabled(reply);

    const { euMsgId, emoji, euJid } = request.body || {};
    if (!euMsgId || !emoji) {
      return reply.code(400).send({ error: 'euMsgId e emoji obrigatórios' });
    }

    const msgKey = { remoteJid: config.WA_GROUP_JID, id: euMsgId, fromMe: false };
    if (euJid) msgKey.participant = euJid;
    await waClient.sendReaction(config.WA_GROUP_JID, msgKey, emoji);
    return { ok: true };
  });

  // S09 — POST /message/send { jid, text }
  fastify.post('/message/send', async (request, reply) => {
    if (!dispatchEnabled()) return disabled(reply);

    const { jid, text } = request.body || {};
    if (!jid || !text) {
      return reply.code(400).send({ error: 'jid e text obrigatórios' });
    }

    await waClient.sendText(jid, text);
    return { ok: true };
  });
};
