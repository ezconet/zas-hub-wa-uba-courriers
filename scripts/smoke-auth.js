// Smoke: GRUPO 7 reconexão + QR + retry (sem WhatsApp/S3/SMTP reais).
process.env.WA_GROUP_JID = 'grp@g.us';
process.env.ZASHUB_WEBHOOK_URL = 'http://localhost:9/api';
process.env.ZASHUB_WEBHOOK_SECRET = 'whsec';
process.env.API_SECRET = 'apikey';
process.env.DB_PATH = './data/smoke-auth.db';

const fs = require('fs');
try { fs.unlinkSync('./data/smoke-auth.db'); } catch {}

const Fastify = require('fastify');
const config = require('../src/config');
const db = require('../src/db/database');
const waClient = require('../src/wa/client');
const qrNotifier = require('../src/services/qrNotifier');
const { withRetry } = require('../src/utils/retry');

let reconnectCalled = false;
waClient.reconnect = () => { reconnectCalled = true; };

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n); } };

async function main() {
  db.connect(config.DB_PATH);

  // --- withRetry (S19) ---
  let attempts = 0;
  const okAfter2 = await withRetry(async () => { attempts++; if (attempts < 2) throw new Error('flaky'); return 'ok'; }, 3, 'test');
  check('withRetry: sucesso após retry', okAfter2 === 'ok' && attempts === 2);

  let thrown = false, tries = 0;
  try { await withRetry(async () => { tries++; throw new Error('sempre falha'); }, 3, 'test'); }
  catch { thrown = true; }
  check('withRetry: lança após 3 tentativas', thrown && tries === 3);

  // --- POST /auth/reconnect (S17) ---
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.split('?')[0] === '/health/status') return;
    if (req.headers['x-api-key'] !== config.API_SECRET) reply.code(401).send({ error: 'unauthorized' });
  });
  await app.register(require('../src/routes/auth'));
  const KEY = { 'x-api-key': 'apikey' };

  let r = await app.inject({ method: 'POST', url: '/auth/reconnect' });
  check('reconnect exige api key (401)', r.statusCode === 401);

  r = await app.inject({ method: 'POST', url: '/auth/reconnect', headers: KEY });
  check('reconnect → status reconnecting', r.json().status === 'reconnecting');
  check('reconnect → estado persistido', db.getState('health_status') === 'reconnecting');
  check('reconnect → waClient.reconnect chamado', reconnectCalled === true);

  // --- qrNotifier.handleQr orquestração (S3/email stubbados) ---
  let uploadedBuf = null, emailedUrl = null;
  config.AWS_BUCKET = 'bucket'; config.AWS_ACCESS_KEY_ID = 'k'; config.AWS_SECRET_ACCESS_KEY = 's';
  config.SMTP_HOST = 'smtp'; config.NOTIFY_EMAIL = 'op@zashub.com.br';
  qrNotifier.uploadQrToS3 = async (buf) => { uploadedBuf = buf; return 'https://s3/qr.png'; };
  qrNotifier.sendQrEmail = async (url) => { emailedUrl = url; };
  await qrNotifier.handleQr('QR-STRING-EXEMPLO');
  check('handleQr: gerou PNG e subiu ao S3', Buffer.isBuffer(uploadedBuf) && uploadedBuf.length > 0);
  check('handleQr: email com URL presigned', emailedUrl === 'https://s3/qr.png');

  // --- qrNotifier sem S3 → fallback terminal (não lança) ---
  config.AWS_BUCKET = ''; let threw = false;
  try { await qrNotifier.handleQr('QR2'); } catch { threw = true; }
  check('handleQr: S3 ausente → não lança (fallback terminal)', threw === false);

  await app.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERRO:', e); process.exit(1); });
