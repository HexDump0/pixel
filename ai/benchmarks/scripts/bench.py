"""Measure wall time, peak memory and CPU of a process tree.

usage: bench.py <label> <idle_secs|0> -- cmd args...
idle_secs > 0: treat as a server; kill after that many seconds and report steady-state numbers.
"""
import json, subprocess, sys, time
import psutil

label, idle = sys.argv[1], float(sys.argv[2])
cmd = sys.argv[sys.argv.index("--") + 1:]

t0 = time.time()
proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
root = psutil.Process(proc.pid)
seen = {}  # pid -> Process, so CPU of children that already exited still counts
cpu_last = {}
peak_rss = peak_uss = 0
nprocs_max = 0
samples = []

def snapshot():
    global peak_rss, peak_uss, nprocs_max
    try:
        procs = [root] + root.children(recursive=True)
    except psutil.NoSuchProcess:
        return
    rss = uss = 0
    for p in procs:
        seen.setdefault(p.pid, p)
        try:
            m = p.memory_full_info()
            rss += m.rss; uss += m.uss
            ct = p.cpu_times(); cpu_last[p.pid] = ct.user + ct.system + ct.children_user + ct.children_system
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    peak_rss, peak_uss = max(peak_rss, rss), max(peak_uss, uss)
    nprocs_max = max(nprocs_max, len(procs))
    samples.append((time.time() - t0, rss, sum(cpu_last.values())))

while proc.poll() is None:
    snapshot()
    if idle and time.time() - t0 > idle:
        for p in root.children(recursive=True):
            p.kill()
        proc.kill()
        break
    time.sleep(0.2)
wall = time.time() - t0
out = proc.stdout.read()

res = {
    "label": label,
    "wall_s": round(wall, 1),
    "peak_rss_mb": peak_rss >> 20,
    "peak_uss_mb": peak_uss >> 20,
    "cpu_s": round(sum(cpu_last.values()), 1),
    "max_procs": nprocs_max,
}
if idle and len(samples) > 10:
    # steady state: last 10 s of the run
    tail = [s for s in samples if s[0] > samples[-1][0] - 10]
    res["steady_rss_mb"] = tail[-1][1] >> 20
    res["steady_cpu_pct"] = round((tail[-1][2] - tail[0][2]) / (tail[-1][0] - tail[0][0]) * 100, 1)
print(json.dumps(res))
print("--- output tail ---\n" + out[-600:], file=sys.stderr)
