# Review-check cgroup stress: not executed

The final candidate release contains:

- per-check cgroup creation and `cgroup.kill`;
- a bounded emptiness poll;
- `setpriv` capability clearing and `--no-new-privs`;
- residual/unknown cleanup reporting and fail-closed check results;
- supervisor unit capabilities `CAP_SETUID`, `CAP_SETGID`, `CAP_SETPCAP`,
  `CAP_KILL`, `CAP_CHOWN`, `CAP_FOWNER`, `CAP_FSETID`, `CAP_DAC_OVERRIDE`;
- `Delegate=yes` and `DelegateSubgroup=supervisor`.

However, this run did **not** execute the real-host matrix with:

1. a child that calls `setsid` and ignores `SIGTERM`;
2. a child that keeps a pipe/descriptor open after the parent exits;
3. a timed-out check followed by an immediate second check in the same
   repository and in another repository;
4. a check whose cgroup cannot be read or killed.

The existing implementation/unit coverage is not presented as evidence for
those real-host cases. This item must be executed on `jd-mc` after the owner
window, with the check identity and cgroup paths recorded before and after.
