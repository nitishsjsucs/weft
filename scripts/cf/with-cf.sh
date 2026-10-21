#!/usr/bin/env bash
# Runs ONE command with the Cloudflare account token and account id in its environment, and nowhere else
# (docs/cloudflare/design.md 9.3). The token is CF_SETUP_TOKEN in the secrets file (default
# ~/Developer/projects/.people-analytics.secrets.env, or WEFT_CF_TOKEN_FILE), parsed with awk and never sourced, never
# printed. The account id comes from CLOUDFLARE_ACCOUNT_ID in the caller's environment, or a CF_ACCOUNT_ID line in
# the same file; it is not committed. Never wrangler OAuth.
#
#   scripts/cf/with-cf.sh pnpm exec wrangler whoami
set -euo pipefail
set +x

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
file="${WEFT_CF_TOKEN_FILE:-$HOME/Developer/projects/.people-analytics.secrets.env}"
if [ "$#" -eq 0 ]; then
  echo "usage: scripts/cf/with-cf.sh <command> [args...]" >&2
  exit 2
fi
if [ ! -r "$file" ]; then
  echo "with-cf: cannot read the token file (set WEFT_CF_TOKEN_FILE)" >&2
  exit 1
fi
token="$(awk -v key=CF_SETUP_TOKEN -f "$here/env-value.awk" "$file")"
if [ -z "$token" ]; then
  echo "with-cf: CF_SETUP_TOKEN is not in the token file" >&2
  exit 1
fi
account="${CLOUDFLARE_ACCOUNT_ID:-}"
if [ -z "$account" ]; then
  account="$(awk -v key=CF_ACCOUNT_ID -f "$here/env-value.awk" "$file")"
fi
if [ -z "$account" ]; then
  echo "with-cf: set CLOUDFLARE_ACCOUNT_ID (or a CF_ACCOUNT_ID line in the token file)" >&2
  exit 1
fi
CLOUDFLARE_API_TOKEN="$token" CLOUDFLARE_ACCOUNT_ID="$account" exec "$@"
