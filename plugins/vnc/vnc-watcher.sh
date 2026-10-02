#!/bin/sh
# VNC watcher: detects Camoufox's dynamically-assigned Xvfb display and attaches
# x11vnc + noVNC to it. Handles browser restarts (re-attaches on display change).
#
# Called by the VNC plugin via child_process.spawn. Not meant to run standalone.
#
# Env vars (set by the plugin):
#   VNC_PASSWORD    If set, x11vnc requires this password
#   VIEW_ONLY       "1" for view-only mode
#   VNC_PORT        VNC port (default: 5900)
#   NOVNC_PORT      noVNC websocket port (default: 6080)
#   VNC_BIND        Address x11vnc and noVNC listen on (default: 127.0.0.1).
#                   Use 0.0.0.0 (or ::) in containers so published ports work.

set -e

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=vnc-watcher-lib.sh
. "$SCRIPT_DIR/vnc-watcher-lib.sh"

VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
VNC_RESOLUTION="${VNC_RESOLUTION:-1920x1080x24}"
VNC_STATUS_FILE="${VNC_STATUS_FILE:-}"
VNC_BIND="${VNC_BIND:-127.0.0.1}"

log() { printf '[vnc-watcher] %s\n' "$*" >&2; }
clear_status() { [ -z "$VNC_STATUS_FILE" ] || rm -f "$VNC_STATUS_FILE"; }
write_status() {
  [ -z "$VNC_STATUS_FILE" ] || printf '%s %s\n' "$CURRENT_DISPLAY" "$X11VNC_PID" > "$VNC_STATUS_FILE"
}
trap clear_status EXIT
trap 'exit 0' INT TERM
clear_status

# x11vnc takes IPv4 via -listen and IPv6 via -listenv6. A wildcard bind means
# "all interfaces", which is x11vnc's default when no -listen option is given.
case "$VNC_BIND" in
  127.*|localhost|::1|"[::1]") VNC_LOOPBACK=1 ;;
  *) VNC_LOOPBACK=0 ;;
esac
case "$VNC_BIND" in
  0.0.0.0|::|"[::]") X11VNC_LISTEN="" ;;
  *:*) X11VNC_LISTEN="-listenv6 $(printf '%s' "$VNC_BIND" | tr -d '[]')" ;;
  *) X11VNC_LISTEN="-listen $VNC_BIND" ;;
esac

CURRENT_DISPLAY=""
X11VNC_PID=""
SERVER_PID="$PPID"

# Prepare password file if requested
PASSFILE=""
if [ -n "${VNC_PASSWORD:-}" ]; then
  mkdir -p /tmp/.vnc
  x11vnc -storepasswd "$VNC_PASSWORD" /tmp/.vnc/passwd >/dev/null 2>&1
  PASSFILE="/tmp/.vnc/passwd"
  log "x11vnc: password protected"
else
  log "x11vnc: NO password set"
  if [ "$VNC_LOOPBACK" != 1 ]; then
      log "WARNING: VNC is listening on $VNC_BIND without VNC_PASSWORD. Anyone who can reach ports $VNC_PORT/$NOVNC_PORT controls this browser session. Set VNC_PASSWORD or restrict the published ports."
  fi
fi

# Start noVNC (websockify) -- proxies to x11vnc regardless of whether it's up yet
NOVNC_DIR="/usr/share/novnc"
if [ ! -d "$NOVNC_DIR" ]; then
  log "ERROR: $NOVNC_DIR not found; noVNC cannot start"
  exit 1
fi
log "Starting noVNC (websockify) on $VNC_BIND:$NOVNC_PORT -> 127.0.0.1:$VNC_PORT"
websockify --web "$NOVNC_DIR" "$VNC_BIND:$NOVNC_PORT" "127.0.0.1:$VNC_PORT" >/tmp/camofox-novnc.log 2>&1 &

log "VNC watcher started -- will attach x11vnc when Camoufox's Xvfb appears"

find_owned_display() {
  # Camoufox normally starts Xvfb with -displayfd, so its display number is not
  # present in argv. First identify this server's Xvfb child, then map its PID
  # through Xvfb's lock file to the corresponding X socket. This retains the
  # per-server ownership isolation needed when several Camofox servers share a
  # process namespace.
  XVFB_PID=$(ps -eo pid=,ppid=,args= 2>/dev/null | find_owned_xvfb_pid "$SERVER_PID" "$VNC_RESOLUTION")
  [ -n "$XVFB_PID" ] || return 0
  display_for_xvfb_pid "$XVFB_PID" /tmp /tmp/.X11-unix /proc
}

while true; do
  # A browser restart commonly recreates Xvfb on the same display number.
  # Clear stale state when this watcher's own x11vnc process has exited so the
  # same display can be attached again.
  if x11vnc_needs_reattach "$X11VNC_PID"; then
    log "x11vnc exited; waiting to reattach"
    clear_status
    CURRENT_DISPLAY=""
    X11VNC_PID=""
  fi

  FOUND=$(find_owned_display)

  if [ -n "$FOUND" ] && [ "$FOUND" != "$CURRENT_DISPLAY" ]; then
    # New or changed display -- (re)attach x11vnc
    if [ -n "$X11VNC_PID" ] && kill -0 "$X11VNC_PID" 2>/dev/null; then
      log "Camoufox display changed ($CURRENT_DISPLAY -> $FOUND), restarting x11vnc"
      kill "$X11VNC_PID" 2>/dev/null || true
      sleep 0.5
    fi

    CURRENT_DISPLAY="$FOUND"
    log "Attaching x11vnc to DISPLAY=$CURRENT_DISPLAY"

    X11VNC_ARGS="-display $CURRENT_DISPLAY -forever -shared $X11VNC_LISTEN -rfbport $VNC_PORT -noxdamage -quiet -bg -o /tmp/camofox-x11vnc.log"
    [ "${VIEW_ONLY:-0}" = "1" ] && X11VNC_ARGS="$X11VNC_ARGS -viewonly"
    if [ -n "$PASSFILE" ]; then
      X11VNC_ARGS="$X11VNC_ARGS -rfbauth $PASSFILE"
    else
      X11VNC_ARGS="$X11VNC_ARGS -nopw"
    fi

    # shellcheck disable=SC2086
    if ! x11vnc $X11VNC_ARGS; then
      log "x11vnc failed to start on DISPLAY=$CURRENT_DISPLAY (VNC_BIND=$VNC_BIND); will retry"
      [ ! -f /tmp/camofox-x11vnc.log ] || tail -n 5 /tmp/camofox-x11vnc.log >&2
      CURRENT_DISPLAY=""
      sleep 2
      continue
    fi
    sleep 1
    X11VNC_PID=$(pgrep -f "x11vnc.*-display $CURRENT_DISPLAY" | head -1 || true)
    if [ -n "$X11VNC_PID" ]; then
      write_status
      log "x11vnc running (pid=$X11VNC_PID) on DISPLAY=$CURRENT_DISPLAY"
    else
      log "x11vnc did not stay running on DISPLAY=$CURRENT_DISPLAY; will retry"
      clear_status
      CURRENT_DISPLAY=""
    fi
  fi

  sleep 2
done
