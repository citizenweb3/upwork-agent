#!/bin/bash
set -euo pipefail

umask 077

export HOME="${HOME:-/app/data/home}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-agent}"

mkdir -p "$HOME/.claude" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" /app/data/logs /app/data/browser-data
chmod 700 "$HOME" "$HOME/.claude" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"

# Claude Code OAuth auth
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    cat > "$HOME/.claude.json" <<EOF
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

# Start a private D-Bus session for Chrome and child processes.
dbus_output="$(dbus-daemon --session --fork --print-address=1 --print-pid=1)"
export DBUS_SESSION_BUS_ADDRESS="$(printf '%s\n' "$dbus_output" | sed -n '1p')"
DBUS_SESSION_BUS_PID="$(printf '%s\n' "$dbus_output" | sed -n '2p')"

cleanup() {
    if [ -n "${DBUS_SESSION_BUS_PID:-}" ]; then
        kill "$DBUS_SESSION_BUS_PID" 2>/dev/null || true
    fi
}

trap cleanup EXIT

# Create log directory
mkdir -p /app/data/logs

# Remove stale Chrome lock (from previous container)
rm -f /app/data/browser-data/SingletonLock /app/data/browser-data/SingletonCookie /app/data/browser-data/SingletonSocket

# Notify user that browser is ready for login
if [ -n "${BOT_TOKEN:-}" ] && [ -n "${CHAT_ID:-}" ]; then
    # Start supervisord in background first so noVNC is available
    /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf &
    SUPERVISOR_PID=$!

    # Wait for noVNC to be ready
    sleep 3

    if ! curl -fsS "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d chat_id="${CHAT_ID}" \
        -d "text=🖥 Browser ready — log in to Upwork at http://localhost:6080" \
        > /dev/null; then
        echo "Warning: failed to send browser-ready Telegram notification" >&2
    fi

    # Wait for supervisord (keeps container alive)
    wait $SUPERVISOR_PID
else
    exec /usr/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf
fi
