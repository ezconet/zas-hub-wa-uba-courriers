const axios = require('axios');
const config = require('../config');

const client = axios.create({
  baseURL: config.CRM_BASE_URL,
  timeout: 10000,
});

async function withRetry(fn, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = attempt * 1000;
      console.warn(`[API] Tentativa ${attempt} falhou. Aguardando ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * Busca todos os pedidos do dia na API.
 * @returns {Promise<Array>}
 */
async function fetchProntoOrders() {
  return withRetry(async () => {
    const { data } = await client.get('/board/ObterTodos');
    return Array.isArray(data) ? data : [];
  });
}

/**
 * Atualiza a fase de um pedido na API.
 * @param {string} idPedido
 * @param {string} fase  Ex: 'motoboysolicitado' | 'motoboyacionado'
 */
async function updateOrderFase(idPedido, fase) {
  return withRetry(async () => {
    const { data } = await client.get('/Board/AtualizaFase', {
      params: { idPedido, fase },
    });
    return data;
  });
}

/**
 * Busca um motoboy pelo telefone.
 * Resolve com os dados se encontrado, rejeita com err.response.status === 404 se não existir.
 * @param {string} fone  Ex: '11999999999'
 */
async function fetchMotoboy(fone) {
  return withRetry(async () => {
    const url = `${config.CRM_BASE_URL}/board/ObterMotoboy?fone=${fone}`;
    console.log(`[API] GET ${url}`);
    const { data } = await client.get('/board/ObterMotoboy', { params: { fone } });
    return data;
  });
}

/**
 * Atribui (ou cadastra) um motoboy a um pedido.
 * @param {{ IdPedido: string, Fone: string, Nome: string, Chave: string }} payload
 */
async function assignMotoboy(payload) {
  return withRetry(async () => {
    const { data } = await client.post('/board/AtribuirMotoboy', payload);
    return data;
  });
}

/**
 * [MOCK] Busca nome e chave PIX do motoboy atribuído a um pedido.
 * TODO: substituir pela URL real quando disponível.
 * @param {string} idPedido
 * @returns {Promise<{ nome: string, chave: string } | null>}
 */
async function fetchMotoboyByOrder(idPedido) {
  return withRetry(async () => {
    const { data } = await client.get('/board/ObterMotoboydoPedido', { params: { idPedido } });
    if (!data) return null;
    return {
      nome: data.nome || data.Nome || '',
      chave: data.chavePix || data.ChavePix || '',
    };
  });
}

/**
 * [MOCK] Atualiza a chave PIX de um motoboy pelo orderId.
 * TODO: substituir pela URL real quando disponível.
 * @param {string} idPedido
 * @param {string} novaChave
 */
async function updateMotoboyKey(idPedido, novaChave) {
  return withRetry(async () => {
    const { data } = await client.post('/board/AtualizarChaveMotoboy', { idPedido, ChavePix: novaChave });
    return data;
  });
}

module.exports = { fetchProntoOrders, updateOrderFase, fetchMotoboy, assignMotoboy, fetchMotoboyByOrder, updateMotoboyKey };
