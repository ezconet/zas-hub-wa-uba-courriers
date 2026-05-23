// Mock do ZasHub p/ teste E2E local — simula como o ZasHub vai falar com a API.
// Fecha o loop: anuncia pedido mock -> recebe webhook eu-received -> reage 👍 + manda PV.
//
// Uso:
//   1) pare o webhook-sink (mesma porta 3081)
//   2) node scripts/mock-zashub.js
//   3) dispare um pedido mock:  curl http://127.0.0.1:3081/mock/announce
//      (ou abra no navegador). Repita p/ vários pedidos.
//   4) responda "eu" no grupo "Motoboys Teste" no WhatsApp.
//
// Requer a API rodando (node src/index.js) na porta 3080.
require('dotenv').config();

const http = require('http');

const PORT = 3081;
const API = process.env.WA_API_URL || 'http://127.0.0.1:3080';
const API_KEY = process.env.API_SECRET || 'devkey';
const WEBHOOK_SECRET = process.env.ZASHUB_WEBHOOK_SECRET || 'devsecret';

// Pedidos mock anunciados: orderId -> dados (p/ compor MSG de PV depois)
const orders = new Map();
let seq = 0;

// ---- chamadas à nossa API (como o ZasHub fará) ----
async function apiPost(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function mapUrl(q) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

// ---- anuncia um pedido mock no grupo ----
async function announceMockOrder() {
  seq += 1;
  const displayId = `MOCK${String(seq).padStart(3, '0')}`;
  const order = {
    orderId: `mock-${Date.now()}-${seq}`,
    displayId,
    neighborhood: 'Itaguá',
    customer: 'Cliente Teste',
    address: 'Rua das Flores, 123',
    merchant: { name: 'Zás', pickupAddress: 'Rua Capitao Felipe, 309', pickupBairro: 'Itaguá' },
  };

  const text =
    `🧪 Entrega ${order.neighborhood}\n\nPedido ${displayId}\n\n` +
    `Retira no(a) ${order.merchant.pickupBairro}\n\nResponda *eu* pra aceitar`;

  const { msgId } = await apiPost('/group/announce', { orderId: order.orderId, text });
  orders.set(order.orderId, order);
  console.log(`\n[MOCK] 📢 announce ${displayId} (orderId=${order.orderId}) msgId=${msgId}`);
  return { displayId, orderId: order.orderId, msgId };
}

// ---- ao receber eu-received: escolhe vencedor, reage e manda PV ----
async function handleEuReceived(payload) {
  const { orderId, entries } = payload;
  const order = orders.get(orderId) || { displayId: orderId, merchant: { name: 'Restaurante', pickupAddress: '?', pickupBairro: '?' }, address: '?', neighborhood: '?', customer: '?' };

  console.log(`[MOCK] 📥 eu-received ${order.displayId}: ${entries.length} "eu"(s)`);
  entries.forEach((e, i) => console.log(`        ${i === 0 ? '👑' : '  '} ${e.jid} (${e.mode}) msgId=${e.msgId}`));

  const winner = entries[0]; // regra de teste: primeiro a chegar vence

  // 1) reação 👍 na msg "eu" do vencedor (precisa euJid = participant)
  try {
    await apiPost('/group/react', { euMsgId: winner.msgId, emoji: '👍', euJid: winner.jid });
    console.log(`[MOCK] 👍 reagiu no "eu" de ${winner.jid}`);
  } catch (e) { console.error('[MOCK] falha react:', e.message); }

  // 2) MSG retirada (PV)
  const m1 = `🧪 Retirada: Restaurante ${order.merchant.name}\n\n${order.merchant.pickupAddress} - ${order.merchant.pickupBairro}\n\nRota RETIRADA: ${mapUrl(order.merchant.pickupAddress + ', Ubatuba')}`;
  // 3) MSG entrega (PV)
  const m2 = `🧪 Entrega — Pedido ${order.displayId}\n\nCliente: ${order.customer}\nEndereço: ${order.address}\nBairro: ${order.neighborhood}\n\nRota ENTREGA: ${mapUrl(order.address + ', ' + order.neighborhood + ', Ubatuba')}`;

  for (const [n, text] of [['MSG1 retirada', m1], ['MSG2 entrega', m2]]) {
    try {
      await apiPost('/message/send', { jid: winner.jid, text });
      console.log(`[MOCK] 📨 ${n} -> ${winner.jid}`);
      await new Promise((r) => setTimeout(r, 600)); // R04 pacing
    } catch (e) { console.error(`[MOCK] falha ${n}:`, e.message); }
  }
}

// ---- servidor: recebe webhooks da API + trigger de pedido mock ----
http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/mock/announce') {
    try { const r = await announceMockOrder(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r)); }
    catch (e) { res.writeHead(502); res.end(e.message); }
    return;
  }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const secret = req.headers['x-webhook-secret'];
    if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) { res.writeHead(401); res.end('unauthorized'); return; }

    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch {}

    if (url === '/wa/eu-received') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
      handleEuReceived(payload).catch((e) => console.error('[MOCK] erro:', e.message));
      return;
    }
    if (url === '/wa/connected') {
      console.log(`[MOCK] 🔌 connected @ ${payload.timestamp}`);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
      return;
    }
    res.writeHead(404); res.end('not found');
  });
}).listen(PORT, () => {
  console.log(`[MOCK] ZasHub mock ouvindo em http://127.0.0.1:${PORT}`);
  console.log(`[MOCK] API alvo: ${API}`);
  console.log(`[MOCK] Dispare pedido: curl http://127.0.0.1:${PORT}/mock/announce`);
});
