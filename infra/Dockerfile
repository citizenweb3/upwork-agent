FROM ubuntu:24.04

# Use a regional mirror (archive.ubuntu.com is unreliable in some regions)
RUN sed -i 's|http://archive.ubuntu.com|http://mirror.yandex.ru|g' /etc/apt/sources.list.d/ubuntu.sources \
    || sed -i 's|http://archive.ubuntu.com|http://mirror.yandex.ru|g' /etc/apt/sources.list

# Base packages + virtual display + VNC + build tools for native Node modules
RUN apt-get update && apt-get install -y \
    curl wget gnupg supervisor \
    xvfb x11vnc novnc websockify \
    fonts-liberation fonts-noto-color-emoji \
    dbus dbus-x11 \
    sqlite3 git jq \
    build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Yarn + Claude Code CLI
RUN npm install -g yarn @anthropic-ai/claude-code

# Browser: Google Chrome on amd64, Chromium (via Playwright) on arm64 (for local testing)
RUN ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "amd64" ]; then \
        wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /usr/share/keyrings/google-chrome.gpg \
        && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
        && apt-get update && apt-get install -y google-chrome-stable \
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
RUN chmod +x /start.sh

EXPOSE 6080

CMD ["/start.sh"]
