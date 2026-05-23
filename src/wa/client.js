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

const waClient = {
  sock: null,
  events: new EventEmitter(),
  _connecting: false,
  _connected: false,
  _lastEventAt: 0,
  _healthTimer: null,
  _lidToJid: new Map(), // @lid → @s.whatsapp.net

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
      // Necessário para evitar que retries internos do WA quebrem o pipeline de eventos
      getMessage: async () => undefined,
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

        if (statusCode === DisconnectReason.loggedOut) {
          // Sessão inválida: limpa credenciais e reconecta — Baileys emite novo QR
          // (qrNotifier sobe pro S3 + SNS + webhook /wa/qr).
          console.warn('[WA] Logout detectado. Limpando sessão e gerando novo QR...');
          this._wipeAuth();
          this._connecting = false;
          await this.connect();
        } else {
          // Queda transitória: reconecta mantendo a sessão.
          console.warn(`[WA] Conexão encerrada (código ${statusCode}). Reconectando...`);
          this._connecting = false;
          await this.connect();
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.process(async (events) => {
      this._lastEventAt = Date.now();

      // DEBUG (LOG_LEVEL=debug): quais eventos chegam do WhatsApp
      console.debug(`[WA-DEBUG] eventos: ${Object.keys(events).join(', ')}`);

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
        // DEBUG: tipo + detalhe de cada msg (revela se chega mas não decifra)
        console.debug(`[WA-DEBUG] messages.upsert type=${upsert.type} n=${upsert.messages?.length ?? 0}`);
        for (const m of (upsert.messages || [])) {
          const keys = m.message ? Object.keys(m.message).join(',') : '(sem message)';
          const txt = m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? null;
          console.debug(`[WA-DEBUG] msg jid=${m.key?.remoteJid} part=${m.key?.participant} fromMe=${m.key?.fromMe} stub=${m.messageStubType ?? '-'} msg=${keys} text=${JSON.stringify(txt)}`);
        }
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
