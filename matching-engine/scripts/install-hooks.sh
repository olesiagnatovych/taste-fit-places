#!/usr/bin/env bash
# Installs this repo's git hooks by copying every file in
# matching-engine/scripts/hooks/ into .git/hooks/. Runs automatically via
# `npm install` in matching-engine/ (see package.json "postinstall"), or
# run manually: bash matching-engine/scripts/install-hooks.sh
set -e

REPO_ROOT=$(git rev-parse --show-toplevel)
SRC_DIR="$REPO_ROOT/matching-engine/scripts/hooks"
DEST_DIR="$REPO_ROOT/.git/hooks"

if [ ! -d "$SRC_DIR" ]; then
  echo "install-hooks.sh: source hooks directory not found at $SRC_DIR" >&2
  exit 1
fi

for hook in "$SRC_DIR"/*; do
  [ -f "$hook" ] || continue
  name=$(basename "$hook")
  cp "$hook" "$DEST_DIR/$name"
  chmod +x "$DEST_DIR/$name"
  echo "Installed $name hook -> $DEST_DIR/$name"
done
