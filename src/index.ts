import { program } from 'commander';
import { resolve, join, relative } from 'path';
import { existsSync, readdirSync, statSync } from 'fs';
import { buildProject, SKIP_DIRS } from './scanner.js';
import { extractQueries } from './parser.js';
import { loadIndexes } from './indexLoader.js';
import { matchIndexes } from './matcher.js';
import { printReport } from './reporter.js';
import { purgeUnusedIndexes } from './purger.js';

/** Walk one level deep to find firestore.indexes.json */
function findIndexesFile(root: string): string | null {
  const direct = resolve(root, 'firestore.indexes.json');
  if (existsSync(direct)) return direct;

  try {
    for (const entry of readdirSync(root)) {
      if (SKIP_DIRS.has(entry)) continue;
      const sub = resolve(root, entry);
      try {
        if (statSync(sub).isDirectory()) {
          const candidate = resolve(sub, 'firestore.indexes.json');
          if (existsSync(candidate)) return candidate;
          // One more level (e.g. functions/src/../firestore.indexes.json)
          const parent = resolve(sub, '..', 'firestore.indexes.json');
          if (existsSync(parent) && parent !== direct) return parent;
        }
      } catch { continue; }
    }
  } catch { /* ignore */ }

  return null;
}

program
  .name('firestore-index-analyzer')
  .description(
    'Find unused Firestore composite indexes by scanning TypeScript source files\n' +
    'and comparing extracted queries against firestore.indexes.json.',
  )
  .option(
    '--root <path>',
    'Root of the project to scan (default: current working directory)',
    process.cwd(),
  )
  .option(
    '--scan <dirs>',
    'Comma-separated directories to scan, relative to --root. ' +
    'Defaults to scanning the entire --root.',
  )
  .option(
    '--indexes <path>',
    'Path to firestore.indexes.json. Auto-discovered if not provided.',
  )
  .option(
    '--output <path>',
    'Where to write report.md',
    join(process.cwd(), 'report.md'),
  )
  .option('--dangerously-purge', 'Remove unused indexes from firestore.indexes.json in place', false)
  .option('--verbose', 'Show matched queries for each used index', false)
  .parse(process.argv);

const opts = program.opts<{
  root: string;
  scan?: string;
  indexes?: string;
  output: string;
  dangerouslyPurge: boolean;
  verbose: boolean;
}>();

const root = resolve(opts.root);

if (!existsSync(root)) {
  console.error(`Root directory not found: ${root}`);
  process.exit(1);
}

// Resolve which directories to scan.
// Paths in --scan are resolved relative to CWD (same as how you'd type them in a shell).
const scanDirs: string[] = opts.scan
  ? opts.scan.split(',').map(d => resolve(d.trim()))
  : [root];

for (const dir of scanDirs) {
  if (!existsSync(dir)) {
    console.error(`Scan directory not found: ${dir}`);
    process.exit(1);
  }
}

// Resolve firestore.indexes.json path
let indexesPath: string;
if (opts.indexes) {
  indexesPath = resolve(opts.indexes);
} else {
  const found = findIndexesFile(root);
  if (!found) {
    console.error('Could not find firestore.indexes.json. Use --indexes <path> to specify it.');
    process.exit(1);
  }
  indexesPath = found;
}

if (!existsSync(indexesPath)) {
  console.error(`firestore.indexes.json not found: ${indexesPath}`);
  process.exit(1);
}

const relIndexesPath = relative(root, indexesPath);
const dirsLabel = scanDirs.length === 1 && scanDirs[0] === root
  ? root
  : scanDirs.map(d => relative(root, d)).join(', ');

console.log(`\nfirestore-index-analyzer`);
console.log(`  indexes : ${relIndexesPath}`);
console.log(`  scanning: ${dirsLabel}\n`);

const { project, totalFiles, dirStats } = buildProject(scanDirs);
console.log(`Loaded ${totalFiles} TypeScript files`);

console.log('Extracting Firestore queries ...');
const queries = extractQueries(project);
console.log(`Found ${queries.length} queries`);

console.log('Loading indexes ...');
const { indexes } = loadIndexes(indexesPath);

console.log('Matching ...\n');
const results = matchIndexes(indexes, queries);

printReport(results, queries, totalFiles, dirStats, opts.verbose, opts.output);

if (opts.dangerouslyPurge) {
  purgeUnusedIndexes(indexesPath, results);
}
