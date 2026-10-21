#!/usr/bin/env bash
# Installs one Worker secret (docs/cloudflare/design.md 9.3): reads KEY from FILE with awk (never sourced), pipes the
# value to `wrangler secret put NAME` on stdin and prints the name only. Run it inside with-cf.sh:
#
#   scripts/cf/with-cf.sh scripts/cf/put-secret.sh WEFT_PROXY_SECRET ~/Developer/projects/.weft.cf.secrets.env \
#     WEFT_PROXY_SECRET apps/cf/wrangler.core.jsonc
#
# The fourth argument (or WEFT_CF_CONFIG) is the wrangler config naming the Worker. WEFT_WRANGLER overrides the
# wrangler command (tests).
set -euo pipefail
set +x

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$#" -lt 3 ]; then
  echo "usage: scripts/cf/put-secret.sh NAME FILE KEY [WRANGLER_CONFIG]" >&2
  exit 2
fi
name="$1"
file="$2"
key="$3"
config="${4:-${WEFT_CF_CONFIG:-}}"
if ! [[ "$name" =~ ^[A-Z][A-Z0-9_]{1,63}$ ]]; then
  echo "put-secret: NAME must be an upper-case env name" >&2
  exit 2
fi
if [ -z "$config" ]; then
  echo "put-secret: name the wrangler config (fourth argument or WEFT_CF_CONFIG)" >&2
  exit 2
fi
if [ ! -r "$file" ]; then
  echo "put-secret: cannot read the secrets file" >&2
  exit 1
fi
value="$(awk -v key="$key" -f "$here/env-value.awk" "$file")"
if [ -z "$value" ]; then
  echo "put-secret: $key is not in the secrets file" >&2
  exit 1
fi
wrangler_cmd="${WEFT_WRANGLER:-pnpm exec wrangler}"
# shellcheck disable=SC2086
printf '%s' "$value" | $wrangler_cmd secret put "$name" --config "$config" > /dev/null
unset value
echo "put-secret: $name"
