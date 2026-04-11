#!/bin/bash

# ==========================================
# Configuration
# ==========================================
APP_NAME="camofox-direct"

export CAMOFOX_PORT="8178"
export CAMOFOX_API_KEY="camof0x-api"
export CAMOFOX_ADMIN_KEY="camof0x-admin"
# No PROXY_HOST, PROXY_PORT, or NODE_EXTRA_CA_CERTS — direct (no proxy) instance

export CAMOUFOX_DEBUG=1

# ==========================================
# Functions
# ==========================================

start() {
    echo "Starting $APP_NAME (direct, no proxy)..."
    echo "API port: $CAMOFOX_PORT"
    pm2 start npm --name "$APP_NAME" -- start
    pm2 save
}

stop() {
    echo "Stopping $APP_NAME..."
    pm2 stop "$APP_NAME"
    pm2 delete "$APP_NAME"
}

delete() {
    echo "Deleting $APP_NAME..."
    pm2 delete "$APP_NAME"
}

restart() {
    echo "Restarting $APP_NAME..."
    pm2 restart "$APP_NAME"
}

status() {
    echo "Checking status of $APP_NAME..."
    pm2 describe "$APP_NAME"
}

logs() {
    echo "Tailing logs for $APP_NAME (Press Ctrl+C to exit)..."
    pm2 logs "$APP_NAME"
}

# ==========================================
# Command Routing
# ==========================================

case "$1" in
    start)
        start
        ;;
    stop)
        stop
        ;;
    delete)
        delete
        ;;
    restart)
        restart
        ;;
    status)
        status
        ;;
    logs)
        logs
        ;;
    *)
        echo "Usage: ./manage-direct.sh {start|stop|delete|restart|status|logs}"
        exit 1
        ;;
esac
