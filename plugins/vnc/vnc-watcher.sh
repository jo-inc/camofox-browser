#!/bin/sh
# VNC watcher: detects Camoufox's dynamically-assigned Xvfb display and attaches
# x11vnc + noVNC to it. Handles browser restarts (re-attaches on display change).
#
# Called by the VNC plugin via child_process.spawn. Not meant to run standalone.
#
# Env vars (set by the plugin):
#   CAMOFOX_VNC_DISPLAY      Exact X display owned by this sidecar
#   CAMOFOX_VNC_DISPLAY_PID  Exact Xvfb PID owned by this sidecar
#   VNC_PASSWORD    If set, x11vnc requires this password
#   VIEW_ONLY       "1" for view-only mode
#   VNC_PORT        VNC port (default: 5900)
#   NOVNC_PORT      noVNC websocket port (default: 6080)

set -e

VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
VNC_RESOLUTION="${VNC_RESOLUTION:-1920x1080x24}"
TARGET_DISPLAY="${CAMOFOX_VNC_DISPLAY:-}"
TARGET_DISPLAY_PID="${CAMOFOX_VNC_DISPLAY_PID:-}"

log() { printf '[vnc-watcher] %s\n' "$*" >&2; }

CURRENT_DISPLAY=""
X11VNC_PID=""
WEBSOCKIFY_PID=""
PASSDIR=""

cleanup() {
  log "stopping owned noVNC/x11vnc children"
  if [ -n "$X11VNC_PID" ] && kill -0 "$X11VNC_PID" 2>/dev/null; then
    kill "$X11VNC_PID" 2>/dev/null || true
    wait "$X11VNC_PID" 2>/dev/null || true
  fi
  if [ -n "$WEBSOCKIFY_PID" ] && kill -0 "$WEBSOCKIFY_PID" 2>/dev/null; then
    kill "$WEBSOCKIFY_PID" 2>/dev/null || true
    wait "$WEBSOCKIFY_PID" 2>/dev/null || true
  fi
  if [ -n "$PASSDIR" ]; then
    rm -rf -- "$PASSDIR"
  fi
}
trap 'cleanup; exit 0' TERM INT EXIT

# Prepare password file if requested
PASSFILE=""
if [ -n "${VNC_PASSWORD:-}" ]; then
  PASSDIR=$(mktemp -d /tmp/camofox-vnc-pass.XXXXXX)
  chmod 700 "$PASSDIR"
  x11vnc -storepasswd "$VNC_PASSWORD" "$PASSDIR/passwd" >/dev/null 2>&1
  PASSFILE="$PASSDIR/passwd"
  log "x11vnc: password protected"
else
  log "x11vnc: NO password (network access is restricted by the host firewall)"
fi

# Start noVNC only when explicitly enabled. MCP takeover uses raw VNC behind
# WireGuard/Guacamole, so keeping legacy websockify off avoids extra listeners.
NOVNC_DIR="/usr/share/novnc"
VNC_BIND="${VNC_BIND:-127.0.0.1}"
if [ "${ENABLE_NOVNC:-0}" = "1" ]; then
  if [ ! -d "$NOVNC_DIR" ]; then
    log "ERROR: $NOVNC_DIR not found; noVNC cannot start"
    exit 1
  fi
  log "Starting noVNC (websockify) on $VNC_BIND:$NOVNC_PORT -> 127.0.0.1:$VNC_PORT"
  websockify --web "$NOVNC_DIR" "$VNC_BIND:$NOVNC_PORT" "127.0.0.1:$VNC_PORT" >/var/log/novnc.log 2>&1 &
  WEBSOCKIFY_PID="$!"
else
  log "noVNC disabled; raw VNC only"
fi

log "VNC watcher started -- attaching only to the owning Xvfb identity"

if [ -z "$TARGET_DISPLAY" ]; then
  log "ERROR: CAMOFOX_VNC_DISPLAY is required; refusing cross-profile display discovery"
  exit 1
fi
case "$TARGET_DISPLAY_PID" in
  ''|*[!0-9]*)
    log "ERROR: CAMOFOX_VNC_DISPLAY_PID is required; refusing unowned display attachment"
    exit 1
    ;;
esac

while true; do
  FOUND=""
  if [ -r "/proc/$TARGET_DISPLAY_PID/cmdline" ]; then
    DISPLAY_OWNER_CMD=$(tr '\000' ' ' < "/proc/$TARGET_DISPLAY_PID/cmdline" 2>/dev/null || true)
    case " $DISPLAY_OWNER_CMD " in
      *"Xvfb $TARGET_DISPLAY "*) FOUND="$TARGET_DISPLAY" ;;
    esac
  fi

  if [ -z "$FOUND" ]; then
    log "Owning Xvfb pid=$TARGET_DISPLAY_PID display=$TARGET_DISPLAY exited or changed; detaching"
    exit 0
  fi

  X11VNC_ALIVE=0
  if [ -n "$X11VNC_PID" ] && kill -0 "$X11VNC_PID" 2>/dev/null; then
    X11VNC_ALIVE=1
  fi

  if [ "$X11VNC_ALIVE" != "1" ]; then
    if [ -n "$CURRENT_DISPLAY" ]; then
      log "owned x11vnc child exited unexpectedly"
      exit 1
    fi

    CURRENT_DISPLAY="$FOUND"
    log "Attaching x11vnc to DISPLAY=$CURRENT_DISPLAY"

    X11VNC_ARGS="-display $CURRENT_DISPLAY -forever -shared -rfbport $VNC_PORT -listen $VNC_BIND -noxdamage -quiet"
    [ "${VIEW_ONLY:-0}" = "1" ] && X11VNC_ARGS="$X11VNC_ARGS -viewonly"
    if [ -n "$PASSFILE" ]; then
      X11VNC_ARGS="$X11VNC_ARGS -rfbauth $PASSFILE"
    else
      X11VNC_ARGS="$X11VNC_ARGS -nopw"
    fi

    # Keep x11vnc in the foreground and background it ourselves so the watcher
    # owns the exact child PID. Never discover or kill processes by pattern.
    # shellcheck disable=SC2086
    x11vnc $X11VNC_ARGS >/var/log/x11vnc.log 2>&1 &
    X11VNC_PID="$!"
    sleep 1
    if ! kill -0 "$X11VNC_PID" 2>/dev/null; then
      wait "$X11VNC_PID" 2>/dev/null || true
      log "owned x11vnc child failed to stay running"
      exit 1
    fi
    log "x11vnc running (pid=$X11VNC_PID) on DISPLAY=$CURRENT_DISPLAY"
  fi

  sleep 2
done
