#!/bin/sh
# Pure helpers for vnc-watcher.sh. Kept separate so display ownership and
# lifecycle decisions can be tested without starting Xvfb, x11vnc, or Docker.

find_owned_xvfb_pid() {
  parent_pid="$1"
  resolution="$2"
  awk -v parent="$parent_pid" -v res="$resolution" '
    $2 == parent && $3 ~ /(^|\/)Xvfb$/ && index($0, res) { found=$1 }
    END { if (found) print found }
  '
}

display_for_xvfb_pid() {
  xvfb_pid="$1"
  lock_dir="${2:-/tmp}"
  socket_dir="${3:-/tmp/.X11-unix}"
  proc_root="${4:-/proc}"

  # Traditional X servers expose a lock file containing the owning PID.
  for lock in "$lock_dir"/.X*-lock; do
    [ -f "$lock" ] || continue
    lock_pid=$(tr -d '[:space:]' < "$lock" 2>/dev/null || true)
    [ "$lock_pid" = "$xvfb_pid" ] || continue

    display_num=$(basename "$lock" | sed -n 's/^\.X\([0-9][0-9]*\)-lock$/\1/p')
    [ -n "$display_num" ] || continue
    [ -S "$socket_dir/X$display_num" ] || continue
    printf ':%s\n' "$display_num"
    return 0
  done

  # Xvfb -displayfd may create no lock file. On Linux, map the sockets opened
  # by the owned Xvfb PID through /proc/net/unix, then require the matching
  # filesystem entry to be a real Unix socket.
  [ -d "$proc_root/$xvfb_pid/fd" ] || return 0
  [ -r "$proc_root/net/unix" ] || return 0
  for fd in "$proc_root/$xvfb_pid/fd"/*; do
    socket_ref=$(readlink "$fd" 2>/dev/null || true)
    inode=$(printf '%s\n' "$socket_ref" | sed -n 's/^socket:\[\([0-9][0-9]*\)\]$/\1/p')
    [ -n "$inode" ] || continue
    socket_path=$(awk -v inode="$inode" '$7 == inode { print $8; exit }' "$proc_root/net/unix")
    case "$socket_path" in
      "$socket_dir"/X[0-9]*) ;;
      *) continue ;;
    esac
    [ -S "$socket_path" ] || continue
    display_num=${socket_path##*/X}
    case "$display_num" in *[!0-9]*|'') continue ;; esac
    printf ':%s\n' "$display_num"
    return 0
  done
}

x11vnc_needs_reattach() {
  tracked_pid="$1"
  [ -n "$tracked_pid" ] || return 1
  ! kill -0 "$tracked_pid" 2>/dev/null
}
