# Docker Deployment Design

## Summary

Containerize the upwork-agent into a single Docker container for deployment on a home server with GUI and GPU. The container runs the existing daemon unchanged, with Google Chrome rendering into a virtual display accessible via noVNC for manual Upwork login and CAPTCHA solving.

## Goals

- **Deploy on home server** — run 24/7 without keeping a laptop on
- **Reproducible environment** — `docker compose up` sets up everything (Node, Chrome, Claude CLI, noVNC)
- **Isolation** — Chrome processes, Node, SQLite don't pollute the host
- **Real browser** — Google Chrome from official deb package, not Playwright/Puppeteer Chromium. Persistent session, real fingerprint, home IP = undetectable

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Docker container (ubuntu:24.04)                    │
│                                                     │
│  supervisord                                        │
│  ├── Xvfb :99 (1920x1080x24)                      │
│  ├── x11vnc → :99                                  │
│  ├── noVNC websockify :6080 → :5900               │
│  └── yarn daemon (Node.js)                         │
│       ├── Google Chrome (CDP :9222, DISPLAY=:99)   │
│       ├── Grammy bot (Telegram)                    │
│       ├── Cron scheduler                           │
│       └── spawn('claude', [...])                   │
│                                                     │
│  Volumes:                                           │
│  /app/data → jobs.db, browser-data/, logs/         │
│  /root/.claude → Claude Code OAuth session         │
└─────────────────────────────────────────────────────┘

Host (home server with GUI + GPU):
  - Physical access via monitor
  - Open http://localhost:6080 to see Chrome inside container
  - Log in to Upwork manually, solve CAPTCHAs
  - Port 6080 bound to 127.0.0.1 only (no external access)
```

## Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Number of containers | 1 (all-in-one) | Daemon already manages Chrome as child process. No need for Docker networking. Simple. |
| Base image | `ubuntu:24.04` | Clean, real Google Chrome from official deb. No Playwright/Chromium fingerprint concerns. |
| Chrome | `google-chrome-stable` from Google apt repo | Same binary as desktop. Real fingerprint, `navigator.webdriver = false`. |
| VNC | noVNC (browser-based) | Access via `http://localhost:6080`, no VNC client needed. Physical access to server. |
| VNC security | localhost only | Physical access to server, port bound to 127.0.0.1. No password needed. |
| Code delivery | `COPY . .` in Dockerfile | Production deployment. Update: `git pull && docker compose up -d --build`. |
| Claude Code auth | OAuth env vars (from agent-factory) | `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_ACCOUNT_UUID`, `CLAUDE_EMAIL`, `CLAUDE_ORG_UUID` injected via .env. `start.sh` creates `.claude.json`. No interactive login needed. |
| Process manager | supervisord | Manages Xvfb, x11vnc, noVNC, daemon. Auto-restarts on crash. |
| Persistence | Docker volumes | `upwork-data` for data/, `claude-auth` for ~/.claude/. Survives container restart. |

## File Structure

```
infra/
├── Dockerfile           — image: Ubuntu 24.04 + Chrome + Node + Claude CLI + noVNC
├── docker-compose.yml   — one service, volumes, env vars, ports
├── start.sh             — entrypoint: Claude auth, TG notification, supervisord
├── supervisord.conf     — process management (Xvfb, x11vnc, noVNC, daemon)
└── .env.example         — secrets template
.dockerignore            — exclude data/, node_modules/, .env, images
```

## Dockerfile

```dockerfile
FROM ubuntu:24.04

# Base packages + virtual display + VNC
RUN apt-get update && apt-get install -y \
    curl wget gnupg supervisor \
    xvfb x11vnc novnc websockify \
    fonts-liberation fonts-noto-color-emoji \
    sqlite3 git jq \
    && rm -rf /var/lib/apt/lists/*

# Google Chrome (real, from official Google repository)
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Yarn + Claude Code CLI
RUN npm install -g yarn @anthropic-ai/claude-code

# Project code
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .

# Configs
COPY infra/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY infra/start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 6080

CMD ["/start.sh"]
```

## docker-compose.yml

```yaml
services:
  upwork-agent:
    build:
      context: ..
      dockerfile: infra/Dockerfile
    container_name: upwork-agent
    restart: unless-stopped
    volumes:
      - upwork-data:/app/data
      - claude-auth:/root/.claude
    ports:
      - "127.0.0.1:6080:6080"
    environment:
      - DISPLAY=:99
      - BOT_TOKEN=${BOT_TOKEN}
      - CHAT_ID=${CHAT_ID}
      - ALLOWED_USERS=${ALLOWED_USERS}
      - TIMEZONE=${TIMEZONE:-Asia/Bangkok}
      - SEARCH_INTERVAL_MIN=${SEARCH_INTERVAL_MIN:-20}
      - CHROME_PATH=/usr/bin/google-chrome-stable
      - CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}
      - CLAUDE_ACCOUNT_UUID=${CLAUDE_ACCOUNT_UUID}
      - CLAUDE_EMAIL=${CLAUDE_EMAIL}
      - CLAUDE_ORG_UUID=${CLAUDE_ORG_UUID}

volumes:
  upwork-data:
  claude-auth:
```

## start.sh

```bash
#!/bin/bash

# Claude Code OAuth auth
if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
    mkdir -p /root/.claude
    cat > /root/.claude.json <<EOF
{
  "hasCompletedOnboarding": true,
  "oauthAccount": {
    "accountUuid": "${CLAUDE_ACCOUNT_UUID}",
    "emailAddress": "${CLAUDE_EMAIL}",
    "organizationUuid": "${CLAUDE_ORG_UUID}"
  }
}
EOF
fi

# Create log directory
mkdir -p /app/data/logs

# Notify user that browser is ready for login
if [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
    # Start supervisord in background first so noVNC is available
    /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf &
    SUPERVISOR_PID=$!

    # Wait for noVNC to be ready
    sleep 3

    curl -s "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d chat_id="${CHAT_ID}" \
        -d "text=🖥 Browser ready — log in to Upwork at http://localhost:6080" \
        > /dev/null

    # Wait for supervisord (keeps container alive)
    wait $SUPERVISOR_PID
else
    exec /usr/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf
fi
```

## supervisord.conf

```ini
[supervisord]
nodaemon=true
logfile=/app/data/logs/supervisord.log
logfile_maxbytes=10MB

[program:xvfb]
command=Xvfb :99 -screen 0 1920x1080x24
autorestart=true

[program:x11vnc]
command=x11vnc -display :99 -forever -nopw -rfbport 5900
autorestart=true

[program:novnc]
command=websockify --web /usr/share/novnc 6080 localhost:5900
autorestart=true

[program:daemon]
command=yarn daemon
directory=/app
environment=DISPLAY=":99"
autorestart=true
stdout_logfile=/app/data/logs/daemon.stdout.log
stderr_logfile=/app/data/logs/daemon.stderr.log
stdout_logfile_maxbytes=10MB
stderr_logfile_maxbytes=10MB
```

## Changes to Existing Code

Minimal:

1. **`src/daemon.ts:22`** — fix default Chrome path for Linux:
   ```typescript
   case 'linux':
     return '/usr/bin/google-chrome-stable';
   ```

2. **`.env.example`** — add Claude OAuth vars:
   ```
   CLAUDE_CODE_OAUTH_TOKEN=
   CLAUDE_ACCOUNT_UUID=
   CLAUDE_EMAIL=
   CLAUDE_ORG_UUID=
   ```

3. **`.dockerignore`** (new file):
   ```
   data/
   node_modules/
   .env
   *.png
   *.md
   !CLAUDE.md
   !README.md
   infra/.env
   ```

## Usage

### First time setup

```bash
# 1. Build
cd infra
cp .env.example .env
# Fill in .env with real values
docker compose up -d --build

# 2. Telegram sends: "Browser ready — log in to Upwork at http://localhost:6080"
# 3. Open http://localhost:6080 on server, log in to Upwork
# 4. Telegram sends: "Agent started"
# 5. Done — agent searches automatically via cron
```

### Update code

```bash
git pull
docker compose up -d --build
```

### View logs

```bash
docker logs upwork-agent          # supervisord + daemon
docker exec upwork-agent cat /app/data/logs/daemon.stdout.log
docker exec upwork-agent yarn jobs stats
docker exec upwork-agent yarn jobs report --week
```

### Stop

```bash
docker compose down               # stop, keep data
docker compose down -v            # stop + delete data (⚠️ loses DB and browser session)
```

## How to Get Claude OAuth Credentials

On a machine where Claude Code is already logged in:

1. `CLAUDE_CODE_OAUTH_TOKEN` — from `~/.claude/.credentials.json` or equivalent
2. `CLAUDE_ACCOUNT_UUID` — from `~/.claude.json` → `oauthAccount.accountUuid`
3. `CLAUDE_EMAIL` — from `~/.claude.json` → `oauthAccount.emailAddress`
4. `CLAUDE_ORG_UUID` — from `~/.claude.json` → `oauthAccount.organizationUuid`
