"""Serial process measurements on macOS/Linux; use wait4 for per-child peak RSS."""
import argparse
import datetime
import hashlib
import json
import os
import platform
from pathlib import Path
import random
import statistics
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--node', default='node')
parser.add_argument('--rounds', type=int, default=9)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
os.chdir(root)
base = Path('artifacts/comparison')
jobs = []
for mode in ['json', 'html']:
    for tool in ['coldpath', 'sme', 'monocart']:
        jobs.append(dict(dataset='blog-measured', tool=tool, mode=mode))
for tool in ['coldpath', 'sme']:
    jobs.append(dict(dataset='blog-mapped', tool=tool, mode='static'))

def command(job, output):
    dataset = base / 'inputs' / job['dataset']
    if job['tool'] != 'coldpath':
        return [args.node, 'benchmarks/run-tool.ts', job['tool'], str(dataset), str(output),
                job['mode'], 'relaxed' if job['tool'] == 'sme' else 'default']
    cmd = ['target/release/coldpath', '--dir', str(dataset / 'files')]
    if job['mode'] != 'static':
        cmd += ['--coverage', str(dataset / 'playwright.json'), '--url-prefix', 'https://comparison.invalid/']
    cmd += ['--html' if job['mode'] == 'html' else '--json', str(output / ('index.html' if job['mode'] == 'html' else 'report.json'))]
    return cmd

raw = []
rng = random.Random(20260923)
for round_index in range(-1, args.rounds):
    shuffled = jobs.copy()
    rng.shuffle(shuffled)
    for order, job in enumerate(shuffled):
        label = f"{job['dataset']}-{job['tool']}-{job['mode']}"
        output = base / 'runs' / ('warmup' if round_index < 0 else f'round-{round_index:02}') / label
        output.mkdir(parents=True, exist_ok=True)
        cmd = command(job, output)
        with (output / 'process.log').open('wb') as log:
            start = time.perf_counter_ns()
            proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT,
                                    env={k:v for k,v in os.environ.items() if k != 'COMPARISON_DIAGNOSTICS'})
            _, status, usage = os.wait4(proc.pid, 0)
            elapsed = (time.perf_counter_ns() - start) / 1_000_000
            proc.returncode = os.waitstatus_to_exitcode(status)
        peak_bytes = usage.ru_maxrss if platform.system() == 'Darwin' else usage.ru_maxrss * 1024
        native = output / ('index.html' if job['mode'] == 'html' else
                           'coverage-report.json' if job['tool'] == 'monocart' else 'report.json')
        row = {**job, 'round':round_index, 'order':order, 'warmup':round_index < 0,
               'elapsedMs':elapsed, 'peakRssBytes':peak_bytes, 'exitCode':proc.returncode,
               'reportBytes':native.stat().st_size if native.exists() else None,
               'command':['node' if part == args.node else part for part in cmd]}
        raw.append(row)
        with (base / 'timings.jsonl').open('a' if len(raw)>1 else 'w') as handle:
            handle.write(json.dumps(row)+'\n')
        print(f"{round_index:2} {label}: {elapsed:.1f} ms, {peak_bytes/1024/1024:.1f} MiB, exit {proc.returncode}", flush=True)
        if proc.returncode:
            raise RuntimeError(f"Measurement failed: {output / 'process.log'}")

summaries=[]
for job in jobs:
    rows=[row for row in raw if not row['warmup'] and all(row[k]==v for k,v in job.items())]
    summary={**job, 'samples':len(rows)}
    for metric in ['elapsedMs','peakRssBytes','reportBytes']:
        values=[row[metric] for row in rows]
        summary[metric]={'median':statistics.median(values),'min':min(values),'max':max(values)}
    summaries.append(summary)
metadata={
    'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'platform':platform.platform(), 'machine':platform.machine(),
    'cpu':subprocess.check_output(['sysctl','-n','machdep.cpu.brand_string'],text=True).strip() if platform.system()=='Darwin' else platform.processor(),
    'node':subprocess.check_output([args.node,'--version'],text=True).strip(),
    'rust':subprocess.check_output(['rustc','--version'],text=True).strip(),
    'coldpathCommit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
    'coldpathBinarySha256':hashlib.sha256(Path('target/release/coldpath').read_bytes()).hexdigest(),
    'tools':{'coldpath':'0.1.0','source-map-explorer':'2.5.3','monocart-coverage-reports':'2.13.0'},
    'rounds':args.rounds, 'warmupsPerJob':1, 'shuffleSeed':20260923,
    'method':'Fresh serial processes, warm filesystem cache, wall clock including startup and report writing, wait4 per-child peak RSS. Input conversion/build/install/browser capture excluded. HTML means one self-contained file; JSON schemas and report features differ.',
    'summary':summaries,
}
(base / 'measurements.json').write_text(json.dumps(metadata,indent=2)+'\n')
