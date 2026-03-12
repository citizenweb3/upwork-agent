# Docker Deployment

Контейнер для запуска Upwork Agent на сервере 24/7. Внутри: настоящий Google Chrome + виртуальный дисплей + VNC-доступ через браузер.

## Что внутри

```
┌─────────────────────────────────────────────┐
│  Docker Container (ubuntu:24.04)            │
│                                             │
│  supervisord управляет 4 процессами:        │
│                                             │
│  ┌─────────┐  ┌────────┐  ┌──────────────┐ │
│  │  Xvfb   │  │ x11vnc │  │    noVNC     │ │
│  │ :99     │→ │ :5900  │→ │ :6080 (web)  │ │
│  └─────────┘  └────────┘  └──────────────┘ │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │  yarn daemon                        │    │
│  │  Chrome (CDP) + Grammy + Cron       │    │
│  │  → спавнит Claude Code по задачам   │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  Volumes:                                   │
│  /app/data → jobs.db, browser-data, logs    │
│  /root/.claude → Claude Code auth cache     │
└─────────────────────────────────────────────┘
```

- **Xvfb** — виртуальный дисплей 1920x1080, Chrome рисует в него
- **x11vnc** — VNC-сервер, транслирует дисплей
- **noVNC** — веб-клиент, открывается в обычном браузере на `http://server:6080`
- **yarn daemon** — основной процесс: Telegram бот + cron + Chrome + Claude Code

## Быстрый старт

### 1. Клонировать репозиторий

```bash
git clone <repo-url>
cd upwork-agent/infra
```

### 2. Создать `.env`

```bash
cp .env.example .env
```

Заполнить переменные:

| Переменная | Откуда взять |
|------------|-------------|
| `BOT_TOKEN` | Создать бота через [@BotFather](https://t.me/BotFather) |
| `CHAT_ID` | Добавить [@RawDataBot](https://t.me/RawDataBot) в группу — он напишет chat ID (отрицательное число). Для личного чата — отправить что-нибудь [@userinfobot](https://t.me/userinfobot) |
| `ALLOWED_USERS` | ID пользователей Telegram через запятую. Узнать свой: [@userinfobot](https://t.me/userinfobot) |
| `TIMEZONE` | Часовой пояс, например `Europe/Moscow` (по умолчанию `Asia/Bangkok`) |
| `SEARCH_INTERVAL_MIN` | Интервал автопоиска в минутах (по умолчанию `20`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth токен Claude Code (см. ниже) |
| `CLAUDE_ACCOUNT_UUID` | UUID аккаунта Claude |
| `CLAUDE_EMAIL` | Email аккаунта Claude |
| `CLAUDE_ORG_UUID` | UUID организации Claude |

Если используете **групповой чат**: BotFather → `/mybots` → ваш бот → Bot Settings → Group Privacy → **Turn off**.

### 3. Получить Claude Code OAuth креды

На машине, где Claude Code уже залогинен:

```bash
# OAuth токен (macOS)
security find-generic-password -s "claude-cli" -w

# Account UUID, email, org UUID
cat ~/.claude.json | grep -A5 oauthAccount
```

Скопировать значения в `.env`.

### 4. Запустить

```bash
docker compose up -d
```

Первая сборка займёт ~5 минут (скачивание Chrome, Node.js, зависимостей).

### 5. Залогиниться в Upwork

1. Открыть `http://server:6080` в браузере — появится Chrome через VNC
2. В Chrome зайти на upwork.com и залогиниться вручную
3. Сессия сохраняется в Docker volume — переживает перезапуски контейнера

После логина бот отправит уведомление в Telegram и начнёт работу по расписанию.

## Управление

```bash
# Логи
docker compose logs -f                    # все логи
docker compose exec upwork-agent tail -f /app/data/logs/daemon.stdout.log  # daemon

# Перезапуск
docker compose restart

# Остановка
docker compose down

# Пересборка (после обновления кода)
docker compose up -d --build
```

### Telegram команды

| Команда | Действие |
|---------|----------|
| `/search` | Запустить поиск вручную |
| `/status` | Статус браузера, очередь задач |
| `/report` | Статистика за сегодня |
| `/report week` | Статистика за 7 дней |

## Данные

Всё персистентно через Docker volumes:

| Volume | Путь в контейнере | Содержимое |
|--------|-------------------|-----------|
| `upwork-data` | `/app/data` | `jobs.db` (база вакансий), `browser-data/` (сессия Chrome), `logs/` |
| `claude-auth` | `/root/.claude` | Кэш авторизации Claude Code |

```bash
# Бэкап базы
docker compose exec upwork-agent sqlite3 /app/data/jobs.db ".backup /app/data/jobs-backup.db"
docker compose cp upwork-agent:/app/data/jobs-backup.db ./jobs-backup.db

# Сбросить сессию Chrome (если нужен повторный логин)
docker compose down
docker volume rm infra_upwork-data  # ⚠️ удалит и jobs.db
docker compose up -d
```

## Архитектура

- **Образ**: Ubuntu 24.04 + Google Chrome (настоящий, из deb-репозитория Google)
- **Дисплей**: Xvfb (виртуальный) → x11vnc → noVNC (веб)
- **Процессы**: supervisord управляет всеми 4 процессами, автоматический перезапуск при падении
- **Chrome**: запускается с `--no-sandbox` (контейнер от root), `--disable-dev-shm-usage`, shared memory 2GB
- **Код**: встроен в образ (`COPY . .`), обновление через `docker compose up -d --build`

## Troubleshooting

**Chrome не запускается (CDP timeout)**
- Проверить логи: `docker compose exec upwork-agent cat /app/data/logs/daemon.stderr.log`
- Stale lock файл удаляется автоматически при старте, но если проблема повторяется: `docker compose restart`

**Claude Code auth error**
- Проверить что `CLAUDE_CODE_OAUTH_TOKEN` заполнен в `.env`
- Токен может истечь — получить новый и обновить `.env`, затем `docker compose restart`

**noVNC не открывается**
- Проверить что порт 6080 доступен: `curl http://localhost:6080`
- Порт привязан к `127.0.0.1` — для доступа снаружи изменить в `docker-compose.yml`: `"6080:6080"`

**Upwork сессия истекла**
- Бот отправит уведомление "Session expired"
- Зайти на `http://server:6080` и залогиниться заново
