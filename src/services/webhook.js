const config = require('../config');
const { withRetry } = require('../utils/retry');

/**
 * POST para o ZasHub com header x-webhook-secret.
 * R05/S19: 3 tentativas com backoff (delay = attempt * 1000ms).
 * Lança erro após esgotar as tentativas — caller decide se é fatal.
 */
async function postWebhook(path, body) {
  const url = `${config.ZASHUB_WEBHOOK_URL}${path}`;
  await withRetry(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-secret': config.ZASHUB_WEBHOOK_SECRET,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }, 3, `webhook ${path}`);
}

function sendEuReceived(orderId, entries) {
  return postWebhook('/wa/eu-received', { orderId, entries });
}

function sendConnected(timestamp) {
  return postWebhook('/wa/connected', { timestamp });
}

// QR necessário: ZasHub mostra banner "WhatsApp caiu" + a imagem do QR (url presigned).
function sendQr(url, expiresAt) {
  return postWebhook('/wa/qr', { url, expiresAt });
}

module.exports = { postWebhook, sendEuReceived, sendConnected, sendQr };
