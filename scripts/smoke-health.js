// Smoke: GRUPO 6 health check manual (sem WhatsApp real).
process.env.WA_GROUP_JID = 'grp@g.us';
process.env.WA_HEALTH_GROUP_JID = 'health@g.us';
process.env.ZASHUB_WEBHOOK_URL = 'http://localhost:9/api';
process.env.ZASHUB_WEBHOOK_SECRET = 'whsec';
process.env.API_SECRET = 'apikey';
process.env.DB_PATH = './data/smoke-health.db';
process.env.RETEST_WINDOW_MS = '150';

const fs = require('fs');
try { fs.unlinkSync('./data/smoke-health.db'); } catch {}

const Fastify = require('fastify');
const config = require('../src/config');
const db = require('../src/db/database');
const waClient = require('../src/wa/client');
const health = require('../src/services/health');

const sent = [];
waClient.sendText = async (jid, text) => { sent.push({ jid, text }); return { key: { id: 'x' } }; };
let reconnectCalled = false;
waClient.reconnect = () => { reconnectCalled = true; };
waClient.isConnected = () => true;

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  db.connect(config.DB_PATH);

  const app = Fastify({ logger: false });
  const PUBLIC = new Set(['/health/status']);
  app.addHook('onRequest', async (req, reply) => {
    if (PUBLIC.has(req.url.split('?')[0])) return;
    if (req.headers['x-api-key'] !== config.API_SECRET) reply.code(401).send({ error: 'unauthorized' });
  });
  await app.register(require('../src/routes/health'));
  const KEY = { 'x-api-key': 'apikey' };

  // S16: status público (sem api key)
  let r = await app.inject({ method: 'GET', url: '/health/status' });
  check('status público (200 sem key)', r.statusCode === 200);
  check('status tem campos', r.json().waConnected === true && typeof r.json().dispatchEnabled === 'boolean');

  // S14: ping (exige api key)
  r = await app.inject({ method: 'GET', url: '/health/ping' });
  check('ping exige api key (401)', r.statusCode === 401);
  r = await app.inject({ method: 'GET', url: '/health/ping', headers: KEY });
  check('ping → awaiting_manual_test', r.json().status === 'awaiting_manual_test');
  check('ping enviou aviso no health group', sent.some(s => s.jid === 'health@g.us'));
  check('estado persistido awaiting_manual_test', db.getState('health_status') === 'awaiting_manual_test');

  // S15a: retest com "eu" dentro da janela → healthy
  sent.length = 0;
  const p1 = app.inject({ method: 'GET', url: '/health/retest', headers: KEY });
  await sleep(50);
  health.notifyHealthEu(); // simula "eu" no grupo
  r = await p1;
  check('retest+eu → healthy', r.json().status === 'healthy');
  check('retest enviou "✅ eco ok"', sent.some(s => s.text.includes('eco ok')));
  check('estado healthy', db.getState('health_status') === 'healthy');

  // S15b: retest sem "eu" → timeout → degraded + reconnect
  sent.length = 0;
  reconnectCalled = false;
  r = await app.inject({ method: 'GET', url: '/health/retest', headers: KEY });
  check('retest timeout → degraded', r.json().status === 'degraded');
  check('retest timeout → action reconnecting', r.json().action === 'reconnecting');
  check('reconnect disparado', reconnectCalled === true);
  check('estado degraded', db.getState('health_status') === 'degraded');

  await app.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERRO:', e); process.exit(1); });
