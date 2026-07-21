#!/usr/bin/env bash
# armory-todo wiper trap — run this in a terminal and leave it running.
# The instant a new ⚠ DROP appears in todo-audit.log, it snapshots EVERY process
# (pid, cwd, command, open files in the todo dir) so the wiper is caught live.
#
# Usage: bash ~/local-dev/getpipher/armory-todo/scripts/wiper-trap.sh
# Stop: Ctrl-C. The snapshots land in /tmp/wiper-trap-<ts>.txt

AUDIT="${TODO_DIR:-$HOME/.pi/agent/todo}/todo-audit.log"
TODO_DIR="${TODO_DIR:-$HOME/.pi/agent/todo}"
[ -f "$AUDIT" ] || { echo "no audit log at $AUDIT — start a pi session first so v0.5.2 writes it (or set TODO_DIR to test against a temp store)"; exit 1; }

echo "wiper trap armed — watching $AUDIT for new ⚠ DROP lines..."
echo "(the recurring wiper has a ~18-min cadence; leave this running)"
echo ""

# tail -F follows the file (creates if missing). grep DROP. On each new DROP, snapshot.
tail -n0 -F "$AUDIT" 2>/dev/null | while IFS= read -r line; do
  case "$line" in
    *DROP*)
      ts=$(date +%Y%m%dT%H%M%S)
      out="/tmp/wiper-trap-${ts}.txt"
      {
        echo "=== WIPE DROP DETECTED at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
        echo "audit line: $line"
        echo
        echo "=== ALL node/tsx/pi processes (pid, cwd, command) ==="
        for pid in $(ps -ax -o pid= 2>/dev/null); do
          cmd=$(ps -p "$pid" -o command= 2>/dev/null | head -c 200)
          case "$cmd" in
            *node*|*tsx*|*"pi "*|*pi$|*armory*|*deno*|*bun*)
              cwd=$(lsof -p "$pid" -a -d cwd 2>/dev/null | tail -1 | awk '{print $NF}')
              printf "  PID %s  cwd=%s\n    cmd=%s\n" "$pid" "$cwd" "$cmd"
              ;;
          esac
        done
        echo
        echo "=== processes with the todo dir open right now ==="
        lsof +D "$TODO_DIR" 2>/dev/null | awk '{print "  ", $1, $2, $3, $4, $5}' | sort -u
        echo
        echo "=== current live store state ==="
        python3 -c "import json,os; p=os.path.join('$TODO_DIR','todo.json'); d=json.load(open(p)) if os.path.exists(p) else {'todos':[]}; print('  live:', len(d['todos']), 'todos', [t['id'] for t in d['todos']])"
      } > "$out"
      echo "[$(date +%H:%M:%S)] ⚠ DROP! snapshot -> $out"
      echo "  audit: $line"
      echo "  inspect: cat $out   (the wiper process is in there if it's still running)"
      ;;
  esac
done