# Setup Spec — VM / Container / Domínio

## Infraestrutura

```
VM (VPS Linux)
├── Docker + Docker Compose
├── Nginx (reverse proxy + SSL)
├── Container: dispatch-wa-api
│     ├── Node.js 20
│     ├── Volume: ./auth  (credenciais WA — persistido fora do container)
│     └── Volume: ./data  (SQLite — persistido fora do container)
└── Certbot (SSL automático via Let's Encrypt)
```

---

## Docker

### Dockerfile

> Os arquivos reais estão na raiz do repo (`Dockerfile`, `docker-compose.yml`).
> Resumo das decisões:

```dockerfile
FROM node:20-slim          # glibc → better-sqlite3 usa prebuilt (alpine/musl exigiria compilar)
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
USER node                  # uid 1000 — volumes ./auth e ./data devem pertencer a 1000
EXPOSE 3001
CMD ["node", "src/index.js"]
```

### docker-compose.yml

```yaml
services:
  dispatch-api:
    build: .
    container_name: zas-hub-wa-api
    restart: unless-stopped
    ports:
      - "127.0.0.1:3001:3001"   # só localhost — Nginx faz o proxy
    environment:
      - PORT=3001               # fixa porta no container (sobrescreve PORT do .env)
    env_file:
      - .env
    volumes:
      - ./auth:/app/auth         # sessão Baileys (uid 1000)
      - ./data:/app/data         # SQLite (uid 1000)
    healthcheck:                 # slim não tem wget/curl → node fetch
      test: ["CMD", "node", "-e", "fetch('http://localhost:3001/health/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
```

### Comandos

```bash
# Build e subir
docker compose up -d --build

# Logs em tempo real
docker compose logs -f dispatch-api

# Restart sem rebuild
docker compose restart dispatch-api

# Derrubar
docker compose down
```

---

## Portas

| Porta | Uso | Exposta externamente? |
|---|---|---|
| 3001 | API Node.js | NÃO (só 127.0.0.1) |
| 80 | Nginx HTTP → redirect HTTPS | SIM |
| 443 | Nginx HTTPS | SIM |

Firewall: bloquear 3001 externamente. Só 80 e 443 abertas.

```bash
# UFW exemplo
ufw allow 80/tcp
ufw allow 443/tcp
ufw deny 3001/tcp
ufw enable
```

---

## Domínio

Domínio sugerido: `wa-api.zashub.com.br` (subdomínio dedicado)

DNS: registro A apontando para IP da VM.

---

## Nginx

### /etc/nginx/sites-available/dispatch-wa-api

```nginx
server {
    listen 80;
    server_name wa-api.zashub.com.br;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name wa-api.zashub.com.br;

    ssl_certificate     /etc/letsencrypt/live/wa-api.zashub.com.br/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wa-api.zashub.com.br/privkey.pem;

    # Segurança mínima
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Timeout generoso para webhooks longos
        proxy_read_timeout 60s;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/dispatch-wa-api /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

---

## SSL (Let's Encrypt)

```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d wa-api.zashub.com.br --non-interactive --agree-tos -m seu@email.com

# Renovação automática (já vem com certbot, verificar)
systemctl status certbot.timer
```

---

## Volumes — Persistência Crítica

```
./auth/baileys_auth/   ← NUNCA deletar. Contém sessão WA.
                         Se deletar: precisará escanear QR novamente.
./data/state.db        ← SQLite com mapeamento msgId↔orderId e estado.
                         Perder isso: próximo ciclo reconstrói, baixo impacto.
```

### Backup da sessão WA

```bash
# Cron diário — backup da pasta auth
0 3 * * * tar -czf /backups/baileys_auth_$(date +\%Y\%m\%d).tar.gz /app/auth/baileys_auth
```

---

## Deploy — Fluxo

```bash
# 1. Subir na VM
git pull origin main

# 2. Rebuild e restart
docker compose up -d --build

# 3. Verificar
docker compose logs -f dispatch-api
curl -H "x-api-key: $API_SECRET" https://wa-api.zashub.com.br/health/status
```

---

## Primeiro Setup (do zero)

```bash
# 1. Instalar Docker
curl -fsSL https://get.docker.com | sh
usermod -aG docker $USER

# 2. Instalar Nginx + Certbot
apt update && apt install -y nginx certbot python3-certbot-nginx

# 3. Clonar repositório
git clone <repo> /opt/dispatch-wa-api
cd /opt/dispatch-wa-api

# 4. Criar .env a partir do .env.example
cp .env.example .env
nano .env   # preencher (ver checklist abaixo)

# 5. Criar pastas de volume e dar dono ao uid do container (node = 1000)
mkdir -p auth data
sudo chown -R 1000:1000 auth data

# 5b. (Opcional) Copiar a sessão Baileys existente p/ evitar re-scan de QR
#     scp -r auth/baileys_auth da máquina atual → ./auth/baileys_auth
sudo chown -R 1000:1000 auth

# 6. Subir container
docker compose up -d --build

# 7. Configurar Nginx e SSL
# (copiar config acima, ln -s, certbot)

# 8. Verificar saúde
curl -H "x-api-key: $API_SECRET" https://wa-api.zashub.com.br/health/status

# 9. (Se NÃO copiou a sessão) Parear o QR
docker compose logs -f dispatch-api
# Sessão nova: o QR vai pro S3 (presigned) + email via SNS + webhook /wa/qr pro ZasHub.
# Headless (VM sem tela): pegue o link no email/SNS ou na tela do ZasHub. O QR também
# sai no log como fallback.
```

---

## Pré-subida — checklist de `.env` (courrier-notify)

```env
PORT=3001                       # compose já fixa; manter 3001
WA_GROUP_JID=<grupo>            # validação pós-deploy: manter o grupo de TESTE
OWNER_JID=<seu jid>            # opcional: ping "reconectado" no WhatsApp

# ZasHub (produção)
ZASHUB_WEBHOOK_URL=https://zashub.com.br/api
ZASHUB_WEBHOOK_SECRET=<segredo>  # = COURRIER_WEBHOOK_SECRET no ZasHub
API_SECRET=<segredo>             # = COURRIER_API_KEY no ZasHub

# AWS — QR de reconexão (objeto privado, URL presigned)
AWS_BUCKET=<bucket>
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=<...>
AWS_SECRET_ACCESS_KEY=<...>
AWS_S3_QR_KEY=courrier-notify/qr.png
QR_PRESIGN_TTL_S=900
SNS_TOPIC_ARN=arn:aws:sns:us-east-1:608231491900:Zas-Hub-WA-Disconected
```

**Pré-requisitos AWS (uma vez):**
- Bucket S3 **privado** (sem acesso público); a credencial precisa de `s3:PutObject` + `s3:GetObject` no prefixo `courrier-notify/`.
- Tópico SNS criado + **subscription de email** confirmada; credencial com `sns:Publish` no tópico.

> **Segurança:** a imagem do QR vincula a conta WhatsApp. Bucket privado + URL presigned
> com TTL curto são obrigatórios — nunca tornar o objeto público.

---

## Monitoramento Básico

```bash
# Status do container
docker compose ps

# Uso de recursos
docker stats dispatch-wa-api

# Logs com filtro de erro
docker compose logs dispatch-api | grep -i error
```

Recomendado: configurar alerta de email/WA se container cair (via Docker healthcheck + script de monitoramento ou UptimeRobot apontando para `/health/status`).
