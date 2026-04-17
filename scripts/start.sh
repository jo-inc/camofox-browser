#!/bin/sh
# camofox-browser container entrypoint
#
# Responsibilities:
#   1. Optionally start a VNC stack (x11vnc + noVNC) attached to Camoufox's Xvfb.
#      This lets a human log into sites interactively, then storageState can be
#      exported and reused — sidestepping fingerprint-based session invalidation.
#   2. Exec the Node server in the foreground (PID 1-ish, signals propagate).
#
# Controlled by env vars (all optional):
#   ENABLE_VNC       "1" to start the VNC stack. Default: off.
#   VNC_PASSWORD     If set, x11vnc requires this password. If unset and
#                    ENABLE_VNC=1, VNC is started WITHOUT a password — only safe
#                    when the port is bound to 127.0.0.1 on the host (use SSH
#                    tunnel to access).
#   VIEW_ONLY        "1" to start x11vnc in view-only mode. Default: off.
#
# Design note: Camoufox's VirtualDisplay.js picks a random free display number
# at browser-launch time and skips any with existing lock files. We can't
# pre-start Xvfb on a known display because that would force Camoufox to pick
# a different one, and x11vnc would show a blank screen. Instead, we spawn a
# watcher that detects the Xvfb process Camoufox creates, then attaches x11vnc
# to that exact display. Same trick works across browser restarts.

set -e

log() { printf '[start.sh] %s\n' "$*" >&2; }

# Background watcher: attach x11vnc to whichever DISPLAY Camoufox's Xvfb uses.
vnc_watcher() {
  CURRENT_DISPLAY=""
  X11VNC_PID=""

  # Prepare password file once if requested
  PASSFILE=""
  if [ -n "${VNC_PASSWORD:-}" ]; then
    mkdir -p /root/.vnc
    x11vnc -storepasswd "$VNC_PASSWORD" /root/.vnc/passwd >/dev/null 2>&1
    PASSFILE="/root/.vnc/passwd"
    log "x11vnc: password protected"
  else
    log "x11vnc: NO password (bind 6080 to 127.0.0.1 on host + SSH tunnel)"
  fi

  # Start noVNC (websockify) up front — it proxies to 127.0.0.1:5900 regardless
  # of whether x11vnc is running yet. The websocket will just fail until x11vnc
  # appears, which is fine for the user (reload the page once you see VNC alive).
  NOVNC_DIR="/usr/share/novnc"
  if [ ! -d "$NOVNC_DIR" ]; then
    log "ERROR: $NOVNC_DIR not found; noVNC cannot start"
    return 1
  fi
  log "Starting noVNC (websockify) on 0.0.0.0:6080 -> 127.0.0.1:5900 ..."
  websockify --web "$NOVNC_DIR" 0.0.0.0:6080 127.0.0.1:5900 >/var/log/novnc.log 2>&1 &

  log "VNC watcher started — will attach x11vnc when Camoufox's Xvfb appears"

  while true; do
    # Find Xvfb process launched with -screen X 1920x1080x24 (our patched resolution)
    # Extract the display arg (:NN) from its cmdline.
    FOUND=$(ps -eo args= 2>/dev/null | awk '
      /\/Xvfb :[0-9]+/ && /1920x1080x24/ {
        for (i=1;i<=NF;i++) if ($i ~ /^:[0-9]+$/) { print $i; exit }
      }
    ' | head -1)

    if [ -n "$FOUND" ] && [ "$FOUND" != "$CURRENT_DISPLAY" ]; then
      # New display appeared (or replaced an old one). Attach x11vnc.
      if [ -n "$X11VNC_PID" ] && kill -0 "$X11VNC_PID" 2>/dev/null; then
        log "Camoufox display changed ($CURRENT_DISPLAY -> $FOUND), restarting x11vnc"
        kill "$X11VNC_PID" 2>/dev/null || true
        sleep 0.5
      fi

      CURRENT_DISPLAY="$FOUND"
      log "Attaching x11vnc to DISPLAY=$CURRENT_DISPLAY"

      X11VNC_ARGS="-display $CURRENT_DISPLAY -forever -shared -rfbport 5900 -noxdamage -quiet -bg -o /var/log/x11vnc.log"
      [ "${VIEW_ONLY:-0}" = "1" ] && X11VNC_ARGS="$X11VNC_ARGS -viewonly"
      if [ -n "$PASSFILE" ]; then
        X11VNC_ARGS="$X11VNC_ARGS -rfbauth $PASSFILE"
      else
        X11VNC_ARGS="$X11VNC_ARGS -nopw"
      fi

      # -bg daemonises x11vnc. We track its PID via a pidfile.
      # shellcheck disable=SC2086
      x11vnc $X11VNC_ARGS
      sleep 1
      X11VNC_PID=$(pgrep -f "x11vnc.*-display $CURRENT_DISPLAY" | head -1)
      log "x11vnc running (pid=$X11VNC_PID) — open http://<host>:6080/vnc.html"
    elif [ -z "$FOUND" ] && [ -n "$X11VNC_PID" ]; then
      # Xvfb disappeared (browser closed); leave x11vnc running until replaced
      :
    fi

    sleep 2
  done
}

if [ "${ENABLE_VNC:-0}" = "1" ]; then
  vnc_watcher &
fi

# Exec the Node server in the foreground so signals (docker stop) propagate
exec node --max-old-space-size="${MAX_OLD_SPACE_SIZE:-128}" server.js
