// Carrega variáveis de ambiente antes de tudo
require('dotenv').config();

// Suprime ruído interno do libsignal/Baileys (erros de decrypt de msgs antigas)
const _origError = console.error.bind(console);
const _noisePatterns = ['Session error:', 'Failed to decrypt', 'Closing open session', 'Closing session:'];
console.error = (...args) => {
  const msg = String(args[0] ?? '');
  if (_noisePatterns.some(p => msg.includes(p))) return;
  _origError(...args);
};

async function main() {
  console.log('=== ZAS Delivery Integration ===');

  // 1. Validar config (lança se faltar variável obrigatória)
  const config = require('./config');

  // 2. Conectar ao banco SQLite e rodar migrations
  const db = require('./db/database');
  db.connect(config.DB_PATH);

  // 3. Conectar ao WhatsApp (aguarda QR scan ou sessão existente)
  const waClient = require('./whatsapp/client');
  await waClient.connect();

  // 4. Registrar handlers de mensagens recebidas
  const { registerHandlers } = require('./whatsapp/messageHandlers');
  registerHandlers();

  // 5. Iniciar poller de pedidos
  const { startPoller } = require('./services/orderPoller');
  startPoller();

  // 6. Iniciar gerenciador de expiração
  const { startExpiryManager } = require('./services/expiryManager');
  startExpiryManager();

  console.log('[MAIN] Sistema iniciado. Aguardando pedidos...');
}

main().catch(err => {
  console.error('[MAIN] Erro fatal na inicialização:', err.message);
  process.exit(1);
});
