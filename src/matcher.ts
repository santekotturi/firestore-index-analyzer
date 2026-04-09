import type { ExtractedQuery, IndexEntry, IndexStatus, MatchResult } from './types.js';

const INEQUALITY_OPS = new Set(['!=', '<', '<=', '>', '>=', 'not-in']);
const ARRAY_OPS = new Set(['array-contains', 'array-contains-any']);

/**
 * Returns true if this query requires a composite Firestore index.
 * Single-field equality or single-field orderBy queries use auto-indexes.
 */
function queryNeedsIndex(query: ExtractedQuery): boolean {
  const { whereClauses, orderByClauses } = query;

  // No filters, at most one orderBy → no composite index
  if (whereClauses.length === 0 && orderByClauses.length <= 1) return false;

  // Single equality filter, no orderBy → no composite index
  if (whereClauses.length === 1 && orderByClauses.length === 0) {
    const op = whereClauses[0].op;
    if (op === '==' || op === 'in') return false;
  }

  // Multiple filters → composite index
  if (whereClauses.length > 1) return true;

  // Any filter + any orderBy → composite index
  if (whereClauses.length >= 1 && orderByClauses.length >= 1) return true;

  // Multiple orderBy fields → composite index
  if (whereClauses.length === 0 && orderByClauses.length > 1) return true;

  // array-contains/array-contains-any on its own needs an index
  if (whereClauses.length === 1 && ARRAY_OPS.has(whereClauses[0].op)) return true;

  // Inequality filter on its own is single-field — uses auto-index
  // (but combined with anything else would have been caught above)

  return false;
}

/**
 * Returns true if `index` could cover `query` — i.e., the index contains
 * all the fields the query requires, in a compatible order.
 *
 * Uses a permissive check: if all query fields are present in the index,
 * we consider it a match. This errs on the side of keeping indexes (conservative).
 */
function indexCoversQuery(index: IndexEntry, query: ExtractedQuery): boolean {
  // Collection group must match exactly
  if (index.collectionGroup !== query.collection) return false;

  // Collection-group queries need COLLECTION_GROUP scope
  if (query.isCollectionGroup && index.queryScope !== 'COLLECTION_GROUP') return false;

  const indexFields = index.fields.map(f => f.fieldPath);
  const indexFieldSet = new Set(indexFields);

  // Every where-clause field must exist in the index
  for (const wc of query.whereClauses) {
    if (!indexFieldSet.has(wc.field)) return false;
  }

  // Every orderBy field must exist in the index
  for (const ob of query.orderByClauses) {
    if (!indexFieldSet.has(ob.field)) return false;
  }

  // Check orderBy direction where the index specifies one
  for (const ob of query.orderByClauses) {
    const indexField = index.fields.find(f => f.fieldPath === ob.field);
    if (indexField?.order) {
      const indexDir = indexField.order.toLowerCase() === 'descending' ? 'desc' : 'asc';
      if (indexDir !== ob.dir) return false;
    }
  }

  // OrderBy fields must appear in order relative to each other in the index
  if (query.orderByClauses.length > 1) {
    const orderByPositions = query.orderByClauses.map(ob => indexFields.indexOf(ob.field));
    for (let i = 1; i < orderByPositions.length; i++) {
      if (orderByPositions[i] <= orderByPositions[i - 1]) return false;
    }
  }

  return true;
}

export function matchIndexes(
  indexes: IndexEntry[],
  queries: ExtractedQuery[],
): MatchResult[] {
  // Only consider queries that actually need a composite index
  const indexableQueries = queries.filter(queryNeedsIndex);

  return indexes.map(index => {
    const matchedQueries = indexableQueries.filter(q => indexCoversQuery(index, q));
    const status: IndexStatus = matchedQueries.length > 0 ? 'used' : 'unused';
    return { index, status, matchedQueries };
  });
}
