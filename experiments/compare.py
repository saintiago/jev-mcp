#!/usr/bin/env python3
"""Opt-in paid, read-only Codex comparison. No inherited MCP tools or runtime activation."""
import argparse, collections, datetime, json, os, pathlib, shutil, signal, subprocess, time
parser = argparse.ArgumentParser()
parser.add_argument('--repository', required=True)
parser.add_argument('--tasks', required=True, help='JSON array of {id, question, scope}')
parser.add_argument('--output', required=True)
parser.add_argument('--model', default='gpt-6.1-sol')
parser.add_argument('--effort', default='high')
parser.add_argument('--timeout', type=int, default=120)
args = parser.parse_args()
repo = pathlib.Path(args.repository).resolve()
package = pathlib.Path(__file__).resolve().parent.parent
server = package / 'dist/mcp.js'
if not server.exists():
    raise SystemExit('Build this package before running the comparison.')
if not os.environ.get('JEV_API_KEY'):
    raise SystemExit('JEV_API_KEY must be available; its value is never printed.')
auth_home = pathlib.Path(os.environ.get('CODEX_HOME', str(pathlib.Path.home() / '.codex')))
tasks = json.loads(pathlib.Path(args.tasks).read_text())
output = pathlib.Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=False, mode=0o700)
revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
(output / 'manifest.json').write_text(json.dumps({'revision': revision, 'model': args.model, 'effort': args.effort, 'tasks': tasks, 'started': datetime.datetime.now(datetime.timezone.utc).isoformat()}, indent=2))
results = []
for index, task in enumerate(tasks):
    for arm in (['ordinary', 'evidence'] if index % 2 == 0 else ['evidence', 'ordinary']):
        directory = output / (task['id'] + '-' + arm)
        directory.mkdir(mode=0o700)
        home = directory / 'home'
        home.mkdir(mode=0o700)
        shutil.copyfile(auth_home / 'auth.json', home / 'auth.json')
        (home / 'auth.json').chmod(0o600)
        config = ['cli_auth_credentials_store = "file"', 'model = ' + json.dumps(args.model), 'model_reasoning_effort = ' + json.dumps(args.effort), 'approval_policy = "never"', 'sandbox_mode = "read-only"', 'web_search = "disabled"', '[features]', 'apps = false', 'browser_use = false', 'multi_agent = false', 'shell_tool = ' + ('false' if arm == 'evidence' else 'true'), 'unified_exec = ' + ('false' if arm == 'evidence' else 'true'), '[apps._default]', 'enabled = false']
        if arm == 'evidence':
            config += ['[mcp_servers.jev]', 'command = ' + json.dumps(shutil.which('node') or 'node'), 'args = ' + json.dumps([str(server)]), 'required = true', 'default_tools_approval_mode = "approve"', 'env_vars = ["JEV_API_KEY", "JEV_USAGE_LOG_PATH", "JEV_RETRIEVAL_LOG_PATH"]', 'tool_timeout_sec = 90']
        (home / 'config.toml').write_text('\n'.join(config) + '\n')
        prompt = 'Read-only repository investigation. Do not modify files, run tests/builds, start workflows, delegate, use memory or browse. Answer in at most 100 words with owning functions and precise source citations. Scope: ' + task['scope'] + '. Question: ' + task['question']
        prompt += (' Use only retrieve_evidence and expand_evidence for repository search/reading. Retrieve several files together with a focused question and known literal terms. Batch missing ranges or full source through expansion; never infer absence from filtering.' if arm == 'evidence' else ' Use ordinary rg and source reads. Batch independent commands when useful.')
        (directory / 'prompt.txt').write_text(prompt)
        env = {key: os.environ[key] for key in ['PATH', 'HOME', 'USER', 'LANG'] if key in os.environ}
        env['CODEX_HOME'] = str(home)
        if arm == 'evidence':
            env.update(JEV_API_KEY=os.environ['JEV_API_KEY'], JEV_USAGE_LOG_PATH=str(directory / 'provider.jsonl'), JEV_RETRIEVAL_LOG_PATH=str(directory / 'retrieval.jsonl'))
        start = time.monotonic()
        timed_out = False
        try:
            with (directory / 'events.jsonl').open('w') as out, (directory / 'stderr.log').open('w') as err:
                child = subprocess.Popen(['codex', 'exec', '--json', '--cd', str(repo), '-'], stdin=subprocess.PIPE, stdout=out, stderr=err, text=True, env=env, start_new_session=True)
                child.stdin.write(prompt)
                child.stdin.close()
                try:
                    child.wait(timeout=args.timeout)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait()
        finally:
            (home / 'auth.json').unlink(missing_ok=True)
        events = []
        for line in (directory / 'events.jsonl').read_text().splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                pass
        usage = [e['usage'] for e in events if e.get('type') == 'turn.completed' and 'usage' in e]
        items = [e['item'] for e in events if e.get('type') == 'item.completed']
        answer = '\n'.join(i.get('text', '') for i in items if i.get('type') == 'agent_message')
        (directory / 'answer.txt').write_text(answer)
        row = {'task': task['id'], 'arm': arm, 'seconds': round(time.monotonic() - start, 2), 'timeout': timed_out, 'exitCode': child.returncode, 'usageAvailable': bool(usage), 'usage': {k: sum(u.get(k, 0) for u in usage) for k in ['input_tokens', 'cached_input_tokens', 'output_tokens']}, 'items': dict(collections.Counter(i.get('type') for i in items))}
        results.append(row)
        (output / 'results.json').write_text(json.dumps(results, indent=2))
        print(json.dumps(row), flush=True)
print('Saved comparison to ' + str(output), flush=True)

if any(not r['usageAvailable'] or r['exitCode'] != 0 or r['timeout'] for r in results):
    raise SystemExit('Incomplete comparison: failed or timed-out arms must not be counted as savings.')
