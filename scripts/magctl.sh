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
  if ! ( cd "$PROJECT_ROOT" && npm run --silent preflight ); then
    return 1
  fi
  refresh_status || true
  echo "MAG started successfully. Select exactly the intended person; Q exits without processing."
  show_status
  exec node "$PROJECT_ROOT/scripts/supervise.mjs" "$PID_FILE" "$PROJECT_ROOT" "$@"
}
validate_targeted() {
  person_id= site_id=
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --person) [ "$#" -ge 2 ] || { echo "Usage: mag run --person P0001 --site S0001" >&2; return 2; }; person_id=$(printf '%s' "$2" | tr '[:lower:]' '[:upper:]'); shift 2 ;;
      --site) [ "$#" -ge 2 ] || { echo "Usage: mag run --person P0001 --site S0001" >&2; return 2; }; site_id=$(printf '%s' "$2" | tr '[:lower:]' '[:upper:]'); shift 2 ;;
      --dry-run) shift ;;
      --all) echo "Targeted runs cannot use --all." >&2; return 2 ;;
      *) echo "Unsupported targeted-run option: $1" >&2; echo "Usage: mag run --person P0001 --site S0001" >&2; return 2 ;;
    esac
  done
  case "$person_id" in P[0-9][0-9][0-9][0-9]*) ;; *) echo "Usage: mag run --person P0001 --site S0001" >&2; return 2 ;; esac
  case "$site_id" in S[0-9][0-9][0-9][0-9]*) ;; *) echo "Usage: mag run --person P0001 --site S0001" >&2; return 2 ;; esac
}
run_targeted() {
  validate_targeted "$@" || return $?
  if is_running; then echo "MAG is already running; stop it before a targeted run." >&2; return 1; fi
  echo "Starting targeted MAG run for ${person_id} / ${site_id}."
  exec node "$PROJECT_ROOT/scripts/supervise.mjs" "$PID_FILE" "$PROJECT_ROOT" "$@"
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
    "  mag preflight    Run the startup integrity gate without starting the worker" \
    "  mag run --person P0001 --site S0001  Run exactly one person/site" \
    "  mag handoffs     List current human handoffs" \
    "  mag handoff resume|skip P0001 S0001  Control exactly one handoff" \
    "  mag dashboard    Show private-safe JSON status" "  mag help         Show this help"
}

command=${1:-default}
case "$command" in
  default) if is_running; then show_status; else start_mag; fi ;;
  start) shift; [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ] && { help_text; exit 0; }; if [ "$#" -gt 0 ]; then run_targeted "$@"; else start_mag; fi ;;
  run) shift; [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ] && { help_text; exit 0; }; run_targeted "$@" ;;
  stop) stop_mag ;;
  restart) stop_mag; is_running && { echo "MAG is still running." >&2; exit 1; }; start_mag ;;
  status) shift; if [ "$#" -gt 0 ]; then cd "$PROJECT_ROOT"; exec npm run status -- "$@"; else show_status; fi ;;
  logs)
    set -- "$DATA_DIR"/logs/run-*.jsonl
    log_file=$SERVICE_LOG
    [ -e "$1" ] && log_file=$(ls -t "$DATA_DIR"/logs/run-*.jsonl | sed -n '1p')
    if [ "${2:-}" = "--follow" ]; then exec tail -n 100 -f "$log_file"; else tail -n 100 "$log_file"; fi
    ;;
  test) cd "$PROJECT_ROOT"; exec npm run check ;;
  backup) cd "$PROJECT_ROOT"; exec npm run backup ;;
  reconcile) cd "$PROJECT_ROOT"; npm run inventory; exec npm run reconcile ;;
  preflight) cd "$PROJECT_ROOT"; exec npm run --silent preflight ;;
  dashboard) shift; cd "$PROJECT_ROOT"; exec npm run status -- "$@" ;;
  handoffs) shift; cd "$PROJECT_ROOT"; exec npm run handoffs -- "$@" ;;
  handoff)
    shift
    [ "$#" -eq 3 ] || { echo "Usage: mag handoff <resume|skip> <personId> <siteId>" >&2; exit 2; }
    action=$1; person=$2; site=$3
    case "$action" in resume)
      cd "$PROJECT_ROOT"; npm run handoffs -- resume "$person" "$site" >/dev/null
      run_targeted --person "$person" --site "$site" ;;
      skip) cd "$PROJECT_ROOT"; exec npm run handoffs -- skip "$person" "$site" ;;
      *) echo "Usage: mag handoff <resume|skip> <personId> <siteId>" >&2; exit 2 ;;
    esac
    ;;
  help|-h|--help) help_text ;;
  *) help_text >&2; exit 2 ;;
esac
