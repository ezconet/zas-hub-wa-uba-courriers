const config = require('../config');
const QRCode = require('qrcode');
const { withRetry } = require('../utils/retry');
const waClient = require('../wa/client');

const PRESIGN_TTL_S = 30 * 60; // URL válida por 30 minutos

function s3Configured() {
  return !!(config.AWS_BUCKET && config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY);
}

function smtpConfigured() {
  return !!(config.SMTP_HOST && config.NOTIFY_EMAIL);
}

// Upload do PNG no S3 (ACL private) + URL pré-assinada (TTL 30min).
async function uploadQrToS3(buffer) {
  const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

  const s3 = new S3Client({
    region: config.AWS_REGION,
    credentials: {
      accessKeyId: config.AWS_ACCESS_KEY_ID,
      secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    },
  });

  const key = `qr-codes/qr-${Date.now()}.png`;
  await withRetry(
    () => s3.send(new PutObjectCommand({
      Bucket: config.AWS_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: 'image/png',
    })),
    3, 'S3 upload',
  );

  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: config.AWS_BUCKET, Key: key }),
    { expiresIn: PRESIGN_TTL_S },
  );
}

// Email com o link do QR (Nodemailer).
async function sendQrEmail(url) {
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
  });

  await withRetry(
    () => transport.sendMail({
      from: config.SMTP_USER || 'no-reply@zashub.com.br',
      to: config.NOTIFY_EMAIL,
      subject: '[ZasHub] WhatsApp QR Code — ação necessária',
      text: `Escaneie o QR para reconectar o WhatsApp (link válido por 30min):\n${url}`,
    }),
    3, 'email QR',
  );
}

// Handler do evento 'qr' do Baileys: PNG → S3 → email. Falhas não-fatais
// (QR sempre sai no terminal como fallback).
async function handleQr(qr) {
  try {
    const buffer = await QRCode.toBuffer(qr, { type: 'png', width: 400 });

    if (!s3Configured()) {
      console.warn('[AUTH] S3 não configurado — QR disponível apenas no terminal.');
      return;
    }

    const url = await self.uploadQrToS3(buffer);
    console.log(`[AUTH] QR enviado ao S3 (TTL 30min): ${url}`);

    if (smtpConfigured()) {
      await self.sendQrEmail(url);
      console.log(`[AUTH] Email com QR enviado para ${config.NOTIFY_EMAIL}`);
    } else {
      console.warn('[AUTH] SMTP não configurado — QR apenas no S3.');
    }
  } catch (err) {
    console.error('[AUTH] Falha ao processar QR:', err.message);
  }
}

function init() {
  waClient.events.on('qr', (qr) => self.handleQr(qr));
  console.log('[AUTH] Notificador de QR ativo.');
}

// self = objeto exportado; handleQr chama self.uploadQrToS3/self.sendQrEmail
// para permitir override (testes) e manter um único ponto de verdade.
const self = { init, handleQr, uploadQrToS3, sendQrEmail };
module.exports = self;
