# Integração: encaminhar comprovante de motoboy pro Hub (OCR)

Feature do Hub: spec `089-motoboy-receipt-ocr` (branch `089-motoboy-receipt-ocr`, ainda não em prod).

## O que o courrier-notify precisa fazer

Escutar **mensagens de imagem** vindas de um JID específico (o "recebedor" — pessoa/grupo que
recebe o comprovante encaminhado pelo operador), baixar a imagem, base64, e postar no webhook do Hub.

Hub faz o resto: dedupe por `msgId` → valida JID → OCR (Bedrock) → casa com o pagamento aberto →
salva no S3 → marca pago → avisa o motoboy. Idempotente: pode reenviar o mesmo `msgId` sem efeito.

> **Fase de teste:** a leitura pode ser no **grupo de teste** (mesmo do `WA_PROBE_GROUP_JID`).
> Basta o JID que você enviar bater com `receiptReceiverJid` configurado no Hub pro restaurante.

---

## Contrato do webhook (lado Hub — já implementado)

```
POST {ZASHUB_WEBHOOK_URL}/wa/receipt-received
headers: x-webhook-secret: <ZASHUB_WEBHOOK_SECRET>   (= COURRIER_WEBHOOK_SECRET no Hub)
body (JSON):
{
  "restaurantId": "c943d847-...",   // qual restaurante (string)
  "jid":          "<remoteJid>",    // de onde veio a imagem (grupo de teste OU dm do recebedor)
  "msgId":        "<msg.key.id>",   // id da mensagem WA — chave de dedupe (@unique no Hub)
  "imageBase64":  "<base64 puro>",  // SEM prefixo data:...;base64,
  "mime":         "image/jpeg"      // opcional, default image/jpeg
}
```

Resposta sempre `200 {ok:true, outcome}`. `outcome` ∈ `duplicate | ignored_jid | paid | needs_review`.
Non-2xx só em secret errado (401). Como o Hub sempre devolve 200, **não** precisa retry por outcome —
o retry do `postWebhook` (3x) cobre só falha de rede/HTTP.

`jid` enviado **tem que ser igual** ao `receiptReceiverJid` configurado no Hub (senão → `ignored_jid`,
nada acontece). Na fase de teste, configure os dois com o JID do grupo de teste.

---

## Mudanças no repo

### 1. `src/config.js` — novas envs

```js
  // Comprovante de motoboy (OCR no Hub)
  RECEIPT_ENABLED: process.env.RECEIPT_ENABLED === 'true',
  RECEIPT_LISTEN_JID: process.env.RECEIPT_LISTEN_JID || '', // JID a escutar (grupo de teste na fase 1)
  RECEIPT_RESTAURANT_ID: process.env.RECEIPT_RESTAURANT_ID || '', // restaurante alvo
```

> `ZASHUB_WEBHOOK_SECRET` já existe e já é mandado no header `x-webhook-secret` — reaproveitar.
> No Hub, esse mesmo valor vai em `COURRIER_WEBHOOK_SECRET`.

### 2. `src/services/webhook.js` — novo helper

```js
function sendReceipt({ restaurantId, jid, msgId, imageBase64, mime }) {
  return postWebhook('/wa/receipt-received', { restaurantId, jid, msgId, imageBase64, mime });
}
// adicionar a sendReceipt no module.exports
```

### 3. `src/wa/messageHandlers.js` — detectar imagem do recebedor

Baileys baixa mídia com `downloadMediaMessage`. Dentro do loop de `messages`, **antes** do trecho de `'eu'`:

```js
const { downloadMediaMessage } = require('@whiskeysockets/baileys'); // confirmar o pacote usado no client.js
const webhook = require('../services/webhook');

// ... dentro do for (const msg of messages), após os guards fromMe/!msg.message:
if (config.RECEIPT_ENABLED && jid === config.RECEIPT_LISTEN_JID) {
  const img = msg.message?.imageMessage;
  if (img) {
    try {
      const buf = await downloadMediaMessage(msg, 'buffer', {}, {
        logger: console,                 // ajustar p/ o logger usado
        reuploadRequest: waClient.sock.updateMediaMessage, // ver assinatura real no client.js
      });
      await webhook.sendReceipt({
        restaurantId: config.RECEIPT_RESTAURANT_ID,
        jid,
        msgId: msg.key.id,
        imageBase64: buf.toString('base64'),
        mime: img.mimetype || 'image/jpeg',
      });
      console.log('[RECEIPT] comprovante enviado ao Hub', msg.key.id);
    } catch (err) {
      console.error('[RECEIPT] falha ao baixar/enviar comprovante:', err.message);
    }
    continue; // imagem tratada — não cai no fluxo de "eu"
  }
}
```

> Conferir no `src/wa/client.js` a forma certa de chamar `downloadMediaMessage` (objeto socket, logger,
> `reuploadRequest`). Cada versão de Baileys muda a assinatura. Se já houver download de mídia em algum
> lugar (ex.: aiExtractor/QR), copiar o padrão de lá.

---

## .env (courrier-notify)

```
RECEIPT_ENABLED=true
RECEIPT_LISTEN_JID=<JID do grupo de teste>          # ex.: 12036xxxxxxx@g.us
RECEIPT_RESTAURANT_ID=<id do restaurante no Hub>
# ZASHUB_WEBHOOK_URL e ZASHUB_WEBHOOK_SECRET já configurados
```

Descobrir o JID do grupo de teste: já é o que você usa em `WA_PROBE_GROUP_JID`.

---

## Checklist de teste (ponta a ponta)

1. Hub rodando com a branch `089-motoboy-receipt-ocr` + envs AWS (Bedrock/S3) + `COURRIER_WEBHOOK_SECRET`.
2. No Hub (Integrações do restaurante): `receiptReceiverJid` = JID do grupo de teste, `receiptOcrEnabled` = on.
3. No Hub: ter um pagamento de motoboy em `awaiting_payment` com "Abrir banco" clicado (gera `bankOpenedAt`).
   O comprovante precisa casar por valor + chave/nome/cpf do motoboy.
4. Subir courrier-notify com as envs acima.
5. Jogar uma **imagem de comprovante Pix** no grupo de teste.
6. Esperado: log `[RECEIPT] comprovante enviado`; Hub responde `outcome: "paid"`; motoboy recebe WA
   com link `/comprovante/<token>`; pagamento vira `paid`.
7. Casos de borda: imagem que não casa → `needs_review` (não finaliza); reenviar mesma msg → `duplicate`.

## Notas

- **Só imagem.** Texto/áudio/etc. ignorar (cai no fluxo normal).
- **Não confie no OCR pra decidir** — o Hub casa por *intenção* (pagamento aberto recente) + valor.
  Se nenhum/múltiplos pagamentos abertos casam, vira `needs_review` (operador resolve manual).
- Quando sair da fase de teste: trocar `RECEIPT_LISTEN_JID` pro JID real do recebedor e atualizar
  `receiptReceiverJid` no Hub. Multi-restaurante: se um dia precisar de mais de um, trocar a env única
  por um mapa JID→restaurantId.
