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

// Spec 099 — guard de elegibilidade antes do react 👍.
// Consulta o Hub e retorna true SÓ se 200 + eligible===true. Fail-closed em
// qualquer outro caso (não-200, !eligible, rede, timeout ~3s) → false (não reage).
// NÃO usa withRetry: é decisão pontual, 1 tentativa, timeout curto. GET é read-only.
// ZASHUB_WEBHOOK_URL já inclui /api → path relativo /dispatch/order-status.
const REACT_GUARD_TIMEOUT_MS = parseInt(process.env.REACT_GUARD_TIMEOUT_MS || '3000', 10);

async function isOrderEligible(orderId) {
  const url = `${config.ZASHUB_WEBHOOK_URL}/dispatch/order-status?orderId=${encodeURIComponent(orderId)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REACT_GUARD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-webhook-secret': config.ZASHUB_WEBHOOK_SECRET },
      signal: ctrl.signal,
    });
    if (res.status !== 200) return false;          // não-200 → fail-closed
    const data = await res.json();
    return data?.eligible === true;                // só elegível (READY)
  } catch {
    return false;                                   // rede/timeout → fail-closed
  } finally {
    clearTimeout(timer);
  }
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

// Comprovante (imagem) do recebedor → Hub faz OCR/dedupe/match. Idempotente por msgId.
function sendReceipt({ restaurantId, jid, msgId, imageBase64, mime }) {
  return postWebhook('/wa/receipt-received', { restaurantId, jid, msgId, imageBase64, mime });
}

module.exports = { postWebhook, isOrderEligible, sendEuReceived, sendConnected, sendQr, sendReceipt };
