FROM ubuntu:24.04

# Base packages + virtual display + VNC
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget gnupg supervisor \
    xvfb x11vnc novnc websockify \
    fonts-liberation fonts-noto-color-emoji \
    dbus dbus-x11 \
    sqlite3 git jq \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Yarn + Claude Code CLI
RUN npm install -g yarn @anthropic-ai/claude-code \
    && npm cache clean --force

# Runtime user
RUN groupadd --system --gid 10001 agent \
    && useradd --system --uid 10001 --gid agent --create-home --home-dir /home/agent --shell /bin/bash agent

# Browser: Google Chrome on amd64, Chromium (via Playwright) on arm64 (for local testing)
RUN ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "amd64" ]; then \
        wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /usr/share/keyrings/google-chrome.gpg \
        && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
        && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
        && rm -rf /var/lib/apt/lists/*; \
    else \
        npx --yes playwright@1.50.0 install --with-deps chromium \
        && ln -sf $(find /root/.cache/ms-playwright -name chrome -type f | head -1) /usr/bin/google-chrome-stable; \
    fi

# Project code
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# noVNC: redirect / → vnc.html
RUN ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html

# Configs
COPY infra/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY infra/start.sh /start.sh
RUN mkdir -p /app/data/browser-data /app/data/logs /app/data/home/.claude /tmp/runtime-agent \
    && chmod 0755 /start.sh \
    && chown -R agent:agent /app /home/agent /tmp/runtime-agent

ENV HOME=/app/data/home \
    XDG_CONFIG_HOME=/app/data/home/.config \
    XDG_CACHE_HOME=/app/data/home/.cache \
    XDG_RUNTIME_DIR=/tmp/runtime-agent

USER agent

EXPOSE 6080

CMD ["/start.sh"]
