# M6-C owner action sheet

The candidate stack and the final main release are running, but the following
items are **not** automated evidence and were not claimed as complete.

## 1. Real-device Passkey (authentication acceptance)

The browser run in this evidence directory used a temporary database session
with user-agent `M6C automation layout session (not auth acceptance)`. It is
not a real Passkey, not a phone proof and not a production authentication
acceptance.

Owner must:

1. Open `https://moyu.sutrasky.com` on the real device.
2. Sign in with the owner's registered Passkey (or register the first/next
   real credential through the owner setup flow if the window is re-opened).
3. Confirm `/api/v1/auth/me` succeeds with that real session and record the
   session id/time in the release evidence.
4. Keep at least one recovery-capable credential; do not revoke the last one.

The temporary automation session id is intentionally not included in this
repository; it was revoked after the run.

## 2. Phone reply and notification

Owner must send a reply from the phone/real mobile client and confirm:

- the phone browser shows the Work thread;
- the reply reaches the runtime and the conversation;
- the desktop/mobile notification behavior matches the owner's setting;
- the message is not a mock or a database-only insert.

## 3. Second GitHub identity

The agent account commenting on its own issue did not produce a GitHub
notification. Owner must use the second GitHub identity already reserved for
acceptance to:

- mention/assign the agent account on a real test issue;
- confirm the GitHub source receives it and the real task/PR path runs;
- confirm the second identity can review/merge the test PR if required.

## 4. Production window and host actions

Owner approval is required before any of the following, because they are
irreversible or user-visible:

- a fresh production backup and a formal migration/switch window;
- a host reboot and post-reboot sleeping-instance check;
- the decision and action for port `3082`;
- cleanup/disablement of the old `moyu.service` (currently inactive but still
  enabled while the M6-C stack owns the public entry);
- any production DNS/nginx change, database restore, user deletion or release
  deletion.

## 5. Acceptance artifacts

The real final task created
`https://github.com/Bouyer12/m5a-beta-adf10ad9/pull/10` on branch
`agent/m6c-final-acceptance`. It is a test-repository artifact. Owner should
decide whether to merge, close or retain PR #9 and PR #10 as evidence.

## 6. Remaining code decisions

- Panel ticket retry for an execute ticket currently returns
  `admissionRequired`; the platform `/api/v1/tasks/:id/retry` path has the
  lease logic. Owner/engineering must wire the superagent ticket action to the
  task command path or keep it disabled in the UI.
- Worker `message.read` events are not emitted by the current pinned runtime
  artifact; `handed_to_worker_at`/`read_at` therefore remain null even though
  the worker produced PR #10. This needs a runtime adapter patch and a rebuilt
  plugin artifact.
- The real-host review-check cgroup cleanup stress matrix was not executed in
  this run; it remains a release-gate item.
