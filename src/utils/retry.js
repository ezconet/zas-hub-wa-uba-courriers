// S19/R05 — retry com backoff: 3 tentativas, delay = attempt * 1000ms.
// Aplicado em chamadas externas (webhooks ZasHub, upload S3, email).
async function withRetry(fn, retries = 3, label = 'op') {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`[RETRY] ${label} tentativa ${attempt}/${retries} falhou: ${err.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
