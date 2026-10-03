"""Serial before/after/SME comparison; never overlap with other test workloads."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import random
import statistics
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--node', default='node')
parser.add_argument('--before', default='artifacts/baseline/coldpath')
parser.add_argument('--rounds', type=int, default=9)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
os.chdir(root)
base = Path('artifacts/mvp/measurements')
jobs = []
for dataset in ['blog-mapped', 'blog-measured']:
    for tool in ['before', 'after', 'sme']:
        jobs.append(dict(dataset=dataset, tool=tool, mode='json'))
    for tool in ['after', 'sme']:
        jobs.append(dict(dataset=dataset, tool=tool, mode='treemap'))
for tool in ['before', 'after']:
    jobs.append(dict(dataset='blog-measured', tool=tool, mode='inspect'))

def command(job, output):
    dataset = Path('artifacts/comparison/inputs') / job['dataset']
    static = job['dataset'] == 'blog-mapped'
    html = job['mode'] != 'json'
    if job['tool'] == 'sme':
        mode = ('static-html' if html else 'static') if static else ('html' if html else 'json')
        return [args.node, 'benchmarks/run-tool.ts', 'sme', str(dataset), str(output), mode, 'relaxed']
    cmd = [args.before if job['tool'] == 'before' else 'target/release/coldpath', '--dir', str(dataset / 'files')]
    if not static:
        cmd += ['--coverage', str(dataset / 'playwright.json'), '--url-prefix', 'https://comparison.invalid/']
    cmd += [{'json':'--json','treemap':'--treemap','inspect':'--html'}[job['mode']], str(output / ('index.html' if html else 'report.json'))]
    return cmd

samples=[]
rng=random.Random(20260923)
for index in range(-1,args.rounds):
    shuffled=jobs.copy()
    rng.shuffle(shuffled)
    for order,job in enumerate(shuffled):
        output=base / str(index) / '-'.join(job.values())
        output.mkdir(parents=True,exist_ok=True)
        cmd=command(job,output)
        with (output/'process.log').open('wb') as log:
            start=time.perf_counter_ns()
            proc=subprocess.Popen(cmd,stdout=log,stderr=subprocess.STDOUT,env={k:v for k,v in os.environ.items() if k!='COMPARISON_DIAGNOSTICS'})
            _,status,usage=os.wait4(proc.pid,0)
            elapsed=(time.perf_counter_ns()-start)/1e6
            proc.returncode=os.waitstatus_to_exitcode(status)
        assert proc.returncode==0,output/'process.log'
        report=output/('report.json' if job['mode']=='json' else 'index.html')
        samples.append(dict(**job,round=index,order=order,elapsedMs=elapsed,peakRssBytes=usage.ru_maxrss if platform.system()=='Darwin' else usage.ru_maxrss*1024,reportBytes=report.stat().st_size,exitCode=proc.returncode))
        print(f"{index} {job}: {elapsed:.2f} ms",flush=True)
    for dataset in ['blog-mapped','blog-measured']:
        a=base/str(index)/f'{dataset}-before-json/report.json'
        b=base/str(index)/f'{dataset}-after-json/report.json'
        assert a.read_bytes()==b.read_bytes(),(dataset,index,'output differs')
summary=[]
for job in jobs:
    selected=[r for r in samples if r['round']>=0 and all(r[k]==v for k,v in job.items())]
    summary.append(dict(**job,**{metric:dict(median=statistics.median(r[metric] for r in selected),min=min(r[metric] for r in selected),max=max(r[metric] for r in selected)) for metric in ['elapsedMs','peakRssBytes','reportBytes']}))
metadata=dict(timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(),platform=platform.platform(),machine=platform.machine(),node=subprocess.check_output([args.node,'--version'],text=True).strip(),rust=subprocess.check_output(['rustc','--version'],text=True).strip(),baseCommit=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),workingTreeDiffSha256=hashlib.sha256(subprocess.check_output(['git','diff','--','src','Cargo.toml','Cargo.lock'])).hexdigest(),binarySha256={name:hashlib.sha256(Path(path).read_bytes()).hexdigest() for name,path in [('before',args.before),('after','target/release/coldpath')]},rounds=args.rounds,warmupsPerJob=1,seed=20260923,summaryJsonByteIdentical=True,method='Randomized serial fresh processes, warm filesystem, startup and writes included; one warmup per job. SME 2.5.3/source-map 0.7.6, relaxed bounds. Same saved inputs. Treemap and inspect are distinct features, not interchangeable HTML workloads.',summary=summary,samples=samples)
metadata['sourceFilesSha256'] = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted([*Path('src').glob('*'), Path('Cargo.toml'), Path('Cargo.lock')]) if path.is_file()}
metadata['inputManifestSha256'] = {name: hashlib.sha256((Path('artifacts/comparison/inputs') / name / 'manifest.json').read_bytes()).hexdigest() for name in ['blog-mapped', 'blog-measured']}
Path('benchmarks/results/mvp-measurements.json').write_text(json.dumps(metadata,indent=2)+'\n')
print(json.dumps(summary,indent=2))
