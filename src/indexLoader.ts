import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { basename, dirname } from 'path';
import type { IndexEntry, IndexField, FieldOverrideEntry, LoadedIndexes } from './types.js';

/** Tolerate trailing commas — real-world index files have them. */
function parseJsonTolerant(content: string): Record<string, unknown> {
  try {
    return JSON.parse(content);
  } catch {
    return JSON.parse(content.replace(/,\s*([\]}])/g, '$1'));
  }
}

function normalizeOrder(order: string | undefined): string {
  return (order ?? 'ASCENDING').toUpperCase().startsWith('DESC') ? 'DESCENDING' : 'ASCENDING';
}

/**
 * Normalize an index's fields:
 * - uppercase order values
 * - strip a trailing `__name__` field when its direction is the default
 *   (matches the direction of the last ordered field). Live dumps from the
 *   Firestore API include this implicit field; repo files usually don't.
 */
export function normalizeFields(rawFields: IndexField[]): IndexField[] {
  let fields = rawFields.map(f => {
    if (f.arrayConfig) return { fieldPath: f.fieldPath, arrayConfig: f.arrayConfig };
    return { fieldPath: f.fieldPath, order: normalizeOrder(f.order) };
  });

  const last = fields[fields.length - 1];
  if (last && last.fieldPath === '__name__' && !last.arrayConfig) {
    // Default direction of the implicit __name__ field = direction of the
    // last ordered field before it (ASCENDING if there is none).
    let defaultDir = 'ASCENDING';
    for (let i = fields.length - 2; i >= 0; i--) {
      if (fields[i].order) { defaultDir = fields[i].order!; break; }
    }
    if (last.order === defaultDir) fields = fields.slice(0, -1);
  }

  return fields;
}

export function indexKey(collectionGroup: string, queryScope: string, fields: IndexField[]): string {
  const fieldsKey = fields
    .map(f => (f.arrayConfig ? `${f.fieldPath}:CONTAINS` : `${f.fieldPath}:${f.order}`))
    .join(',');
  return `${collectionGroup}|${queryScope}|${fieldsKey}`;
}

interface RawSource {
  label: string;
  filePath?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: Record<string, any>;
}

function loadFileSource(spec: string): RawSource {
  const eq = spec.indexOf('=');
  const [label, filePath] = eq > 0
    ? [spec.slice(0, eq), spec.slice(eq + 1)]
    : [labelFromPath(spec), spec];
  const raw = parseJsonTolerant(readFileSync(filePath, 'utf-8'));
  return { label, filePath, raw };
}

function labelFromPath(filePath: string): string {
  const base = basename(filePath);
  if (base === 'firestore.indexes.json') return basename(dirname(filePath));
  return base.replace(/\.json$/, '');
}

function fetchLiveSource(projectId: string): RawSource {
  const output = execSync(
    `firebase firestore:indexes --json --project=${projectId}`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = parseJsonTolerant(output);
  // The CLI wraps the payload in { status, result }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (parsed as any).result ?? parsed;
  return { label: `live:${projectId}`, raw };
}

/**
 * Load and merge indexes from file specs (`label=path` or bare paths) and
 * live Firebase projects. Entries identical after normalization are deduped,
 * accumulating the labels of every source that declares them.
 */
export function loadIndexSources(fileSpecs: string[], projectIds: string[]): LoadedIndexes {
  const sources: RawSource[] = [
    ...fileSpecs.map(loadFileSource),
    ...projectIds.map(fetchLiveSource),
  ];

  const indexByKey = new Map<string, IndexEntry>();
  const overrideByKey = new Map<string, FieldOverrideEntry>();
  const filePathByLabel = new Map<string, string>();

  for (const source of sources) {
    if (source.filePath) filePathByLabel.set(source.label, source.filePath);

    const rawIndexes: Record<string, unknown>[] = Array.isArray(source.raw.indexes)
      ? source.raw.indexes
      : [];

    for (const entry of rawIndexes) {
      const collectionGroup = entry.collectionGroup as string;
      const queryScope = (entry.queryScope as string) ?? 'COLLECTION';
      const fields = normalizeFields((entry.fields ?? []) as IndexField[]);
      const key = indexKey(collectionGroup, queryScope, fields);

      const existing = indexByKey.get(key);
      if (existing) {
        if (!existing.sources.includes(source.label)) existing.sources.push(source.label);
      } else {
        indexByKey.set(key, {
          collectionGroup,
          queryScope: queryScope as IndexEntry['queryScope'],
          fields,
          key,
          sources: [source.label],
        });
      }
    }

    const rawOverrides: Record<string, unknown>[] = Array.isArray(source.raw.fieldOverrides)
      ? source.raw.fieldOverrides
      : [];

    for (const entry of rawOverrides) {
      const collectionGroup = entry.collectionGroup as string;
      const fieldPath = entry.fieldPath as string;
      const key = `${collectionGroup}|${fieldPath}`;
      const existing = overrideByKey.get(key);
      if (existing) {
        if (!existing.sources.includes(source.label)) existing.sources.push(source.label);
      } else {
        overrideByKey.set(key, {
          collectionGroup,
          fieldPath,
          raw: entry,
          sources: [source.label],
        });
      }
    }
  }

  return {
    indexes: [...indexByKey.values()],
    fieldOverrides: [...overrideByKey.values()],
    sourceLabels: sources.map(s => s.label),
    filePathByLabel,
  };
}
