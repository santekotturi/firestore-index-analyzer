import { resolve, join } from 'path';
import { readdirSync, statSync, existsSync, readFileSync } from 'fs';
import type { FileEntry } from './types.js';

export const SKIP_DIRS = new Set([
  'node_modules', '.next', 'dist', 'build', '.git',
  '__pycache__', '.turbo', 'coverage', '.cache', 'out',
  '.claude', '.vercel', '.firebase', '.ww-cache',
]);

/**
 * A nested `.git` entry means one of:
 *  - a git WORKTREE (`.git` file pointing at .../worktrees/...) — a parallel
 *    checkout of the same repo; scanning it double-counts queries → skip
 *  - a nested full CLONE (`.git` directory) — a separate codebase → skip
 *  - a git SUBMODULE (`.git` file pointing at .../modules/...) — part of THIS
 *    codebase (e.g. a shared types package) → scan it
 */
function shouldSkipNestedGit(dir: string): boolean {
  const gitPath = join(dir, '.git');
  if (!existsSync(gitPath)) return false;
  try {
    if (statSync(gitPath).isDirectory()) return true;
    const content = readFileSync(gitPath, 'utf-8');
    return !content.includes('/modules/');
  } catch {
    return true;
  }
}

/**
 * Recursively collect .ts/.tsx files under `dir`, skipping SKIP_DIRS and
 * nested worktrees/clones (but NOT submodules — see shouldSkipNestedGit).
 */
function walkDir(dir: string, isRoot: boolean, skipped: string[]): string[] {
  const results: string[] = [];

  if (!isRoot && shouldSkipNestedGit(dir)) {
    skipped.push(dir);
    return results;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = resolve(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...walkDir(fullPath, false, skipped));
    } else if (
      /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(fullPath) &&
      !fullPath.endsWith('.d.ts') &&
      !/\.(min|bundle)\.js$/.test(fullPath)
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

export interface DirStat {
  dir: string;
  files: number;
}

export interface ScanResult {
  files: FileEntry[];
  totalFiles: number;
  dirStats: DirStat[];
  /** Nested worktrees/clones that were skipped (submodules are scanned) */
  skippedNestedGit: string[];
}

/**
 * Collect source files (path + content) from the given directories.
 * Contents are read once here and reused for the constant table,
 * AST parsing, and the collection-reference scan.
 */
export function collectFiles(scanDirs: string[]): ScanResult {
  const files: FileEntry[] = [];
  const dirStats: DirStat[] = [];
  const seen = new Set<string>();
  const skippedNestedGit: string[] = [];

  for (const dir of scanDirs) {
    const paths = walkDir(dir, true, skippedNestedGit);
    let count = 0;
    for (const p of paths) {
      if (seen.has(p)) continue;
      seen.add(p);
      try {
        files.push({ path: p, content: readFileSync(p, 'utf-8') });
        count++;
      } catch {
        // unreadable file — skip
      }
    }
    dirStats.push({ dir, files: count });
  }

  return { files, totalFiles: files.length, dirStats, skippedNestedGit };
}
