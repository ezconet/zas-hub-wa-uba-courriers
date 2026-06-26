const config = require('../config');
const db = require('../db/database');
const waClient = require('../wa/client');
const webhook = require('../services/webhook');
const log = require('../utils/logger').createLogger('DISPATCH');
const flow = require('../utils/logger').createLogger('FLOW');

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

    flow.info(`ANNOUNCE solicitado pelo Hub | pedido=${orderId}`);
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
    flow.info(`ANNOUNCE enviado ao grupo | pedido=${orderId} | msgId=${msgId} | escutando "eu"...`);
    return { msgId };
  });

  // S08 — POST /group/react { euMsgId, emoji, euJid?, orderId? }
  // euJid = participante que mandou o "eu" (vem no webhook eu-received). Necessário
  // pra reagir em msg de membro de grupo: sem participant a key não localiza a msg.
  // Spec 099: guard de elegibilidade. Antes de reagir, consulta o Hub e só reage se
  // o pedido ainda está READY. Evita dar 👍 em pedido já atribuído quando a courrier
  // reconecta e re-entrega "eu"s antigos. Fail-closed: na dúvida, não reage.
  fastify.post('/group/react', async (request, reply) => {
    if (!dispatchEnabled()) return disabled(reply);

    const { euMsgId, emoji, euJid, orderId } = request.body || {};
    if (!euMsgId || !emoji) {
      return reply.code(400).send({ error: 'euMsgId e emoji obrigatórios' });
    }

    const winnerPhone = waClient.phoneOf(euJid);
    flow.info(`REACT solicitado pelo Hub (winner) | pedido=${orderId || '-'} | winner_phone=${winnerPhone} | emoji=${emoji} | euMsgId=${euMsgId}`);

    if (config.REACT_GUARD_ENABLED) {
      // Sem orderId não há como validar → fail-closed (não reage).
      if (!orderId) {
        flow.warn(`REACT BLOQUEADO (guard: sem orderId) | winner_phone=${winnerPhone} | euMsgId=${euMsgId}`);
        return reply.code(409).send({ ok: false, skipped: true, reason: 'orderId ausente' });
      }
      const eligible = await webhook.isOrderEligible(orderId);
      if (!eligible) {
        flow.warn(`REACT BLOQUEADO (guard: pedido não elegível/READY) | pedido=${orderId} | winner_phone=${winnerPhone}`);
        return reply.code(409).send({ ok: false, skipped: true, reason: 'not_eligible' });
      }
    }

    // SHADOW: não aplica o 👍 — só loga o que faria. Operador marca manual e valida.
    if (config.REACT_DRY_RUN) {
      flow.warn(`REACT DRY-RUN (NÃO reagiu — marque na mão) | pedido=${orderId || '-'} | winner_phone=${winnerPhone} | euMsgId=${euMsgId}`);
      return { ok: true, dryRun: true, winnerPhone, euMsgId };
    }

    const msgKey = { remoteJid: config.WA_GROUP_JID, id: euMsgId, fromMe: false };
    if (euJid) msgKey.participant = euJid;
    await waClient.sendReaction(config.WA_GROUP_JID, msgKey, emoji);
    flow.info(`REACT aplicado 👍 | pedido=${orderId || '-'} | winner_phone=${winnerPhone}`);
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
