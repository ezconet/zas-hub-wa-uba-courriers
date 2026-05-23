// Testa SÓ a conexão WhatsApp (reuso da sessão copiada), sem HTTP.
// Sucesso: "[WA] WhatsApp conectado com sucesso!" sem pedir QR.
require('dotenv').config();
require('../src/utils/logger').installConsole(process.env.LOG_LEVEL || 'info');

const config = require('../src/config');
const db = require('../src/db/database');
const waClient = require('../src/wa/client');

db.connect(config.DB_PATH);

let qrSeen = false;
waClient.events.on('qr', () => { qrSeen = true; });
waClient.events.on('connected', (ts) => {
  console.log(`[TEST] ✅ CONECTADO em ${ts} — sessão reutilizada, sem QR.`);
  setTimeout(() => process.exit(0), 1500);
});

setTimeout(() => {
  if (qrSeen) console.error('[TEST] ❌ Pediu QR — sessão inválida/expirada. Re-escaneie.');
  else console.error('[TEST] ⏱️ Timeout 40s sem conectar. Ver logs acima.');
  process.exit(1);
}, 40000);

waClient.connect().catch((e) => { console.error('[TEST] erro:', e.message); process.exit(1); });
