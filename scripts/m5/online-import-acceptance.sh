#!/usr/bin/env bash
# M5-A online GitHub import acceptance check (read-only).
# Override M5_* variables for a different isolated stack. The task state check
# accepts running, awaiting_review, or completed because the worker may finish
# before the acceptance rerun; counts and ownership assertions are unchanged.
# Verifies the human @ trigger on issue #1 produced exactly one reception
# (bridge ticket.imported), one platform conversation/message/task, one DSH
# worker session, and that the online m5a runtime process owns the bridge.
set -u
DB="${M5_DATABASE_URL:-postgres://moyu@127.0.0.1:55432/moyu_m5a_live}"
REPO_ID="${M5_REPOSITORY_ID:-705d163e-6cdc-4f90-b819-67c5238a3a90}"
TICKET="${M5_TICKET_ID:-499f76d58c4c0eb5b1063e874455d822}"
TRIGGER="${M5_TRIGGER_ID:-ebb726a0e2066b2d37a500a818b68a3f}"
CONV="${M5_CONVERSATION_ID:-107ebc4d-501b-4f5c-911a-f042d8db3f94}"
SESS="${M5_WORKER_SESSION:-/root/.dsh-m5/sessions/--root-.dsh-m5-worktrees-m5a-online-import-acceptance-499f76d58c4c--/worker-$TICKET/session.v4.jsonl.zstd}"
BRIDGE="${M5_BRIDGE_EVENTS:-/root/.dsh-m5/state/m5a/bridge/events.jsonl}"
DISPATCHER_LOG="${M5_DISPATCHER_LOG:-/tmp/m5-run/dispatcher.log}"
pass=0; fail=0
ok()   { pass=$((pass+1)); echo "PASS  $1"; }
bad()  { fail=$((fail+1)); echo "FAIL  $1"; }
q()    { PGPASSWORD= psql "$DB" -tA -c "$1" 2>/dev/null | tr -d '\n'; }

# 1. Human trigger author and time, and no import for the prior agent self-comment.
author=$(gh api repos/Bouyer12/m5a-alpha-adf10ad9/issues/comments/6648169490 --jq .user.login)
created=$(gh api repos/Bouyer12/m5a-alpha-adf10ad9/issues/comments/6648169490 --jq .created_at)
[ "$author" = "sutrasky" ] && ok "trigger author is human sutrasky (not agent Bouyer12), comment 6648169490 at $created" \
                           || bad "trigger author unexpected: $author"
self_imports=$(q "select count(*) from conversations where external_url like '%6637745507%';")
[ "$self_imports" = "0" ] && ok "prior agent-authored comment 6637745507 produced 0 imports (self-echo filter)" \
                          || bad "agent self-comment unexpectedly imported: $self_imports"

# 2. Reception: bridge emitted exactly one ticket.imported for this trigger.
recv=$(grep -c "\"id\":\"ticket-imported:$TICKET\".*\"triggerId\":\"$TRIGGER\"" "$BRIDGE" || true)
[ "$recv" = "1" ] && ok "bridge ticket.imported event present exactly once (trigger $TRIGGER)" \
                 || bad "bridge ticket.imported count=$recv"
recv_at=$(grep "\"id\":\"ticket-imported:$TICKET\"" "$BRIDGE" | sed -n 's/.*"at":"\([^"]*\)".*/\1/p')
[ -n "$recv_at" ] && ok "bridge reception timestamp $recv_at" || bad "no bridge reception timestamp"
grep -q "bridge.ticket_imported.*$TICKET" "$DISPATCHER_LOG" \
  && ok "dispatcher recorded bridge.ticket_imported for $TICKET" \
  || bad "dispatcher import log missing"

# 3. Session: exactly one conversation, message and task; task running.
convs=$(q "select count(*) from conversations where external_url like '%6648169490%';")
[ "$convs" = "1" ] && ok "exactly 1 platform conversation for comment 6648169490" || bad "conversation count=$convs"
ext=$(q "select source||' '||external_key from conversations where id='$CONV';")
[ "$ext" = "github github:1" ] && ok "conversation source/external key = github / github:1" || bad "conversation source/key=$ext"
msgs=$(q "select count(*) from messages where conversation_id='$CONV' and direction='inbound' and source='github' and source_event_id='import:$TRIGGER';")
[ "$msgs" = "1" ] && ok "exactly 1 inbound GitHub message carrying trigger id $TRIGGER" || bad "inbound message count=$msgs"
tasks=$(q "select count(*) from task_links where upstream_ticket_id='$TICKET';")
[ "$tasks" = "1" ] && ok "exactly 1 task linked to ticket $TICKET" || bad "task count=$tasks"
state=$(q "select state||' v'||version from task_links where conversation_id='$CONV';")
case "$state" in running*|awaiting_review*|completed*) ok "task state $state (imported and reached a valid execution state)" ;; *) bad "task state $state" ;; esac

# 4. Session: DSH worker session file and title match the imported ticket.
[ -s "$SESS" ] && ok "DSH worker session file exists: $SESS" || bad "DSH worker session file missing"
sess_id=$(zstdcat "$SESS" | head -1 | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ "$sess_id" = "worker-$TICKET" ] && ok "worker session id = $sess_id" || bad "worker session id=$sess_id"
title=$(zstdcat "$SESS" | sed -n '9p' | sed -n 's/.*"title":"\([^"]*\)".*/\1/p')
[ "$title" = "执行在线导入验收测试并回报接收、会话与进程证据" ] && ok "worker session title matches imported ticket" || bad "worker session title=$title"

# 5. Process: DB instance online with a live pid owning 3401/3402.
pid=$(q "select pid from repository_instances where repository_id='$REPO_ID' and state='online';")
[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ok "m5a runtime online, pid $pid alive" || bad "runtime pid missing/dead (pid=$pid)"
cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
case "$cmdline" in *"--profile m5a"*) ok "pid $pid command: $cmdline" ;; *) bad "pid $pid command=$cmdline" ;; esac
listening=$(ss -ltnp 2>/dev/null | awk -v p="pid=$pid," '$0 ~ p && ($4 ~ /:3401$/ || $4 ~ /:3402$/) {print $4}' | sort | tr '\n' ' ')
[ "$listening" = "127.0.0.1:3401 127.0.0.1:3402 " ] && ok "pid $pid listens on bridge 3401 and panel 3402" || bad "listeners=$listening"
progress=$(q "select to_char(last_progress_at,'YYYY-MM-DD\"T\"HH24:MI:SS.MSOF') from repository_instances where repository_id='$REPO_ID';")
[ -n "$progress" ] && ok "runtime last_progress_at $progress" || bad "runtime last_progress_at missing"

echo "----"
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
