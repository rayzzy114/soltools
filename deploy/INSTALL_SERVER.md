## Установка на выделенный сервер (Docker Compose)

### 1) Установи Docker (Ubuntu)
Если у тебя другой дистрибутив — ставь Docker официальным способом.

Проверь:
```bash
docker --version
docker compose version
```

### 2) Подготовь директорию
```bash
sudo mkdir -p /opt/panel
sudo chown -R $USER:$USER /opt/panel
cd /opt/panel
```

Скопируй в `/opt/panel`:
- `docker-compose.yml`
- папку `deploy/`

### 3) Создай `.env`
```bash
cp ./deploy/env.example ./.env
nano ./.env
```

Минимум нужно заполнить:
- `POSTGRES_PASSWORD`
- `DATABASE_URL` (если используешь встроенный `db`, оставь `@db:5432`)
- `NEXT_PUBLIC_SOLANA_RPC_URL`

### 4) Первый запуск
```bash
docker compose up -d --build
docker logs --tail=200 panel-app
```

Проверка health:
```bash
curl -s http://127.0.0.1:${APP_PORT:-3000}/api/health
```

### 5) Обновление (2B)
На своём ПК запускаешь:
```powershell
.\deploy\release.ps1 -ServerHost "1.2.3.4" -ServerUser "root" -ServerDir "/opt/panel"
```

Если хочешь руками на сервере:
```bash
cd /opt/panel
sh ./deploy/server-update.sh ./releases/panel-app_YYYY-MM-DD_HHMMSS.tar.gz
```

### 6) Откат
```bash
cd /opt/panel
docker compose down
docker image tag panel-app:rollback panel-app:latest
docker compose up -d --no-build
```





