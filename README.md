# 时光闪卡

时光闪卡是一套集抽卡、收藏和制卡于一体的应用。H5 与微信小程序共用 Flask 服务端和 SQLite 数据库。

## 项目功能

- **抽卡**：每发消耗 10 星尘，张数由卡池配置。新账号有 50 星尘，每天可签到一次，按北京时间领取 10 星尘。支持拆包动画和逐张翻面。
- **我的卡组**：按卡池查看收藏进度，展开后每次加载 12 张。点卡片可查看 3D 卡面、卡背和光效。
- **制卡与管理**：上传卡包封面、卡框、主体图、卡面背景和卡背。卡池可新增自定义闪卡类型并分配概率和卡片。创作者可在首页「我的测试卡池」免费试抽。
- **投稿审核**：首次进入时设置唯一用户名。登录后可新建卡池、上传上层卡框和背景图、制作闪卡。店主在「管理 → 投稿审核」审批投稿、上下架卡池或池内闪卡，以及封禁和解封用户。
- **互动卡分享**：获授权的账号可以导出单文件 HTML。收件人在电脑浏览器打开文件即可离线拖动和翻面。

## 素材放在哪里

本仓库提供源码。运行前请从自己持有的素材包补齐以下文件，并保留原文件名。

```text
项目/
├── 时光闪卡/
│   └── assets/              # 小程序与 H5 共用的头像、卡框、卡面和备用卡包图
└── 时光闪卡服务端/
    ├── seed.json            # 初始卡片、卡框、背景和卡池配置
    └── h5/
        ├── avatar.jpg
        ├── back-default.webp
        ├── kanto/           # catalog.json、001.webp 至 151.webp 和关都卡池素材
        │   ├── pack.webp
        │   ├── frame.png
        │   ├── field.jpg
        │   └── back.webp
        ├── gen2/            # 如使用该世代，放入目录清单、卡图、包面、背景和卡背
        └── gen3/ … gen9/    # 与 gen2 结构相同
```

- 新建数据库前准备 `seed.json` 和关都卡池素材。`seed.json` 包含 `cards`、`frames`、`backgrounds`、`pools` 四个数组。
- `catalog.json` 记录 `number`、`name` 和 `english`。关都卡图按三位编号命名，其他世代按四位编号命名，例如 `0152.webp`。其他世代使用 `field.webp`，请在首次初始化数据库前放好需要导入的世代目录。
- 两个项目目录应保持相邻。打包时会将共用素材复制到部署包的 `h5/assets/`，并生成缩略图。用户上传的素材保存在服务端数据目录的 `uploads/`。

`.gitignore` 将素材、种子数据、部署包、虚拟环境和数据库排除在 Git 之外。

## 本地运行

安装 Python 3.11 或更高版本，补齐素材后，从仓库根目录执行以下 PowerShell 命令。

```powershell
cd '项目/时光闪卡服务端'
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe server.py --dev
```

- H5 打开 `http://127.0.0.1:8765/`。开发库位于服务端目录的 `data-dev/`。
- 微信开发者工具导入 `项目/时光闪卡`。`lib/config.js` 的 `serverOrigin` 留空时，模拟器使用同一个本地服务。
- Linux 或 macOS 使用 `.venv/bin/python`。接口测试可运行 `python -m unittest -v test_server`，测试使用随素材包提供的卡池数据。

## 部署到 Debian

在已安装依赖的服务端源码目录打包。

```powershell
.\.venv\Scripts\python.exe webfiles.py candy-h5-debian.tar.gz
```

### 全新安装

将部署包上传到服务器的 `/root/`，以 root 执行以下命令。H5 公网 IP 模式需要开放 TCP 80。

```bash
mkdir -p /root/candy-h5
tar -xzf /root/candy-h5-debian.tar.gz -C /root/candy-h5
bash /root/candy-h5/deploy-debian.sh --h5
```

脚本会安装 Nginx 并启动 `candy-cards` 服务，后端监听 `127.0.0.1:8765`。访问填写的公网 IP 打开 H5。正式小程序使用域名和 HTTPS，运行安装脚本时省略 `--h5`，并按提示配置正式 AppID 和 AppSecret。小程序的 `serverOrigin` 应指向该 HTTPS 域名，并在微信后台配置 `request`、`uploadFile`、`downloadFile` 合法域名。

### 更新现有部署

将新包上传到 `/root/`，执行以下命令。SQLite 数据库与用户上传的素材保存在 `/var/lib/candy-cards/`。

```bash
cd /opt/candy-cards
tar -xzf /root/candy-h5-debian.tar.gz server.py database.py webfiles.py seed.json h5
systemctl restart candy-cards
curl --retry 10 --retry-connrefused --retry-delay 1 -fsS http://127.0.0.1:8765/health
```

如果手动配置 Nginx，请将网站请求代理到 `127.0.0.1:8765`，保留 `/api/`、`/h5/`、`/assets/`、`/media/` 和 `/thumb/`，上传请求体上限设为 `12m`。

### 设置首位店主

先使用要授权的身份访问应用。小程序可在「我的卡组」复制用户 ID，H5 可在浏览器开发者工具的 `/api/home` 响应中查看 `who.id`。在服务器执行以下命令，然后刷新应用。

```bash
runuser -u candy-cards -- /opt/candy-cards/.venv/bin/python /opt/candy-cards/server.py \
  --data /var/lib/candy-cards --owner '替换为用户ID'
```
