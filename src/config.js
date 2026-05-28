require('dotenv').config();

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Variável de ambiente obrigatória não definida: ${name}`);
  return val;
}

module.exports = {
  // WhatsApp
  WA_GROUP_JID: required('WA_GROUP_JID'),
  WA_HEALTH_GROUP_JID: process.env.WA_HEALTH_GROUP_JID || '',
  OWNER_JID: process.env.OWNER_JID || '',

  // ZasHub webhooks
  ZASHUB_WEBHOOK_URL: required('ZASHUB_WEBHOOK_URL'),
  ZASHUB_WEBHOOK_SECRET: required('ZASHUB_WEBHOOK_SECRET'),

  // API security
  API_SECRET: required('API_SECRET'),

  // AWS S3 (QR code upload)
  AWS_BUCKET: process.env.AWS_BUCKET || '',
  AWS_REGION: process.env.AWS_REGION || 'us-east-1',
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || '',
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || '',
  AWS_S3_QR_KEY: process.env.AWS_S3_QR_KEY || 'courrier-notify/qr.png', // key fixa (sobrescreve)
  QR_PRESIGN_TTL_S: parseInt(process.env.QR_PRESIGN_TTL_S || '900', 10),  // 15min

  // SNS (notificação de QR por email — você configura topic→email)
  SNS_TOPIC_ARN: process.env.SNS_TOPIC_ARN || '',

  // Email SMTP (fallback de QR, opcional — preferir SNS)
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '587', 10),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  NOTIFY_EMAIL: process.env.NOTIFY_EMAIL || '',

  // App
  PORT: parseInt(process.env.PORT || '3001', 10),
  AUTH_PATH: process.env.AUTH_PATH || './auth/baileys_auth',
  DB_PATH: process.env.DB_PATH || './data/state.db',
  DISPATCH_QUEUE_WINDOW_MS: parseInt(process.env.DISPATCH_QUEUE_WINDOW_MS || '4000', 10),
  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),

  // Watchdog de "grupo mudo" (sender-keys quebradas: msgs chegam mas não decifram).
  // Passivo conta stub=2 do grupo real; confirma via probe no grupo de teste; se mudo, wipe+reconnect.
  WA_PROBE_GROUP_JID: process.env.WA_PROBE_GROUP_JID || '', // grupo de teste p/ probe (≠ grupo real); vazio = watchdog off
  MUTE_UNDECRYPTED_THRESHOLD: parseInt(process.env.MUTE_UNDECRYPTED_THRESHOLD || '3', 10),
  MUTE_PROBE_WAIT1_MS: parseInt(process.env.MUTE_PROBE_WAIT1_MS || '300000', 10), // 5min
  MUTE_PROBE_WAIT2_MS: parseInt(process.env.MUTE_PROBE_WAIT2_MS || '120000', 10), // 2min

  // Merchants (mapeamento merchantId → dados de retirada)
  MERCHANTS: {
    'c943d847-0ab5-4147-aa02-68df78415ebf': { name: 'Zas', pickupAddress: 'Rua Capitao Felipe, 309', pickupBairro: 'Itagua' },
    '0e26ebcf-03db-4966-aadf-22fffe033209': { name: 'Zas', pickupAddress: 'Rua Capitao Felipe, 309', pickupBairro: 'Itagua' },
    'a636aa41-d070-47ef-9c12-983839147b01': { name: 'Nega', pickupAddress: 'Av. Atlantica, 220', pickupBairro: 'Praia Grande' },
    DEFAULT: { name: 'Restaurante', pickupAddress: 'Av. Atlantica, 220', pickupBairro: 'Praia Grande' },
  },
};
