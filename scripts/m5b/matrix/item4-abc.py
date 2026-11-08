#!/usr/bin/env python3
"""item 4 — three repositories arriving at once (A/B execute, C queued).

STATUS 2026-11-08: the three repositories and their tasks are created over the
real Web API, but the two added repositories never get a repository_instance, so
every task stays pending_admission and the A/B-versus-C split is NOT measured.
Run it with the stack up; it prints the timeline it observes.

Known gaps to settle before this can be called evidence:
  - the supervisor provisions instances from INSTANCES_CONFIG at boot; adding a
    repository row and an instances.json entry did not create a second instance,
    so the provisioning path for an extra repository is still unknown;
  - the member-level OOM and the bounded recovery parts of item 4 are untouched.
"""

import json, urllib.request, uuid, datetime, subprocess, time

def env_map(path='/tmp/m5bmatrix/state.env'):
    out = {}
    for line in open(path).read().split('\n'):
        line = line.strip()
        if line.startswith('export '):
            line = line[len('export '):]
        if '=' in line:
            key, value = line.split('=', 1)
            out[key.strip()] = value.strip()
    return out

env = env_map()
API = 'http://127.0.0.1:4510'
TOKEN = env['M5B_SESSION_TOKEN']


def psql(sql):
    result = subprocess.run(['psql', 'postgres://moyu@127.0.0.1:55433/m5b_matrix', '-X', '-q', '-tA', '-F', '|', '-c', sql],
                            capture_output=True, text=True)
    return result.stdout.strip()


def call(path, body):
    request = urllib.request.Request(API + path, data=json.dumps(body).encode(), method='POST',
                                     headers={'content-type': 'application/json', 'cookie': 'moyu_session=' + TOKEN})
    return json.load(urllib.request.urlopen(request, timeout=30))


rows = psql("select id, full_name from repositories order by full_name").split('\n')
repos = [(row.split('|')[1], row.split('|')[0]) for row in rows if '|' in row]

print('# item 4 — A/B 执行、C 排队（三个仓库同时来任务）')
print('recorded=%s' % datetime.datetime.now().astimezone().isoformat())
for name, rid in repos:
    print('repository %-32s id=%s status=%s' % (name, rid, psql("select status from repositories where id='%s'" % rid)))

print('\n## 同时创建三个任务（真实 Web API）')
for name, rid in repos:
    try:
        conv = call('/api/v1/conversations', {
            'repositoryId': rid, 'mode': 'work', 'executionMode': 'execute', 'baseBranch': 'main',
            'model': {'provider': 'local-test', 'model': 'local-test'},
            'clientRequestId': 'item4-%s-%s' % (name.split('/')[-1], uuid.uuid4().hex[:6]),
        })
        cid = conv['data']['conversation']['id']
        call('/api/v1/conversations/%s/messages' % cid, {
            'clientMessageId': 'm-' + uuid.uuid4().hex[:8],
            'text': 'Matrix item 4: admission probe for %s.' % name,
        })
        print('created %-32s conversation=%s' % (name, cid))
    except Exception as error:
        print('create failed for %s: %s' % (name, error))

print('\n## 时间线（每 10 秒采样：task / instance / reason / waiting_for）')
for step in range(8):
    out = psql("select c.repository_id, t.state, coalesce(i.state,'-'), coalesce(i.reason_code,'-'), coalesce(i.waiting_for,'-') "
               "from task_links t join conversations c on c.id=t.conversation_id "
               "left join repository_instances i on i.repository_id=c.repository_id order by c.created_at")
    print('t=%ds' % (step * 10))
    for line in out.split('\n'):
        if '|' in line:
            rid, tstate, istate, reason, waiting = line.split('|')
            name = [k for k, v in repos if v == rid]
            print('   %-32s task=%-16s instance=%-11s reason=%-26s waiting=%s'
                  % (name[0] if name else rid, tstate, istate, reason, waiting))
    if step < 7:
        time.sleep(10)

print('\n## 切片总量')
print('slice_current=%s' % open('/sys/fs/cgroup/m5bmatrix.slice/memory.current').read().strip())
