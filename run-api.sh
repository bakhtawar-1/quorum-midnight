#!/usr/bin/env bash
# Detached launcher for the Quorum demo API. Keeps threshold 5 + empty seeded
# pool so it REJOINS the existing contract (no redeploy, no store wipe).
source "$HOME/.mn-env.sh"
[ -f "$HOME/.quorum-mail.sh" ] && source "$HOME/.quorum-mail.sh"
cd "$HOME/quorum" || exit 1
export QUORUM_THRESHOLD=5
export QUORUM_IDENTITY_POOL=
exec npx tsx server/index.ts
