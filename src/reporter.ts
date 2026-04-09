import { writeFileSync } from 'fs';
import { relative } from 'path';
import chalk from 'chalk';
import type { MatchResult, ExtractedQuery, IndexEntry } from './types.js';
import type { DirStat } from './scanner.js';

function formatIndexFields(result: MatchResult): string {
  return result.index.fields
    .map(f => {
      if (f.arrayConfig) return `${f.fieldPath} ARRAY`;
      const dir = f.order?.toLowerCase() === 'descending' ? 'DESC' : 'ASC';
      return `${f.fieldPath} ${dir}`;
    })
    .join(', ');
}

function formatQuerySummary(q: ExtractedQuery): string {
  const parts: string[] = [];
  for (const w of q.whereClauses) parts.push(`where(${w.field} ${w.op})`);
  for (const o of q.orderByClauses) parts.push(`orderBy(${o.field} ${o.dir})`);
  const rel = q.sourceFile.split('/wideworlds-')[1] ?? q.sourceFile;
  return `    ${parts.join(', ')}  ← ${rel}:${q.sourceLine}`;
}

/** Reconstruct the compact JSON snippet for an index as it appears in firestore.indexes.json */
function indexToJson(index: IndexEntry): string {
  const obj = {
    collectionGroup: index.collectionGroup,
    queryScope: index.queryScope,
    fields: index.fields.map(f => {
      if (f.arrayConfig) return { fieldPath: f.fieldPath, arrayConfig: f.arrayConfig };
      return { fieldPath: f.fieldPath, order: f.order ?? 'ASCENDING' };
    }),
  };
  return JSON.stringify(obj);
}

/** Relative path from root, falling back to stripping common wideworlds- prefix */
function shortPath(filePath: string): string {
  const m = filePath.match(/\/(wideworlds[^/].*)/);
  return m ? m[1] : filePath;
}

export function printReport(
  results: MatchResult[],
  allQueries: ExtractedQuery[],
  totalFiles: number,
  dirStats: DirStat[],
  verbose: boolean,
  outputPath: string,
): void {
  const used = results.filter(r => r.status === 'used');
  const unused = results.filter(r => r.status === 'unused');

  // Build collection → source files map from ALL extracted queries
  const collectionFiles = new Map<string, Set<string>>();
  for (const q of allQueries) {
    if (!collectionFiles.has(q.collection)) collectionFiles.set(q.collection, new Set());
    collectionFiles.get(q.collection)!.add(q.sourceFile);
  }

  // ── Terminal ────────────────────────────────────────────────────────────
  console.log(chalk.dim('─'.repeat(60)));
  console.log(
    `Scanned ${chalk.cyan(totalFiles)} files  ·  ${chalk.cyan(results.length)} indexes  ·  ${chalk.cyan(allQueries.length)} queries extracted`,
  );
  console.log('');
  console.log(`  ${chalk.green('●')} USED   ${String(used.length).padStart(4)}   covered by at least 1 query`);
  console.log(`  ${chalk.red('●')} UNUSED ${String(unused.length).padStart(4)}   no matching query found`);
  console.log('');

  if (unused.length > 0) {
    console.log(chalk.bold.red(`UNUSED INDEXES (${unused.length})`));
    console.log(chalk.dim('  Review the files below before removing any index.\n'));

    // Group by collection
    const byCollection = new Map<string, MatchResult[]>();
    for (const r of unused) {
      const key = r.index.collectionGroup;
      if (!byCollection.has(key)) byCollection.set(key, []);
      byCollection.get(key)!.push(r);
    }

    for (const [collection, items] of [...byCollection.entries()].sort()) {
      const files = [...(collectionFiles.get(collection) ?? [])].sort();
      const scope = items[0].index.queryScope === 'COLLECTION_GROUP' ? chalk.dim(' [group]') : '';

      console.log(chalk.yellow(`  ── ${collection} (${items.length})${scope}`));

      if (files.length > 0) {
        console.log(chalk.dim('  Files to review:'));
        for (const f of files) {
          console.log(chalk.dim(`    → ${shortPath(f)}`));
        }
      } else {
        console.log(chalk.dim('  (no query files found for this collection)'));
      }

      console.log('');
      for (const item of items) {
        console.log(`  ${chalk.red(indexToJson(item.index))}`);
      }
      console.log('');
    }
  }

  if (verbose && used.length > 0) {
    console.log(chalk.bold.green(`USED INDEXES (${used.length})`));
    console.log('');
    for (const r of used) {
      console.log(`  ${chalk.green(r.index.collectionGroup)}`);
      console.log(`    [${formatIndexFields(r)}]`);
      for (const q of r.matchedQueries.slice(0, 3)) {
        console.log(formatQuerySummary(q));
      }
      if (r.matchedQueries.length > 3) {
        console.log(chalk.dim(`    … and ${r.matchedQueries.length - 3} more`));
      }
    }
    console.log('');
  }

  if (unused.length > 0) {
    console.log(chalk.dim(`Run with --dangerously-purge to remove ${unused.length} indexes from firestore.indexes.json`));
  } else {
    console.log(chalk.green('No unused indexes found.'));
  }

  console.log(chalk.dim(`Report written to ${outputPath}`));
  console.log('');

  // ── Markdown file ───────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push('# Firestore Index Analysis Report');
  lines.push('');
  lines.push(`**Scanned:** ${totalFiles} files · ${results.length} indexes · ${allQueries.length} queries extracted`);
  lines.push('');
  lines.push(`| Status | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Used   | ${used.length} |`);
  lines.push(`| Unused | ${unused.length} |`);
  lines.push('');

  if (unused.length > 0) {
    lines.push('## Unused Indexes');
    lines.push('');
    lines.push('Review the files listed under each collection before removing any index.');
    lines.push('');

    const byCollection = new Map<string, MatchResult[]>();
    for (const r of unused) {
      const key = r.index.collectionGroup;
      if (!byCollection.has(key)) byCollection.set(key, []);
      byCollection.get(key)!.push(r);
    }

    for (const [collection, items] of [...byCollection.entries()].sort()) {
      const files = [...(collectionFiles.get(collection) ?? [])].sort();
      const scope = items[0].index.queryScope === 'COLLECTION_GROUP' ? ' *(collectionGroup)*' : '';

      lines.push(`### ${collection}${scope} — ${items.length} unused`);
      lines.push('');

      if (files.length > 0) {
        lines.push('**Files to review:**');
        for (const f of files) lines.push(`- \`${shortPath(f)}\``);
        lines.push('');
      }

      lines.push('**Indexes to remove:**');
      lines.push('```json');
      for (const item of items) {
        lines.push(indexToJson(item.index));
      }
      lines.push('```');
      lines.push('');
    }
  }

  if (verbose && used.length > 0) {
    lines.push('## Used Indexes');
    lines.push('');
    lines.push('| Collection | Fields | Matched Queries |');
    lines.push('|------------|--------|-----------------|');
    for (const r of used) {
      const fields = formatIndexFields(r);
      lines.push(`| ${r.index.collectionGroup} | ${fields} | ${r.matchedQueries.length} |`);
    }
    lines.push('');
  }

  writeFileSync(outputPath, lines.join('\n'), 'utf-8');
}
