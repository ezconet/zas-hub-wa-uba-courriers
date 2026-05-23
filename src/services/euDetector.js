const config = require('../config');
const db = require('../db/database');
const waClient = require('../wa/client');
const webhook = require('./webhook');

const QUEUE_WINDOW_MS = config.DISPATCH_QUEUE_WINDOW_MS; // janela de coleta (default 4s)

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
  console.debug('[EU-DEBUG] handleEu entrou');
  const rawJid = msg.key.participant;
  const motoboyJid = waClient.resolveJid(rawJid) || rawJid;
  if (motoboyJid !== rawJid) {
    console.log(`[EU] LID resolvido: ${rawJid} → ${motoboyJid}`);
  } else if (rawJid && rawJid.endsWith('@lid')) {
    console.warn(`[EU] LID não resolvido ainda: ${rawJid}. Usando como fallback.`);
  }

  const stanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
  const euMsgId = msg.key.id;

  let orderId = null;
  let mode = null;

  if (stanzaId) {
    // CASO 1: quote — só processa se for uma das nossas mensagens (R08/R09).
    const row = db.getOrderByMsgId(stanzaId);
    if (!row) {
      console.log(`[EU] Quote ignorado: stanzaId=${stanzaId} não pertence a pedido nosso`);
      return;
    }
    orderId = row.order_id;
    mode = 'quoted';
    console.log(`[EU] Quote detectado. stanzaId=${stanzaId} → pedido ${orderId}`);
  } else {
    // CASO 2: plain — atribui ao group_msg mais recente.
    const row = db.getMostRecentGroupMsg();
    if (!row) {
      console.log('[EU] Sem mensagens de grupo registradas. "eu" ignorado.');
      return;
    }
    orderId = row.order_id;
    mode = 'plain';
    console.log(`[EU] Plain "eu" de ${motoboyJid} → fila para pedido ${orderId}`);
  }

  // R12 (1/2): double-check na entrada, antes de enfileirar.
  //   - DB (durável): webhook já disparado com sucesso → não re-disparar (anti double-dispatch).
  //   - Set (in-flight): webhook do mesmo pedido em voo agora.
  if (db.isEuDispatched(orderId) || processingOrders.has(orderId)) {
    console.log(`[EU] Pedido ${orderId} já disparado/em processamento. "eu" de ${motoboyJid} ignorado.`);
    return;
  }

  _enqueue(orderId, motoboyJid, euMsgId, mode);
}

function _enqueue(orderId, jid, msgId, mode) {
  const entry = { jid, msgId, mode, receivedAt: new Date().toISOString() };

  if (!orderQueue.has(orderId)) {
    // Primeiro "eu" — abre a janela de coleta (R10: nunca processa imediato).
    const slot = { timer: null, entries: [entry] };
    slot.timer = setTimeout(() => _processQueue(orderId), QUEUE_WINDOW_MS);
    orderQueue.set(orderId, slot);
    console.log(`[EU] Pedido ${orderId}: 1º "eu" de ${jid}. Aguardando ${QUEUE_WINDOW_MS / 1000}s...`);
  } else {
    // "eu" adicional dentro da janela — só acumula.
    const slot = orderQueue.get(orderId);
    slot.entries.push(entry);
    console.log(`[EU] Pedido ${orderId}: +1 "eu" de ${jid} (${slot.entries.length} na fila).`);
  }
}

async function _processQueue(orderId) {
  const slot = orderQueue.get(orderId);
  orderQueue.delete(orderId);

  if (!slot || slot.entries.length === 0) return;

  // R12 (2/2): double-check antes de processar a fila (estado pode ter mudado na janela).
  if (db.isEuDispatched(orderId) || processingOrders.has(orderId)) {
    console.log(`[EU] Pedido ${orderId} já disparado/em processamento. Fila descartada.`);
    return;
  }

  // R11: trava ANTES do primeiro await (POST webhook) e libera no finally.
  processingOrders.add(orderId);

  try {
    console.log(`[EU] Pedido ${orderId}: ${slot.entries.length} "eu"(s). Disparando webhook eu-received.`);
    await webhook.sendEuReceived(orderId, slot.entries);
    // Marca SÓ após sucesso: webhook falho (R05 esgotado) não trava o pedido,
    // próximo "eu" re-dispara (ninguém foi acionado → sem custo). Sucesso trava
    // de forma durável → segundo motoboy nunca é acionado (sem gasto duplo).
    db.markEuDispatched(orderId);
  } catch (err) {
    console.error(`[EU] Falha ao disparar webhook do pedido ${orderId}:`, err.message);
  } finally {
    processingOrders.delete(orderId);
  }
}

module.exports = { handleEu };
