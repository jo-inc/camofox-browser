#!/bin/bash

# ==========================================
# Configuration
# ==========================================
# Change this to whatever you want to call your app in PM2
APP_NAME="camofox-browser"

export CAMOFOX_PORT="8177"
export CAMOFOX_API_KEY="camof0x-api"
export CAMOFOX_ADMIN_KEY="camof0x-admin"

export PROXY_HOST="127.0.0.1"
export PROXY_PORT="8179"

export NODE_EXTRA_CA_CERTS="/home/bbp/ca.crt"

export CAMOUFOX_DEBUG=1

# ==========================================
# Functions
# ==========================================

start() {
    echo "Starting $APP_NAME..."
    echo "API port: $CAMOFOX_PORT"
    echo "Proxy: $PROXY_HOST:$PROXY_PORT"
    # This runs 'npm start' and names the process in PM2
    pm2 start npm --name "$APP_NAME" -- start
    
    # Saves the PM2 process list so it can restart on system boot (optional but recommended)
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
        echo "Usage: ./manage.sh {start|stop|delete|restart|status|logs}"
        exit 1
        ;;
esac

