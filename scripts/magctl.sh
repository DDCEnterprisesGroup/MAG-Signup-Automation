#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DATA_DIR=${MAG_DATA_DIR:-"$HOME/Library/Application Support/MAG-Automation"}
PID_FILE="$DATA_DIR/runtime/mag.pid"
SERVICE_LOG="$DATA_DIR/logs/service.log"
STATUS_CACHE="$DATA_DIR/runtime/status.json"
mkdir -p "$DATA_DIR/runtime" "$DATA_DIR/logs"
touch "$SERVICE_LOG"

is_running() { [ -f "$PID_FILE" ] && kill -0 "$(sed -n '1p' "$PID_FILE")" 2>/dev/null; }
refresh_status() { cd "$PROJECT_ROOT"; npm run status -- --output "$STATUS_CACHE" >/dev/null; }
show_status() {
  if ! is_running; then refresh_status || true; fi
  node "$PROJECT_ROOT/scripts/operator-status.mjs" "$STATUS_CACHE" "$PID_FILE"
}
start_mag() {
  if is_running; then echo "MAG is already running; no duplicate worker was started."; show_status; return 0; fi
  refresh_status || true
  echo "MAG started successfully. Select exactly the intended person; Q exits without processing."
  show_status
  exec node "$PROJECT_ROOT/scripts/supervise.mjs" "$PID_FILE" "$PROJECT_ROOT"
}
stop_mag() {
  if ! is_running; then rm -f "$PID_FILE"; echo "MAG is already stopped."; return 0; fi
  mag_pid=$(sed -n '1p' "$PID_FILE")
  kill -INT "$mag_pid"
  wait_count=0
  while kill -0 "$mag_pid" 2>/dev/null && [ "$wait_count" -lt 30 ]; do sleep 1; wait_count=$((wait_count + 1)); done
  if kill -0 "$mag_pid" 2>/dev/null; then echo "MAG did not stop safely within 30 seconds." >&2; return 1; fi
  rm -f "$PID_FILE"; echo "MAG stopped safely."
}
help_text() {
  printf '%s\n' "MAG commands:" "  mag              Start safely, or show status if already running" \
    "  mag start        Start with interactive person selection" "  mag stop         Stop cleanly" \
    "  mag restart      Stop, verify, then start" "  mag status       Show concise operational status" \
    "  mag logs [--follow]  Show recent logs" "  mag test         Run the accepted suite" \
    "  mag backup       Create a portable backup" "  mag reconcile    Audit and reconcile the workbook" \
    "  mag dashboard    Show private-safe JSON status" "  mag help         Show this help"
}

command=${1:-default}
case "$command" in
  default) if is_running; then show_status; else start_mag; fi ;;
  start) start_mag ;;
  stop) stop_mag ;;
  restart) stop_mag; is_running && { echo "MAG is still running." >&2; exit 1; }; start_mag ;;
  status) show_status ;;
  logs)
    set -- "$DATA_DIR"/logs/run-*.jsonl
    log_file=$SERVICE_LOG
    [ -e "$1" ] && log_file=$(ls -t "$DATA_DIR"/logs/run-*.jsonl | sed -n '1p')
    if [ "${2:-}" = "--follow" ]; then exec tail -n 100 -f "$log_file"; else tail -n 100 "$log_file"; fi
    ;;
  test) cd "$PROJECT_ROOT"; exec npm run check ;;
  backup) cd "$PROJECT_ROOT"; exec npm run backup ;;
  reconcile) cd "$PROJECT_ROOT"; npm run inventory; exec npm run reconcile ;;
  dashboard) cd "$PROJECT_ROOT"; exec npm run status ;;
  help|-h|--help) help_text ;;
  *) help_text >&2; exit 2 ;;
esac
