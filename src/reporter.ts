import { writeFileSync } from 'fs';
import { resolve } from 'path';
import chalk from 'chalk';
import type { MatchResult, ExtractedQuery } from './types.js';
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

export function printReport(
  results: MatchResult[],
  totalFiles: number,
  totalQueries: number,
  dirStats: DirStat[],
  verbose: boolean,
  outputPath: string,
): void {
  const used = results.filter(r => r.status === 'used');
  const unused = results.filter(r => r.status === 'unused');

  // ── Terminal ────────────────────────────────────────────────────────────
  console.log(chalk.dim('─'.repeat(50)));
  console.log(`Scanned ${chalk.cyan(totalFiles)} files  ·  ${chalk.cyan(results.length)} indexes  ·  ${chalk.cyan(totalQueries)} queries extracted`);
  console.log('');
  console.log(`  ${chalk.green('●')} USED   ${String(used.length).padStart(4)}   covered by at least 1 query`);
  console.log(`  ${chalk.red('●')} UNUSED ${String(unused.length).padStart(4)}   no matching query found`);
  console.log('');

  if (unused.length > 0) {
    console.log(chalk.bold.red(`UNUSED INDEXES (${unused.length})`));
    console.log('');

    // Group by collection
    const byCollection = new Map<string, MatchResult[]>();
    for (const r of unused) {
      const key = r.index.collectionGroup;
      if (!byCollection.has(key)) byCollection.set(key, []);
      byCollection.get(key)!.push(r);
    }

    for (const [collection, items] of [...byCollection.entries()].sort()) {
      console.log(chalk.yellow(`  ${collection}`));
      for (const item of items) {
        const scope = item.index.queryScope === 'COLLECTION_GROUP' ? chalk.dim(' [group]') : '';
        console.log(`    [${formatIndexFields(item)}]${scope}`);
      }
    }
    console.log('');
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
    console.log(chalk.dim(`Run with --purge to remove ${unused.length} indexes from firestore.indexes.json`));
  } else {
    console.log(chalk.green('No unused indexes found.'));
  }

  console.log(chalk.dim(`Report written to ${outputPath}`));
  console.log('');

  // ── Markdown file ───────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push('# Firestore Index Analysis Report');
  lines.push('');
  lines.push(`**Scanned:** ${totalFiles} files · ${results.length} indexes · ${totalQueries} queries extracted`);
  lines.push('');
  lines.push(`| Status | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Used   | ${used.length} |`);
  lines.push(`| Unused | ${unused.length} |`);
  lines.push('');

  if (unused.length > 0) {
    lines.push('## Unused Indexes');
    lines.push('');
    lines.push('These indexes have no matching queries in the codebase and can be safely removed.');
    lines.push('');
    lines.push('| Collection | Fields | Scope |');
    lines.push('|------------|--------|-------|');
    for (const r of unused) {
      const fields = formatIndexFields(r);
      const scope = r.index.queryScope === 'COLLECTION_GROUP' ? 'collectionGroup' : 'collection';
      lines.push(`| ${r.index.collectionGroup} | ${fields} | ${scope} |`);
    }
    lines.push('');
  }

  if (verbose && used.length > 0) {
    lines.push('## Used Indexes');
    lines.push('');
    lines.push('| Collection | Fields | Matched Queries |');
    lines.push('|------------|--------|-----------------|');
    for (const r of used) {
      const fields = formatIndexFields(r);
      const qCount = r.matchedQueries.length;
      lines.push(`| ${r.index.collectionGroup} | ${fields} | ${qCount} |`);
    }
    lines.push('');
  }

  writeFileSync(outputPath, lines.join('\n'), 'utf-8');
}
