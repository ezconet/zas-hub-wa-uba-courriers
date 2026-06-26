# Contrato: consulta de elegibilidade antes do react 👍

**Spec**: 099-react-status-guard | **Lado**: API do WhatsApp (courrier-notify) → Hub
**Status**: endpoint implementado no Hub. **A ligação no lado da API do WhatsApp é responsabilidade do leitor (fora de escopo deste repo).**

## Objetivo

Segunda camada de validação. Antes de executar **qualquer** reação 👍 ("joia") na msg
"eu" do motoboy, a API do WhatsApp deve consultar o Hub e confirmar que o pedido ainda
está elegível (em "Pronto"/READY). Isso evita reagir em pedidos já atribuídos
("Motoboy a caminho"/DISPATCHED) quando a courrier reconecta e re-entrega "eu"s antigos.

## Request

| Item | Valor |
|------|-------|
| Método | `GET` |
| URL | `{HUB_BASE_URL}/api/dispatch/order-status` |
| Query param | `orderId=<id do pedido>` (obrigatório) |
| Header | `x-webhook-secret: <COURRIER_WEBHOOK_SECRET>` |
| Body | (nenhum) |
| Timeout sugerido | ~3000 ms |

- `HUB_BASE_URL`: base do Hub (env no lado da API do WhatsApp), ex.: `https://hub.exemplo.com`.
- `COURRIER_WEBHOOK_SECRET`: **o mesmo segredo já usado** pelo webhook `eu-received`.
- Endpoint é read-only — não muta nada no Hub. Pode ser chamado quantas vezes precisar.

## Response

`200 OK`, JSON:

```json
{ "orderId": "abc123", "eligible": true, "status": "READY" }
```

| Campo | Tipo | Significado |
|-------|------|-------------|
| `orderId` | string | Echo do `orderId` consultado. |
| `eligible` | boolean | `true` **apenas** quando o pedido está em "Pronto" (`status === "READY"`). Caso contrário `false`. |
| `status` | string \| null | Status bruto do pedido no Hub; `null` se o pedido não for encontrado. |

### Outros códigos

| Código | Quando | Ação da API do WhatsApp |
|--------|--------|-------------------------|
| `400` | `orderId` ausente | Não reagir (request mal formado). |
| `401` | `x-webhook-secret` ausente/incorreto | Não reagir (corrigir o segredo). |
| `5xx` / erro de rede / timeout | Hub indisponível | Não reagir (fail-closed). |

## Regra FAIL-CLOSED

> Execute o react **somente se** a resposta for `200` **E** `eligible === true`.

Em **qualquer** outro cenário — `eligible: false`, status HTTP não-200, erro de rede ou
timeout (~3s) — **NÃO** execute o react. Na dúvida, não reage.

## Exemplo curl

```bash
curl -sS -m 3 \
  -H "x-webhook-secret: $COURRIER_WEBHOOK_SECRET" \
  "$HUB_BASE_URL/api/dispatch/order-status?orderId=abc123"
# → {"orderId":"abc123","eligible":true,"status":"READY"}
```

## Pseudo-código do guard (lado API do WhatsApp)

```js
const REACT_GUARD_TIMEOUT_MS = 3000;

async function canReact(orderId) {
  const url = `${process.env.HUB_BASE_URL}/api/dispatch/order-status` +
              `?orderId=${encodeURIComponent(orderId)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REACT_GUARD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "x-webhook-secret": process.env.COURRIER_WEBHOOK_SECRET },
      signal: ctrl.signal,
    });
    if (res.status !== 200) return false;        // não-200 → fail-closed
    const data = await res.json();
    return data?.eligible === true;              // só reage se elegível
  } catch {
    return false;                                // rede/timeout → fail-closed
  } finally {
    clearTimeout(timer);
  }
}

// Envolva a execução do react:
async function executeReactGuarded(orderId, reactArgs) {
  if (!(await canReact(orderId))) {
    // logar skip (motivo: status/erro) e abortar silenciosamente
    return;
  }
  await sendReaction(reactArgs); // /group/react só roda quando elegível
}
```

## De onde vem o `orderId`

O Hub passou a enviar `orderId` no corpo do `POST /group/react`:

```json
{ "orderId": "abc123", "euMsgId": "...", "euJid": "...", "emoji": "👍" }
```

A API do WhatsApp usa esse `orderId` pra chamar o `canReact(orderId)` antes de aplicar a
reação. (Origem Hub: `react()` em `src/modules/dispatch/CourrierNotifyClient.ts`.)

## Notas

- O guard equivalente também roda **dentro do Hub** (STEP 1 de `acceptOrder`), então este
  contrato é uma camada **adicional** de defesa no lado do produtor da reação.
- Endpoint Hub: `src/app/api/dispatch/order-status/route.ts`.
- Função de elegibilidade reaproveitada: `src/modules/dispatch/reactEligibility.ts`.
