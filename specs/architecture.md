# Architecture Spec — ZasHub WhatsApp Dispatch API

## Visão Geral

Serviço Node.js standalone que expõe uma REST API de transporte WhatsApp.
Responsabilidade única: enviar/receber mensagens. Zero regra de negócio.

Regras de negócio (quem ganhou o "eu", o que enviar, quando) vivem no **ZasHub** (Next.js).

```
┌─────────────┐        REST calls         ┌──────────────────────┐
│   ZasHub    │ ─────────────────────────▶ │  Dispatch WA API     │
│  (Next.js)  │ ◀───────────────────────── │  (este serviço)      │
│             │        webhooks            │                      │
└─────────────┘                            │  ┌────────────────┐  │
                                           │  │  Baileys/WA    │  │
                                           │  └────────────────┘  │
                                           └──────────────────────┘
```

---

## Responsabilidades

### Este serviço (Dispatch WA API)
- Conexão e autenticação WhatsApp via Baileys
- Envio de mensagens (grupo e privado)
- Envio de reações
- Coleta de "eu"s na janela de 4s
- Disparo de webhooks para ZasHub
- Health check de conectividade
- Reconexão automática + QR via S3 + email
- Flag global de enable/disable

### ZasHub (fora do escopo deste serviço)
- Decidir quem ganhou o "eu"
- Compor texto das mensagens
- Chamar endpoints de envio
- Lógica de motoboy, pedido, fase, PIX

---

## Stack

| Componente | Tecnologia |
|---|---|
| Runtime | Node.js 20 LTS |
| Framework HTTP | Fastify (ou Express) |
| WhatsApp | @whiskeysockets/baileys |
| Autenticação WA | MultiFileAuthState (pasta persistida em volume) |
| Persistência | SQLite (better-sqlite3) — apenas estado interno da API |
| QR upload | AWS S3 (ou Cloudflare R2) |
| Email | Nodemailer (SMTP simples) |
| Container | Docker |
| Processo | PM2 dentro do container (restart automático) |

---

## Estado Interno (SQLite)

Somente o que a API precisa para funcionar. Não é banco de negócio.

```sql
-- Mapeamento msgId do grupo → orderId (para detecção de quote)
CREATE TABLE group_messages (
  msg_id    TEXT PRIMARY KEY,
  order_id  TEXT NOT NULL,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Estado global da instância
CREATE TABLE instance_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Chaves usadas:
--   dispatch_enabled: 'true' | 'false'
--   health_status: 'healthy' | 'awaiting_manual_test' | 'degraded' | 'reconnecting'
--   last_connected_at: ISO string
```

---

## Endpoints Expostos

### Dispatch

| Método | Rota | Descrição |
|---|---|---|
| POST | `/group/announce` | Envia msg no grupo; armazena msgId↔orderId |
| POST | `/group/react` | Envia reação em msg do grupo. Body: `{ euMsgId, emoji, euJid }` — `euJid` (participante) vem do webhook `eu-received` e é obrigatório p/ a reação colar em msg de membro de grupo |
| POST | `/message/send` | Envia msg privada para JID |

> **S20/R04 — pacing:** a API não espaça envios internamente. O caller (ZasHub) deve
> aguardar ~500ms entre `/group/announce` consecutivos. WhatsApp trata rajadas como
> spam e pode bloquear o número.

### Controle

| Método | Rota | Descrição |
|---|---|---|
| POST | `/dispatch/enable` | Liga envios e escuta de "eu" |
| POST | `/dispatch/disable` | Desliga tudo (announce, "eu", privado) |
| GET | `/dispatch/status` | Retorna `{ enabled: bool }` |

### Health

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health/ping` | Envia msg de aviso no grupo de validação |
| GET | `/health/retest` | Inicia reteste com timer de 30s |
| GET | `/health/status` | Estado atual: `healthy | awaiting_manual_test | degraded | reconnecting` |

### Auth

| Método | Rota | Descrição |
|---|---|---|
| POST | `/auth/reconnect` | Força desconexão e inicia novo fluxo de QR |

---

## Webhooks Disparados (de API → ZasHub)

Todos via POST para `ZASHUB_WEBHOOK_URL` configurada em env.

### `eu-received`
```json
POST {ZASHUB_WEBHOOK_URL}/wa/eu-received
{
  "orderId": "uuid",
  "entries": [
    {
      "jid": "5512999990000@s.whatsapp.net",
      "msgId": "ABCD123",
      "mode": "quoted | plain",
      "receivedAt": "ISO string"
    }
  ]
}
```

### `connected`
```json
POST {ZASHUB_WEBHOOK_URL}/wa/connected
{
  "timestamp": "ISO string"
}
```

### `qr` — WhatsApp caiu, precisa re-parear
```json
POST {ZASHUB_WEBHOOK_URL}/wa/qr
{
  "url": "https://bucket.s3...presigned...",
  "expiresAt": "ISO string"
}
```

---

## Fluxo: "eu" Detection

```
Msg recebida no grupo WA_GROUP_JID
  └── texto normalizado == "eu"?
        ├── NÃO → ignorar
        └── SIM
              └── dispatch_enabled?
                    ├── NÃO → ignorar silenciosamente
                    └── SIM
                          ├── tem stanzaId (quoted)?
                          │     ├── SIM → lookup group_messages WHERE msg_id = stanzaId
                          │     │           ├── encontrou (status pending) → detectionMode='quoted'
                          │     │           └── não encontrou → ignorar (outro comércio ou pedido já fechado)
                          │     └── NÃO → orderId = mais recente em group_messages → detectionMode='plain'
                          │
                          └── enfileirar { orderId, jid, msgId, mode }
                                └── após 4s: disparar webhook eu-received com todos os entries
```

---

## Fluxo: Health Check

```
/health/ping
  └── envia "🔍 Teste de conectividade. Responda 'eu' pra validar." no WA_HEALTH_GROUP_JID
  └── estado → awaiting_manual_test

/health/retest  (chamado pelo operador quando está online)
  └── envia "🔁 Reteste. Responda 'eu' em 30s." no WA_HEALTH_GROUP_JID
  └── inicia timer 30s aguardando "eu" do WA_HEALTH_GROUP_JID
        ├── recebeu → estado = healthy → envia "✅ eco ok" no grupo de validação
        └── não recebeu → estado = degraded → dispara /auth/reconnect automático
```

---

## Fluxo: Reconexão

```
Queda do socket (connection='close'):
  ├── statusCode == loggedOut (sessão inválida)
  │     1. APAGAR pasta auth/baileys_auth (sessão suja)
  │     2. connect() limpo → Baileys emite 'qr'
  │     3. QR string → PNG
  │     4. Upload S3 em KEY FIXA (sobrescreve) → URL pré-assinada (TTL 15min, objeto privado)
  │     5. Webhook POST /wa/qr { url, expiresAt } → ZasHub mostra banner + QR na tela
  │     6. SNS publish (email) — throttle 1x/10min — fallback se hub fechado
  │        (Baileys rotaciona o QR ~20s → repete 4-5 a cada rotação; SNS só 1x/episódio)
  │
  └── outro código (queda transitória)
        reconecta MANTENDO a sessão (sem QR)

On connection='open':
  a. Estado → healthy ; last_connected_at = now
  b. WA para OWNER_JID: "✅ WhatsApp reconectado em {timestamp}" (se OWNER_JID setado)
  c. Webhook POST /wa/connected { timestamp } → ZasHub limpa o banner
  d. Reseta throttle do SNS
```

> **Segurança:** a imagem do QR permite vincular a conta (sequestro se vazar). Por isso o
> objeto S3 é **privado** e a URL é **pré-assinada com TTL curto** — nunca pública/permanente.

---

## Variáveis de Ambiente

```env
# WhatsApp
WA_GROUP_JID=            # JID do grupo de motoboys
WA_HEALTH_GROUP_JID=     # JID do grupo de validação (só operador)
OWNER_JID=               # JID do dono (para msgs de status)

# ZasHub
ZASHUB_WEBHOOK_URL=      # URL base para webhooks (ex: https://zashub.com.br/api)
ZASHUB_WEBHOOK_SECRET=   # Header de autenticação nos webhooks

# AWS S3 (QR code)
AWS_BUCKET=
AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=

# Email (reconexão)
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
NOTIFY_EMAIL=

# API Security
API_SECRET=              # Header x-api-key obrigatório em todos endpoints

# App
PORT=3001
NODE_ENV=production
AUTH_PATH=./auth/baileys_auth
DB_PATH=./data/state.db
DISPATCH_QUEUE_WINDOW_MS=4000
```

---

## Segurança

- Todos endpoints exigem header `x-api-key: {API_SECRET}`
- Webhooks disparados incluem header `x-webhook-secret: {ZASHUB_WEBHOOK_SECRET}`
- ZasHub valida o secret antes de processar qualquer webhook
- API não expõe nenhum dado de pedido ou cliente — apenas JIDs e IDs opacos
