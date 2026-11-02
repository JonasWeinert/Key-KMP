"""Sample the real extraction/index/search example, including descendant helpers.
Usage: python3 benchmark-library-memory.py BINARY PDF LIBRARY_DIR REPORT.json
Use a new LIBRARY_DIR for cold indexing and repeat it for cache-reuse checks.
"""
import json, subprocess, sys, time
binary, pdf, library, report = sys.argv[1:]
started = time.monotonic()
with open(report + '.log', 'w') as log:
    process = subprocess.Popen([binary, pdf, library], stdout=log, stderr=subprocess.STDOUT)
    peak = 0
    peak_rows = []
    individual = {}
    while process.poll() is None:
        rows = []
        for line in subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss=,command='], text=True).splitlines():
            parts = line.strip().split(None, 3)
            if len(parts) == 4:
                rows.append(dict(pid=int(parts[0]), parent=int(parts[1]), rssMiB=int(parts[2])/1024, command=parts[3]))
        pids = {process.pid}
        while True:
            expanded = pids | {r['pid'] for r in rows if r['parent'] in pids}
            if expanded == pids:
                break
            pids = expanded
        tree = [r for r in rows if r['pid'] in pids]
        rss = sum(r['rssMiB'] for r in tree)
        if rss > peak:
            peak, peak_rows = rss, tree
        for row in tree:
            previous = individual.get(row['pid'])
            if previous is None or row['rssMiB'] > previous['rssMiB']:
                individual[row['pid']] = row
        time.sleep(.1)
result = dict(exitCode=process.returncode, elapsedSeconds=time.monotonic()-started, peakProcessTreeMiB=peak, peakProcesses=peak_rows, processPeaks=list(individual.values()))
with open(report, 'w') as out:
    json.dump(result, out, indent=2)
print(json.dumps(result, indent=2))
if process.returncode:
    raise SystemExit(process.returncode)
