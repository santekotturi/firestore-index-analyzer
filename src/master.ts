import { writeFileSync } from 'fs';
import chalk from 'chalk';
import type { MatchResult, FieldOverrideEntry } from './types.js';

/**
 * Emit a unified firestore.indexes.json containing every index with code
 * evidence (`used`) or a raw-text reference (`unverified`), plus the union of
 * all sources' field overrides. This is the reviewable master file meant to
 * replace the per-repo index files.
 */
export function emitMasterFile(
  outPath: string,
  results: MatchResult[],
  fieldOverrides: FieldOverrideEntry[],
): void {
  const kept = results
    .filter(r => r.status !== 'unused')
    .map(r => r.index)
    .sort((a, b) =>
      a.collectionGroup.localeCompare(b.collectionGroup) ||
      a.queryScope.localeCompare(b.queryScope) ||
      a.key.localeCompare(b.key),
    );

  const indexes = kept.map(i => ({
    collectionGroup: i.collectionGroup,
    queryScope: i.queryScope,
    fields: i.fields,
  }));

  const overrides = [...fieldOverrides]
    .sort((a, b) =>
      a.collectionGroup.localeCompare(b.collectionGroup) ||
      a.fieldPath.localeCompare(b.fieldPath),
    )
    .map(o => {
      // Preserve the original override shape, minus any bookkeeping we added
      const { ...raw } = o.raw;
      return raw;
    });

  writeFileSync(
    outPath,
    JSON.stringify({ indexes, fieldOverrides: overrides }, null, 2) + '\n',
    'utf-8',
  );

  const dropped = results.length - kept.length;
  console.log(chalk.green(`Master file written to ${outPath}`));
  console.log(chalk.dim(`  ${indexes.length} indexes kept (used + unverified), ${dropped} unused dropped, ${overrides.length} field overrides`));
}
