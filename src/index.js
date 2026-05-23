// Carrega variáveis de ambiente antes de tudo
require('dotenv').config();

const Fastify = require('fastify');
const config = require('./config');

// S18 — logging estruturado (timestamp + nível) + supressão de ruído Baileys.
require('./utils/logger').installConsole(config.LOG_LEVEL);

const db = require('./db/database');
const waClient = require('./wa/client');
const { registerHandlers } = require('./wa/messageHandlers');
const webhook = require('./services/webhook');
const qrNotifier = require('./services/qrNotifier');
const dispatchRoutes = require('./routes/dispatch');
const controlRoutes = require('./routes/control');
const healthRoutes = require('./routes/health');
const authRoutes = require('./routes/auth');

// Rotas públicas (sem x-api-key)
const PUBLIC_ROUTES = new Set(['/health/status']);

async function main() {
  console.log('=== ZasHub WA Dispatch API ===');

  // Footgun guard: health group igual ao grupo de dispatch faz o health-check
  // engolir todos os "eu" antes do dispatch. Avisa alto (o handler já protege).
  if (config.WA_HEALTH_GROUP_JID && config.WA_HEALTH_GROUP_JID === config.WA_GROUP_JID) {
    console.warn('[MAIN] ATENÇÃO: WA_HEALTH_GROUP_JID == WA_GROUP_JID. Health check desativado para não engolir "eu" de dispatch. Use grupos diferentes (ou deixe WA_HEALTH_GROUP_JID vazio).');
  }

  // 1. Conectar ao banco SQLite (cria schema + seed de estado)
  db.connect(config.DB_PATH);

  // 2. Registrar listeners ANTES de conectar (evita perder o 1º evento 'connected')
  registerHandlers();
  qrNotifier.init(); // listener de 'qr' → PNG → S3 → email (S17)
  waClient.events.on('connected', (ts) => {
    db.setState('health_status', 'healthy');
    db.setState('last_connected_at', ts);
    // Avisa o dono e notifica o ZasHub (não-fatais)
    if (config.OWNER_JID) {
      waClient.sendText(config.OWNER_JID, `✅ WhatsApp reconectado em ${ts}`)
        .catch((e) => console.warn('[AUTH] Falha ao avisar owner:', e.message));
    }
    webhook.sendConnected(ts).catch((e) => console.warn('[AUTH] Falha webhook connected:', e.message));
  });

  // 3. Conectar ao WhatsApp (aguarda QR scan ou sessão existente)
  await waClient.connect();

  // 4. HTTP server
  const app = Fastify({ logger: false });

  // Middleware global: x-api-key obrigatório, exceto rotas públicas (S02)
  app.addHook('onRequest', async (request, reply) => {
    if (PUBLIC_ROUTES.has(request.url.split('?')[0])) return;
    const key = request.headers['x-api-key'];
    if (!key || key !== config.API_SECRET) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  await app.register(dispatchRoutes);
  await app.register(controlRoutes);
  await app.register(healthRoutes);
  await app.register(authRoutes);

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  console.log(`[HTTP] Escutando na porta ${config.PORT}`);
  console.log('[MAIN] Sistema iniciado.');
}

main().catch(err => {
  console.error('[MAIN] Erro fatal na inicialização:', err.message);
  process.exit(1);
});
