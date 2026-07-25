#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${1:-"$repo_root"}"

if [[ "${1:-}" == "--no-export" ]]; then
  shift
  out="${1:-"$repo_root"}"
fi

node "$repo_root/scripts/audit-public-projection.mjs" "$out"
