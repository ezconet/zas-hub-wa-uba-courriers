const cron = require('node-cron');
const crmClient = require('../api/crmClient');
const db = require('../db/database');
const orderSender = require('./orderSender');
const config = require('../config');

async function poll() {
  let orders;
  try {
    orders = await crmClient.fetchProntoOrders();
  } catch (err) {
    console.error('[POLL] Falha ao buscar pedidos da API:', err.message);
    return;
  }

  // Filtrar apenas pedidos na fase 'pronto'
  const prontoOrders = orders.filter(o => o.fase === 'pronto');

  let announced = 0;

  for (const apiOrder of prontoOrders) {
    try {
      let orderData;
      try {
        orderData = JSON.parse(apiOrder.json);
      } catch (err) {
        console.warn(`[POLL] JSON inválido no pedido idBoard=${apiOrder.idBoard}. Pulando.`);
        continue;
      }

      // Apenas deliveries (não retirada pelo cliente)
      if (orderData.orderType !== 'DELIVERY') continue;

      // Verificar se já foi anunciado (proteção dupla: DB é a fonte primária)
      if (db.isOrderAnnounced(apiOrder.idPedido)) continue;

      if (apiOrder.precisaDeMotoboy === false) {
        await orderSender.finalizeWithoutMotoboy(apiOrder, orderData);
        announced++;
        continue;
      }

      await orderSender.announceOrder(apiOrder, orderData);
      announced++;

      // Pequena pausa entre anúncios para não sobrecarregar o WhatsApp
      if (announced > 0) await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`[POLL] Erro ao processar pedido ${apiOrder.idPedido}:`, err.message);
    }
  }

  if (prontoOrders.length > 0 || announced > 0) {
    console.log(`[POLL] ${orders.length} pedidos no dia, ${prontoOrders.length} prontos, ${announced} novos anunciados`);
  }
}

function startPoller() {
  console.log(`[POLL] Iniciando poller com intervalo: ${config.POLL_INTERVAL_CRON}`);

  // Executa imediatamente na inicialização
  poll().catch(err => console.error('[POLL] Erro na primeira execução:', err.message));

  // Agenda execuções periódicas
  cron.schedule(config.POLL_INTERVAL_CRON, () => {
    poll().catch(err => console.error('[POLL] Erro no cron:', err.message));
  });
}

module.exports = { startPoller, poll };
