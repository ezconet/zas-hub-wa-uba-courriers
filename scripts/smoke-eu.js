// Smoke: euDetector janela de coleta → webhook eu-received (sem WhatsApp real).
process.env.WA_GROUP_JID = 'grp@g.us';
process.env.ZASHUB_WEBHOOK_URL = 'http://localhost:9/api';
process.env.ZASHUB_WEBHOOK_SECRET = 'whsec';
process.env.API_SECRET = 'apikey';
process.env.DB_PATH = './data/smoke-eu.db';
process.env.DISPATCH_QUEUE_WINDOW_MS = '120';

const fs = require('fs');
try { fs.unlinkSync('./data/smoke-eu.db'); } catch {}

const db = require('../src/db/database');
const webhook = require('../src/services/webhook');
const euDetector = require('../src/services/euDetector');

const fired = [];
webhook.sendEuReceived = async (orderId, entries) => { fired.push({ orderId, entries }); };

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const euMsg = (id, jid, stanzaId) => ({
  key: { id, participant: jid, remoteJid: 'grp@g.us', fromMe: false },
  message: stanzaId ? { extendedTextMessage: { text: 'eu', contextInfo: { stanzaId } } } : { conversation: 'eu' },
});

async function main() {
  db.connect(process.env.DB_PATH);
  db.insertGroupMsg('m1', 'order-1');

  // PLAIN: 2 "eu"s na janela → 1 webhook com 2 entries para o group_msg mais recente
  await euDetector.handleEu(euMsg('e1', 'moto-a@s.whatsapp.net'));
  await euDetector.handleEu(euMsg('e2', 'moto-b@s.whatsapp.net'));
  await sleep(250);
  check('plain: 1 webhook disparado', fired.length === 1);
  check('plain: orderId correto', fired[0]?.orderId === 'order-1');
  check('plain: 2 entries coletados', fired[0]?.entries.length === 2);
  check('plain: mode=plain', fired[0]?.entries[0].mode === 'plain');
  check('plain: entry tem jid/msgId/receivedAt', !!fired[0]?.entries[0].jid && !!fired[0]?.entries[0].msgId && !!fired[0]?.entries[0].receivedAt);

  // QUOTED: stanzaId conhecido → mode quoted (rodada nova: limpa marca do plain anterior)
  fired.length = 0;
  db.clearEuDispatched('order-1');
  await euDetector.handleEu(euMsg('e3', 'moto-c@s.whatsapp.net', 'm1'));
  await sleep(250);
  check('quoted: webhook disparado', fired.length === 1);
  check('quoted: mode=quoted', fired[0]?.entries[0].mode === 'quoted');

  // QUOTED desconhecido (R08) → ignorado
  fired.length = 0;
  await euDetector.handleEu(euMsg('e4', 'moto-d@s.whatsapp.net', 'STANZA_DESCONHECIDA'));
  await sleep(250);
  check('R08: quote desconhecido ignorado (sem webhook)', fired.length === 0);

  // R12 durável: order-1 já disparado (sucesso) → "eu" tardio NÃO re-dispara (anti gasto duplo)
  fired.length = 0;
  check('order-1 marcado no DB', db.isEuDispatched('order-1') === true);
  await euDetector.handleEu(euMsg('e5', 'moto-e@s.whatsapp.net'));
  await sleep(250);
  check('R12: "eu" tardio de order disparado → sem webhook', fired.length === 0);

  // Re-announce reabre: clearEuDispatched → "eu" volta a disparar
  fired.length = 0;
  db.clearEuDispatched('order-1');
  await euDetector.handleEu(euMsg('e6', 'moto-f@s.whatsapp.net'));
  await sleep(250);
  check('re-announce reabre escuta → webhook dispara', fired.length === 1);

  // Webhook falha (R05 esgotado) → NÃO marca → próximo "eu" re-dispara
  db.insertGroupMsg('m2', 'order-2');
  db.clearEuDispatched('order-2');
  fired.length = 0;
  webhook.sendEuReceived = async () => { throw new Error('rede caiu'); };
  await euDetector.handleEu(euMsg('e7', 'moto-g@s.whatsapp.net', 'm2'));
  await sleep(250);
  check('webhook falho → order-2 NÃO marcado', db.isEuDispatched('order-2') === false);
  webhook.sendEuReceived = async (orderId, entries) => { fired.push({ orderId, entries }); };
  await euDetector.handleEu(euMsg('e8', 'moto-h@s.whatsapp.net', 'm2'));
  await sleep(250);
  check('webhook falho → re-dispatch posterior funciona', fired.length === 1 && fired[0].orderId === 'order-2');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERRO:', e); process.exit(1); });
