const config = require('../config');
const QRCode = require('qrcode');
const { withRetry } = require('../utils/retry');
const waClient = require('../wa/client');
const webhook = require('./webhook');
const db = require('../db/database');

// Evita spam de email: SNS no máximo 1x a cada 10min (reset no 'connected').
const SNS_MIN_INTERVAL_MS = 10 * 60 * 1000;
let lastSnsAt = 0;

function s3Configured() {
  return !!(config.AWS_BUCKET && config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY);
}
function snsConfigured() {
  return !!config.SNS_TOPIC_ARN;
}

// Upload do PNG no S3 em KEY FIXA (sobrescreve, sem acúmulo) + URL pré-assinada (objeto privado).
async function uploadQrToS3(buffer) {
  const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

  const s3 = new S3Client({
    region: config.AWS_REGION,
    credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
  });
  const Key = config.AWS_S3_QR_KEY;

  await withRetry(
    () => s3.send(new PutObjectCommand({ Bucket: config.AWS_BUCKET, Key, Body: buffer, ContentType: 'image/png' })),
    3, 'S3 upload',
  );

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: config.AWS_BUCKET, Key }),
    { expiresIn: config.QR_PRESIGN_TTL_S },
  );
  const expiresAt = new Date(Date.now() + config.QR_PRESIGN_TTL_S * 1000).toISOString();
  return { url, expiresAt };
}

// Publica no SNS (você configura subscription topic→email).
async function publishSns(url, expiresAt) {
  const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
  const sns = new SNSClient({
    region: config.AWS_REGION,
    credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
  });
  const ttlMin = Math.round(config.QR_PRESIGN_TTL_S / 60);

  await withRetry(
    () => sns.send(new PublishCommand({
      TopicArn: config.SNS_TOPIC_ARN,
      Subject: '[courrier-notify] WhatsApp caiu — escaneie o QR',
      Message:
        `O WhatsApp do courrier-notify desconectou e precisa de novo pareamento.\n\n` +
        `Escaneie o QR (link válido ~${ttlMin}min, expira ${expiresAt}):\n${url}\n\n` +
        `Ou abra o ZasHub para escanear na tela.`,
    })),
    3, 'SNS publish',
  );
}

function _shouldSns() {
  return Date.now() - lastSnsAt > SNS_MIN_INTERVAL_MS;
}

// Handler do evento 'qr': PNG → S3 (presigned) → webhook /wa/qr → SNS (throttled).
// Tudo não-fatal: o QR também sai no terminal (fallback) via client.js.
async function handleQr(qr) {
  try {
    const buffer = await QRCode.toBuffer(qr, { type: 'png', width: 400 });

    try { db.setState('health_status', 'awaiting_qr'); } catch { /* db pode não estar pronto */ }

    if (!s3Configured()) {
      console.warn('[AUTH] S3 não configurado — QR disponível apenas no terminal.');
      return;
    }

    const { url, expiresAt } = await self.uploadQrToS3(buffer);
    console.log(`[AUTH] QR no S3 (presigned, expira ${expiresAt})`);

    // Webhook a cada QR: a tela do ZasHub sempre mostra o QR atual (Baileys rotaciona).
    webhook.sendQr(url, expiresAt).catch((e) => console.warn('[AUTH] webhook /wa/qr falhou:', e.message));

    // SNS (email) só 1x por episódio (throttle) — fallback se o hub não estiver aberto.
    if (snsConfigured() && _shouldSns()) {
      lastSnsAt = Date.now();
      self.publishSns(url, expiresAt)
        .then(() => console.log(`[AUTH] SNS publicado para ${config.SNS_TOPIC_ARN}`))
        .catch((e) => { lastSnsAt = 0; console.warn('[AUTH] SNS falhou:', e.message); });
    } else if (!snsConfigured()) {
      console.warn('[AUTH] SNS_TOPIC_ARN não configurado — sem email de QR.');
    }
  } catch (err) {
    console.error('[AUTH] Falha ao processar QR:', err.message);
  }
}

// Reseta o throttle ao reconectar (próxima queda manda email na hora).
function onConnected() {
  lastSnsAt = 0;
}

function init() {
  waClient.events.on('qr', (qr) => self.handleQr(qr));
  waClient.events.on('connected', () => onConnected());
  console.log('[AUTH] Notificador de QR ativo.');
}

// self = objeto exportado; handleQr chama self.uploadQrToS3/self.publishSns
// para permitir override em testes e manter um único ponto de verdade.
const self = { init, handleQr, uploadQrToS3, publishSns, onConnected };
module.exports = self;
