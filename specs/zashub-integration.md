# Spec — Integração ZasHub ↔ courrier-notify (dispatch de motoboy)

> **Status:** planejamento. Define como o **ZasHub** deve conversar com esta API
> (apelido **courrier-notify**) para o fluxo de motoboy. Não altera o ZasHub ainda.

---

## 1. Contexto e escopo

Esta API (`zas-hub-wa-uba-courriers`, apelido **courrier-notify**) roda no **número
pessoal do dono** via Baileys. Diferente da Evolution, ela **lê mensagens do grupo**
de motoboys — por isso existe.

**Divisão de responsabilidade no ZasHub:**

| Canal | Número | Gateway | Usado para |
|---|---|---|---|
| Transacional cliente | número do **restaurante** | **Evolution API** (permanece) | confirmações, status de pedido ao cliente, etc. |
| Dispatch de motoboy | número **pessoal do dono** | **courrier-notify** (esta API) | anúncio no grupo, leitura de "eu", reação 👍, PV ao motoboy |

**Só o módulo de motoboy do ZasHub muda.** Evolution e tudo de cliente continua igual.
Substituir a Evolution por completo fica para um momento futuro (fora deste spec).

---

## 2. Topologia

```
                         ┌─────────────────────────── ZasHub (Next.js, :3000) ───────────────────────────┐
                         │                                                                                │
  Cliente WhatsApp ◀───── Evolution API (número do RESTAURANTE)  ◀── transacional (INALTERADO)            │
                         │                                                                                │
  Grupo Motoboys  ◀───── courrier-notify (número PESSOAL) ◀────────── dispatch motoboy:                   │
  + PV motoboy    ──eu──▶ (Baileys, :3080)  ──webhook eu-received──▶  /api/wa/eu-received (novo)          │
                         │                  ──webhook connected────▶  /api/wa/connected   (novo)          │
                         │                  ◀── announce/react/send ── CourrierNotifyClient (novo)        │
                         └────────────────────────────────────────────────────────────────────────────┘
```

Tudo local na fase de teste; em produção, courrier-notify atrás de Nginx/SSL
(ver `specs/setup-vm.md`).

---

## 3. Configuração (variáveis de ambiente)

### courrier-notify (esta API) — já existe
```env
WA_GROUP_JID=<jid do grupo de motoboys>         # único grupo por instância
ZASHUB_WEBHOOK_URL=<base dos webhooks do ZasHub> # ex: http://127.0.0.1:3000/api
ZASHUB_WEBHOOK_SECRET=<segredo compartilhado>
API_SECRET=<chave da API>                        # exigida em x-api-key
```

### ZasHub — adicionar (NÃO remover as da Evolution)
```env
COURRIER_API_URL=http://127.0.0.1:3080      # base da courrier-notify
COURRIER_API_KEY=<= API_SECRET acima>        # enviado em header x-api-key
COURRIER_WEBHOOK_SECRET=<= ZASHUB_WEBHOOK_SECRET>  # valida webhooks recebidos
```

> **Atenção ao path do webhook:** a courrier-notify faz `POST {ZASHUB_WEBHOOK_URL}/wa/eu-received`.
> Se as rotas do ZasHub forem `/api/wa/eu-received`, então `ZASHUB_WEBHOOK_URL` deve
> terminar em `/api` (ex: `https://zashub.com.br/api`).

---

## 4. O que muda no ZasHub (somente o módulo de motoboy)

### Adicionar
- **`CourrierNotifyClient`** (cliente HTTP) implementando as 3 chamadas: `announce`,
  `react`, `messageSend`. Pode implementar a interface `WhatsAppProvider` existente
  (`src/modules/whatsapp/WhatsAppProvider.ts`) ou ser um client dedicado do módulo dispatch.
- **Rota webhook** `src/app/api/wa/eu-received/route.ts` — recebe os "eu"s coalescidos.
- **Rota webhook** `src/app/api/wa/connected/route.ts` — opcional (log/healthcheck).

### Trocar (no caminho de motoboy)
- `src/modules/dispatch/DispatchService.ts` — ao marcar pedido pronto (`fluxoB`),
  anunciar via `CourrierNotifyClient.announce()` em vez de `EvolutionWhatsAppProvider.sendToGroup()`.
- `src/modules/dispatch/DispatchNotifications.ts` — `sendReaction` e `sendPrivate*`
  passam a usar a courrier-notify (`react` / `messageSend`).

### Aposentar (no caminho de motoboy)
- `src/modules/dispatch/AcceptanceQueue.ts` — **a courrier-notify já faz a janela de 4s
  e o dedup**. O ZasHub recebe os "eu"s já agrupados em `eu-received`. Não precisa coalescer
  de novo.
- `src/app/api/dispatch/webhook/route.ts` — esse parser de `messages.upsert` da Evolution
  era para detectar "eu". A detecção agora vem pronta da courrier-notify. (Se a Evolution
  ainda mandar algum evento de grupo, pode ignorar — mas o número do restaurante nem está
  no grupo de motoboys.)

### Manter
- Modelos Prisma `DispatchOrder`, `DispatchAcceptance`, `Motoboy`, `DispatchMessageLog`,
  `NotificationConfig` — estado e auditoria continuam.
- Templates de mensagem (retirada/entrega) — texto é montado no ZasHub, enviado via courrier.
- Dedup de announce por pedido (`isOrderAnnounced` / `DispatchOrder.status`).
- Toda a Evolution (provider + webhook) para o transacional do cliente.

---

## 5. Contrato — ZasHub → courrier-notify (REST)

Base: `COURRIER_API_URL`. **Todos exigem header `x-api-key: COURRIER_API_KEY`**
(exceto `GET /health/status`). Corpo e resposta em JSON.

### 5.1 `POST /group/announce` — anuncia pedido no grupo
```
Req:  { "orderId": "string", "text": "string" }
200:  { "msgId": "string" }          # guardar em DispatchOrder.groupMsgId
423:  { "error": "dispatch disabled" }   # flag global desligada
400:  { "error": "..." }             # orderId/text faltando
500/502:                             # falha de envio WA → NADA salvo (R02); reenviar no próximo ciclo
```
- A courrier-notify guarda internamente `msgId → orderId` (para detecção quoted).
- O `text` é o anúncio completo (já montado pelo ZasHub).

### 5.2 `POST /group/react` — reage na msg "eu" do vencedor
```
Req:  { "euMsgId": "string", "emoji": "👍", "euJid": "5512...@s.whatsapp.net" }
200:  { "ok": true }
423/400/500
```
- **`euJid` é obrigatório** (participante que mandou o "eu"). Sem ele a reação não cola
  em mensagem de membro de grupo. `euMsgId` e `euJid` vêm do webhook `eu-received`.
- Emoji deve ir em **UTF-8** (cliente HTTP normal já faz; cuidado só com shells).

### 5.3 `POST /message/send` — PV ao motoboy
```
Req:  { "jid": "5512...@s.whatsapp.net", "text": "string" }
200:  { "ok": true }
423/400/500
```
- Use o `jid` do vencedor (vem em `eu-received`, já resolvido de @lid → @s.whatsapp.net).
- Para várias mensagens (retirada, entrega, etc.): chamadas sequenciais com **~500ms
  entre elas** (R04 — evita bloqueio por spam).

### 5.4 Controle (opcional, operacional)
```
POST /dispatch/enable    → { "enabled": true }
POST /dispatch/disable   → { "enabled": false }   # bloqueia announce/react/send/escuta de "eu"
GET  /dispatch/status    → { "enabled": bool }
```

### 5.5 Saúde / reconexão (opcional)
```
GET  /health/status      → { status, waConnected, dispatchEnabled, lastConnectedAt }   # PÚBLICO
GET  /health/ping        → dispara teste no grupo de validação (501 se não configurado)
GET  /health/retest      → { status: "healthy" } ou { status:"degraded", action:"reconnecting" }
POST /auth/reconnect     → { status: "reconnecting" }
```

---

## 6. Contrato — courrier-notify → ZasHub (Webhooks)

A courrier-notify faz `POST` para `ZASHUB_WEBHOOK_URL` + path, com header
**`x-webhook-secret: ZASHUB_WEBHOOK_SECRET`**. O ZasHub **deve validar** o secret.

**Retry:** 3 tentativas, backoff `attempt*1000ms` (R05). Se todas falharem (não-2xx),
a courrier-notify **não marca o pedido como disparado** → um próximo "eu" reabre o envio.
⇒ O receiver do ZasHub deve responder **2xx rápido** e processar de forma **idempotente**.

### 6.1 `POST /wa/eu-received`
```json
{
  "orderId": "string",
  "entries": [
    { "jid": "5512...@s.whatsapp.net", "msgId": "ABCD123", "mode": "quoted|plain", "receivedAt": "ISO" }
  ]
}
```
- `entries` = **todos** os "eu"s coletados na janela de 4s para esse pedido.
- O ZasHub **escolhe o vencedor** (recomendado: `entries[0]` = primeiro a chegar; regra é do ZasHub).
- Em seguida o ZasHub chama `react` (no vencedor) e `message/send` (PV ao vencedor).
- **Garantia da courrier-notify:** dispara `eu-received` **uma vez por rodada de announce**
  (dedup durável anti gasto-duplo). Para reabrir (ex: vencedor recusou), o ZasHub
  **re-anuncia** o pedido (`/group/announce` limpa o dedup e abre nova rodada).

### 6.2 `POST /wa/connected`
```json
{ "timestamp": "ISO" }
```
- Disparado quando a courrier-notify (re)conecta ao WhatsApp. Opcional: log/limpar estado degradado.

---

## 7. Fluxo completo

```
1. Pedido fica "pronto" no ZasHub, precisa de motoboy (needsMotoboy && deliveryType=DELIVERY).
   ZasHub valida status (R21) e dedup de announce (R22).
2. ZasHub monta o texto e chama courrier-notify: POST /group/announce { orderId, text }.
   → guarda msgId em DispatchOrder.groupMsgId; status "pending".
3. courrier-notify envia no grupo (número pessoal) e mapeia msgId→orderId.
4. Motoboy responde "eu" no grupo (quoted ou plain).
5. courrier-notify: janela 4s coletando "eu"s → POST /wa/eu-received { orderId, entries[] }.
6. ZasHub (receiver): escolhe vencedor; marca DispatchOrder accepted + winner; grava DispatchAcceptance.
7. ZasHub chama courrier-notify:
   a. POST /group/react { euMsgId, emoji:"👍", euJid }       (vencedor)
   b. POST /message/send { jid, text }  (retirada) … ~500ms … (entrega) …
8. (Opcional) ZasHub avisa o cliente via Evolution (número do restaurante) — fluxo separado.
```

---

## 8. Regras obrigatórias para o ZasHub

| # | Regra |
|---|---|
| R21 | Validar que o pedido ainda está "pronto" **antes** de chamar `/group/announce`. |
| R22 | **Não anunciar duas vezes** o mesmo pedido. A courrier-notify NÃO faz dedup por orderId no announce — só guarda o msgId. ZasHub controla via `DispatchOrder`. |
| — | `react` exige **`euJid`** (participante). Pegar de `eu-received`. |
| — | Escolha de vencedor é do ZasHub. Recebe **todos** os entries; processa **um**. |
| — | Entre PVs múltiplos, **~500ms** (R04). |
| — | Webhook receiver: validar `x-webhook-secret`, responder **2xx rápido**, ser **idempotente** (pode chegar repetido em retry). |
| — | Re-announce reabre a rodada de "eu" (a courrier-notify limpa o dedup no announce). Usar isso se o vencedor recusar. |

---

## 9. Mapeamento de campos

| courrier-notify | ZasHub | Observação |
|---|---|---|
| `orderId` (announce / eu-received) | `DispatchOrder.idPedido` | id opaco do pedido; ecoado de volta no webhook |
| `msgId` (resposta do announce) | `DispatchOrder.groupMsgId` | usado para detecção quoted |
| `entries[].jid` | JID do motoboy | já resolvido de @lid; usar em react (`euJid`) e message/send (`jid`) |
| `entries[].msgId` | — | id da msg "eu"; usar em react (`euMsgId`) |
| `entries[].mode` | — | `quoted`/`plain`, informativo |

---

## 10. Pontos em aberto / decisões

1. **Um grupo por instância.** A courrier-notify tem um único `WA_GROUP_JID`. Hoje o
   dono atende um grupo de motoboys → ok. Multi-restaurante / múltiplos grupos exigiria
   `groupJid` no `announce` ou uma instância por grupo. **Decidir se/quando.**
2. **Regra de vencedor** vive 100% no ZasHub. Definir (primeiro a chegar? prioridade?).
3. **Substituir Evolution por completo** (transacional via Baileys também): fora de escopo
   agora; exigiria a courrier-notify no número do restaurante + endpoints de envio ao cliente.
4. **Chave de idempotência** nos webhooks: opcionalmente a courrier-notify pode passar um
   id de rodada; hoje o ZasHub deve idempotentizar por `orderId` + estado do `DispatchOrder`.

---

## 11. Checklist de implementação (lado ZasHub)

- [ ] Env: `COURRIER_API_URL`, `COURRIER_API_KEY`, `COURRIER_WEBHOOK_SECRET`.
- [ ] `CourrierNotifyClient` (announce / react / messageSend) com header `x-api-key` + tratamento de 423/4xx/5xx.
- [ ] `DispatchService`: announce do pedido pronto → courrier (guardar `groupMsgId`).
- [ ] `DispatchNotifications`: react + PV via courrier.
- [ ] Rota `POST /api/wa/eu-received` (valida secret, escolhe vencedor, react + PV, marca accepted, idempotente).
- [ ] Rota `POST /api/wa/connected` (opcional).
- [ ] Aposentar `AcceptanceQueue` e o parsing de "eu" do webhook Evolution **no caminho de motoboy**.
- [ ] Manter Evolution para transacional do cliente.
- [ ] Configurar `WA_GROUP_JID` (courrier) = grupo de motoboys; secrets batendo nos dois lados.
- [ ] Teste E2E: announce → "eu" → eu-received → react 👍 → PV (usar `scripts/mock-zashub.js` como referência de comportamento).
