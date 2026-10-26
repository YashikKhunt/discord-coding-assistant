#!/usr/bin/env bash
# Forced command for the CI deploy key (see docs/DEPLOY-ORACLE.md). sshd passes the
# commit CI approved in $SSH_ORIGINAL_COMMAND; this script is the only thing that key
# can do, so it accepts nothing but a SHA that is already on origin/main.
set -euo pipefail

cd "$(dirname "$0")/../.."

SHA="${SSH_ORIGINAL_COMMAND:-}"
if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected a 40-character commit SHA, got: '$SHA'" >&2
  exit 64
fi

echo "==> Fetching origin"
git fetch --quiet origin main

# Without this check the key could deploy any commit that happens to be fetchable
# (an old release, or a branch that never passed CI).
if ! git merge-base --is-ancestor "$SHA" origin/main; then
  echo "$SHA is not an ancestor of origin/main; refusing to deploy it" >&2
  exit 65
fi

# merge --ff-only rather than a detached checkout, so the box stays on main and a
# manual `deploy.sh --pull` still behaves afterwards.
echo "==> Fast-forwarding to $SHA"
git merge --ff-only "$SHA"

exec ./infra/scripts/deploy.sh
