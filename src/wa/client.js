const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const config = require('../config');

// Resolvido a partir de config.AUTH_PATH (volume ./auth montado fora do container)
const AUTH_PATH = path.resolve(config.AUTH_PATH);

// Se nenhum evento de mensagem chegar neste intervalo, força reconexão
const HEALTH_CHECK_INTERVAL_MS = 3 * 60 * 1000; // 3 minutos
const HEALTH_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutos sem nenhum evento

// Idade máxima para reenviar uma msg em retry receipt. Acima disso, getMessage
// retorna undefined → WhatsApp não ressuscita announce de pedido já entregue.
const RETRY_RESEND_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutos

const waClient = {
  sock: null,
  events: new EventEmitter(),
  _connecting: false,
  _connected: false,
  _lastEventAt: 0,
  _healthTimer: null,
  _reconnectAttempts: 0,   // backoff: zera ao abrir conexão
  _reconnectTimer: null,   // timer do reconnect agendado (evita agendar 2x)
  _lidToJid: new Map(), // @lid → @s.whatsapp.net
  _msgStore: new Map(), // id → { message, ts } — serve retry receipts (getMessage); cap ~1000 FIFO

  // Guarda conteúdo da msg enviada para reenvio em retry receipt.
  // Sem isso, getMessage retorna undefined e a msg fica "Aguardando mensagem" pra sempre.
  _rememberMsg(result) {
    if (result?.key?.id && result.message) {
      this._msgStore.set(result.key.id, { message: result.message, ts: Date.now() });
      if (this._msgStore.size > 1000) {
        this._msgStore.delete(this._msgStore.keys().next().value);
      }
    }
  },

  // Serve conteúdo no retry receipt — MAS só se a msg for recente.
  // Reenviar announce antigo (pedido já entregue) o re-exibe pros motoboys após
  // resync/multi-device → pedido fantasma, motoboy se desloca à toa = prejuízo.
  // Teto de idade: retry legítimo de "Aguardando" chega em segundos; nada velho reenvia.
  _getStoredMsg(id) {
    const stored = this._msgStore.get(id);
    if (!stored) return undefined;
    if (Date.now() - stored.ts > RETRY_RESEND_MAX_AGE_MS) return undefined;
    return stored.message;
  },

  // Resolve JID do tipo @lid para @s.whatsapp.net usando o mapa de contatos.
  // Retorna null se o LID ainda não foi mapeado.
  resolveJid(jid) {
    if (jid && jid.endsWith('@lid')) {
      return this._lidToJid.get(jid) || null;
    }
    return jid;
  },

  isConnected() {
    return this._connected && !!this.sock;
  },

  // Força reconexão: encerra o socket; o handler de connection.update 'close'
  // reconecta automaticamente (statusCode != loggedOut).
  reconnect() {
    if (!this.sock) return;
    console.warn('[WA] Reconexão forçada solicitada.');
    this._connecting = false;
    this.sock.end(undefined);
  },

  // Reconexão com backoff exponencial (2s → 60s cap). Evita tempestade close→connect
  // que vaza sockets/listeners e satura o event loop (sintoma: container unhealthy/504).
  // Idempotente: se já há reconnect agendado, não agenda outro.
  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    const attempt = this._reconnectAttempts++;
    const delay = Math.min(2000 * 2 ** attempt, 60000);
    console.warn(`[WA] Reconnect agendado em ${delay}ms (tentativa ${attempt + 1}).`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect().catch((e) => {
        console.error('[WA] Falha no reconnect agendado:', e.message);
        this._scheduleReconnect();
      });
    }, delay);
  },

  // Repair forçado: apaga sessão + reconecta → Baileys gera QR novo (qrNotifier notifica).
  // Usado pelo watchdog de "grupo mudo" quando a leitura do grupo morre.
  forceRepair() {
    console.warn('[WA] forceRepair: sessão suja, apagando e repareando...');
    this._wipeAuth();
    this.reconnect();
  },

  // Apaga a pasta de credenciais Baileys (sessão suja). Próximo connect() gera QR novo.
  _wipeAuth() {
    try {
      fs.rmSync(AUTH_PATH, { recursive: true, force: true });
      console.warn(`[WA] Sessão apagada: ${AUTH_PATH}`);
    } catch (e) {
      console.error('[WA] Falha ao apagar auth:', e.message);
    }
  },

  async connect() {
    if (this._connecting) return;
    this._connecting = true;

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: false,
      // Retry receipt: WA pede reenvio quando destinatário não decifra.
      // Servir conteúdo armazenado → Baileys re-encripta e reenvia → "Aguardando mensagem" some.
      // Retornar undefined (msg desconhecida) é seguro — só não reenvia.
      getMessage: async (key) => this._getStoredMsg(key.id),
      logger: { level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({ level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({}) }) },
    });

    this.sock = sock;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\n[WA] Escaneie o QR Code abaixo com o WhatsApp:\n');
        qrcode.generate(qr, { small: true });
        // Emite para o qrNotifier (PNG → S3 → email) — GRUPO 7
        this.events.emit('qr', qr);
      }

      if (connection === 'open') {
        console.log('[WA] WhatsApp conectado com sucesso!');
        this._connecting = false;
        this._connected = true;
        this._reconnectAttempts = 0; // conexão ok → zera backoff
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        this._lastEventAt = Date.now();
        this._startHealthCheck();
        this.events.emit('connected', new Date().toISOString());
        if (config.WA_GROUP_JID) {
          sock.groupMetadata(config.WA_GROUP_JID).then(meta => {
            let mapped = 0;
            for (const p of meta.participants) {
              if (p.lid && p.jid) {
                this._lidToJid.set(p.lid, p.jid);
                mapped++;
              }
            }
            // Log do primeiro participante para inspecionar campos disponíveis
            if (meta.participants.length > 0) {
              console.log('[WA-LID] Campos do participante:', JSON.stringify(meta.participants[0]));
            }
            console.log(`[WA-LID] Mapa lid→jid: ${mapped} de ${meta.participants.length} participantes mapeados`);
          }).catch(() => {});
        }
      }

      if (connection === 'close') {
        this._connected = false;
        this._stopHealthCheck();
        this.events.emit('disconnected');
        const statusCode = lastDisconnect?.error?.output?.statusCode;

        // Limpa listeners do socket morto: sem isso cada reconexão vaza handlers
        // (connection.update, ev.process...) → memória/CPU sobem → unhealthy/504.
        try { sock.ev.removeAllListeners(); } catch { /* ev pode não suportar */ }

        if (statusCode === DisconnectReason.loggedOut) {
          // Sessão inválida: limpa credenciais — próximo connect() emite novo QR
          // (qrNotifier sobe pro S3 + SNS + webhook /wa/qr).
          console.warn('[WA] Logout detectado. Limpando sessão e gerando novo QR...');
          this._wipeAuth();
        } else {
          // Queda transitória: reconecta mantendo a sessão (com backoff).
          console.warn(`[WA] Conexão encerrada (código ${statusCode}). Reconectando com backoff...`);
        }
        this._connecting = false;
        this._scheduleReconnect();
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.process(async (events) => {
      this._lastEventAt = Date.now();

      if (events['contacts.upsert']) {
        for (const contact of events['contacts.upsert']) {
          if (contact.lid && contact.id) {
            this._lidToJid.set(contact.lid, contact.id);
          }
        }
      }

      if (events['contacts.update']) {
        for (const contact of events['contacts.update']) {
          if (contact.lid && contact.id) {
            this._lidToJid.set(contact.lid, contact.id);
          }
        }
      }

      if (events['messages.upsert']) {
        const upsert = events['messages.upsert'];
        // Watchdog de grupo mudo precisa ver TODAS as msgs (inclusive não-decifradas/stub).
        this.events.emit('rawUpsert', upsert);
        if (upsert.type === 'notify') {
          this.events.emit('messages', upsert.messages);
        }
      }
    });
  },

  _startHealthCheck() {
    this._stopHealthCheck();
    this._healthTimer = setInterval(() => {
      if (!this.sock) return;
      const staleSince = Date.now() - this._lastEventAt;
      if (staleSince > HEALTH_STALE_THRESHOLD_MS) {
        console.warn(`[WA] Nenhum evento há ${Math.round(staleSince / 1000)}s. Conexão degradada — reconectando...`);
        this._stopHealthCheck();
        this._connecting = false;
        this.sock.end(undefined);
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  },

  _stopHealthCheck() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  },

  async sendText(jid, text) {
    if (!this.sock) throw new Error('[WA] Socket não inicializado.');
    const result = await this.sock.sendMessage(jid, { text });
    this._rememberMsg(result);
    return result;
  },

  async sendReaction(jid, msgKey, emoji) {
    if (!this.sock) throw new Error('[WA] Socket não inicializado.');
    await this.sock.sendMessage(jid, {
      react: { text: emoji, key: msgKey },
    });
  },
};

module.exports = waClient;
