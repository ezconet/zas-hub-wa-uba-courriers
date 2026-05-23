const db = require('../db/database');
const motoboySender = require('./motoboySender');
const waClient = require('../whatsapp/client');

const QUEUE_WINDOW_MS = 4000; // aguarda 4s coletando "eu"s antes de processar

// Map: idPedido → { timer, entries: [{ order, motoboyJid, euMsgKey, detectionMode }] }
const orderQueue = new Map();

// Pedidos cuja aceitação já foi iniciada — lock em memória para evitar duplo processamento
// enquanto o DB ainda não foi escrito (janela entre await confirmStep e STEP 0)
const processingOrders = new Set();

/**
 * Processa uma mensagem "eu" recebida no grupo de motoboys.
 *
 * CASO 1 - Quoted reply: o motoboy citou diretamente nossa mensagem.
 *   → match exato via group_msg_id = stanzaId
 *
 * CASO 2 - Plain "eu": o motoboy enviou sem citar nenhuma mensagem.
 *   → atribui ao pedido pending mais recente (janela aberta)
 */
async function handleEu(msg) {
  const rawJid = msg.key.participant;
  const motoboyJid = waClient.resolveJid(rawJid) || rawJid;
  if (motoboyJid !== rawJid) {
    console.log(`[EU] LID resolvido: ${rawJid} → ${motoboyJid}`);
  } else if (rawJid.endsWith('@lid')) {
    console.warn(`[EU] LID não resolvido ainda: ${rawJid}. Usando como fallback.`);
  }
  const stanzaId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;

  let order = null;
  let detectionMode = null;

  if (stanzaId) {
    // CASO 1: Reply com quote — verifica se é uma das nossas mensagens
    order = db.getOrderByGroupMsgId(stanzaId);
    if (order) {
      detectionMode = 'quoted';
      console.log(`[EU] Quote detectado. stanzaId=${stanzaId} → pedido ${order.display_id}`);
    } else {
      // Quote de outra mensagem (outro comércio, etc.) — ignorar
      console.log(`[EU] Quote ignorado: stanzaId=${stanzaId} não pertence a pedido nosso`);
      return;
    }
  } else {
    // CASO 2: Sem quote — atribui ao pedido pending mais recente
    order = db.getMostRecentPendingOrder();
    if (!order) {
      console.log('[EU] Sem pedidos pendentes. "eu" ignorado.');
      return;
    }
    detectionMode = 'plain';
    console.log(`[EU] Plain "eu" de ${motoboyJid} → fila para pedido ${order.display_id}`);
  }

  // Verificar se o pedido já foi aceito (DB) ou está sendo processado (lock em memória)
  if (db.isOrderAccepted(order.id_pedido) || processingOrders.has(order.id_pedido)) {
    console.log(`[EU] Pedido ${order.display_id} já aceito/em processamento. "eu" de ${motoboyJid} ignorado.`);
    return;
  }

  _enqueue(order, motoboyJid, msg.key, detectionMode);
}

function _enqueue(order, motoboyJid, euMsgKey, detectionMode) {
  const idPedido = order.id_pedido;

  if (!orderQueue.has(idPedido)) {
    // Primeiro "eu" para este pedido — abre a janela de coleta
    orderQueue.set(idPedido, { timer: null, entries: [] });
    const entry = orderQueue.get(idPedido);
    entry.entries.push({ order, motoboyJid, euMsgKey, detectionMode });
    entry.timer = setTimeout(() => _processQueue(idPedido), QUEUE_WINDOW_MS);
    console.log(`[EU] Pedido ${order.display_id}: 1º "eu" de ${motoboyJid}. Aguardando ${QUEUE_WINDOW_MS / 1000}s por mais respostas...`);
  } else {
    // "eu" adicional dentro da janela — só registra
    const entry = orderQueue.get(idPedido);
    entry.entries.push({ order, motoboyJid, euMsgKey, detectionMode });
    console.log(`[EU] Pedido ${order.display_id}: +1 "eu" de ${motoboyJid} (${entry.entries.length} na fila).`);
  }
}

async function _processQueue(idPedido) {
  const entry = orderQueue.get(idPedido);
  orderQueue.delete(idPedido);

  if (!entry || entry.entries.length === 0) return;

  const { order, motoboyJid, euMsgKey, detectionMode } = entry.entries[0];

  if (entry.entries.length > 1) {
    const outros = entry.entries.slice(1).map(e => e.motoboyJid).join(', ');
    console.log(`[EU] Pedido ${order.display_id}: ${entry.entries.length} "eu"s recebidos. Processando 1º: ${motoboyJid}. Ignorando: ${outros}`);
  }

  // Safety net: double-check DB + lock em memória antes de processar
  if (db.isOrderAccepted(order.id_pedido) || processingOrders.has(order.id_pedido)) {
    console.log(`[EU] Pedido ${order.display_id} já aceito/em processamento. Fila descartada.`);
    return;
  }

  // Trava imediata — antes de qualquer await — para bloquear "eus" que chegarem
  // durante a execução assíncrona de processAcceptance
  processingOrders.add(order.id_pedido);

  try {
    await motoboySender.processAcceptance(order, motoboyJid, euMsgKey, detectionMode);
  } catch (err) {
    console.error(`[EU] Erro ao processar aceitação do pedido ${order.display_id}:`, err.message);
  } finally {
    processingOrders.delete(order.id_pedido);
  }
}

module.exports = { handleEu };
