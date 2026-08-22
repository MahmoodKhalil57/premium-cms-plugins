#!/usr/bin/env bash
# Publish built plugins to the marketplace bucket and upsert marketplace/index.json.
#   bin/publish.sh premium-commerce          one plugin (must be built)
#   bin/publish.sh --all [--prune]           every dist/*; --prune removes index
#                                            entries for plugins no longer in the repo
# env: CF_ACCOUNT_ID, ARTIFACTS_PUBLISH_TOKEN  (R2 bucket platform-artifacts)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$ROOT" "$@" <<'PY'
import glob, hashlib, io, json, os, re, sys, tarfile, time, urllib.parse, urllib.request
root, args = sys.argv[1], sys.argv[2:]
acct = os.environ["CF_ACCOUNT_ID"]; token = os.environ["ARTIFACTS_PUBLISH_TOKEN"]
base = f"https://api.cloudflare.com/client/v4/accounts/{acct}/r2/buckets/platform-artifacts/objects/"
HDR = {"Authorization": f"Bearer {token}", "User-Agent": "premiumcms-publisher/1.0"}
def r2_put(key, data, ctype):
    req = urllib.request.Request(base + urllib.parse.quote(key, safe=""), data=data, method="PUT", headers={**HDR, "Content-Type": ctype})
    with urllib.request.urlopen(req) as r: r.read()
def r2_get(key):
    req = urllib.request.Request(base + urllib.parse.quote(key, safe=""), headers=HDR)
    try:
        with urllib.request.urlopen(req) as r: return r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404: return None
        raise
def jsonc(text):
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S); text = re.sub(r"(?m)^\s*//.*$", "", text); text = re.sub(r"(?m)(?<=\s)//\s.*$", "", text)
    return json.loads(re.sub(r",(\s*[}\]])", r"\1", text))
def publish(pid):
    d = os.path.join(root, "dist", pid)
    manifest_raw = open(os.path.join(d, "manifest.json"), "rb").read(); manifest = json.loads(manifest_raw)
    assert manifest["id"] == pid, f"{pid}: manifest id mismatch"
    files = {"manifest.json": manifest_raw}
    for name in ("backend.js", "admin.js", "README.md"):
        p = os.path.join(d, name)
        if os.path.exists(p): files[name] = open(p, "rb").read()
    meta = jsonc(open(os.path.join(d, "emdash-plugin.jsonc")).read()) if os.path.exists(os.path.join(d, "emdash-plugin.jsonc")) else {}
    version = manifest["version"]
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", compresslevel=9) as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name); info.size = len(data); info.mtime = int(time.time()); tar.addfile(info, io.BytesIO(data))
    tarball = buf.getvalue(); checksum = hashlib.sha256(tarball).hexdigest()
    r2_put(f"marketplace/plugins/{pid}/{version}.tar.gz", tarball, "application/gzip")
    icon = os.path.join(d, "icon.png")
    if os.path.exists(icon): r2_put(f"marketplace/plugins/{pid}/icon.png", open(icon, "rb").read(), "image/png")
    return {"id": pid, "version": version, "size": len(tarball), "checksum": checksum, "manifest": manifest, "meta": meta, "hasIcon": os.path.exists(icon), "readme": files.get("README.md", b"").decode(errors="replace")}
raw = r2_get("marketplace/index.json"); index = json.loads(raw) if raw else {"plugins": []}
ids = [a for a in args if not a.startswith("--")]
if "--all" in args: ids = sorted(os.path.basename(p) for p in glob.glob(os.path.join(root, "dist", "*")) if os.path.exists(os.path.join(p, "manifest.json")))
entries = {p["id"]: p for p in index.get("plugins", [])}
now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
for pid in ids:
    r = publish(pid)
    meta, manifest = r["meta"], r["manifest"]
    entry = entries.get(pid) or {"id": pid, "createdAt": now, "versions": [], "installCount": 0}
    author = meta.get("author") or {}
    entry.update({
        "name": meta.get("name") or pid,
        "description": meta.get("description"),
        "author": {"name": author.get("name") or "PremiumCMS", "verified": True, "avatarUrl": None},
        "capabilities": manifest.get("capabilities", []),
        "keywords": meta.get("keywords", []),
        "license": meta.get("license"),
        "repositoryUrl": (meta.get("repository") or {}).get("url") if isinstance(meta.get("repository"), dict) else meta.get("repository"),
        "homepageUrl": meta.get("homepage"),
        "hasIcon": r["hasIcon"] or entry.get("hasIcon", False),
        "hidden": bool(meta.get("hidden")),
        "updatedAt": now,
    })
    entry["versions"] = [v for v in entry["versions"] if v["version"] != r["version"]] + [{
        "version": r["version"], "bundleSize": r["size"], "checksum": r["checksum"], "publishedAt": now,
        "capabilities": manifest.get("capabilities", []), "readme": r["readme"] or None, "minEmDashVersion": meta.get("minEmDashVersion"),
    }]
    entries[pid] = entry
    print(f"published {pid}@{r['version']}: {r['size']} bytes, sha256 {r['checksum'][:16]}…")
if "--prune" in args:
    repo_ids = {os.path.basename(p) for p in glob.glob(os.path.join(root, "plugins", "*")) if os.path.exists(os.path.join(p, "manifest.json"))}
    for gone in [pid for pid in entries if pid not in repo_ids]:
        del entries[gone]; print(f"pruned {gone} from the catalogue (artifacts kept)")
index["plugins"] = sorted(entries.values(), key=lambda p: p["id"])
r2_put("marketplace/index.json", json.dumps(index, indent=2).encode(), "application/json")
print(f"{len(index['plugins'])} plugin(s) in catalogue")
PY
