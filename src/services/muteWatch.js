const config = require('../config');
const waClient = require('../wa/client');

// WAMessageStubType.CIPHERTEXT — Baileys recebeu a msg mas NÃO decifrou (sender-key quebrada).
const CIPHERTEXT_STUB = 2;

const THRESHOLD = config.MUTE_UNDECRYPTED_THRESHOLD;
const WAIT1 = config.MUTE_PROBE_WAIT1_MS;
const WAIT2 = config.MUTE_PROBE_WAIT2_MS;

let consecutiveCipher = 0; // stub=2 seguidos no grupo real (reseta em qualquer leitura ok)
let confirming = false;    // confirmação (probe) em andamento
let readSeen = false;      // leu algo decifrado do grupo de probe durante a confirmação

function probeGroup() {
  return config.WA_PROBE_GROUP_JID;
}

// Chamado para cada upsert bruto (inclui msgs não-decifradas).
function observeUpsert(upsert) {
  for (const m of (upsert?.messages || [])) {
    const jid = m.key?.remoteJid;
    const decrypted = !!m.message;

    // Leitura OK no grupo de probe durante a confirmação → saudável.
    if (confirming && jid === probeGroup() && decrypted) {
      readSeen = true;
    }

    if (jid !== config.WA_GROUP_JID) continue;

    if (decrypted) {
      consecutiveCipher = 0; // leu de verdade → resta saudável
    } else if (m.messageStubType === CIPHERTEXT_STUB) {
      consecutiveCipher += 1;
      console.warn(`[MUTE] msg do grupo não decifrou (${consecutiveCipher}/${THRESHOLD}).`);
      if (consecutiveCipher >= THRESHOLD && !confirming) {
        startConfirm().catch((e) => console.error('[MUTE] erro na confirmação:', e.message));
      }
    }
  }
}

async function startConfirm() {
  if (!probeGroup()) {
    console.warn('[MUTE] WA_PROBE_GROUP_JID vazio — não dá pra confirmar; ignorando.');
    consecutiveCipher = 0;
    return;
  }
  confirming = true;
  readSeen = false;
  console.warn('[MUTE] Suspeita de grupo mudo. Confirmando via probe no grupo de teste...');

  await sendProbe(1);
  if (await waitRead(WAIT1)) return finish(true);

  await sendProbe(2);
  if (await waitRead(WAIT2)) return finish(true);

  // Sem nenhuma leitura decifrada após os 2 probes → mudo confirmado.
  console.error('[MUTE] Grupo mudo confirmado (sem leitura). Apagando auth e repareando (novo QR).');
  finish(false);
  waClient.forceRepair();
}

async function sendProbe(n) {
  const text = `🔧 healthcheck ${n} ${Date.now()}`;
  await waClient.sendText(probeGroup(), text).catch((e) => console.warn('[MUTE] falha ao enviar probe:', e.message));
}

// Resolve true assim que readSeen virar true, ou false ao esgotar ms.
function waitRead(ms) {
  const step = Math.min(2000, Math.max(50, ms)); // poll rápido p/ janelas curtas (testes)
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (readSeen) { clearInterval(iv); resolve(true); }
      else if (Date.now() - start >= ms) { clearInterval(iv); resolve(false); }
    }, step);
  });
}

function finish(healthy) {
  confirming = false;
  readSeen = false;
  consecutiveCipher = 0;
  if (healthy) console.log('[MUTE] Leitura confirmada no probe — grupo saudável.');
}

function init() {
  if (!config.WA_PROBE_GROUP_JID) {
    console.warn('[MUTE] WA_PROBE_GROUP_JID não configurado — watchdog de grupo mudo desativado.');
    return;
  }
  if (config.WA_PROBE_GROUP_JID === config.WA_GROUP_JID) {
    console.warn('[MUTE] WA_PROBE_GROUP_JID == WA_GROUP_JID — watchdog desativado (probe não pode spammar o grupo real).');
    return;
  }
  waClient.events.on('rawUpsert', observeUpsert);
  console.log('[MUTE] Watchdog de grupo mudo ativo.');
}

module.exports = { init, observeUpsert };
