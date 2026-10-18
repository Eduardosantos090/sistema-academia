#!/usr/bin/env bash
# Instala a Evolution API v2 (WhatsApp por QR Code do Venceu) num Ubuntu 22.04/24.04 limpo.
# Uso (como root):  bash instalar.sh [dominio-opcional]
#   Sem domínio, usa <ip>.sslip.io (https automático, sem precisar comprar domínio).
# No final mostra o ENDEREÇO e a CHAVE para colar no Venceu → Plataforma → WhatsApp (QR Code).
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Rode como root (sudo -i)."; exit 1; }
DIR=/opt/evolution
DOMINIO="${1:-}"

echo "==> Atualizando o sistema e instalando o Docker…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null
apt-get install -y curl ca-certificates openssl ufw >/dev/null
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh >/dev/null

if [ -z "$DOMINIO" ]; then
  IP=$(curl -fsS4 https://api.ipify.org || hostname -I | awk '{print $1}')
  DOMINIO="$(echo "$IP" | tr '.' '-').sslip.io"
fi

mkdir -p "$DIR"
cd "$DIR"

if [ ! -f .env ]; then
  echo "==> Gerando senhas…"
  API_KEY=$(openssl rand -hex 24)
  PG_PASS=$(openssl rand -hex 16)
  cat > .env <<ENV
SERVER_TYPE=http
SERVER_PORT=8080
SERVER_URL=https://${DOMINIO}
LANGUAGE=en
DEL_INSTANCE=false
AUTHENTICATION_API_KEY=${API_KEY}
AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=false
CONFIG_SESSION_PHONE_CLIENT=Venceu
CONFIG_SESSION_PHONE_NAME=Chrome
QRCODE_LIMIT=30
DATABASE_PROVIDER=postgresql
DATABASE_CONNECTION_URI=postgresql://evolution:${PG_PASS}@evolution-postgres:5432/evolution?schema=evolution_api
DATABASE_CONNECTION_CLIENT_NAME=evolution
DATABASE_SAVE_DATA_INSTANCE=true
DATABASE_SAVE_DATA_NEW_MESSAGE=false
DATABASE_SAVE_MESSAGE_UPDATE=false
DATABASE_SAVE_DATA_CONTACTS=false
DATABASE_SAVE_DATA_CHATS=false
DATABASE_SAVE_DATA_HISTORIC=false
DATABASE_SAVE_DATA_LABELS=false
CACHE_REDIS_ENABLED=true
CACHE_REDIS_URI=redis://evolution-redis:6379/6
CACHE_REDIS_PREFIX_KEY=evolution
CACHE_REDIS_SAVE_INSTANCES=false
CACHE_LOCAL_ENABLED=false
WEBHOOK_GLOBAL_ENABLED=false
POSTGRES_DATABASE=evolution
POSTGRES_USERNAME=evolution
POSTGRES_PASSWORD=${PG_PASS}
DOMINIO=${DOMINIO}
ENV
  chmod 600 .env
fi
set -a; . ./.env; set +a

cat > docker-compose.yml <<'YML'
services:
  api:
    image: evoapicloud/evolution-api:latest
    restart: always
    env_file: .env
    depends_on: [evolution-postgres, evolution-redis]
    volumes: [evolution_instances:/evolution/instances]
  evolution-redis:
    image: redis:7
    restart: always
    command: redis-server --appendonly yes
    volumes: [evolution_redis:/data]
  evolution-postgres:
    image: postgres:15
    restart: always
    environment:
      POSTGRES_DB: ${POSTGRES_DATABASE}
      POSTGRES_USER: ${POSTGRES_USERNAME}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes: [postgres_data:/var/lib/postgresql/data]
  caddy:
    image: caddy:2
    restart: always
    ports: ["80:80", "443:443"]
    command: caddy reverse-proxy --from ${DOMINIO} --to api:8080
    volumes: [caddy_data:/data, caddy_config:/config]
    depends_on: [api]
volumes:
  evolution_instances:
  evolution_redis:
  postgres_data:
  caddy_data:
  caddy_config:
YML

echo "==> Liberando o firewall (SSH, HTTP e HTTPS)…"
ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "==> Subindo a Evolution API (pode levar alguns minutos)…"
docker compose pull -q
docker compose up -d

echo "==> Aguardando o https ficar pronto…"
for i in $(seq 1 60); do
  if curl -fsS "https://${DOMINIO}/" >/dev/null 2>&1; then break; fi
  sleep 5
done

echo
echo "================================================================"
echo " Evolution API instalada!"
echo
echo " Cole no Venceu → Plataforma → WhatsApp (QR Code):"
echo "   Endereço:     https://${DOMINIO}"
echo "   Chave global: ${AUTHENTICATION_API_KEY}"
echo
echo " Guarde a chave em local seguro. Para ver de novo:"
echo "   grep AUTHENTICATION_API_KEY ${DIR}/.env"
echo " Atualizar no futuro:  cd ${DIR} && docker compose pull && docker compose up -d"
echo "================================================================"
