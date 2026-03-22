#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

CURRENT=$(grep '^version' Cargo.toml | head -1 | sed 's/.*"\(.*\)"/\1/')
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "${1:-patch}" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
  *) echo "Usage: $0 [major|minor|patch]"; exit 1 ;;
esac

NEW="${MAJOR}.${MINOR}.${PATCH}"

sed -i.bak "s/^version = \"${CURRENT}\"/version = \"${NEW}\"/" Cargo.toml && rm -f Cargo.toml.bak

echo "${CURRENT} → ${NEW}"
