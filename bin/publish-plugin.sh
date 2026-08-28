#!/usr/bin/env bash
#
# Release a sandboxed plugin to the premium-cms marketplace.
#
#   bin/publish-plugin.sh <plugin-id>
#
# The marketplace's own publish path needs an atproto author identity that is
# not stood up, so a release is the listing written directly: the
# `emdash-plugin bundle` tarball goes to the `plugin-bundles` R2 bucket at
# `<id>/<version>.tar.gz`, and a `plugins` row (upserted from the manifest) +
# a published `plugin_versions` row are written to the marketplace D1.
# Idempotent: a version that is already listed is left alone (exit 0, prints
# "already published"), so CI can run it on every push.
#
# Credentials (env): CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN for the
# account that owns the marketplace (or CLOUDFLARE_MASTER_ACOUNT_ID /
# CLOUDFLARE_MASTER_API_TOKEN from ../.env.master). Optional overrides:
# MARKETPLACE_D1_ID, MARKETPLACE_BUCKET, MARKETPLACE_AUTHOR, MIN_EMDASH_VERSION.
set -euo pipefail
ID="${1:?usage: publish-plugin.sh <plugin-id>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/plugins/$ID"
[ -d "$DIR" ] || { echo "no plugin at $DIR"; exit 1; }
if [ ! -f "$DIR/emdash-plugin.jsonc" ]; then
	echo "$ID is a trusted (source) plugin — it ships inside theme bundles, not the marketplace"
	exit 0
fi
if [ "$(node -p "require('$DIR/package.json').private ? 1 : 0")" = "1" ]; then
	echo "$ID is private — not listed on the marketplace"
	exit 0
fi

for envf in "$ROOT/../.env.master" "$ROOT/.env"; do
	[ -f "$envf" ] && { set -a; source "$envf"; set +a; }
done
: "${CLOUDFLARE_ACCOUNT_ID:=${CLOUDFLARE_MASTER_ACOUNT_ID:-}}"
: "${CLOUDFLARE_API_TOKEN:=${CLOUDFLARE_MASTER_API_TOKEN:-}}"
: "${MARKETPLACE_D1_ID:=db47e8ef-e2d5-41c8-9d32-7298d52d6941}"
: "${MARKETPLACE_BUCKET:=plugin-bundles}"
: "${MARKETPLACE_AUTHOR:=premiumcms}"
: "${MIN_EMDASH_VERSION:=0.35.0}"
[ -n "$CLOUDFLARE_ACCOUNT_ID" ] && [ -n "$CLOUDFLARE_API_TOKEN" ] || { echo "missing Cloudflare credentials"; exit 1; }
export CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN MARKETPLACE_D1_ID MARKETPLACE_BUCKET MARKETPLACE_AUTHOR MIN_EMDASH_VERSION ID DIR

echo "building + bundling $ID…"
( cd "$DIR" && bun install >/dev/null 2>&1 && bunx emdash-plugin build >/dev/null && bunx emdash-plugin bundle >/dev/null )

python3 - <<'EOF'
import glob, hashlib, json, os, re, sys, urllib.parse, urllib.request, urllib.error

acct, tok = os.environ["CLOUDFLARE_ACCOUNT_ID"], os.environ["CLOUDFLARE_API_TOKEN"]
d1, bucket, author = os.environ["MARKETPLACE_D1_ID"], os.environ["MARKETPLACE_BUCKET"], os.environ["MARKETPLACE_AUTHOR"]
pid, pdir, min_v = os.environ["ID"], os.environ["DIR"], os.environ["MIN_EMDASH_VERSION"]
UA = "premiumcms-plugin-publisher/1.0"

def cf(method, path, data=None, ctype="application/json"):
    body = data if isinstance(data, (bytes, type(None))) else json.dumps(data).encode()
    req = urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{acct}{path}", data=body, method=method,
        headers={"Authorization": f"Bearer {tok}", "Content-Type": ctype, "User-Agent": UA})
    with urllib.request.urlopen(req) as r:
        return json.load(r)

def d1q(sql, params=()):
    r = cf("POST", f"/d1/database/{d1}/query", {"sql": sql, "params": list(params)})
    if not r.get("success"):
        sys.exit(f"D1 error: {r.get('errors')}")
    return r["result"][0]["results"]

manifest = json.load(open(os.path.join(pdir, "dist", "manifest.json")))
pkg = json.load(open(os.path.join(pdir, "package.json")))
version = manifest.get("version") or pkg["version"]
tarballs = glob.glob(os.path.join(pdir, "dist", "*.tar.gz"))
if len(tarballs) != 1:
    sys.exit(f"expected one tarball in dist/, found {tarballs}")
data = open(tarballs[0], "rb").read()
checksum = hashlib.sha256(data).hexdigest()

if d1q("SELECT 1 AS x FROM plugin_versions WHERE plugin_id = ? AND version = ?", (pid, version)):
    print(f"{pid}@{version} already published")
    sys.exit(0)

key = f"{pid}/{version}.tar.gz"
req = urllib.request.Request(
    f"https://api.cloudflare.com/client/v4/accounts/{acct}/r2/buckets/{bucket}/objects/{urllib.parse.quote(key, safe='')}",
    data=data, method="PUT",
    headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/gzip", "User-Agent": UA})
urllib.request.urlopen(req).read()

caps = json.dumps(manifest.get("capabilities") or [])
keywords = json.dumps(pkg.get("keywords") or manifest.get("keywords") or [])
d1q("""INSERT INTO plugins (id, name, description, author_id, repository_url, homepage_url, license, capabilities, keywords)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
         capabilities = excluded.capabilities, keywords = excluded.keywords, updated_at = datetime('now')""",
    (pid, manifest.get("name") or pkg.get("name") or pid, manifest.get("description") or pkg.get("description") or "",
     author, "https://github.com/MahmoodKhalil57/premium-cms-plugins", "https://premium-cms.com",
     manifest.get("license") or pkg.get("license") or "MIT", caps, keywords))
vid = hashlib.sha1(f"{pid}@{version}".encode()).hexdigest()[:26].upper()
d1q("""INSERT INTO plugin_versions (id, plugin_id, version, min_emdash_version, bundle_key, bundle_size, checksum, capabilities, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published')""",
    (vid, pid, version, manifest.get("minEmdashVersion") or min_v, key, len(data), checksum, caps))
print(f"published {pid}@{version} ({len(data)} bytes, sha256 {checksum[:12]}…)")
EOF
