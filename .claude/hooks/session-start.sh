#!/bin/bash
set -euo pipefail

# Only run in remote Claude Code web sessions
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR/backend"
npm install

# Print full vulnerability details (|| true so hook doesn't fail on findings)
npm audit || true
