# M6-C owner actions after gap closure

These actions need the owner's real device, account, data or maintenance
authorization. They are not automated or simulated by this evidence run.

## Real acceptance evidence

1. **Passkey**: register and log in with a real device Passkey on
   `https://moyu.sutrasky.com`; retain the browser/user-verification result.
2. **Phone**: send a real phone message and confirm the notification/reply
   round trip; record the source message and delivery IDs.
3. **Second GitHub identity**: trigger a real mention/assignment/review from a
   second GitHub account; record the webhook/event and the resulting ticket or
   review state.
4. **P19 real source data**: configure source labels and policy-sync inputs that
   actually contain names/rules, then rerun the two currently fail-closed panel
   actions for a positive write result.

## Production window

5. Approve a formal maintenance window and authorize a fresh pre-cutover
   backup, host reboot and production migration/cutover.
6. Decide and act on port `3082` (still listening; PID `2146551` at the last
   check). Do not change it silently.
7. Decide whether to disable/remove the old `moyu.service`, which is inactive
   but still enabled.
8. Decide the merge/close disposition of test PRs
   [#9](https://github.com/Bouyer12/m5a-beta-adf10ad9/pull/9),
   [#10](https://github.com/Bouyer12/m5a-beta-adf10ad9/pull/10) and
   [#11](https://github.com/Bouyer12/m5a-beta-adf10ad9/pull/11).

## Safety

Do not reuse the temporary automation DB session as authentication evidence.
The temporary session used for these checks was marked
`M6C read-receipt automation (not auth acceptance)` and was revoked after the
run. No real Passkey, phone or second-account proof is claimed here.
