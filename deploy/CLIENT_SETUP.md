# инструкция для заказчика

## что нужно передать заказчику:

1. **docker-compose.production.yml** (уже настроен с твоим Docker Hub username)
2. **deploy/env.example** (шаблон для .env)
3. **доступ к приватному Docker Hub репозиторию** (или публичный, если не секретно)

## установка (один раз):

```bash
# 1. создай директорию
mkdir -p /opt/panel
cd /opt/panel

# 2. скопируй файлы от разработчика:
# - docker-compose.production.yml
# - deploy/env.example

# 3. создай .env файл
cp deploy/env.example .env
# отредактируй .env - укажи свои RPC URLs, пароли и т.д.

# 4. залогинься в Docker Hub (если образ приватный)
docker login

# 5. запусти всё
docker compose -f docker-compose.production.yml up -d
```

## автоматические обновления:

**watchtower** автоматически проверяет Docker Hub каждые 5 минут и обновляет контейнер `panel-app` при появлении нового образа.

**проверка статуса:**
```bash
docker logs panel-watchtower
docker logs panel-app
```

**ручное обновление (если нужно):**
```bash
docker compose -f docker-compose.production.yml pull
docker compose -f docker-compose.production.yml up -d
```

## остановка/перезапуск:

```bash
# остановка
docker compose -f docker-compose.production.yml down

# перезапуск
docker compose -f docker-compose.production.yml restart
```

## логи:

```bash
docker logs -f panel-app
docker logs -f panel-db
docker logs -f panel-watchtower
```
