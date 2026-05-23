# node:20-slim (Debian/glibc) — better-sqlite3 usa binário prebuilt (sem compilar).
# (alpine/musl exigiria python3+make+g++ e build do native addon.)
FROM node:20-slim

WORKDIR /app

# Instala só deps de produção. package-lock garante versões travadas.
COPY package*.json ./
RUN npm ci --omit=dev

# Só o código da aplicação (ver .dockerignore). auth/ e data/ vêm de volume.
COPY src ./src

# Usuário não-root já existente na imagem (uid 1000). Os volumes ./auth e ./data
# no host devem pertencer ao uid 1000 (ver setup-vm.md), senão dá EACCES.
USER node

EXPOSE 3001

CMD ["node", "src/index.js"]
