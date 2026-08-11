export type FirestoreOp =
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'in'
  | 'not-in'
  | 'array-contains'
  | 'array-contains-any';

export interface WhereClause {
  field: string;
  op: FirestoreOp;
}

export interface OrderByClause {
  field: string;
  dir: 'asc' | 'desc';
}

export interface ExtractedQuery {
  collection: string;
  isCollectionGroup: boolean;
  whereClauses: WhereClause[];
  orderByClauses: OrderByClause[];
  /** Constraints that are conditionally applied (e.g. inside `if` blocks, ternary spreads, .push() in conditionals) */
  conditionalWhereClauses?: WhereClause[];
  conditionalOrderByClauses?: OrderByClause[];
  sourceFile: string;
  sourceLine: number;
}

export interface IndexField {
  fieldPath: string;
  order?: string; // 'ASCENDING' | 'DESCENDING'
  arrayConfig?: string; // 'CONTAINS'
}

export interface IndexEntry {
  collectionGroup: string;
  queryScope: 'COLLECTION' | 'COLLECTION_GROUP';
  /** Normalized fields: uppercase order, default trailing __name__ stripped */
  fields: IndexField[];
  /** Canonical dedup key derived from collectionGroup + queryScope + normalized fields */
  key: string;
  /** Labels of the sources this index came from (e.g. 'live:my-project', 'fancuts') */
  sources: string[];
}

export interface FieldOverrideEntry {
  collectionGroup: string;
  fieldPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: Record<string, any>;
  sources: string[];
}

export interface LoadedIndexes {
  indexes: IndexEntry[];
  fieldOverrides: FieldOverrideEntry[];
  /** Source labels in the order they were loaded */
  sourceLabels: string[];
  /** label → file path (absent for live project fetches) */
  filePathByLabel: Map<string, string>;
}

export type IndexStatus = 'used' | 'unverified' | 'unused';

export interface MatchResult {
  index: IndexEntry;
  status: IndexStatus;
  matchedQueries: ExtractedQuery[];
}

export interface FileEntry {
  path: string;
  content: string;
}
