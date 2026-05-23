const waClient = require('../whatsapp/client');
const db = require('../db/database');
const crmClient = require('../api/crmClient');
const config = require('../config');
const { buildMsg1, buildMsg2, buildMsg3 } = require('../utils/messageBuilder');
const motoboyRegistration = require('./motoboyRegistration');
const { confirmStep, promptValue } = require('../utils/testConfirm');

/**
 * Executa o fluxo completo de aceitação de pedido por um motoboy:
 * 1. Reação 👍 na mensagem "eu" do motoboy
 * 2. Envia MSG 1, 2, 3 privativamente
 * 3. Atualiza SQLite
 * 4. Atualiza API
 */
async function processAcceptance(order, motoboyJid, euMsgKey, detectionMode) {
  const orderData = JSON.parse(order.full_json);
  const merchant = config.MERCHANTS[orderData.merchant?.id] || config.MERCHANTS.DEFAULT;
  const now = new Date().toISOString();

  console.log(`[ACCEPT] Motoboy ${motoboyJid} aceitou pedido ${order.display_id} (modo: ${detectionMode})`);

  // CONFIRMAÇÃO 1: Marcar 👍 e prosseguir com aceitação
  const okAccept = await confirmStep(`Marcar 👍 para "${motoboyJid}" no pedido ${order.display_id}?`);
  if (!okAccept) {
    console.log(`[TEST] Aceitação do pedido ${order.display_id} cancelada pelo operador.`);
    return;
  }

  // STEP 0: Marcar como aceito no DB ANTES de qualquer await (evita race condition)
  // Se outro "eu" chegar enquanto enviamos as mensagens, o isOrderAccepted já retorna true
  db.setOrderAccepted(order.id_pedido, now);
  db.insertAcceptance({
    id_pedido: order.id_pedido,
    motoboy_jid: motoboyJid,
    detection_mode: detectionMode,
    accepted_at: now,
  });
  console.log(`[ACCEPT] DB bloqueado: pedido ${order.display_id} → accepted`);

  // STEP 1: Reagir com 👍 na mensagem "eu" do motoboy no grupo
  try {
    await waClient.sendReaction(config.WHATSAPP_GROUP_JID, euMsgKey, '👍');
    console.log(`[ACCEPT] Reação 👍 enviada`);
    _logMsg(order.id_pedido, config.WHATSAPP_GROUP_JID, 'reaction', true);
  } catch (err) {
    console.error('[ACCEPT] Falha ao enviar reação:', err.message);
    _logMsg(order.id_pedido, config.WHATSAPP_GROUP_JID, 'reaction', false, err.message);
    // Continua mesmo sem a reação
  }

  // CONFIRMAÇÃO 2: Enviar msgs privadas
  const okMsgs = await confirmStep(`Enviar MSG 1, 2, 3 para "${motoboyJid}" (pedido ${order.display_id})?`);
  if (!okMsgs) {
    console.log(`[TEST] Envio de mensagens privadas do pedido ${order.display_id} cancelado pelo operador.`);
    // DB já bloqueado, prossegue para API sem msgs
  } else {
    // STEP 2: MSG 1 – Endereço de retirada (privado)
    try {
      const text1 = buildMsg1(orderData, merchant);
      await waClient.sendText(motoboyJid, text1);
      console.log(`[ACCEPT] MSG 1 (retirada) enviada para ${motoboyJid}`);
      _logMsg(order.id_pedido, motoboyJid, 'private_pickup', true);
    } catch (err) {
      console.error('[ACCEPT] Falha ao enviar MSG 1:', err.message);
      _logMsg(order.id_pedido, motoboyJid, 'private_pickup', false, err.message);
      throw err;
    }

    // STEP 3: MSG 2 – Endereço de entrega (privado)
    try {
      const text2 = buildMsg2(orderData);
      await waClient.sendText(motoboyJid, text2);
      console.log(`[ACCEPT] MSG 2 (entrega) enviada para ${motoboyJid}`);
      _logMsg(order.id_pedido, motoboyJid, 'private_delivery', true);
    } catch (err) {
      console.error('[ACCEPT] Falha ao enviar MSG 2:', err.message);
      _logMsg(order.id_pedido, motoboyJid, 'private_delivery', false, err.message);
      throw err;
    }

    // STEP 4: MSG 3 – Link de confirmação (privado)
    try {
      const text3 = buildMsg3(orderData);
      await waClient.sendText(motoboyJid, text3);
      console.log(`[ACCEPT] MSG 3 (confirmação) enviada para ${motoboyJid}`);
      _logMsg(order.id_pedido, motoboyJid, 'private_confirm', true);
    } catch (err) {
      console.error('[ACCEPT] Falha ao enviar MSG 3:', err.message);
      _logMsg(order.id_pedido, motoboyJid, 'private_confirm', false, err.message);
      throw err;
    }
  }

  // STEP 5: Atualizar API
  try {
    await crmClient.updateOrderFase(order.id_pedido, 'motoboyacionado');
    console.log(`[API] Pedido ${order.display_id} → motoboyacionado`);
  } catch (err) {
    console.error(`[API] Falha ao atualizar fase para motoboyacionado (pedido ${order.display_id}):`, err.message);
    // Não relança: DB já atualizado
  }

  // STEP 6: Confirmação da chave (TEST_MODE: via API por orderId; produção: fluxo normal)
  if (config.TEST_MODE) {
    await _confirmChaveByOrder(order.id_pedido);
  } else {
    motoboyRegistration.startRegistration(order.id_pedido, motoboyJid).catch(err => {
      console.error(`[REG] Erro ao iniciar registro do motoboy:`, err.message);
    });
  }
}

/**
 * Em TEST_MODE: busca nome+chave do motoboy pelo orderId,
 * pede confirmação ao operador e atualiza via API se necessário.
 */
async function _confirmChaveByOrder(idPedido) {
  let motoboy = null;
  try {
    motoboy = await crmClient.fetchMotoboyByOrder(idPedido);
  } catch (err) {
    console.warn(`[TEST] Não foi possível buscar dados do motoboy para pedido ${idPedido}:`, err.message);
    return;
  }

  if (!motoboy || !motoboy.nome) {
    console.log(`[TEST] Motoboy não encontrado na API para pedido ${idPedido}. Pulando confirmação de chave.`);
    return;
  }

  console.log(`[TEST] Motoboy do pedido ${idPedido}: Nome="${motoboy.nome}", Chave="${motoboy.chave}"`);
  const okChave = await confirmStep(`Nome: "${motoboy.nome}" | Chave PIX: "${motoboy.chave}" — está correto?`);

  if (okChave) {
    console.log(`[TEST] Chave confirmada pelo operador.`);
    return;
  }

  // Operador disse que está errado — pede a chave correta
  const novaChave = await promptValue(`Digite a chave PIX correta para ${motoboy.nome}`);
  if (!novaChave) {
    console.warn(`[TEST] Nenhuma chave informada. Pulando atualização.`);
    return;
  }

  try {
    await crmClient.updateMotoboyKey(idPedido, novaChave);
    console.log(`[TEST] Chave atualizada para "${novaChave}" (pedido ${idPedido}).`);
  } catch (err) {
    console.error(`[TEST] Falha ao atualizar chave:`, err.message);
  }
}

function _logMsg(idPedido, recipientJid, type, success, errorText = null) {
  try {
    db.logMessage({
      id_pedido: idPedido,
      recipient_jid: recipientJid,
      message_type: type,
      sent_at: new Date().toISOString(),
      success: success ? 1 : 0,
      error_text: errorText,
    });
  } catch (_) { /* log silencioso */ }
}

module.exports = { processAcceptance };
