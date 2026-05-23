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

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3001

CMD ["node", "src/index.js"]
```

### docker-compose.yml

```yaml
version: '3.9'

services:
  dispatch-api:
    build: .
    container_name: dispatch-wa-api
    restart: unless-stopped
    ports:
      - "127.0.0.1:3001:3001"   # só localhost — Nginx faz o proxy
    volumes:
      - ./auth:/app/auth         # credenciais Baileys (não perder entre deploys)
      - ./data:/app/data         # SQLite
    env_file:
      - .env
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3001/health/status"]
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
nano .env   # preencher todas variáveis

# 5. Criar pastas de volume
mkdir -p auth data

# 6. Subir container
docker compose up -d --build

# 7. Configurar Nginx e SSL
# (copiar config acima, ln -s, certbot)

# 8. Verificar saúde
curl -H "x-api-key: $API_SECRET" https://wa-api.zashub.com.br/health/status

# 9. Escanear QR (primeiro acesso)
docker compose logs -f dispatch-api
# QR aparece no terminal OU é enviado por email se SMTP configurado
```

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
