# solana tools panel (pump.fun)

панель для pump.fun: launcher, bundler, ragpull, volume bot, gather. по умолчанию mainnet-beta.

## деплой для заказчика (без передачи кода) — вариант 1: Docker Hub + автообновления

**идея:** пушишь Docker образ в приватный Docker Hub, заказчик пуллит образ. watchtower автоматически обновляет приложение при новом образе.

### настройка (один раз):

1. **создай приватный репозиторий на Docker Hub:**
   - зайди на https://hub.docker.com
   - создай репозиторий `panel-app` (приватный)
   - запомни свой username

2. **настрой docker-compose.production.yml:**
   - открой `deploy/docker-compose.production.yml`
   - замени `YOUR_DOCKERHUB_USER` на свой Docker Hub username

3. **запуши образ:**
```powershell
.\deploy\docker-hub-push.ps1 -DockerHubUser "твой_username"
```

### передача заказчику:

передай заказчику:
- `deploy/docker-compose.production.yml` (уже с твоим username)
- `deploy/env.example`
- `deploy/CLIENT_SETUP.md` (инструкция)
- доступ к приватному Docker Hub репозиторию

### обновление (когда делаешь фиксы):

```powershell
# просто запуши новый образ
.\deploy\docker-hub-push.ps1 -DockerHubUser "твой_username" -ImageTag "v1.0.1"

# watchtower у заказчика автоматически обновит контейнер в течение 5 минут
```

**преимущества:**
- код не передаётся заказчику
- автоматические обновления через watchtower
- простота: заказчик только запускает docker compose
- версионирование через теги

---

## деплой на выделенный сервер + автообновления (без github) — вариант 2B

Идея: **ты собираешь Docker image локально**, упаковываешь в `*.tar.gz`, заливаешь на сервер по SSH и сервер делает `docker load` + `docker compose up -d`. Код панели никуда публично не выкладывается.

### 0) требования на сервере
- установлен Docker + Docker Compose plugin
- директория, например `/opt/panel`

Структура на сервере:
```
/opt/panel
  docker-compose.yml
  .env
  /deploy
    server-update.sh
    env.example
  /releases
    panel-app_*.tar.gz
```

### 1) первый запуск (на сервере)
1) Скопируй на сервер файлы: `docker-compose.yml` и папку `deploy/`
2) Создай `.env` на сервере (можно взять шаблон `deploy/env.example`)
3) Запусти:
```bash
cd /opt/panel
docker compose up -d --build
```

Проверка:
```bash
curl -s http://127.0.0.1:3000/api/health
docker logs --tail=200 panel-app
```

### 2) обновление одной командой (на твоём ПК, Windows)
В репозитории есть скрипт `deploy/release.ps1`. Он:
- билдит `panel-app:latest`
- сохраняет образ в `releases/panel-app_<tag>.tar.gz`
- заливает на сервер в `/opt/panel/releases/`
- запускает на сервере `deploy/server-update.sh`

Пример:
```powershell
.\deploy\release.ps1 -ServerHost "1.2.3.4" -ServerUser "root" -ServerDir "/opt/panel"
```

### 3) откат (rollback) на сервере
Скрипт обновления автоматически ставит тег `panel-app:rollback` перед применением нового образа.

Откат:
```bash
cd /opt/panel
docker compose down
docker image tag panel-app:rollback panel-app:latest
docker compose up -d --no-build
```

## запуск через Docker (рекомендуется)

самый простой способ запустить проект:

```powershell
# 1. клонируй репозиторий
git clone <твой_приватный_репозиторий>
cd панель

# 2. создай .env файл
cp deploy/env.example .env
# отредактируй .env - укажи свои RPC URLs, пароли и т.д.

# 3. запусти всё одной командой
docker compose up -d --build
```

**что происходит:**
- автоматически поднимается PostgreSQL (порт 5433)
- собирается и запускается Next.js приложение (порт 3000)
- выполняются миграции Prisma
- всё работает в изолированных контейнерах

**проверка:**
```powershell
# проверь что приложение запустилось
curl http://localhost:3000/api/health

# посмотри логи
docker logs panel-app
docker logs panel-db
```

**остановка:**
```powershell
docker compose down
```

**обновление после изменений:**
```powershell
git pull
docker compose up -d --build
```

## быстрый старт (mainnet, без Docker)
1) зависимости  
```bash
pnpm install
pnpm prisma generate
```

2) .env (пример)  
```
NEXT_PUBLIC_SOLANA_NETWORK=mainnet-beta
NEXT_PUBLIC_SOLANA_RPC_URL=https://edge.erpc.global?api-key=YOUR_KEY
NEXT_PUBLIC_SOLANA_RPC_URLS=https://rpc1,...,https://rpcN
NEXT_PUBLIC_ALLOW_PRIVATE_KEYS=true
EXPOSE_WALLET_SECRETS=false
LOG_LEVEL=info
DATABASE_URL=postgresql://user:pass@host:5432/pumpfun_panel
```

3) база  
```bash
pnpm db:init           # создаст базу/схему из DATABASE_URL
pnpm prisma migrate deploy
```

4) запуск  
```bash
pnpm dev   # локально
# или prod
pnpm build
pnpm start
```

## что внутри
- bundler: launch + buy/sell (bundle/stagger) с LUT и auto-close
- gather: сбор токенов+SOL в основной кошелек (по walletIds / groupIds)
- ragpull: bonding-curve/pumpswap sell all
- volume bot: wash/buy/sell, random/fixed/percentage amounts, intervals
- token launcher: IPFS upload, create, clone metadata

## заметки
- pump.fun работает только на mainnet-beta; задайте свои mainnet rpc в .env
- оставьте `NEXT_PUBLIC_ALLOW_PRIVATE_KEYS=false` в проде, если хотите запретить ввод приватников в UI
- `EXPOSE_WALLET_SECRETS=false` скрывает secretKey в API ответах
