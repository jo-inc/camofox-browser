#!/bin/sh
# Linux-only real-process smoke test for Xvfb -> x11vnc -> noVNC attachment
# and recovery. Intended to run in a disposable Debian container:
#
# docker run --rm \
#   -v "$PWD/plugins/vnc:/plugin:ro" \
#   -v "$PWD/tests/vnc-linux-smoke.sh:/smoke.sh:ro" \
#   debian:bookworm-slim sh /smoke.sh
set -eu

if [ "${VNC_SMOKE_INSTALL_DEPS:-1}" = "1" ]; then
  apt-get update >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc websockify procps curl netcat-openbsd >/dev/null
fi

PLUGIN_DIR="${VNC_PLUGIN_DIR:-/plugin}"

cleanup() {
  kill "${XVFB_PID:-}" "${WATCHER_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

export VNC_RESOLUTION=1920x1080x24
export VNC_PORT=5900
export NOVNC_PORT=6080
export VNC_BIND=127.0.0.1
export VNC_STATUS_FILE=/tmp/vnc-status

sh "$PLUGIN_DIR/vnc-watcher.sh" &
WATCHER_PID=$!
Xvfb -displayfd 3 -screen 0 "$VNC_RESOLUTION" -ac -nolisten tcp 3>/tmp/display-number &
XVFB_PID=$!

wait_ready() {
  tries=0
  while [ "$tries" -lt 30 ]; do
    if [ -s "$VNC_STATUS_FILE" ] && nc -z 127.0.0.1 "$VNC_PORT" && nc -z 127.0.0.1 "$NOVNC_PORT"; then
      return 0
    fi
    tries=$((tries + 1))
    sleep 1
  done
  echo "VNC did not become ready" >&2
  ps -ef >&2
  [ ! -f /tmp/camofox-x11vnc.log ] || cat /tmp/camofox-x11vnc.log >&2
  exit 1
}

wait_ready
FIRST_X11VNC_PID=$(awk '{print $2}' "$VNC_STATUS_FILE")
FIRST_DISPLAY=$(awk '{print $1}' "$VNC_STATUS_FILE")
[ -S "/tmp/.X11-unix/X${FIRST_DISPLAY#:}" ]
curl -fsS "http://127.0.0.1:${NOVNC_PORT}/vnc.html" >/dev/null
printf 'initial display=%s x11vnc_pid=%s\n' "$FIRST_DISPLAY" "$FIRST_X11VNC_PID"

kill "$XVFB_PID"
wait "$XVFB_PID" 2>/dev/null || true
tries=0
while [ "$tries" -lt 20 ] && kill -0 "$FIRST_X11VNC_PID" 2>/dev/null; do
  tries=$((tries + 1))
  sleep 1
done

rm -f /tmp/display-number
Xvfb -displayfd 3 -screen 0 "$VNC_RESOLUTION" -ac -nolisten tcp 3>/tmp/display-number &
XVFB_PID=$!
wait_ready
SECOND_X11VNC_PID=$(awk '{print $2}' "$VNC_STATUS_FILE")
SECOND_DISPLAY=$(awk '{print $1}' "$VNC_STATUS_FILE")
[ "$SECOND_X11VNC_PID" != "$FIRST_X11VNC_PID" ]
nc -z 127.0.0.1 "$VNC_PORT"
nc -z 127.0.0.1 "$NOVNC_PORT"
printf 'recovered display=%s x11vnc_pid=%s\n' "$SECOND_DISPLAY" "$SECOND_X11VNC_PID"
