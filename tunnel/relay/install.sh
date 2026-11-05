#!/usr/bin/env bash
# Установка relay TabTunnel на сервер с Ubuntu/Debian (нужен root и публичный IP).
#
#   sudo bash install.sh                     один туннель:   https://<IP-через-дефисы>.sslip.io
#   sudo bash install.sh --multi             много туннелей: https://<имя>.<IP-через-дефисы>.sslip.io
#   sudo bash install.sh --domain my.site    свой домен (A-запись, а для --multi ещё и *.my.site → IP сервера)
#   sudo bash install.sh --turn              плюс TURN-сервер, чтобы звонки работали через любой NAT
#
# Что ставится: Caddy (HTTPS с бесплатными сертификатами Let's Encrypt), relay как служба systemd,
# по желанию coturn. Повторный запуск безопасен: ключ не меняется.
set -euo pipefail

DOMAIN=""
MULTI=0
TURN=0
PORT=7000
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:?укажите домен}"; shift 2 ;;
    --multi) MULTI=1; shift ;;
    --turn) TURN=1; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "Неизвестный параметр: $1"; exit 1 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "Запустите от root: sudo bash install.sh"; exit 1; }
command -v apt-get >/dev/null || { echo "Нужен Ubuntu или Debian (apt-get)"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/relay.py" ] || { echo "Рядом с install.sh должен лежать relay.py"; exit 1; }

echo "==> Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null

IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org || curl -4 -fsS --max-time 10 https://ifconfig.me || hostname -I | awk '{print $1}')"
[ -n "$IP" ] || { echo "Не удалось узнать внешний IP"; exit 1; }
if [ -z "$DOMAIN" ]; then
  DOMAIN="$(echo "$IP" | tr . -).sslip.io"     # sslip.io сам резолвит такое имя в этот IP
fi
echo "    IP: $IP   домен: $DOMAIN"

if ! command -v caddy >/dev/null; then
  echo "==> Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

echo "==> relay"
id tabtunnel >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin tabtunnel
install -d -m 755 /opt/tabtunnel
install -m 644 "$HERE/relay.py" /opt/tabtunnel/relay.py
install -d -m 750 -o root -g tabtunnel /etc/tabtunnel
if [ ! -s /etc/tabtunnel/token ]; then
  python3 -c 'import secrets; print(secrets.token_urlsafe(24))' > /etc/tabtunnel/token
fi
chown root:tabtunnel /etc/tabtunnel/token
chmod 640 /etc/tabtunnel/token
TOKEN="$(head -n1 /etc/tabtunnel/token)"

ARGS="--listen 127.0.0.1 --port $PORT --token-file /etc/tabtunnel/token"
if [ "$MULTI" = 1 ]; then
  ARGS="$ARGS --domain $DOMAIN"
else
  ARGS="$ARGS --public-url https://$DOMAIN"
fi

if [ "$TURN" = 1 ]; then
  echo "==> TURN (coturn) для звонков"
  apt-get install -y -qq coturn >/dev/null
  if [ ! -s /etc/tabtunnel/turn_secret ]; then
    python3 -c 'import secrets; print(secrets.token_hex(24))' > /etc/tabtunnel/turn_secret
  fi
  chown root:tabtunnel /etc/tabtunnel/turn_secret
  chmod 640 /etc/tabtunnel/turn_secret
  TURN_SECRET="$(head -n1 /etc/tabtunnel/turn_secret)"
  cat > /etc/turnserver.conf <<EOF
# сгенерировано TabTunnel install.sh
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=$TURN_SECRET
realm=$DOMAIN
external-ip=$IP
min-port=49160
max-port=49999
no-cli
no-multicast-peers
# не даём использовать TURN для походов во внутренние сети сервера
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
total-quota=200
EOF
  if [ -f /etc/default/coturn ]; then
    sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
  fi
  systemctl enable coturn >/dev/null 2>&1 || true
  systemctl restart coturn
  ARGS="$ARGS --turn-secret-file /etc/tabtunnel/turn_secret --turn-url turn:$IP:3478?transport=udp --turn-url turn:$IP:3478?transport=tcp"
fi

cat > /etc/systemd/system/tabtunnel-relay.service <<EOF
[Unit]
Description=TabTunnel relay
After=network-online.target
Wants=network-online.target

[Service]
User=tabtunnel
Group=tabtunnel
ExecStart=/usr/bin/python3 /opt/tabtunnel/relay.py $ARGS
Restart=always
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable tabtunnel-relay >/dev/null 2>&1
systemctl restart tabtunnel-relay

echo "==> HTTPS (Caddy)"
[ -f /etc/caddy/Caddyfile ] && cp -n /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-tabtunnel || true
# keepalive off: одно соединение до relay = один посетитель одного туннеля
if [ "$MULTI" = 1 ]; then
  cat > /etc/caddy/Caddyfile <<EOF
{
	on_demand_tls {
		ask http://127.0.0.1:$PORT/_tunnel/ask
	}
}

https:// {
	tls {
		on_demand
	}
	reverse_proxy 127.0.0.1:$PORT {
		transport http {
			keepalive off
		}
	}
}
EOF
else
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT {
		transport http {
			keepalive off
		}
	}
}
EOF
fi
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  echo "==> Открываю порты в ufw"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  if [ "$TURN" = 1 ]; then
    ufw allow 3478 >/dev/null
    ufw allow 49160:49999/udp >/dev/null
  fi
fi

sleep 1
if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/_tunnel/health" >/dev/null; then
  STATE="работает"
else
  STATE="НЕ ОТВЕЧАЕТ — смотрите: journalctl -u tabtunnel-relay -n 50"
fi

KEY="tabtunnel://$TOKEN@$DOMAIN"
echo
echo "=================================================================="
echo " TabTunnel relay: $STATE"
echo
echo " Ключ подключения (секрет — не публикуйте его):"
echo "   $KEY"
echo
if [ "$MULTI" = 1 ]; then
  echo " Чат:      TabChat.exe --tunnel $KEY/mychat"
  echo "           → https://mychat.$DOMAIN"
else
  echo " Чат:      TabChat.exe --tunnel $KEY"
  echo "           → https://$DOMAIN"
fi
echo " Утилита:  вставьте ключ в окно TabTunnel"
[ "$TURN" = 1 ] && echo " TURN для звонков включён: $IP:3478"
echo
echo " Первый заход по https может занять до минуты: Caddy получает сертификат."
echo " Если у провайдера VPS есть свой фаервол — откройте в нём порты 80 и 443"
[ "$TURN" = 1 ] && echo " и для звонков 3478 (tcp/udp) и 49160-49999 (udp)."
echo "=================================================================="
