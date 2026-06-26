const config = require('../config');
const db = require('../db/database');
const waClient = require('../wa/client');
const webhook = require('./webhook');
const flow = require('../utils/logger').createLogger('FLOW');

const QUEUE_WINDOW_MS = config.DISPATCH_QUEUE_WINDOW_MS; // janela de coleta (default 4s)

// Idade (s) do announce a partir de sent_at (datetime('now') = UTC sem timezone).
function announceAgeSec(sentAt) {
  if (!sentAt) return null;
  const ms = Date.now() - Date.parse(`${sentAt}Z`);
  return Math.round(ms / 1000);
}

// Map: orderId → { timer, entries: [{ jid, msgId, mode, receivedAt }] }
const orderQueue = new Map();

// R11: lock em memória — orderIds cujo webhook está sendo disparado.
// Bloqueia processamento duplicado durante o await assíncrono do POST.
const processingOrders = new Set();

/**
 * Processa uma mensagem "eu" recebida no grupo de motoboys.
 *
 * QUOTED: motoboy citou nossa mensagem → match exato msg_id = stanzaId.
 * PLAIN:  "eu" sem quote → atribui ao group_msg mais recente (janela aberta).
 *
 * Não há regra de negócio aqui: apenas coleta os "eu"s da janela de 4s e
 * dispara o webhook para o ZasHub decidir quem ganhou.
 */
async function handleEu(msg) {
  const rawJid = msg.key.participant;
  const motoboyJid = waClient.resolveJid(rawJid) || rawJid;
  if (motoboyJid !== rawJid) {
    console.log(`[EU] LID resolvido: ${rawJid} → ${motoboyJid}`);
  } else if (rawJid && rawJid.endsWith('@lid')) {
    console.warn(`[EU] LID não resolvido ainda: ${rawJid}. Usando como fallback.`);
  }

  const stanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
  const euMsgId = msg.key.id;
  // Timestamp do servidor WA (hora real de envio), em ms. Independe de atraso de
  // decrypt: se a msg do 1º motoboy chegar atrasada, o hub ainda ordena por envio real.
  const waTs = msg.messageTimestamp
    ? Number(msg.messageTimestamp) * 1000
    : null;

  const phone = waClient.phoneOf(motoboyJid);
  let orderId = null;
  let mode = null;
  let ageSec = null;

  if (stanzaId) {
    // CASO 1: quote — só processa se for uma das nossas mensagens (R08/R09).
    const row = db.getOrderByMsgId(stanzaId);
    if (!row) {
      flow.warn(`EU IGNORADO (quote de outro) | phone=${phone} | stanzaId=${stanzaId} não é pedido nosso`);
      return;
    }
    orderId = row.order_id;
    mode = 'quoted';
    ageSec = announceAgeSec(row.sent_at);
    flow.info(`EU recebido | phone=${phone} | modo=QUOTE | pedido=${orderId} | announce há ${ageSec}s | euMsgId=${euMsgId}`);
  } else {
    // CASO 2: plain — atribui ao group_msg mais recente.
    // RISCO: se outro comércio pede motoboy no MESMO grupo, o "eu" plain do motoboy
    // pra ELE cai no nosso último announce. Guard de idade (PLAIN_EU_MAX_AGE_MS) limita.
    const row = db.getMostRecentGroupMsg();
    if (!row) {
      flow.warn(`EU IGNORADO (sem announce nosso) | phone=${phone} | plain "eu"`);
      return;
    }
    orderId = row.order_id;
    mode = 'plain';
    ageSec = announceAgeSec(row.sent_at);
    const announceMs = row.sent_at ? Date.parse(`${row.sent_at}Z`) : null;

    // GUARD principal: "eu" enviado antes do nosso announce não é do nosso pedido
    // (resposta não precede o estímulo) → é de outro comércio no mesmo grupo. Rejeita.
    if (
      config.PLAIN_EU_REQUIRE_AFTER_ANNOUNCE &&
      waTs && announceMs &&
      waTs < announceMs - config.PLAIN_EU_AFTER_GRACE_MS
    ) {
      const deltaS = Math.round((announceMs - waTs) / 1000);
      flow.warn(`EU IGNORADO (enviado ${deltaS}s ANTES do announce → outro comércio) | phone=${phone} | pedido=${orderId}`);
      return;
    }

    // GUARD secundário (opcional): announce velho demais → provável outro comércio.
    const maxAge = config.PLAIN_EU_MAX_AGE_MS;
    if (maxAge > 0 && ageSec != null && ageSec * 1000 > maxAge) {
      flow.warn(`EU IGNORADO (plain velho, provável outro comércio) | phone=${phone} | pedido=${orderId} | announce há ${ageSec}s > limite ${maxAge / 1000}s`);
      return;
    }
    flow.info(`EU recebido | phone=${phone} | modo=PLAIN | pedido=${orderId} | announce há ${ageSec}s | euMsgId=${euMsgId}`);
  }

  // R12 (1/2): double-check na entrada, antes de enfileirar.
  //   - DB (durável): webhook já disparado com sucesso → não re-disparar (anti double-dispatch).
  //   - Set (in-flight): webhook do mesmo pedido em voo agora.
  if (db.isEuDispatched(orderId) || processingOrders.has(orderId)) {
    flow.info(`EU ignorado (pedido já disparado/em processamento) | phone=${phone} | pedido=${orderId}`);
    return;
  }

  _enqueue(orderId, motoboyJid, euMsgId, mode, waTs);
}

function _enqueue(orderId, jid, msgId, mode, waTs) {
  const phone = waClient.phoneOf(jid);
  const entry = {
    jid,
    msgId,
    mode,
    receivedAt: new Date().toISOString(), // hora de chegada local (pode atrasar por decrypt)
    waTimestamp: waTs,                     // hora real de envio no servidor WA (ms) — ordenar por isto
  };

  if (!orderQueue.has(orderId)) {
    // Primeiro "eu" — abre a janela de coleta (R10: nunca processa imediato).
    const slot = { timer: null, entries: [entry] };
    slot.timer = setTimeout(() => _processQueue(orderId), QUEUE_WINDOW_MS);
    orderQueue.set(orderId, slot);
    flow.info(`JANELA ABERTA | pedido=${orderId} | 1º eu phone=${phone} | aguardando ${QUEUE_WINDOW_MS / 1000}s...`);
  } else {
    // "eu" adicional dentro da janela — só acumula.
    const slot = orderQueue.get(orderId);
    slot.entries.push(entry);
    flow.info(`+EU na janela | pedido=${orderId} | phone=${phone} | total=${slot.entries.length}`);
  }
}

async function _processQueue(orderId) {
  const slot = orderQueue.get(orderId);
  orderQueue.delete(orderId);

  if (!slot || slot.entries.length === 0) return;

  // R12 (2/2): double-check antes de processar a fila (estado pode ter mudado na janela).
  if (db.isEuDispatched(orderId) || processingOrders.has(orderId)) {
    flow.info(`Fila descartada (pedido já disparado/em processamento) | pedido=${orderId}`);
    return;
  }

  // R11: trava ANTES do primeiro await (POST webhook) e libera no finally.
  processingOrders.add(orderId);

  // Ordena por waTimestamp só para o LOG (não muta o payload): mostra a ordem real
  // de envio no WhatsApp — o "primeiro a falar eu" deveria ser o winner no Hub.
  const ordered = [...slot.entries]
    .map((e) => ({ phone: waClient.phoneOf(e.jid), mode: e.mode, ts: e.waTimestamp }))
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const phones = ordered
    .map((e, i) => `${i + 1}º ${e.phone}[${e.mode}]@${e.ts ? new Date(e.ts).toISOString().slice(11, 19) : '??'}`)
    .join(', ');
  try {
    flow.info(`JANELA FECHADA → enviando ao Hub | pedido=${orderId} | ${slot.entries.length} eu(s) por ordem de envio WA: ${phones}`);
    await webhook.sendEuReceived(orderId, slot.entries);
    // Marca SÓ após sucesso: webhook falho (R05 esgotado) não trava o pedido,
    // próximo "eu" re-dispara (ninguém foi acionado → sem custo). Sucesso trava
    // de forma durável → segundo motoboy nunca é acionado (sem gasto duplo).
    db.markEuDispatched(orderId);
    flow.info(`eu-received OK (Hub recebeu, vai decidir winner) | pedido=${orderId}`);
  } catch (err) {
    flow.error(`eu-received FALHOU | pedido=${orderId} | ${err.message}`);
  } finally {
    processingOrders.delete(orderId);
  }
}

module.exports = { handleEu };
