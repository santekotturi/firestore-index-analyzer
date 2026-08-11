import { readFileSync, writeFileSync } from 'fs';
import chalk from 'chalk';
import type { MatchResult, IndexField } from './types.js';
import { normalizeFields, indexKey } from './indexLoader.js';

/**
 * Remove `unused` indexes from the given index FILES (live sources can't be
 * purged from here — deploy the purged file instead). Entries are matched by
 * normalized key, so formatting differences and implicit __name__ suffixes
 * don't matter. Only `unused` (collection never referenced in any scanned
 * repo) is ever purged; `unverified` requires human review.
 */
export function purgeUnusedIndexes(
  filePathByLabel: Map<string, string>,
  results: MatchResult[],
): number {
  const unusedKeys = new Set(
    results.filter(r => r.status === 'unused').map(r => r.index.key),
  );

  if (unusedKeys.size === 0) {
    console.log(chalk.green('Nothing to purge — no unused indexes.'));
    return 0;
  }

  let totalRemoved = 0;

  for (const [label, filePath] of filePathByLabel) {
    const content = readFileSync(filePath, 'utf-8');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let raw: Record<string, any>;
    try {
      raw = JSON.parse(content);
    } catch {
      raw = JSON.parse(content.replace(/,\s*([\]}])/g, '$1'));
    }

    if (!Array.isArray(raw.indexes)) continue;
    const originalCount = raw.indexes.length;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw.indexes = raw.indexes.filter((entry: any) => {
      const fields = normalizeFields((entry.fields ?? []) as IndexField[]);
      const key = indexKey(entry.collectionGroup, entry.queryScope ?? 'COLLECTION', fields);
      return !unusedKeys.has(key);
    });

    const removed = originalCount - raw.indexes.length;
    if (removed > 0) {
      writeFileSync(filePath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
      console.log(chalk.green(`Purged ${removed} unused indexes from ${label} (${filePath})`));
      console.log(chalk.dim(`  Before: ${originalCount}  After: ${raw.indexes.length}`));
      totalRemoved += removed;
    }
  }

  if (totalRemoved === 0) {
    console.log(chalk.yellow('No unused indexes found in any FILE source (live sources are not purgeable).'));
  }

  return totalRemoved;
}
