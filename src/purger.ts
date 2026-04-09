import { readFileSync, writeFileSync } from 'fs';
import chalk from 'chalk';
import type { MatchResult } from './types.js';

export function purgeUnusedIndexes(indexesPath: string, results: MatchResult[]): number {
  const unusedOriginalIndexes = new Set(
    results
      .filter(r => r.status === 'unused')
      .map(r => r.index._originalIndex),
  );

  if (unusedOriginalIndexes.size === 0) {
    console.log(chalk.green('Nothing to purge — all indexes are in use.'));
    return 0;
  }

  // Re-read to preserve original formatting as much as possible
  const content = readFileSync(indexesPath, 'utf-8');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = JSON.parse(content) as Record<string, any>;

  const originalCount = Array.isArray(raw.indexes) ? raw.indexes.length : 0;

  raw.indexes = (raw.indexes as unknown[]).filter(
    (_: unknown, i: number) => !unusedOriginalIndexes.has(i),
  );

  const newCount = raw.indexes.length;
  const removed = originalCount - newCount;

  writeFileSync(indexesPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');

  console.log(chalk.green(`Purged ${removed} unused indexes from ${indexesPath}`));
  console.log(chalk.dim(`  Before: ${originalCount} indexes`));
  console.log(chalk.dim(`  After:  ${newCount} indexes`));

  return removed;
}
