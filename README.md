# firestore-index-analyzer

Find and remove unused Firestore composite indexes by statically scanning your TypeScript/JavaScript codebase — across multiple repos and index sources at once.

## Origin story

![Claude Code warning that firestore.indexes.json is too large](motivation.png)

This warning — every single time — is what finally motivated building this tool. Then production hit Firestore's **1,000 composite index cap** and it became load-bearing.

## Why

Firestore charges for index storage and — more importantly — maintains every composite index on every write, and hard-caps a database at 1,000 composite indexes. As projects grow, indexes accumulate from deprecated features, renamed collections, refactored queries, and one-click console error links that never get round-tripped into `firestore.indexes.json`. This tool identifies which ones are actually needed.

## Install

```bash
npm install -g firestore-index-analyzer
```

Or run without installing:

```bash
npx firestore-index-analyzer
```

## Usage

```bash
# Single repo, report only — never modifies files
firestore-index-analyzer

# Multiple codebases vs. LIVE production indexes + per-repo index files
firestore-index-analyzer \
  --root ~/dev/acme \
  --scan monorepo/apps,legacy-app/src,legacy-functions/functions/src \
  --project acme-prod \
  --indexes monorepo=monorepo/firestore.indexes.json \
  --indexes legacy=legacy-functions/firestore.indexes.json \
  --emit-master master.indexes.json

# Show which queries matched each used index
firestore-index-analyzer --verbose

# Remove UNUSED indexes from file sources in place
firestore-index-analyzer --dangerously-purge
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--root <path>` | Root directory to scan | Current working directory |
| `--scan <dirs>` | Comma-separated directories to scan (resolved from CWD) | Entire `--root` |
| `--indexes <spec>` | Index source: a path or `label=path`. **Repeatable.** | Auto-discovered |
| `--project <id>` | Fetch live indexes from a Firebase project (`firebase` CLI auth required). **Repeatable.** | — |
| `--output <path>` | Where to write `report.md` | `./report.md` |
| `--emit-master <path>` | Write a unified `firestore.indexes.json` of used + unverified indexes | — |
| `--dangerously-purge` | Remove UNUSED indexes from file sources in place | false |
| `--verbose` | Show matched queries for each used index | false |

Indexes identical after normalization (uppercased directions, implicit trailing `__name__` stripped) are deduped across sources, and every index is reported with the sources that declare it — so you can see at a glance which live indexes exist in no repo file.

## Verdicts: used / unverified / unused

Every index gets one of three statuses:

- **`used`** — at least one extracted query requires it (evidence: file:line in the report)
- **`unverified`** — the collection name appears somewhere in the scanned code, but no parseable query matched this exact index. Review by hand: it's either dead weight from an old query shape, or belongs to a query the parser can't model (helper wrappers, fully dynamic sorts).
- **`unused`** — the collection name appears **nowhere** in any scanned source. Safe to delete.

`--dangerously-purge` only ever removes `unused`. `--emit-master` keeps used + unverified.

## How it works

1. **Scan** — recursively collects `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs` files (skips `node_modules`, `dist`, `.next`, build output, nested git **worktrees and clones** — but scans git **submodules**, which are part of your codebase)
2. **Constant table** — a pre-pass collects every `const NAME = 'literal'` across all files, so `db.collection(ORDERS_COLLECTION)` resolves
3. **Parse** — uses the TypeScript AST (via `ts-morph`) to extract Firestore queries without running code; files are parsed one at a time and released, so memory stays flat on large monorepos
4. **Match** — for each composite index, checks whether any extracted query (in any conditional instantiation) requires it
5. **Reference scan** — for unmatched indexes, a raw-text search for the collection name separates `unverified` from `unused`
6. **Report** — terminal summary + `report.md` with per-index sources and evidence
7. **Purge / emit** *(optional)* — rewrites file sources without `unused` indexes, and/or emits a unified master file

### Supported query patterns

**Admin SDK (chained):**
```typescript
firestore.collection('orders')
  .where('userId', '==', userId)
  .orderBy('createdAt', 'desc')
  .get()
```

**Client SDK (functional):**
```typescript
query(
  collection(db, 'orders'),
  where('userId', '==', userId),
  orderBy('createdAt', 'desc'),
)
```

**Collection names via constants** (file-local or defined anywhere in the scanned codebase):
```typescript
export const ORDERS_COLLECTION = 'orders';
db.collection(ORDERS_COLLECTION).where(...)
```

**Subcollection paths, including template literals** (the index `collectionGroup` is the leaf segment):
```typescript
db.collection(`teams/${teamId}/members`)        // → members
collection(db, 'teams', teamId, 'members')      // → members
```

**Constraint-array accumulation:**
```typescript
const constraints: QueryConstraint[] = [where('teamId', '==', teamId)];
if (filter) constraints.push(where('subjects', 'array-contains-any', filter));
constraints.push(orderBy('createdAt', 'desc'));
query(collection(db, 'clips'), ...constraints)
```

**Inline ternary spreads:**
```typescript
query(col, where('a', '==', x), ...(flag ? [where('b', '==', y)] : []), orderBy('c'))
```

**Dynamic Admin SDK (conditional filters):**
```typescript
let ref = db.collection('products');
if (filters.status) ref = ref.where('status', '==', filters.status);
if (sortBy === 'price') ref = ref.orderBy('price', 'desc');
ref.get()
```

**Dynamic Client SDK (reassignment):**
```typescript
let q = query(collection(db, 'posts'), where('authorId', '==', id));
if (tag) q = query(q, where('tags', 'array-contains', tag));
```

### Conservative by design

If a collection or field name can't be resolved statically, the query is **skipped** — and any index on a collection that is so much as *mentioned* in code can only be `unverified`, never `unused`. This prevents false deletions at the cost of some manual review.

For dynamic queries (conditional where/orderBy), the tool enumerates all possible combinations of active constraints and checks whether any of them would require the index. An index is only left unmatched if *no* possible instantiation of any query needs it.

`fieldOverrides` are never analyzed or purged; `--emit-master` carries the union of all sources' overrides through.

## Limitations

- Queries constructed via abstraction layers or helper wrappers may not be matched (they land in `unverified` via the reference scan, not `unused`)
- Matching is permissive (all query fields present in the index = match), so redundant near-duplicate indexes both count as used
- Does not analyze security rules

## License

MIT
