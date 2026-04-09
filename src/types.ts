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
  /** Constraints that are conditionally applied (e.g. inside `if` blocks, ternary spreads) */
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
  fields: IndexField[];
  _originalIndex: number;
}

export interface IndexesFile {
  indexes: IndexEntry[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _raw: Record<string, any>;
}

export type IndexStatus = 'used' | 'unused';

export interface MatchResult {
  index: IndexEntry;
  status: IndexStatus;
  matchedQueries: ExtractedQuery[];
}
