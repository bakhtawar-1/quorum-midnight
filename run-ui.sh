#!/usr/bin/env bash
# Detached launcher for the Quorum web UI (Vite dev server on :5173).
source "$HOME/.mn-env.sh"
cd "$HOME/quorum/ui" || exit 1
exec npx vite --port 5173 --strictPort --host
