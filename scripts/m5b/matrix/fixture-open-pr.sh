#!/bin/sh
# Matrix fixture for the awaiting_review scenario: push the worker's ticket branch
# so the harness can open a real PR from it. Push only — the worker's bash tool has
# a short foreground budget and `gh pr create` does not fit in it.
set -e
cd "$(git rev-parse --show-toplevel)"
branch=$(git rev-parse --abbrev-ref HEAD)
echo "worktree=$(pwd)"
echo "branch=${branch}"
# A PR needs a commit the base branch does not have: the worktree is otherwise clean
# at the base commit, so the fixture writes its own probe file first.
printf '# m5b matrix fixture\n\nOpened by the M5-B item 5 awaiting_review probe; deleted after the run.\n' >M5B-MATRIX-FIXTURE.md
git add -A
git -c user.name=Bouyer12 \
    -c user.email=202233540+Bouyer12@users.noreply.github.com \
    commit -q -m "m5b matrix fixture commit" || echo "commit: nothing to commit"
git push -q -u origin "$branch" 2>&1 | tail -2 || true
echo "PUSHED=${branch}"
