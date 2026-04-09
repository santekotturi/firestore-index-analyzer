import { Project } from 'ts-morph';
import { resolve } from 'path';
import { readdirSync, statSync } from 'fs';

export const SKIP_DIRS = new Set([
  'node_modules', '.next', 'dist', 'build', '.git',
  '__pycache__', '.turbo', 'coverage', '.cache', 'out',
]);

function walkDir(dir: string): string[] {
  const results: string[] = [];
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
      results.push(...walkDir(fullPath));
    } else if (
      (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) &&
      !fullPath.endsWith('.d.ts')
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
  project: Project;
  totalFiles: number;
  dirStats: DirStat[];
}

/**
 * Build a ts-morph Project from the given list of directories.
 * Each entry in `scanDirs` is an absolute path to scan recursively.
 */
export function buildProject(scanDirs: string[]): ScanResult {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: {
      skipLibCheck: true,
      allowJs: false,
      noEmit: true,
    },
  });

  const dirStats: DirStat[] = [];
  let totalFiles = 0;

  for (const dir of scanDirs) {
    const files = walkDir(dir);
    for (const f of files) {
      try {
        project.addSourceFileAtPath(f);
      } catch {
        // skip files that fail to parse (generated, malformed, etc.)
      }
    }
    dirStats.push({ dir, files: files.length });
    totalFiles += files.length;
  }

  return { project, totalFiles, dirStats };
}
