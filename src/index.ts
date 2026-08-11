import { program } from 'commander';
import { resolve, join } from 'path';
import { existsSync, readdirSync, statSync } from 'fs';
import { collectFiles, SKIP_DIRS } from './scanner.js';
import { extractQueries, buildGlobalConstTable } from './parser.js';
import { loadIndexSources } from './indexLoader.js';
import { matchIndexes, findReferencedCollections } from './matcher.js';
import { printReport } from './reporter.js';
import { purgeUnusedIndexes } from './purger.js';
import { emitMasterFile } from './master.js';

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
        }
      } catch { continue; }
    }
  } catch { /* ignore */ }

  return null;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

program
  .name('firestore-index-analyzer')
  .description(
    'Find unused Firestore composite indexes by scanning TypeScript source files\n' +
    'and comparing extracted queries against one or more index sources\n' +
    '(firestore.indexes.json files and/or live Firebase projects).',
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
    '--indexes <spec>',
    'Index source: a path to firestore.indexes.json, or label=path. Repeatable.',
    collect,
    [] as string[],
  )
  .option(
    '--project <id>',
    'Fetch live indexes from this Firebase project (needs firebase CLI auth). Repeatable.',
    collect,
    [] as string[],
  )
  .option(
    '--output <path>',
    'Where to write report.md',
    join(process.cwd(), 'report.md'),
  )
  .option(
    '--emit-master <path>',
    'Write a unified firestore.indexes.json containing used + unverified indexes',
  )
  .option('--dangerously-purge', 'Remove UNUSED indexes from file sources in place', false)
  .option('--verbose', 'Show matched queries for each used index', false)
  .parse(process.argv);

const opts = program.opts<{
  root: string;
  scan?: string;
  indexes: string[];
  project: string[];
  output: string;
  emitMaster?: string;
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

// Resolve index sources
let fileSpecs = opts.indexes;
if (fileSpecs.length === 0 && opts.project.length === 0) {
  const found = findIndexesFile(root);
  if (!found) {
    console.error('No index sources. Use --indexes <path> (repeatable) and/or --project <id>.');
    process.exit(1);
  }
  fileSpecs = [found];
}

console.log(`\nfirestore-index-analyzer`);
console.log(`  sources : ${[...fileSpecs, ...opts.project.map(p => `live:${p}`)].join(', ')}`);
console.log(`  scanning: ${scanDirs.join(', ')}\n`);

const { files, totalFiles, dirStats, skippedNestedGit } = collectFiles(scanDirs);
console.log(`Collected ${totalFiles} TypeScript files`);
for (const dir of skippedNestedGit) {
  console.log(`  skipped nested worktree/clone: ${dir}`);
}

const globalConsts = buildGlobalConstTable(files);
console.log(`Constant table: ${globalConsts.size} string constants`);

console.log('Extracting Firestore queries ...');
const queries = extractQueries(files, globalConsts, (done, total) => {
  process.stdout.write(`  ${done}/${total} files\r`);
});
console.log(`Found ${queries.length} queries${' '.repeat(20)}`);

console.log('Loading indexes ...');
const loaded = loadIndexSources(fileSpecs, opts.project);
console.log(`Loaded ${loaded.indexes.length} distinct indexes from ${loaded.sourceLabels.length} source(s)`);

console.log('Scanning for raw collection references ...');
const collectionNames = new Set(loaded.indexes.map(i => i.collectionGroup));
const referenced = findReferencedCollections(files, collectionNames);

console.log('Matching ...\n');
const results = matchIndexes(loaded.indexes, queries, referenced);

printReport(results, queries, totalFiles, dirStats, opts.verbose, opts.output, root);

if (opts.emitMaster) {
  emitMasterFile(resolve(opts.emitMaster), results, loaded.fieldOverrides);
}

if (opts.dangerouslyPurge) {
  purgeUnusedIndexes(loaded.filePathByLabel, results);
}
