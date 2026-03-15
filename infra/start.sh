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

# Start dbus (Chrome needs it for IPC)
mkdir -p /run/dbus
dbus-daemon --system --fork 2>/dev/null || true

# Create persistent data directories
mkdir -p /app/data/logs /app/data/browser-data

# Seed profile files into the persistent volume on first boot.
if [ -f /opt/upwork-agent-seed/profile.example.md ] && [ ! -f /app/data/profile.example.md ]; then
    cp /opt/upwork-agent-seed/profile.example.md /app/data/profile.example.md
fi

if [ -f /opt/upwork-agent-seed/profile.md ] && [ ! -f /app/data/profile.md ]; then
    cp /opt/upwork-agent-seed/profile.md /app/data/profile.md
elif [ -f /opt/upwork-agent-seed/profile.example.md ] && [ ! -f /app/data/profile.md ]; then
    cp /opt/upwork-agent-seed/profile.example.md /app/data/profile.md
fi

# Remove stale Chrome lock (from previous container)
rm -f /app/data/browser-data/SingletonLock /app/data/browser-data/SingletonCookie /app/data/browser-data/SingletonSocket

# Notify user that browser is ready for login
if [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
    # Start supervisord in background first so noVNC is available
    /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf &
    SUPERVISOR_PID=$!

    # Wait for noVNC to be ready
    sleep 3

    curl -s "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d chat_id="${CHAT_ID}" \
        -d "text=🖥 Browser ready — open noVNC at http://localhost:6080 (use an SSH tunnel if the server is remote) and log in to Upwork" \
        > /dev/null

    # Wait for supervisord (keeps container alive)
    wait $SUPERVISOR_PID
else
    exec /usr/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf
fi
