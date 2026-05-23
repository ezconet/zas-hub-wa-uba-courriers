// Smoke test: exercita rotas via fastify.inject SEM conectar ao WhatsApp.
// Stub do envio WA para validar fluxo announce/react/send + R02 + auth + 423.
process.env.WA_GROUP_JID = process.env.WA_GROUP_JID || 'grp-test@g.us';
process.env.ZASHUB_WEBHOOK_URL = process.env.ZASHUB_WEBHOOK_URL || 'http://localhost:9/api';
process.env.ZASHUB_WEBHOOK_SECRET = process.env.ZASHUB_WEBHOOK_SECRET || 'whsec';
process.env.API_SECRET = process.env.API_SECRET || 'apikey';
process.env.DB_PATH = process.env.DB_PATH || './data/smoke.db';

const fs = require('fs');
try { fs.unlinkSync('./data/smoke.db'); } catch {}

const Fastify = require('fastify');
const config = require('../src/config');
const db = require('../src/db/database');
const waClient = require('../src/wa/client');

// Stub WA — não conecta socket real
waClient.sendText = async (jid, text) => ({ key: { id: 'WAMSG_' + Math.random().toString(36).slice(2, 8) } });
waClient.sendReaction = async () => {};

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

async function main() {
  db.connect(config.DB_PATH);

  const app = Fastify({ logger: false });
  const PUBLIC = new Set(['/health/status']);
  app.addHook('onRequest', async (req, reply) => {
    if (PUBLIC.has(req.url.split('?')[0])) return;
    if (req.headers['x-api-key'] !== config.API_SECRET) reply.code(401).send({ error: 'unauthorized' });
  });
  await app.register(require('../src/routes/dispatch'));
  await app.register(require('../src/routes/control'));

  const KEY = { 'x-api-key': 'apikey' };

  // auth
  let r = await app.inject({ method: 'GET', url: '/dispatch/status' });
  check('401 sem x-api-key', r.statusCode === 401);

  r = await app.inject({ method: 'GET', url: '/dispatch/status', headers: KEY });
  check('status enabled=true (seed)', r.statusCode === 200 && r.json().enabled === true);

  // announce ok (R02: salva no DB após envio)
  r = await app.inject({ method: 'POST', url: '/group/announce', headers: KEY, payload: { orderId: 'o1', text: 'pedido pronto' } });
  const msgId = r.json().msgId;
  check('announce retorna msgId', r.statusCode === 200 && !!msgId);
  check('R02: group_msg salvo após envio', db.getOrderByMsgId(msgId)?.order_id === 'o1');

  // announce falha no envio → NÃO salva (R02)
  waClient.sendText = async () => { throw new Error('WA down'); };
  r = await app.inject({ method: 'POST', url: '/group/announce', headers: KEY, payload: { orderId: 'o2', text: 'x' } });
  check('R02: envio falha → 500', r.statusCode === 500);
  check('R02: orderId não salvo após falha', db.getMostRecentGroupMsg()?.order_id === 'o1');
  waClient.sendText = async () => ({ key: { id: 'WAMSG2' } });

  // disable → 423
  r = await app.inject({ method: 'POST', url: '/dispatch/disable', headers: KEY });
  check('disable → enabled=false', r.json().enabled === false);
  r = await app.inject({ method: 'POST', url: '/group/announce', headers: KEY, payload: { orderId: 'o3', text: 'x' } });
  check('announce 423 quando disabled', r.statusCode === 423);
  r = await app.inject({ method: 'POST', url: '/message/send', headers: KEY, payload: { jid: 'j@s.whatsapp.net', text: 'x' } });
  check('message/send 423 quando disabled', r.statusCode === 423);

  // re-enable + send/react ok
  await app.inject({ method: 'POST', url: '/dispatch/enable', headers: KEY });
  r = await app.inject({ method: 'POST', url: '/message/send', headers: KEY, payload: { jid: 'j@s.whatsapp.net', text: 'oi' } });
  check('message/send ok', r.json().ok === true);
  r = await app.inject({ method: 'POST', url: '/group/react', headers: KEY, payload: { euMsgId: 'WAMSG1', emoji: '👍', euJid: 'moto@s.whatsapp.net' } });
  check('group/react ok', r.json().ok === true);

  await app.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('SMOKE ERRO:', e); process.exit(1); });
