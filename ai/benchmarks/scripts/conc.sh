#!/bin/bash
# usage: conc.sh standalone|attach N
# Runs N tool-using tasks at once; samples total memory of all opencode processes except the user's live session.
S=$(cd "$(dirname "$0")" && pwd)
export XDG_CONFIG_HOME=$S/cfg
MODE=$1; N=$2; LIVE=${LIVE:-0}  # pid of an opencode process to exclude from totals
TASK="Write fib.c that prints the first 30 Fibonacci numbers, compile it with gcc, run it, then reply with just the 30th number."

sample() {
  python3 - "$LIVE" <<'EOF'
import psutil, sys, time
live = int(sys.argv[1]); peak = 0
while True:
    tot = 0
    for p in psutil.process_iter(["name", "pid"]):
        if p.info["name"] == "opencode" and p.info["pid"] != live:
            try: tot += p.memory_full_info().uss
            except Exception: pass
    peak = max(peak, tot)
    open("/dev/shm/pixel_peak", "w").write(str(peak >> 20))
    time.sleep(0.2)
EOF
}
sample & SP=$!

if [ "$MODE" = attach ]; then
  opencode serve --pure --port 47120 >/dev/null 2>&1 & SRV=$!
  until curl -s -m 1 -o /dev/null http://127.0.0.1:47120/doc; do sleep 0.1; done
  ATT="--attach http://127.0.0.1:47120"
fi

t0=$(date +%s.%N); pids=()
for i in $(seq 1 "$N"); do
  d=$S/conc/$MODE-$i; rm -rf "$d"; mkdir -p "$d"
  (cd "$d" && opencode run --pure --auto -m opencode/big-pickle --title pixel-bench $ATT --dir "$d" "$TASK" > "$d/out.txt" 2>&1) & pids+=($!)
done
wait "${pids[@]}"
echo "mode=$MODE n=$N wall_s=$(echo "$(date +%s.%N)-$t0" | bc) peak_total_uss_mb=$(cat /dev/shm/pixel_peak)"
grep -h -o '514229' "$S"/conc/$MODE-*/out.txt | sort | uniq -c
kill $SP ${SRV:-} 2>/dev/null; rm -f /dev/shm/pixel_peak
