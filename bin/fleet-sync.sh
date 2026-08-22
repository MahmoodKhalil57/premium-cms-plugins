#!/usr/bin/env bash
# Ask the apex platform plugin to apply a change to every live project.
#   bin/fleet-sync.sh bundle                 # redeploy + setup on the latest bundle
#   bin/fleet-sync.sh plugins [id,id…]       # update installed marketplace plugins (+ install these)
#   bin/fleet-sync.sh themes  [theme,theme…] # re-apply theme seeds
# env: PLATFORM_URL (default https://premium-cms.com), DEPLOY_KEY
set -euo pipefail
OP="${1:-bundle}"; LIST="${2:-}"
URL="${PLATFORM_URL:-https://premium-cms.com}/_emdash/api/plugins/premium-platform/fleet/sync"
[ -n "${DEPLOY_KEY:-}" ] || { echo "DEPLOY_KEY is not set"; exit 1; }
after=""; total=0; failed=0
while :; do
  body=$(python3 -c "
import json,sys,os
op, lst, after = sys.argv[1:4]
b = {'key': os.environ['DEPLOY_KEY'], 'op': op, 'limit': 3 if op == 'plugins' else 1}
if after: b['after'] = after
items = [x for x in lst.split(',') if x]
if items: b['install' if op == 'plugins' else 'themes'] = items
print(json.dumps(b))" "$OP" "$LIST" "$after")
  res=$(curl -sS --max-time 300 -X POST "$URL" -H "Content-Type: application/json" -H "X-EmDash-Request: 1" -d "$body")
  python3 -c "
import json,sys
d=json.loads(sys.argv[1]); data=d.get('data') or {}
if not d.get('success', True) or 'error' in d: print('ERROR', (d.get('error') or {}).get('message', d)); sys.exit(2)
for x in data.get('done', []): print('  ok    ', x['id'], json.dumps(x.get('result'))[:160])
for x in data.get('failed', []): print('  FAILED', x['id'], x['error'][:200])
print(f\"  remaining {data.get('remaining')} / {data.get('total')}\")
open('/tmp/fleet-after','w').write(str(data.get('after') or ''))
open('/tmp/fleet-remaining','w').write(str(data.get('remaining') or 0))
open('/tmp/fleet-failed','w').write(str(len(data.get('failed', []))))
" "$res"
  failed=$((failed + $(cat /tmp/fleet-failed)))
  after=$(cat /tmp/fleet-after)
  [ "$(cat /tmp/fleet-remaining)" = "0" ] && break
done
echo "fleet sync ($OP) finished; failed projects: $failed"
[ "$failed" = "0" ]
