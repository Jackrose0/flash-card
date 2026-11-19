#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if (( EUID != 0 )); then echo "请以 root 或 sudo 运行"; exit 1; fi

site=/etc/nginx/sites-available/candy-cards
mode=${1:-wechat}
if [[ $mode == --h5 ]]; then
    domain=${2:-}
    if [[ -z $domain ]]; then read -rp '服务器公网 IPv4：' domain; fi
    python3 -c 'import ipaddress,sys; ipaddress.IPv4Address(sys.argv[1])' "$domain"
    site=/etc/nginx/sites-available/candy-cards-ip
else
    read -rp '接口域名（例如 cards.example.com，不含 https://）：' domain
    [[ $domain =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$ ]] || { echo '域名格式错误'; exit 1; }
fi
if [[ -f $site ]] && ! grep -Fq "server_name $domain;" "$site"; then
    echo "已有站点使用其他域名，请先检查 $site"; exit 1
fi
if [[ $mode != --h5 && ! -s /etc/candy-cards.env ]]; then
    read -rp '正式小程序 AppID：' appid
    [[ $appid =~ ^wx[0-9a-fA-F]{16}$ && $appid != wxf274f7c9d2c051f2 ]] || { echo '请填写正式小程序 AppID'; exit 1; }
    read -rsp '正式小程序 AppSecret（输入时隐藏）：' secret
    echo
    [[ $secret =~ ^[0-9a-zA-Z]+$ ]] || { echo '密钥格式错误'; exit 1; }
    install -m 600 /dev/null /etc/candy-cards.env
    printf 'WX_APP_ID=%s\nWX_APP_SECRET=%s\n' "$appid" "$secret" > /etc/candy-cards.env
    unset secret
fi

apt-get update
apt-get install -y python3-venv nginx curl
if [[ $mode != --h5 ]]; then apt-get install -y python3-certbot-nginx; fi
id -u candy-cards >/dev/null 2>&1 || useradd --system --home-dir /var/lib/candy-cards --shell /usr/sbin/nologin candy-cards
install -d /opt/candy-cards
install -m 644 server.py database.py webfiles.py seed.json requirements.txt /opt/candy-cards/
cp -R h5 /opt/candy-cards/
python3 -m venv /opt/candy-cards/.venv
/opt/candy-cards/.venv/bin/pip install -r /opt/candy-cards/requirements.txt

cat > /etc/systemd/system/candy-cards.service <<'UNIT'
[Unit]
Description=Candy Cards API
After=network.target

[Service]
User=candy-cards
StateDirectory=candy-cards
StateDirectoryMode=0750
WorkingDirectory=/opt/candy-cards
EnvironmentFile=-/etc/candy-cards.env
ExecStart=/opt/candy-cards/.venv/bin/python server.py --data /var/lib/candy-cards
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable candy-cards
systemctl restart candy-cards
curl --noproxy '*' --retry 8 --retry-connrefused --retry-delay 1 -fsS http://127.0.0.1:8765/health

if [[ ! -f $site ]]; then
    cat > "$site" <<NGINX
server {
    listen 80;
    server_name $domain;
    client_max_body_size 12m;
    location / {
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_pass http://127.0.0.1:8765;
    }
}
NGINX
fi
enabled="/etc/nginx/sites-enabled/${site##*/}"
[[ -e $enabled ]] || ln -s "$site" "$enabled"
nginx -t
systemctl enable --now nginx
systemctl reload nginx
if [[ $mode == --h5 ]]; then
    # During a graceful reload the previous site can briefly answer this IP.
    if ! curl --noproxy '*' --retry 8 --retry-all-errors --retry-delay 1 -fsS -H "Host: $domain" http://127.0.0.1/health; then
        echo "后端已启动，但 Nginx 的 IP 站点健康检查失败。请核对 nginx -T 中的 server_name $domain 和 proxy_pass。" >&2
        exit 1
    fi
    curl --noproxy '*' -fsS -H "Host: $domain" http://127.0.0.1/ > /dev/null
    echo "时光闪卡 H5：http://$domain/"
    exit 0
fi
certbot --nginx --redirect --keep-until-expiring -d "$domain"
systemctl enable --now certbot.timer
curl -fsS "https://$domain/health"
