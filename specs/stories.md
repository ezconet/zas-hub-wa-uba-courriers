# Stories — Dispatch WA API

Agrupadas por funcionalidade. Grupos marcados com `[JUNTO]` podem ser implementados na mesma sessão de código.

---

## REGRAS DEFENSIVAS — Lições Aprendidas em Produção

> Não são stories — são **restrições obrigatórias** que o Claude deve aplicar ao codar cada grupo.
> Cada item foi uma solução para um problema real que surgiu em produção. Não omitir.

---

### Dispatch API — Regras de Envio

**R01 — JSON inválido no payload não quebra o loop**
Se o JSON do pedido não parsear → `warn` + `continue`. O erro em um pedido não pode parar o processamento dos outros.

**R02 — Falha no envio WA → não salvar no DB**
Se `sendText` lançar erro ao anunciar no grupo → não inserir em `group_messages` → não retornar sucesso. O próximo ciclo vai tentar de novo. Se salvar no DB antes de enviar, o pedido fica travado para sempre como "anunciado" sem nunca ter sido enviado.

**R03 — Falha na atualização de fase → não-fatal**
Após enviar no grupo e salvar no DB, se a chamada para atualizar fase no ZasHub falhar → apenas `warn`, não lançar erro. O DB já garantiu dedup. O ZasHub pode ter outro mecanismo para detectar a fase.

**R04 — 500ms de pausa entre anúncios múltiplos**
Se vários pedidos prontos chegarem no mesmo ciclo, esperar 500ms entre cada envio no grupo. WhatsApp detecta envios em rajada como spam e pode bloquear o número.

**R05 — Retry com backoff exponencial em chamadas externas**
Toda chamada HTTP (ZasHub, S3, email) deve ter 3 tentativas com delay de `attempt * 1000ms`. Uma falha de rede pontual não pode derrubar o fluxo.

**R06 — `precisaDeMotoboy = false` → não passa por `motoboysolicitado`**
Vai direto para `motoboyacionado`. Nunca anunciar no grupo. Nunca entrar na fila de "eu".

**R07 — Pedido do tipo não-DELIVERY → ignorar completamente**
Pedidos de retirada pelo cliente (`orderType != 'DELIVERY'`) não precisam de motoboy. Filtrar antes de qualquer processamento.

---

### Dispatch API — Detecção de "eu"

**R08 — "eu" quoted de outro comércio → ignorar silenciosamente**
Se `stanzaId` não corresponder a nenhum `msg_id` em `group_messages` → ignorar sem log de erro. É normal: múltiplos comércios usam o mesmo grupo, motoboy pode citar mensagem de outro.

**R09 — "eu" quoted de pedido já fechado → ignorar**
`group_messages` só contém pedidos ainda processáveis. Pedidos aceitos ou expirados não ficam na tabela. Se `stanzaId` não der match → ignora. Não precisa checar status separadamente.

**R10 — Janela de 4s é obrigatória**
Nunca processar o primeiro "eu" imediatamente. Sempre aguardar a janela completa. Motivo: múltiplos motoboys respondem simultaneamente e o "primeiro" que chegou ao servidor pode não ser o mais rápido na prática (latência de entrega WA é variável).

**R11 — Lock em memória ANTES do primeiro `await`**
Ao iniciar o processamento de um "eu" vencedor, adicionar `orderId` ao Set de lock **antes** de qualquer operação assíncrona. Se outro "eu" do mesmo pedido chegar durante o processamento, o lock impede duplo processamento. Remover do Set no `finally`.

**R12 — Double-check em dois momentos**
Verificar se pedido já foi aceito: (1) na entrada do `handleEu`, antes de enfileirar; (2) antes de processar a fila após os 4s. O status pode mudar durante a janela de coleta.

**R13 — "eu" do próprio número da conta → ignorar**
Se a mensagem vier do JID da própria conta conectada, ignorar. Evita loop quando API envia msg no grupo e sistema processa como "eu".

---

### Dispatch API — Aceitação (processAcceptance)

**R14 — Marcar pedido como aceito no DB é o PRIMEIRO passo**
Antes de enviar reação, antes de enviar MSG 1. Motivo: se qualquer envio falhar depois, o pedido já está bloqueado no DB e não será processado duas vezes. Ordem: DB lock → reação → MSG1 → MSG2 → MSG3 → atualizar fase.

**R15 — Falha na reação 👍 → não-fatal, continuar**
Reação é cosmética (feedback visual para o motoboy no grupo). Se falhar → `warn` + continuar para MSG 1. Nunca lançar erro por causa de reação.

**R16 — Falha em MSG 1 ou MSG 2 → fatal, lançar erro**
Se não conseguir enviar endereço de retirada ou entrega → lançar erro. Motoboy sem endereço não consegue entregar. O pedido fica como `accepted` no DB (não vai ser reprocessado), mas o problema fica visível nos logs para intervenção manual.

---

### Dispatch API — Conexão WhatsApp

**R17 — LID resolution obrigatória**
WhatsApp envia JIDs no formato `@lid` para participantes de grupo em alguns dispositivos. Sempre resolver `@lid → @s.whatsapp.net` usando mapa populado via `groupMetadata` no connect e eventos `contacts.upsert` / `contacts.update`. Se não resolver → usar LID como fallback com `warn` (não quebrar o fluxo).

**R18 — `getMessage: async () => undefined`**
Parâmetro obrigatório ao criar socket Baileys. Sem isso, Baileys tenta buscar mensagens antigas ao processar eventos e quebra o pipeline interno de eventos com erros silenciosos.

**R19 — `syncFullHistory: false`**
Nunca sincronizar histórico completo ao conectar. Causa lentidão severa na inicialização e pode travar o socket por vários minutos em contas com histórico grande.

**R20 — 5 minutos sem evento WA = reconectar**
Baileys pode ficar em estado "conectado" mas silencioso — envia mensagens mas não recebe eventos. Se nenhum evento (qualquer tipo) chegar em 5 minutos → fechar socket e reconectar. Este é o cenário mais comum de degradação silenciosa.

---

### ZasHub — Regras para quem chama a API

**R21 — Validar status do pedido antes de chamar `/group/announce`**
Antes de chamar o endpoint de announce, verificar no ZasHub se o pedido ainda está com status `pronto`. O pedido pode ter mudado de fase entre o evento de criação e o momento da chamada (cancelamento, erro, etc.). Announce de pedido cancelado gera confusão operacional.

**R22 — Não chamar announce duas vezes para o mesmo pedido**
ZasHub deve manter controle de quais pedidos já foram anunciados (equivalente ao `isOrderAnnounced` atual). A Dispatch API não faz dedup por orderId — apenas armazena o `msgId` retornado. Se ZasHub chamar duas vezes, dois anúncios serão enviados.

---

### ZasHub — Cadastro de Motoboy (via WA privado)

**R23 — Não perguntar PIX duas vezes no mesmo dia**
Se motoboy já tem sessão com `confirmed_at = hoje` → ignorar mensagens privadas desse JID. Evita spam de perguntas em dias com múltiplas entregas do mesmo motoboy.

**R24 — Acumular mensagens antes de chamar AI**
Não chamar `extractNameAndPix` com uma única mensagem curta. Acumular em buffer e chamar AI com todas as mensagens do ciclo. Motoboys frequentemente mandam nome em uma mensagem e PIX em outra.

**R25 — Após 3 tentativas AI sem extrair → pedir formato direto**
Se após 3 mensagens acumuladas a AI não extraiu nome e PIX → limpar buffer e enviar instrução estruturada:
`"Me manda seu nome completo e chave PIX separados:\nJoão Silva\n11999990000"`

**R26 — AI falhou → tratar como `ignore`, não como erro**
Se chamada à AI lançar exceção (timeout, erro de rede, resposta inválida) → retornar estado neutro (`null`/`ignore`/`inconclusivo`). Nunca deixar falha de AI derrubar o fluxo de cadastro.

**R27 — Normalizar resposta da AI antes de comparar**
Remover acentos + lowercase antes de comparar retorno de confirmação. AI pode retornar `"Sim"`, `"SIM"`, `"sim"`, `"Não"`, `"nao"` — todos devem funcionar.

**R28 — `interpretKeyResponse` retorna `ignore` em caso de dúvida**
Se AI não consegue determinar se motoboy está confirmando ou atualizando chave → retornar `ignore`. Melhor ignorar mensagem irrelevante do que interpretar errado e atualizar chave indevidamente.

---

## GRUPO 1 — Esqueleto da API `[JUNTO]`

> Base que tudo depende. Fazer primeiro.

### S01 — Setup do projeto

- Node.js 20 + Fastify
- Estrutura de pastas: `src/routes/`, `src/services/`, `src/db/`, `src/wa/`
- `.env.example` com todas variáveis documentadas
- `Dockerfile` + `docker-compose.yml`
- Script de start com PM2 ou direto `node src/index.js`

### S02 — Autenticação da API

- Middleware global: valida header `x-api-key`
- Se ausente ou inválido → 401
- Aplicado em todas rotas exceto `/health/status` (pode ser pública)

### S03 — SQLite — state.db

- Schema inicial:
  ```sql
  CREATE TABLE group_messages (msg_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, sent_at TEXT NOT NULL);
  CREATE TABLE instance_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  ```
- Seed inicial: `dispatch_enabled = 'true'`, `health_status = 'healthy'`
- Módulo `db.js` com funções: `getState(key)`, `setState(key, value)`, `insertGroupMsg(msgId, orderId)`, `getOrderByMsgId(msgId)`

---

## GRUPO 2 — Conexão WhatsApp `[JUNTO]`

> Portar e adaptar o `client.js` atual. Não reinventar.

### S04 — Baileys client (adaptar do atual)

- Conectar usando `useMultiFileAuthState` + `fetchLatestBaileysVersion`
- Suprimir logs internos do Baileys (logger silent)
- Eventos emitidos internamente: `wa:message`, `wa:connected`, `wa:disconnected`
- LID resolution: manter mapa `_lidToJid` + popular via `groupMetadata` on connect + eventos `contacts.upsert` / `contacts.update`
- `getMessage: async () => undefined` (evita retries internos quebrarem pipeline)

### S05 — Health check de conexão (reconexão automática por inatividade)

- Se nenhum evento em 5 minutos → forçar reconexão
- Portar lógica de `_startHealthCheck` / `_stopHealthCheck` do atual
- Separado do health check manual (seção GRUPO 6)

### S06 — sendText e sendReaction

- `wa.sendText(jid, text)` → retorna `{ msgId }`
- `wa.sendReaction(jid, msgId, emoji)`
- Ambos lançam erro se socket não inicializado

---

## GRUPO 3 — Endpoints de Dispatch `[JUNTO]`

### S07 — POST /group/announce

```
Body: { orderId: string, text: string }

1. Checar dispatch_enabled → se false, retornar 423 { error: 'dispatch disabled' }
2. Enviar text para WA_GROUP_JID
3. Salvar em group_messages: msgId → orderId
4. Retornar { msgId }
```

### S08 — POST /group/react

```
Body: { euMsgId: string, emoji: string }

1. Checar dispatch_enabled → se false, retornar 423
2. Enviar reação no WA_GROUP_JID
3. Retornar { ok: true }
```

### S09 — POST /message/send

```
Body: { jid: string, text: string }

1. Checar dispatch_enabled → se false, retornar 423
2. Enviar text para jid
3. Retornar { ok: true }
```

---

## GRUPO 4 — Detecção de "eu" + Webhook `[JUNTO]`

> Coração do serviço. Depende de GRUPO 2 e GRUPO 3.

### S10 — Escuta de mensagens do grupo

- Ouvir evento `wa:message`
- Filtrar: deve ser do `WA_GROUP_JID`
- Filtrar: `dispatch_enabled = true`
- Filtrar: texto normalizado == `"eu"` (trim + toLowerCase)
- Ignorar mensagens próprias (remetente == número da conta)

### S11 — Detecção de modo (quoted vs plain)

```
Se tem stanzaId (msg.extendedTextMessage?.contextInfo?.stanzaId):
  Modo QUOTED:
    Buscar group_messages WHERE msg_id = stanzaId
    Se não encontrar → ignorar (outro comércio ou pedido fechado)
    Se encontrar → { orderId, jid, msgId, mode: 'quoted' }

Se não tem stanzaId:
  Modo PLAIN:
    Buscar group_messages ORDER BY sent_at DESC LIMIT 1
    Se não houver → ignorar
    Se houver → { orderId, jid, msgId, mode: 'plain' }
```

**Regra crítica:** `WHERE msg_id = stanzaId` não filtra por status — filtra apenas se o msgId é nosso. Pedidos "fechados" simplesmente não estão em group_messages (foram deletados após expirar ou nunca foram nossos).

### S12 — Fila de coleta (janela de 4s) + webhook

```
Map em memória: orderId → { timer, entries[] }

Ao receber "eu" válido:
  Se orderId não está no Map:
    Criar entrada, push entry, iniciar setTimeout(4000)
  Senão:
    Push entry na lista existente

Ao disparar timer:
  POST {ZASHUB_WEBHOOK_URL}/wa/eu-received
  Headers: { x-webhook-secret: ZASHUB_WEBHOOK_SECRET }
  Body: { orderId, entries: [{ jid, msgId, mode, receivedAt }] }
  Deletar entry do Map
```

**Nota de implementação:** Map em singleton funciona com `node src/index.js` (processo único). Não usar serverless para este serviço.

---

## GRUPO 5 — Controle Enable/Disable `[JUNTO]`

### S13 — POST /dispatch/enable e /dispatch/disable

```
POST /dispatch/enable
  setState('dispatch_enabled', 'true')
  Retornar { enabled: true }

POST /dispatch/disable
  setState('dispatch_enabled', 'false')
  Retornar { enabled: false }

GET /dispatch/status
  Retornar { enabled: bool }
```

- Flag persiste no SQLite (sobrevive restart)
- Verificada em S07, S08, S09, S10

---

## GRUPO 6 — Health Check Manual

### S14 — GET /health/ping

```
1. Enviar no WA_HEALTH_GROUP_JID:
   "🔍 Teste de conectividade. Responda 'eu' pra validar."
2. setState('health_status', 'awaiting_manual_test')
3. Retornar { status: 'awaiting_manual_test' }
```

### S15 — GET /health/retest

```
1. Enviar no WA_HEALTH_GROUP_JID:
   "🔁 Reteste iniciado. Responda 'eu' em 30s."
2. Iniciar timer de 30s aguardando "eu" do WA_HEALTH_GROUP_JID
   (escuta separada da escuta de dispatch — verificar remoteJid == WA_HEALTH_GROUP_JID)
3a. Recebeu "eu" dentro de 30s:
     setState('health_status', 'healthy')
     sendText(WA_HEALTH_GROUP_JID, "✅ eco ok")
     Retornar { status: 'healthy' }
3b. Não recebeu em 30s:
     setState('health_status', 'degraded')
     Disparar reconexão automática (chamar internamente S17)
     Retornar { status: 'degraded', action: 'reconnecting' }
```

### S16 — GET /health/status

```
Retornar {
  status: getState('health_status'),
  waConnected: bool,
  dispatchEnabled: bool,
  lastConnectedAt: getState('last_connected_at')
}
```

---

## GRUPO 7 — Reconexão + QR via S3 + Email `[JUNTO]`

### S17 — POST /auth/reconnect (+ trigger interno)

```
1. setState('health_status', 'reconnecting')
2. Fechar socket Baileys (sock.end())
3. Aguardar evento wa:disconnected
4. Reiniciar conexão (connect())
5. Baileys emite evento 'qr' com string do QR
6. Converter QR string → PNG (lib: 'qrcode' package)
7. Upload PNG para S3:
   - Bucket: AWS_BUCKET
   - Key: qr-codes/qr-{timestamp}.png
   - ACL: private
   - URL pré-assinada: TTL 30 minutos
8. Enviar email (Nodemailer):
   Para: NOTIFY_EMAIL
   Assunto: "[ZasHub] WhatsApp QR Code — ação necessária"
   Body: "Escaneie o QR: {url}"
9. On connection='open':
   setState('health_status', 'healthy')
   setState('last_connected_at', now())
   sendText(OWNER_JID, "✅ WhatsApp reconectado em {timestamp}")
   POST {ZASHUB_WEBHOOK_URL}/wa/connected { timestamp }
```

**Nota:** Não deletar `./auth/baileys_auth` antes de reconectar — Baileys tenta reutilizar sessão. Só limpar se for logout explícito (statusCode === loggedOut).

---

## GRUPO 8 — Observabilidade `[JUNTO]`

> Baixa prioridade. Fazer depois que tudo funcionar.

### S18 — Logging estruturado

- Prefixos por módulo: `[WA]`, `[DISPATCH]`, `[HEALTH]`, `[AUTH]`, `[DB]`
- Nível configurável via `LOG_LEVEL` env
- Timestamp em todos os logs

### S19 — Retry com backoff em chamadas de webhook

```
withRetry(fn, retries=3):
  attempt 1 → falha → aguardar 1000ms
  attempt 2 → falha → aguardar 2000ms
  attempt 3 → falha → lançar erro
```

Aplicar em: webhooks disparados para ZasHub, upload S3, envio de email.

### S20 — Pausa entre envios em grupo

- Se múltiplos `POST /group/announce` em sequência rápida: sem controle interno
- Responsabilidade do caller (ZasHub) espaçar chamadas
- API apenas documenta recomendação de 500ms entre announces

---

## Ordem de Implementação Recomendada

```
GRUPO 1 (S01-S03)  → base
GRUPO 2 (S04-S06)  → WhatsApp funciona
GRUPO 3 (S07-S09)  → envio funciona
GRUPO 4 (S10-S12)  → recepção + webhook funciona  ← sistema mínimo viável
GRUPO 5 (S13)      → controle operacional
GRUPO 6 (S14-S16)  → health check manual
GRUPO 7 (S17)      → reconexão
GRUPO 8 (S18-S20)  → polish
```

Sistema mínimo viável (MVP) = GRUPOs 1, 2, 3, 4.
