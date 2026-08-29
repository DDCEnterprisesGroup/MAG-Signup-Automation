#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DATA_DIR=${MAG_DATA_DIR:-"$HOME/Library/Application Support/MAG-Automation"}
PID_FILE="$DATA_DIR/runtime/mag.pid"
SERVICE_LOG="$DATA_DIR/logs/service.log"

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(sed -n '1p' "$PID_FILE")" 2>/dev/null
}

case "${1:-}" in
  start)
    if is_running; then echo "MAG is already running (PID $(sed -n '1p' "$PID_FILE"))."; exit 0; fi
    mkdir -p "$DATA_DIR/runtime" "$DATA_DIR/logs"
    cd "$PROJECT_ROOT"
    nohup npm start -- --all >>"$SERVICE_LOG" 2>&1 &
    mag_pid=$!
    printf '%s\n' "$mag_pid" >"$PID_FILE"
    echo "MAG started (PID $mag_pid)."
    ;;
  run)
    cd "$PROJECT_ROOT"; exec npm start -- --all
    ;;
  stop)
    if ! is_running; then rm -f "$PID_FILE"; echo "MAG is stopped."; exit 0; fi
    mag_pid=$(sed -n '1p' "$PID_FILE")
    kill -INT "$mag_pid"
    wait_count=0
    while kill -0 "$mag_pid" 2>/dev/null && [ "$wait_count" -lt 30 ]; do sleep 1; wait_count=$((wait_count + 1)); done
    if kill -0 "$mag_pid" 2>/dev/null; then echo "MAG did not stop within 30 seconds." >&2; exit 1; fi
    rm -f "$PID_FILE"; echo "MAG stopped safely."
    ;;
  status) cd "$PROJECT_ROOT"; exec npm run status ;;
  logs) mkdir -p "$DATA_DIR/logs"; touch "$SERVICE_LOG"; exec tail -n 100 -f "$SERVICE_LOG" ;;
  test) cd "$PROJECT_ROOT"; exec npm run check ;;
  reconcile) cd "$PROJECT_ROOT"; exec npm run reconcile ;;
  backup) cd "$PROJECT_ROOT"; exec npm run backup ;;
  *) echo "Usage: scripts/magctl.sh {start|run|stop|status|logs|test|reconcile|backup}" >&2; exit 2 ;;
esac
