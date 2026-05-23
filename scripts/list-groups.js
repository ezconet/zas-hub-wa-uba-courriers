// Lista todos os grupos que a conta WhatsApp conectada participa.
// Use a coluna JID para preencher WA_GROUP_JID / WA_HEALTH_GROUP_JID no .env.
require('dotenv').config();
require('../src/utils/logger').installConsole(process.env.LOG_LEVEL || 'info');

const config = require('../src/config');
const db = require('../src/db/database');
const waClient = require('../src/wa/client');

db.connect(config.DB_PATH);

waClient.events.on('qr', () => {
  console.error('[LIST] ❌ Pediu QR — sessão inválida. Re-escaneie antes de listar.');
  process.exit(1);
});

waClient.events.on('connected', async () => {
  try {
    const groups = await waClient.sock.groupFetchAllParticipating();
    const rows = Object.values(groups)
      .map((g) => ({ subject: g.subject || '(sem nome)', participants: g.participants?.length ?? '?', jid: g.id }))
      .sort((a, b) => String(a.subject).localeCompare(String(b.subject)));

    console.log(`\n=== ${rows.length} grupos ===\n`);
    for (const r of rows) {
      console.log(`${r.subject}  [${r.participants} membros]\n  ${r.jid}\n`);
    }
  } catch (e) {
    console.error('[LIST] erro ao buscar grupos:', e.message);
  }
  process.exit(0);
});

setTimeout(() => { console.error('[LIST] ⏱️ Timeout sem conectar.'); process.exit(1); }, 40000);

waClient.connect().catch((e) => { console.error('[LIST] erro:', e.message); process.exit(1); });
