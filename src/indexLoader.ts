import { readFileSync } from 'fs';
import type { IndexEntry, IndexesFile } from './types.js';

export function loadIndexes(indexesPath: string): IndexesFile {
  const content = readFileSync(indexesPath, 'utf-8');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = JSON.parse(content) as Record<string, any>;

  const rawIndexes: Record<string, unknown>[] = Array.isArray(raw.indexes) ? raw.indexes : [];

  const indexes: IndexEntry[] = rawIndexes.map((entry, i) => ({
    collectionGroup: entry.collectionGroup as string,
    queryScope: entry.queryScope as 'COLLECTION' | 'COLLECTION_GROUP',
    fields: entry.fields as IndexEntry['fields'],
    _originalIndex: i,
  }));

  return { indexes, _raw: raw };
}
