const waClient = require('../whatsapp/client');
const db = require('../db/database');
const crmClient = require('../api/crmClient');
const config = require('../config');
const { buildGroupMessage } = require('../utils/messageBuilder');
const { confirmStep } = require('../utils/testConfirm');

/**
 * Anuncia um pedido no grupo de motoboys.
 * Controle de deduplicação:
 *   1. Insere no SQLite PRIMEIRO (proteção principal)
 *   2. Chama API para atualizar substatus DEPOIS (proteção secundária)
 *
 * @param {object} apiOrder  - Objeto bruto retornado pela API
 * @param {object} orderData - JSON do pedido já parseado
 */
async function announceOrder(apiOrder, orderData) {
  const merchant = config.MERCHANTS[orderData.merchant?.id] || config.MERCHANTS.DEFAULT;
  const neighborhood = orderData.delivery?.deliveryAddress?.neighborhood || '';

  const text = buildGroupMessage({
    displayId: orderData.displayId,
    neighborhood,
    bairroRetirada: merchant.pickupBairro,
  });

  // Confirmação do operador em TEST_MODE
  const ok = await confirmStep(`Enviar mensagem de chamada do Pedido ${orderData.displayId} (${neighborhood}) no grupo?`);
  if (!ok) {
    console.log(`[TEST] Envio do pedido ${orderData.displayId} cancelado pelo operador.`);
    return;
  }

  // Enviar no grupo
  let sentKey = null;
  try {
    // TODO: reativar após teste
     const result = await waClient.sendText(config.WHATSAPP_GROUP_JID, text);
     sentKey = result?.key?.id || null;
    //console.log(`[ANNOUNCE] [TESTE] Pedido ${orderData.displayId} — envio ao grupo DESATIVADO temporariamente. msg_id=${sentKey}`);
  } catch (err) {
    console.error(`[ANNOUNCE] Falha ao enviar pedido ${orderData.displayId} ao grupo:`, err.message);
    throw err; // Não salvar no DB se não conseguiu enviar
  }

  // Salvar no SQLite PRIMEIRO (proteção primária contra reenvio)
  db.insertAnnouncedOrder({
    id_pedido: apiOrder.idPedido,
    id_board: apiOrder.idBoard,
    display_id: orderData.displayId,
    merchant_id: orderData.merchant?.id || 'unknown',
    neighborhood,
    full_json: apiOrder.json,
    group_msg_id: sentKey,
    announced_at: new Date().toISOString(),
  });

  // Log no banco
  try {
    db.logMessage({
      id_pedido: apiOrder.idPedido,
      recipient_jid: config.WHATSAPP_GROUP_JID,
      message_type: 'group_announce',
      sent_at: new Date().toISOString(),
      success: 1,
      error_text: null,
    });
  } catch (_) { /* log silencioso */ }

  // Atualizar API DEPOIS (proteção secundária — não-fatal se falhar)
  try {
    await crmClient.updateOrderFase(apiOrder.idPedido, 'motoboyacionado');
    console.log(`[API] Pedido ${orderData.displayId} → motoboyacionado`);
  } catch (err) {
    console.warn(`[API] Falha ao atualizar substatus do pedido ${orderData.displayId}:`, err.message);
    // SQLite já garantiu a deduplicação — continua
  }
}

/**
 * Registra pedido que não precisa de motoboy: não anuncia no grupo,
 * salva no DB para deduplicação e avança a fase no CRM.
 */
async function finalizeWithoutMotoboy(apiOrder, orderData) {
  console.log(`[ANNOUNCE] Pedido ${orderData.displayId} — precisaDeMotoboy=false recebido da API. NÃO será anunciado no grupo. Finalizando diretamente.`);

  db.insertNoMotoboyOrder({
    id_pedido: apiOrder.idPedido,
    id_board: apiOrder.idBoard,
    display_id: orderData.displayId,
    merchant_id: orderData.merchant?.id || 'unknown',
    neighborhood: orderData.delivery?.deliveryAddress?.neighborhood || '',
    full_json: apiOrder.json,
    announced_at: new Date().toISOString(),
  });

  try {
    await crmClient.updateOrderFase(apiOrder.idPedido, 'motoboyacionado');
    console.log(`[API] Pedido ${orderData.displayId} → motoboyacionado (sem motoboy)`);
  } catch (err) {
    console.warn(`[API] Falha ao atualizar fase do pedido ${orderData.displayId}:`, err.message);
  }
}

module.exports = { announceOrder, finalizeWithoutMotoboy };
