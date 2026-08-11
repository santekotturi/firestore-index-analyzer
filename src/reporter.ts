import { writeFileSync } from 'fs';
import { relative } from 'path';
import chalk from 'chalk';
import type { MatchResult, ExtractedQuery, IndexEntry, IndexStatus } from './types.js';
import type { DirStat } from './scanner.js';

function formatIndexFields(index: IndexEntry): string {
  return index.fields
    .map(f => {
      if (f.arrayConfig) return `${f.fieldPath} ARRAY`;
      const dir = f.order?.toLowerCase() === 'descending' ? 'DESC' : 'ASC';
      return `${f.fieldPath} ${dir}`;
    })
    .join(', ');
}

function formatQuerySummary(q: ExtractedQuery, root: string): string {
  const parts: string[] = [];
  for (const w of q.whereClauses) parts.push(`where(${w.field} ${w.op})`);
  for (const o of q.orderByClauses) parts.push(`orderBy(${o.field} ${o.dir})`);
  for (const w of q.conditionalWhereClauses ?? []) parts.push(`?where(${w.field} ${w.op})`);
  for (const o of q.conditionalOrderByClauses ?? []) parts.push(`?orderBy(${o.field} ${o.dir})`);
  return `${parts.join(', ')}  ← ${shortPath(q.sourceFile, root)}:${q.sourceLine}`;
}

/** Compact JSON snippet for an index as it appears in firestore.indexes.json */
function indexToJson(index: IndexEntry): string {
  const obj = {
    collectionGroup: index.collectionGroup,
    queryScope: index.queryScope,
    fields: index.fields,
  };
  return JSON.stringify(obj);
}

function shortPath(filePath: string, root: string): string {
  const rel = relative(root, filePath);
  return rel.startsWith('..') ? filePath : rel;
}

function groupByCollection(results: MatchResult[]): Map<string, MatchResult[]> {
  const byCollection = new Map<string, MatchResult[]>();
  for (const r of results) {
    const key = r.index.collectionGroup;
    if (!byCollection.has(key)) byCollection.set(key, []);
    byCollection.get(key)!.push(r);
  }
  return byCollection;
}

export function printReport(
  results: MatchResult[],
  allQueries: ExtractedQuery[],
  totalFiles: number,
  dirStats: DirStat[],
  verbose: boolean,
  outputPath: string,
  root: string,
): void {
  const byStatus: Record<IndexStatus, MatchResult[]> = {
    used: results.filter(r => r.status === 'used'),
    unverified: results.filter(r => r.status === 'unverified'),
    unused: results.filter(r => r.status === 'unused'),
  };

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
  console.log(`  ${chalk.green('●')} USED       ${String(byStatus.used.length).padStart(4)}   covered by at least 1 extracted query`);
  console.log(`  ${chalk.yellow('●')} UNVERIFIED ${String(byStatus.unverified.length).padStart(4)}   collection referenced in code, but no matching query parsed — review by hand`);
  console.log(`  ${chalk.red('●')} UNUSED     ${String(byStatus.unused.length).padStart(4)}   collection never referenced in any scanned repo`);
  console.log('');

  for (const status of ['unused', 'unverified'] as const) {
    const items = byStatus[status];
    if (items.length === 0) continue;
    const color = status === 'unused' ? chalk.red : chalk.yellow;
    console.log(color.bold(`${status.toUpperCase()} INDEXES (${items.length})`));
    console.log('');

    for (const [collection, group] of [...groupByCollection(items).entries()].sort()) {
      const scope = group[0].index.queryScope === 'COLLECTION_GROUP' ? chalk.dim(' [group]') : '';
      console.log(chalk.yellow(`  ── ${collection} (${group.length})${scope}`));

      const files = [...(collectionFiles.get(collection) ?? [])].sort();
      if (files.length > 0) {
        console.log(chalk.dim('  Query files (parsed but none matched these indexes):'));
        for (const f of files.slice(0, 8)) console.log(chalk.dim(`    → ${shortPath(f, root)}`));
        if (files.length > 8) console.log(chalk.dim(`    … and ${files.length - 8} more`));
      }

      for (const item of group) {
        console.log(`  ${color(indexToJson(item.index))} ${chalk.dim(`[${item.index.sources.join(', ')}]`)}`);
      }
      console.log('');
    }
  }

  if (verbose && byStatus.used.length > 0) {
    console.log(chalk.bold.green(`USED INDEXES (${byStatus.used.length})`));
    console.log('');
    for (const r of byStatus.used) {
      console.log(`  ${chalk.green(r.index.collectionGroup)}  ${chalk.dim(`[${r.index.sources.join(', ')}]`)}`);
      console.log(`    [${formatIndexFields(r.index)}]`);
      for (const q of r.matchedQueries.slice(0, 3)) {
        console.log(`    ${formatQuerySummary(q, root)}`);
      }
      if (r.matchedQueries.length > 3) {
        console.log(chalk.dim(`    … and ${r.matchedQueries.length - 3} more`));
      }
    }
    console.log('');
  }

  if (byStatus.unused.length > 0) {
    console.log(chalk.dim(`Run with --dangerously-purge to remove the ${byStatus.unused.length} UNUSED indexes from file sources`));
  }
  console.log(chalk.dim(`Report written to ${outputPath}`));
  console.log('');

  // ── Markdown file ───────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push('# Firestore Index Analysis Report');
  lines.push('');
  lines.push(`**Scanned:** ${totalFiles} files · ${results.length} indexes · ${allQueries.length} queries extracted`);
  lines.push('');
  for (const d of dirStats) lines.push(`- \`${d.dir}\` — ${d.files} files`);
  lines.push('');
  lines.push(`| Status | Count | Meaning |`);
  lines.push(`|--------|-------|---------|`);
  lines.push(`| Used | ${byStatus.used.length} | covered by at least 1 extracted query |`);
  lines.push(`| Unverified | ${byStatus.unverified.length} | collection referenced in code, but no matching query parsed — review by hand |`);
  lines.push(`| Unused | ${byStatus.unused.length} | collection never referenced in any scanned repo — safe to delete |`);
  lines.push('');

  for (const status of ['unused', 'unverified'] as const) {
    const items = byStatus[status];
    if (items.length === 0) continue;
    lines.push(`## ${status === 'unused' ? 'Unused' : 'Unverified'} Indexes (${items.length})`);
    lines.push('');
    lines.push(status === 'unused'
      ? 'The collection name never appears in any scanned source file.'
      : 'The collection IS referenced in code, but no parseable query matched these exact indexes. Review by hand before deleting.');
    lines.push('');

    for (const [collection, group] of [...groupByCollection(items).entries()].sort()) {
      const scope = group[0].index.queryScope === 'COLLECTION_GROUP' ? ' *(collectionGroup)*' : '';
      lines.push(`### ${collection}${scope} — ${group.length} ${status}`);
      lines.push('');

      const files = [...(collectionFiles.get(collection) ?? [])].sort();
      if (files.length > 0) {
        lines.push('**Query files (parsed but none matched these indexes):**');
        for (const f of files) lines.push(`- \`${shortPath(f, root)}\``);
        lines.push('');
      }

      lines.push('```json');
      for (const item of group) lines.push(indexToJson(item.index));
      lines.push('```');
      lines.push(`Sources: ${[...new Set(group.flatMap(g => g.index.sources))].join(', ')}`);
      lines.push('');
    }
  }

  if (byStatus.used.length > 0) {
    lines.push(`## Used Indexes (${byStatus.used.length})`);
    lines.push('');
    lines.push('| Collection | Fields | Sources | Matched Queries | Example |');
    lines.push('|------------|--------|---------|-----------------|---------|');
    for (const r of byStatus.used) {
      const example = r.matchedQueries[0]
        ? `\`${shortPath(r.matchedQueries[0].sourceFile, root)}:${r.matchedQueries[0].sourceLine}\``
        : '';
      lines.push(`| ${r.index.collectionGroup} | ${formatIndexFields(r.index)} | ${r.index.sources.join(', ')} | ${r.matchedQueries.length} | ${example} |`);
    }
    lines.push('');
  }

  writeFileSync(outputPath, lines.join('\n'), 'utf-8');
}
