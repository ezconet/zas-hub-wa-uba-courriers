# CLAUDE.md — Zas Hub WA Integration

## O que é este projeto

REST API Node.js que envolve WhatsApp (Baileys) e expõe endpoints HTTP simples.
Responsabilidade única: **transporte WhatsApp**. Zero regra de negócio de pedido ou motoboy.

Regras de negócio vivem no **ZasHub** (Next.js separado).
Esta API recebe comandos do ZasHub via HTTP e dispara webhooks de volta para ele.

## Specs — ler antes de codar

| Arquivo | Conteúdo |
|---|---|
| `specs/architecture.md` | Arquitetura completa, endpoints, fluxos, variáveis de ambiente |
| `specs/setup-vm.md` | Docker, Nginx, SSL, deploy |
| `specs/stories.md` | Stories por grupo + **REGRAS DEFENSIVAS R01–R28** (obrigatório) |

**Leia `specs/stories.md` seção "REGRAS DEFENSIVAS" antes de implementar qualquer coisa.**
Cada regra representa um problema real que surgiu em produção.

## Arquivos battle-tested — NÃO reescrever do zero

Estes arquivos foram copiados de produção. Estão testados e funcionando.
Adaptar imports/paths se necessário, mas não mudar lógica central:

| Arquivo | O que é | O que pode mudar |
|---|---|---|
| `src/wa/client.js` | Conexão Baileys, LID resolution, health check, sendText, sendReaction | Adaptar imports para novo config.js |
| `src/services/euDetector.js` | Detecção de "eu", janela 4s, lock, double-check, quoted vs plain | Mudar output: em vez de chamar motoboySender, disparar webhook para ZasHub |
| `src/services/aiExtractor.js` | Extração de nome/PIX via Claude (Bedrock) | Nada |
| `src/utils/messageBuilder.js` | Templates das mensagens WA | Atualizar URL mobifyme → zashub.com.br em MSG3 |
| `src/utils/greeting.js` | Saudação por horário | Nada |
| `src/utils/mapLink.js` | Geração de link Google Maps | Nada |

## Referência do projeto original

`_reference/src/` contém o código completo do projeto anterior.
Consultar para entender detalhes de implementação de qualquer lógica.

## Stack

- **Runtime:** Node.js 20
- **HTTP:** Fastify
- **WhatsApp:** @whiskeysockets/baileys
- **DB:** SQLite (better-sqlite3) — apenas estado interno
- **AI:** AWS Bedrock (Claude Haiku) — para extração PIX/nome
- **Infra:** Docker + Nginx + Let's Encrypt

## Estrutura de pastas

```
src/
├── wa/           ← cliente WhatsApp (battle-tested)
├── services/     ← euDetector, aiExtractor (battle-tested)
├── utils/        ← messageBuilder, greeting, mapLink (battle-tested)
├── routes/       ← handlers HTTP (NOVO — seguir specs/stories.md)
├── db/           ← schema.sql + database.js
├── config.js     ← variáveis de ambiente
└── index.js      ← entry point (Fastify + connect WA + rotas)
auth/             ← credenciais Baileys (NÃO commitar, NÃO deletar)
data/             ← state.db SQLite
specs/            ← documentação completa
_reference/       ← código original para consulta
```

## Regras de implementação (resumo crítico)

1. **Todos endpoints exigem header `x-api-key`** — middleware global, exceto `/health/status`
2. **`dispatch_enabled = false` bloqueia tudo** — announce, react, send, escuta de "eu"
3. **Falha no envio WA → não salvar no DB** — deixar próximo ciclo retentar (R02)
4. **Lock de processamento antes do primeiro `await`** — Set em memória (R11)
5. **Double-check em dois momentos** — entrada do handleEu + antes de processar fila (R12)
6. **Reação 👍 não-fatal** — falha não impede MSG 1/2/3 (R15)
7. **`getMessage: async () => undefined`** — parâmetro obrigatório no socket Baileys (R18)
8. **`syncFullHistory: false`** — obrigatório (R19)
9. **5min sem evento WA = reconectar** — degradação silenciosa (R20)
10. **Retry com backoff em chamadas externas** — 3 tentativas, delay = attempt * 1000ms (R05)

## Variáveis de ambiente

Ver `.env.example` para lista completa com descrições.
Copiar para `.env` e preencher antes de rodar.

## Como rodar (desenvolvimento)

```bash
npm install
cp .env.example .env
# preencher .env
# copiar auth/baileys_auth do projeto anterior (evita re-scan de QR)
node src/index.js
```

## Endpoints

Ver `specs/architecture.md` seção "Endpoints Expostos" para lista completa.

Resumo:
- `POST /group/announce` — enviar no grupo
- `POST /group/react` — reagir em msg
- `POST /message/send` — msg privada
- `POST /dispatch/enable|disable` + `GET /dispatch/status`
- `GET /health/ping` + `GET /health/retest` + `GET /health/status`
- `POST /auth/reconnect`

## Webhooks disparados (API → ZasHub)

- `POST {ZASHUB_WEBHOOK_URL}/wa/eu-received` — após janela de 4s, todos os "eu"s coletados
- `POST {ZASHUB_WEBHOOK_URL}/wa/connected` — após reconexão bem-sucedida

Header em todos: `x-webhook-secret: {ZASHUB_WEBHOOK_SECRET}`
