"""item 7 — 状态原因、恢复引导、重试与清错：走一遍闭环。

1) 用 worker 内存 1024 MB 触发一次真实成员级 OOM，读任务终态、原因与系统给的恢复引导；
2) 清掉压力源，按系统给出的引导做一次人工恢复（唤醒实例 + 重试任务），给操作前后快照；
3) 重启双库（平台 PostgreSQL 与 runtime 状态），再读一次，证明错误没有复活。

    python3 scripts/m5b/matrix/item7-loop.py <step>     step ∈ {oom, recover, restart, read}
"""
import json
import subprocess
import sys
import time
import urllib.request
import uuid
import datetime

RUN = '/tmp/m5bmatrix'
SLICE = '/sys/fs/cgroup/m5bmatrix.slice'


def env_map(path=f'{RUN}/state.env'):
    out = {}
    for line in open(path).read().split('\n'):
        line = line.strip()
        if line.startswith('export '):
            line = line[len('export '):]
        if '=' in line:
            key, value = line.split('=', 1)
            out[key.strip()] = value.strip()
    return out


ENV = env_map()
API = 'http://127.0.0.1:4510'
COOKIE = {'cookie': 'moyu_session=' + ENV['M5B_SESSION_TOKEN']}
RID = ENV['M5B_REPOSITORY_ID']


def psql(sql):
    return subprocess.run(['psql', 'postgres://moyu@127.0.0.1:55433/m5b_matrix', '-X', '-q', '-tA', '-F', '|', '-c', sql],
                          capture_output=True, text=True).stdout.strip()


def call(path, body=None, method=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(API + path, data=data, method=method or ('GET' if body is None else 'POST'),
                                     headers={'content-type': 'application/json', **COOKIE})
    try:
        response = urllib.request.urlopen(request, timeout=30)
        return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode() or '{}')


def runtime():
    status, body = call(f'/api/v1/repositories/{RID}/runtime')
    return body.get('data', {}).get('runtime', {})


def task_state(cid):
    return psql("select t.id::text||'|'||t.state::text from task_links t join conversations c on c.id=t.conversation_id "
                f"where c.id='{cid}'")


def events(sql):
    return subprocess.run(['bash', '-c', sql], capture_output=True, text=True).stdout.strip()


def worker_mem(mb):
    path = f'{RUN}/worker-mem.txt'
    with open(path, 'w') as handle:
        handle.write(f'{mb}\n')
    subprocess.run(['chown', 'm5bmatrix:m5bmatrix', path], check=False)
    subprocess.run(['chmod', '0640', path], check=False)


def step_oom():
    print('## 1) 触发一次真实成员级 OOM')
    worker_mem(1024)
    _, conv = call('/api/v1/conversations', {
        'repositoryId': RID, 'mode': 'work', 'executionMode': 'execute', 'baseBranch': 'main',
        'clientRequestId': 'item7-oom-' + uuid.uuid4().hex[:6],
        'model': {'provider': 'local-test', 'model': 'local-test'},
    })
    cid = conv['data']['conversation']['id']
    call(f'/api/v1/conversations/{cid}/messages', {'clientMessageId': 'm-' + uuid.uuid4().hex[:8],
                                                   'text': 'Matrix item 7: OOM 的因与果。'})
    print('conversation=%s（worker 被要求分配 1024 MB；supervisor MemoryMax=512M）' % cid)
    for step in range(12):
        events_now = open(f'{SLICE}/memory.events').read().replace('\n', ' ')
        print('t=%-4d task=%-45s runtime=%-18s %s' % (step * 10, task_state(cid),
                                                     runtime().get('state', '-') + '/' + str(runtime().get('reasonCode')), events_now))
        time.sleep(10)
    print('\n### supervisor 的 fault（人可读原因）')
    print(events('journalctl -u m5bmatrix-supervisor --since "-10min" --no-pager | grep -a "supervisor.fault" | tail -2 | cut -c1-420'))
    print('\n### 内核原始行')
    print(events('journalctl --since "-10min" --no-pager | grep -aE "oom-kill:|Memory cgroup out of memory" | tail -3'))
    print('\n### runtime 投影（状态原因 + 恢复引导）')
    print(json.dumps(runtime(), ensure_ascii=False)[:1200])
    print('\n### 平台事件（状态迁移）')
    print(psql("select type||' '||coalesce(payload->'task'->>'state','-') from events where conversation_id='%s' order by seq" % cid))
    open(f'{RUN}/item7-cid.txt', 'w').write(cid)
    worker_mem(0)


def step_recover():
    cid = open(f'{RUN}/item7-cid.txt').read().strip()
    print('## 2) 人工恢复（压力源已清零，按系统给出的引导操作）')
    print('### 之前')
    print('task:', task_state(cid))
    print('runtime:', json.dumps({k: runtime().get(k) for k in ('state', 'reasonCode', 'waitingFor')}, ensure_ascii=False))
    wake = call(f'/api/v1/repositories/{RID}/wake', {})
    print('\nPOST /repositories/:id/wake ->', wake[0], json.dumps(wake[1], ensure_ascii=False)[:200])
    time.sleep(10)
    tid = task_state(cid).split('|')[0]
    retry = call(f'/api/v1/tasks/{tid}/retry', {'clientCommandId': 'retry-' + uuid.uuid4().hex[:8], 'expectedVersion': 0})
    print('POST /tasks/:id/retry ->', retry[0], json.dumps(retry[1], ensure_ascii=False)[:240])
    for step in range(12):
        print('t=%-4d task=%s' % (step * 10, task_state(cid)))
        time.sleep(10)
    print('\n### 之后')
    print('task:', task_state(cid))
    print('runtime:', json.dumps({k: runtime().get(k) for k in ('state', 'reasonCode', 'waitingFor', 'executionSlot')}, ensure_ascii=False))


def step_restart():
    print('## 3) 重启双库后复查')
    print('### 重启前')
    print('instances:', psql("select state::text||'|'||reason_code||'|'||coalesce(waiting_for,'none') from repository_instances"))
    subprocess.run(['systemctl', 'restart', 'm5bmatrix-pg.service'], check=False)
    time.sleep(8)
    subprocess.run(['systemctl', 'restart', 'm5bmatrix-supervisor.service'], check=False)
    time.sleep(45)
    print('\n### 重启后（平台 PostgreSQL + runtime 状态都重启过）')
    print('pg active:', subprocess.run(['systemctl', 'is-active', 'm5bmatrix-pg.service'], capture_output=True, text=True).stdout.strip())
    print('supervisor active:', subprocess.run(['systemctl', 'is-active', 'm5bmatrix-supervisor.service'], capture_output=True, text=True).stdout.strip())
    print('instances:', psql("select state::text||'|'||reason_code||'|'||coalesce(waiting_for,'none')||'|'||coalesce(error_code,'none') from repository_instances"))
    print('runtime:', json.dumps({k: runtime().get(k) for k in ('state', 'reasonCode', 'waitingFor', 'errorCode')}, ensure_ascii=False))
    cid = open(f'{RUN}/item7-cid.txt').read().strip()
    print('task:', task_state(cid))


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'oom'
    {'oom': step_oom, 'recover': step_recover, 'restart': step_restart}[which]()
