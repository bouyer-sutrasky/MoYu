#!/bin/bash
# Bounded live probe: the production launcher is released only after the
# supervisor writes its PID into an isolated cgroup; the first child and its
# descendants must inherit that cgroup. Runs in a 256 MiB slice.
set -euo pipefail
CGROUP_LAUNCHER='IFS= read -r go <&3 || exit 126; [ "$go" = go ] || exit 127; exec "$@"'
slice="m5b-launcher-$$.slice"
unit="m5b-launcher-$$"
cleanup() {
  systemctl stop "$unit" 2>/dev/null || true
  systemctl reset-failed "$unit" 2>/dev/null || true
  systemctl stop "$slice" 2>/dev/null || true
  rm -rf "/run/systemd/system.control/${slice}.d"
  systemctl daemon-reload 2>/dev/null || true
}
trap cleanup EXIT
systemd-run --unit="$unit" --slice="$slice" --property=MemoryMax=256M --wait -- /bin/sleep 20 >/dev/null 2>&1 &
anchor=$!
sleep 1
root="/sys/fs/cgroup/${slice}/probe"
mkdir -p "$root"
echo '+memory +pids' > "/sys/fs/cgroup/${slice}/cgroup.subtree_control"
cat > /tmp/m5b-launcher-probe.$$.mjs <<'JS'
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync } from 'node:fs'
const cgroup = process.argv[2]
const launcher = process.env.CGROUP_LAUNCHER
const child = spawn('/bin/sh', ['-c', launcher, 'moyu-cgroup', '/bin/sh', '-c', 'sleep 3 & echo $! > /tmp/m5b-launcher-child.pid; wait'], {
  detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
})
writeFileSync('/tmp/m5b-launcher-parent.pid', String(child.pid))
writeFileSync(`${cgroup}/cgroup.procs`, String(child.pid))
child.stdio[3].end('go\n')
await new Promise(resolve => setTimeout(resolve, 300))
const parentCgroup = readFileSync(`/proc/${child.pid}/cgroup`, 'utf8').trim()
const childPid = readFileSync('/tmp/m5b-launcher-child.pid', 'utf8').trim()
const childCgroup = readFileSync(`/proc/${childPid}/cgroup`, 'utf8').trim()
console.log(JSON.stringify({ parentPid: child.pid, parentCgroup, childPid, childCgroup }))
JS
CGROUP_LAUNCHER="$CGROUP_LAUNCHER" /usr/bin/node /tmp/m5b-launcher-probe.$$.mjs "$root"
cat "$root/cgroup.procs"
echo kill > "$root/cgroup.kill" 2>/dev/null || true
sleep 1
test -z "$(cat "$root/cgroup.procs")" && echo "cgroup-empty"
rm -f /tmp/m5b-launcher-probe.$$.mjs /tmp/m5b-launcher-parent.pid /tmp/m5b-launcher-child.pid
wait "$anchor" 2>/dev/null || true
