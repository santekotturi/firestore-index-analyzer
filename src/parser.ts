import { Project, Node, CallExpression, SourceFile, SyntaxKind, ts } from 'ts-morph';
import type { ExtractedQuery, FirestoreOp, WhereClause, OrderByClause, FileEntry } from './types.js';

const VALID_OPS = new Set<string>([
  '==', '!=', '<', '<=', '>', '>=',
  'in', 'not-in', 'array-contains', 'array-contains-any',
]);

function parseOp(raw: string | null): FirestoreOp | null {
  if (raw && VALID_OPS.has(raw)) return raw as FirestoreOp;
  return null;
}

// ─── Constant tables ─────────────────────────────────────────────────────────

/** null value = the name is ambiguous (bound to different strings in different files) */
export type ConstTable = Map<string, string | null>;

const CONST_RE = /const\s+([A-Za-z_$][\w$]*)(?:\s*:\s*[^=\n]+)?\s*=\s*(['"])([^'"\n]+)\2/g;

/**
 * Regex pre-pass over all file contents: collect `const NAME = 'literal'`
 * bindings (exported or not). Names bound to different values in different
 * places are marked ambiguous and never resolved.
 */
export function buildGlobalConstTable(files: FileEntry[]): ConstTable {
  const table: ConstTable = new Map();
  for (const f of files) {
    CONST_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CONST_RE.exec(f.content)) !== null) {
      const [, name, , value] = m;
      const existing = table.get(name);
      if (existing === undefined) table.set(name, value);
      else if (existing !== value) table.set(name, null);
    }
  }
  return table;
}

/** File-local `const x = 'literal'` bindings; take precedence over the global table. */
function buildLocalConstTable(sourceFile: SourceFile): Map<string, string> {
  const table = new Map<string, string>();
  for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    if (init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) {
      table.set(decl.getName(), init.getLiteralText());
    }
  }
  return table;
}

// ─── Name resolution ─────────────────────────────────────────────────────────

interface ResolveCtx {
  local: Map<string, string>;
  global: ConstTable;
}

function resolveIdent(name: string, ctx: ResolveCtx): string | null {
  const local = ctx.local.get(name);
  if (local !== undefined) return local;
  const global = ctx.global.get(name);
  return global ?? null;
}

/**
 * Collection paths always end with the collection name; for
 * 'teams/{id}/teamPlayers' the composite-index collectionGroup is 'teamPlayers'.
 */
function lastPathSegment(s: string): string | null {
  const segments = s.split('/').filter(seg => seg.length > 0);
  const last = segments[segments.length - 1];
  return last && last.length > 0 ? last : null;
}

/**
 * Resolve an expression node to a string, handling:
 *   'literal'  →  literal
 *   `template` →  template (no substitutions)
 *   `a/${x}/b` →  static tail after the last '/'  (caller applies lastPathSegment)
 *   `${CONST}` →  resolved constant
 *   IDENT      →  file-local const, then global const table
 */
function resolveStr(node: Node, ctx: ResolveCtx): string | null {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText();
  }

  if (Node.isTemplateExpression(node)) {
    const spans = node.getTemplateSpans();
    const tail = spans[spans.length - 1]?.getLiteral().getLiteralText() ?? '';
    if (tail.includes('/')) {
      // `teams/${id}/teamPlayers` → 'teamPlayers'
      return lastPathSegment(tail);
    }
    // `${CONST}` (pure wrapper)
    const head = node.getHead().getLiteralText();
    if (head === '' && spans.length === 1 && tail === '') {
      const expr = spans[0].getExpression();
      if (Node.isIdentifier(expr)) return resolveIdent(expr.getText(), ctx);
    }
    return null;
  }

  if (Node.isIdentifier(node)) {
    return resolveIdent(node.getText(), ctx);
  }

  // (x as T) casts
  if (Node.isAsExpression(node) || Node.isParenthesizedExpression(node)) {
    return resolveStr(node.getExpression(), ctx);
  }

  return null;
}

/** Resolve a collection-name argument, reducing slash paths to the leaf collection. */
function resolveCollectionName(node: Node, ctx: ResolveCtx): string | null {
  const raw = resolveStr(node, ctx);
  return raw ? lastPathSegment(raw) : null;
}

// ─── Shared constraint parsing ───────────────────────────────────────────────

interface Constraints {
  wheres: WhereClause[];
  orderBys: OrderByClause[];
}

function emptyConstraints(): Constraints {
  return { wheres: [], orderBys: [] };
}

function addConstraintFromCall(
  fnName: string,
  argNodes: Node[],
  ctx: ResolveCtx,
  out: Constraints,
): void {
  if (fnName === 'where') {
    const field = argNodes[0] ? resolveStr(argNodes[0], ctx) : null;
    const op = parseOp(argNodes[1] ? resolveStr(argNodes[1], ctx) : null);
    if (field && op) out.wheres.push({ field, op });
  } else if (fnName === 'orderBy') {
    const field = argNodes[0] ? resolveStr(argNodes[0], ctx) : null;
    if (field) {
      const dirRaw = argNodes[1] ? resolveStr(argNodes[1], ctx) : null;
      const dir = dirRaw?.toLowerCase() === 'desc' ? 'desc' : 'asc';
      out.orderBys.push({ field, dir });
    }
  }
}

/** Parse a modular-SDK constraint call like where(...) / orderBy(...) into `out`. */
function parseConstraintCall(node: Node, ctx: ResolveCtx, out: Constraints): void {
  if (!Node.isCallExpression(node)) return;
  const callee = node.getExpression();
  if (!Node.isIdentifier(callee)) return;
  addConstraintFromCall(callee.getText(), node.getArguments(), ctx, out);
}

/** Extract where/orderBy constraints from an ArrayLiteralExpression. */
function extractFromArray(arr: Node, ctx: ResolveCtx): Constraints {
  if (!Node.isArrayLiteralExpression(arr)) return emptyConstraints();
  const result = emptyConstraints();
  for (const el of arr.getElements()) parseConstraintCall(el, ctx, result);
  return result;
}

// ─── Conditional detection ───────────────────────────────────────────────────

/**
 * Returns true if `node` is inside an if/ternary conditional (not crossing a
 * function boundary).
 */
function isInsideConditional(node: Node): boolean {
  let parent: Node | undefined = node.getParent();
  while (parent && !Node.isSourceFile(parent)) {
    if (Node.isIfStatement(parent) || Node.isConditionalExpression(parent)) return true;
    if (
      Node.isFunctionDeclaration(parent) ||
      Node.isArrowFunction(parent) ||
      Node.isFunctionExpression(parent) ||
      Node.isMethodDeclaration(parent)
    ) break;
    parent = parent.getParent();
  }
  return false;
}

// ─── Spread variable resolution (incl. .push accumulation) ──────────────────

/**
 * Resolve a spread variable to fixed/conditional constraints.
 *
 * Handles:
 *   const x = [where(...), orderBy(...)]         → fixed
 *   const x = cond ? [where(...)] : []           → conditional
 *   x.push(where(...))                           → fixed or conditional,
 *                                                  depending on surrounding ifs
 */
function resolveSpreadVar(
  varName: string,
  sourceFile: SourceFile,
  ctx: ResolveCtx,
): { fixed: Constraints; conditional: Constraints } {
  const fixed = emptyConstraints();
  const conditional = emptyConstraints();

  for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (decl.getName() !== varName) continue;
    const init = decl.getInitializer();
    if (!init) break;

    // cond ? [where(...)] : []
    if (Node.isConditionalExpression(init)) {
      for (const branch of [init.getWhenTrue(), init.getWhenFalse()]) {
        const c = extractFromArray(branch, ctx);
        conditional.wheres.push(...c.wheres);
        conditional.orderBys.push(...c.orderBys);
      }
    }

    // [where(...), orderBy(...)] (possibly empty)
    if (Node.isArrayLiteralExpression(init)) {
      const c = extractFromArray(init, ctx);
      fixed.wheres.push(...c.wheres);
      fixed.orderBys.push(...c.orderBys);
    }

    break;
  }

  // varName.push(where(...), ...) accumulation
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    if (callee.getName() !== 'push') continue;
    const target = callee.getExpression();
    if (!Node.isIdentifier(target) || target.getText() !== varName) continue;

    const bucket = isInsideConditional(call) ? conditional : fixed;
    for (const arg of call.getArguments()) parseConstraintCall(arg, ctx, bucket);
  }

  return { fixed, conditional };
}

/**
 * Resolve a spread ELEMENT (the expression after `...`) to constraints.
 * Handles identifier spreads (via resolveSpreadVar) and inline ternaries:
 *   ...(cond ? [where(...)] : [])
 */
function resolveSpreadExpr(
  expr: Node,
  sourceFile: SourceFile,
  ctx: ResolveCtx,
): { fixed: Constraints; conditional: Constraints } {
  if (Node.isIdentifier(expr)) {
    return resolveSpreadVar(expr.getText(), sourceFile, ctx);
  }

  if (Node.isParenthesizedExpression(expr)) {
    return resolveSpreadExpr(expr.getExpression(), sourceFile, ctx);
  }

  if (Node.isConditionalExpression(expr)) {
    const conditional = emptyConstraints();
    for (const branch of [expr.getWhenTrue(), expr.getWhenFalse()]) {
      const c = extractFromArray(branch, ctx);
      conditional.wheres.push(...c.wheres);
      conditional.orderBys.push(...c.orderBys);
    }
    return { fixed: emptyConstraints(), conditional };
  }

  // ...[where(...)] inline array spread
  if (Node.isArrayLiteralExpression(expr)) {
    return { fixed: extractFromArray(expr, ctx), conditional: emptyConstraints() };
  }

  return { fixed: emptyConstraints(), conditional: emptyConstraints() };
}

// ─── Admin SDK chains ────────────────────────────────────────────────────────

interface ChainStep {
  name: string;
  argNodes: Node[];
}

/** Walk backward through a method chain starting at `call`. */
function unrollChain(call: CallExpression): ChainStep[] {
  const steps: ChainStep[] = [];
  let node: Node = call;

  while (Node.isCallExpression(node)) {
    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) break;

    steps.unshift({
      name: expr.getName(),
      argNodes: node.getArguments(),
    });
    node = expr.getExpression();
  }

  return steps;
}

/** Walk UP to find the outermost CallExpression in a method chain. */
function getTopmostChain(node: CallExpression): CallExpression {
  let topmost: CallExpression = node;
  let current: Node = node;

  while (true) {
    const parent = current.getParent();
    if (!parent || !Node.isPropertyAccessExpression(parent)) break;
    const grandparent = parent.getParent();
    if (!grandparent || !Node.isCallExpression(grandparent)) break;
    topmost = grandparent;
    current = grandparent;
  }

  return topmost;
}

interface ChainParse {
  collection: string | null;
  isCollectionGroup: boolean;
  constraints: Constraints;
}

function parseAdminChain(steps: ChainStep[], ctx: ResolveCtx): ChainParse {
  let collection: string | null = null;
  let isCollectionGroup = false;
  const constraints = emptyConstraints();

  for (const step of steps) {
    if (step.name === 'collection' || step.name === 'collectionGroup') {
      const name = step.argNodes[0] ? resolveCollectionName(step.argNodes[0], ctx) : null;
      if (name) {
        collection = name;
        isCollectionGroup = step.name === 'collectionGroup';
      }
    } else {
      addConstraintFromCall(step.name, step.argNodes, ctx, constraints);
    }
  }

  return { collection, isCollectionGroup, constraints };
}

/** Build an ExtractedQuery from an Admin SDK chain. */
function queryFromAdminChain(
  steps: ChainStep[],
  ctx: ResolveCtx,
  sourceFile: string,
  sourceLine: number,
): ExtractedQuery | null {
  const { collection, isCollectionGroup, constraints } = parseAdminChain(steps, ctx);
  if (!collection) return null;

  return {
    collection,
    isCollectionGroup,
    whereClauses: constraints.wheres,
    orderByClauses: constraints.orderBys,
    sourceFile,
    sourceLine,
  };
}

// ─── Collection reference map ────────────────────────────────────────────────

interface CollRef { name: string; isGroup: boolean }

/**
 * Build a map of variable name → collection reference for the source file.
 * Handles: const ref = collection(db, ..., 'X')
 *          const ref = collectionGroup(db, 'X')
 */
function buildCollRefMap(sourceFile: SourceFile, ctx: ResolveCtx): Map<string, CollRef> {
  const map = new Map<string, CollRef>();
  for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    const callee = init.getExpression();
    if (!Node.isIdentifier(callee)) continue;
    const fnName = callee.getText();
    if (fnName !== 'collection' && fnName !== 'collectionGroup') continue;
    const name = resolveModularCollectionArgs(init.getArguments(), ctx);
    if (name) {
      map.set(decl.getName(), { name, isGroup: fnName === 'collectionGroup' });
    }
  }
  return map;
}

/**
 * Resolve the collection name from modular-SDK collection()/collectionGroup()
 * arguments: collection(db, 'teams', id, 'teamPlayers') → 'teamPlayers';
 * collection(db, `teams/${id}/x`) → 'x'. The last resolvable path argument wins.
 */
function resolveModularCollectionArgs(args: Node[], ctx: ResolveCtx): string | null {
  let name: string | null = null;
  for (let i = 1; i < args.length; i++) {
    const resolved = resolveCollectionName(args[i], ctx);
    if (resolved) name = resolved;
  }
  // Single-argument form (unusual, but harmless to try the first arg too)
  if (!name && args.length === 1) name = resolveCollectionName(args[0], ctx);
  return name;
}

/** Resolve the first argument of query(...) to a collection ref. */
function resolveQueryTarget(
  firstArg: Node,
  collRefMap: Map<string, CollRef>,
  ctx: ResolveCtx,
): CollRef | null {
  if (Node.isCallExpression(firstArg)) {
    const callee = firstArg.getExpression();
    if (Node.isIdentifier(callee)) {
      const fnName = callee.getText();
      if (fnName === 'collection' || fnName === 'collectionGroup') {
        const name = resolveModularCollectionArgs(firstArg.getArguments(), ctx);
        if (name) return { name, isGroup: fnName === 'collectionGroup' };
      }
    }
    return null;
  }
  if (Node.isIdentifier(firstArg)) {
    return collRefMap.get(firstArg.getText()) ?? null;
  }
  return null;
}

// ─── Client SDK: query() calls ───────────────────────────────────────────────

function queryFromClientCall(
  call: CallExpression,
  sourceFile: SourceFile,
  collRefMap: Map<string, CollRef>,
  ctx: ResolveCtx,
  filePath: string,
  sourceLine: number,
): ExtractedQuery | null {
  const args = call.getArguments();
  if (args.length < 1) return null;

  const target = resolveQueryTarget(args[0], collRefMap, ctx);
  if (!target) return null;

  const fixed = emptyConstraints();
  const conditional = emptyConstraints();

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];

    if (arg.getKind() === SyntaxKind.SpreadElement) {
      const children = arg.getChildren();
      const spreadExpr = children.length >= 2 ? children[1] : null;
      if (spreadExpr) {
        const resolved = resolveSpreadExpr(spreadExpr, sourceFile, ctx);
        fixed.wheres.push(...resolved.fixed.wheres);
        fixed.orderBys.push(...resolved.fixed.orderBys);
        conditional.wheres.push(...resolved.conditional.wheres);
        conditional.orderBys.push(...resolved.conditional.orderBys);
      }
      continue;
    }

    parseConstraintCall(arg, ctx, fixed);
  }

  return {
    collection: target.name,
    isCollectionGroup: target.isGroup,
    whereClauses: fixed.wheres,
    orderByClauses: fixed.orderBys,
    conditionalWhereClauses: conditional.wheres.length > 0 ? conditional.wheres : undefined,
    conditionalOrderByClauses: conditional.orderBys.length > 0 ? conditional.orderBys : undefined,
    sourceFile: filePath,
    sourceLine,
  };
}

// ─── Dynamic query reassignment detection ───────────────────────────────────

/** Strip TypeScript cast suffixes: `(ref as CollectionReference<X>)` → `ref` */
function stripCast(text: string): string {
  const m = text.match(/^\(?\s*(\w+)\s+as\s+[\w<>\[\].,| ]+\)?\s*$/);
  return m ? m[1] : text.trim();
}

interface DynQueryState {
  collection: string;
  isCollectionGroup: boolean;
  fixed: Constraints;
  conditional: Constraints;
  sourceLine: number;
}

/**
 * Extract queries from dynamic reassignment patterns:
 *
 *   Admin SDK:   let ref = db.collection('X');
 *                if (x) ref = ref.where('f', '==', v);
 *
 *   Client SDK:  let q = query(collection(db, 'X'), where(...));
 *                if (x) q = query(q, where('f', '==', v));
 */
function extractDynamicQueries(
  sourceFile: SourceFile,
  collRefMap: Map<string, CollRef>,
  ctx: ResolveCtx,
  filePath: string,
): ExtractedQuery[] {
  const queryVars = new Map<string, DynQueryState>();

  // ── Phase 1: Find variable declarations that hold a Firestore query/ref ──
  for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    const varName = decl.getName();
    const callee = init.getExpression();

    // Admin SDK chain: let ref = db.collection('X').where(...)...
    if (Node.isPropertyAccessExpression(callee)) {
      const parsed = parseAdminChain(unrollChain(init), ctx);
      if (parsed.collection) {
        queryVars.set(varName, {
          collection: parsed.collection,
          isCollectionGroup: parsed.isCollectionGroup,
          fixed: parsed.constraints,
          conditional: emptyConstraints(),
          sourceLine: decl.getStartLineNumber(),
        });
      }
      continue;
    }

    // Client SDK: let q = query(collection(db, 'X'), ...) or query(refVar, ...)
    if (Node.isIdentifier(callee) && callee.getText() === 'query') {
      const qArgs = init.getArguments();
      if (qArgs.length < 1) continue;

      const target = resolveQueryTarget(qArgs[0], collRefMap, ctx);
      if (!target) continue;

      const fixed = emptyConstraints();
      for (let i = 1; i < qArgs.length; i++) parseConstraintCall(qArgs[i], ctx, fixed);

      queryVars.set(varName, {
        collection: target.name,
        isCollectionGroup: target.isGroup,
        fixed,
        conditional: emptyConstraints(),
        sourceLine: decl.getStartLineNumber(),
      });
    }
  }

  if (queryVars.size === 0) return [];

  // ── Phase 2: Find assignments that add constraints to tracked variables ──
  for (const binary of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (binary.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;

    const left = binary.getLeft();
    if (!Node.isIdentifier(left)) continue;
    const varName = left.getText();
    const state = queryVars.get(varName);
    if (!state) continue;

    const right = binary.getRight();
    if (!Node.isCallExpression(right)) continue;

    const bucket = isInsideConditional(binary) ? state.conditional : state.fixed;
    const rightCallee = right.getExpression();

    // Pattern A: ref = ref.where('f', '==', v) — possibly a longer chain
    // like ref = ref.where(...).orderBy(...), or with casts.
    if (Node.isPropertyAccessExpression(rightCallee)) {
      const steps = unrollChain(right);
      // The chain must be rooted at the same variable
      let rootNode: Node = right;
      while (Node.isCallExpression(rootNode)) {
        const e = rootNode.getExpression();
        if (!Node.isPropertyAccessExpression(e)) break;
        rootNode = e.getExpression();
      }
      if (stripCast(rootNode.getText()) !== varName) continue;

      for (const step of steps) addConstraintFromCall(step.name, step.argNodes, ctx, bucket);
      continue;
    }

    // Pattern B: q = query(q, where('f', '==', v), ...)
    if (Node.isIdentifier(rightCallee) && rightCallee.getText() === 'query') {
      const rArgs = right.getArguments();
      for (let i = 1; i < rArgs.length; i++) {
        const a = rArgs[i];
        if (a.getKind() === SyntaxKind.SpreadElement) {
          const children = a.getChildren();
          const spreadExpr = children.length >= 2 ? children[1] : null;
          if (spreadExpr) {
            const resolved = resolveSpreadExpr(spreadExpr, sourceFile, ctx);
            bucket.wheres.push(...resolved.fixed.wheres, ...resolved.conditional.wheres);
            bucket.orderBys.push(...resolved.fixed.orderBys, ...resolved.conditional.orderBys);
          }
          continue;
        }
        parseConstraintCall(a, ctx, bucket);
      }
    }
  }

  // ── Phase 3: Emit queries that have at least one conditional constraint ──
  const results: ExtractedQuery[] = [];
  for (const [, state] of queryVars) {
    if (state.conditional.wheres.length === 0 && state.conditional.orderBys.length === 0) continue;
    results.push({
      collection: state.collection,
      isCollectionGroup: state.isCollectionGroup,
      whereClauses: state.fixed.wheres,
      orderByClauses: state.fixed.orderBys,
      conditionalWhereClauses: state.conditional.wheres,
      conditionalOrderByClauses: state.conditional.orderBys,
      sourceFile: filePath,
      sourceLine: state.sourceLine,
    });
  }
  return results;
}

// ─── Main extraction entry point ─────────────────────────────────────────────

/**
 * Extract Firestore queries from the given files.
 *
 * Files are parsed one at a time and released immediately after extraction so
 * memory stays flat on large monorepos.
 */
export function extractQueries(
  files: FileEntry[],
  globalConsts: ConstTable,
  onProgress?: (done: number, total: number) => void,
): ExtractedQuery[] {
  const results: ExtractedQuery[] = [];

  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: {
      skipLibCheck: true,
      allowJs: true,
      noEmit: true,
      jsx: ts.JsxEmit.Preserve,
    },
  });

  let done = 0;
  for (const file of files) {
    let sourceFile: SourceFile;
    try {
      sourceFile = project.createSourceFile(file.path, file.content, { overwrite: true });
    } catch {
      continue;
    }

    try {
      const ctx: ResolveCtx = {
        local: buildLocalConstTable(sourceFile),
        global: globalConsts,
      };
      const collRefMap = buildCollRefMap(sourceFile, ctx);
      const processedChains = new Set<number>();

      for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const expr = call.getExpression();

        // ── Admin SDK static chains ──────────────────────────────────────
        if (Node.isPropertyAccessExpression(expr)) {
          const methodName = expr.getName();
          if (methodName === 'collection' || methodName === 'collectionGroup') {
            const firstArg = call.getArguments()[0];
            if (!firstArg || !resolveCollectionName(firstArg, ctx)) continue;

            const topmost = getTopmostChain(call);
            const pos = topmost.getStart();
            if (processedChains.has(pos)) continue;
            processedChains.add(pos);

            const query = queryFromAdminChain(
              unrollChain(topmost), ctx, file.path, call.getStartLineNumber(),
            );
            if (query) results.push(query);
          }
        }

        // ── Client SDK: query(collection|refVar, ...args, ...spreads) ────
        if (Node.isIdentifier(expr) && expr.getText() === 'query') {
          const query = queryFromClientCall(
            call, sourceFile, collRefMap, ctx, file.path, call.getStartLineNumber(),
          );
          if (query) results.push(query);
        }
      }

      // ── Dynamic reassignment queries ────────────────────────────────────
      results.push(...extractDynamicQueries(sourceFile, collRefMap, ctx, file.path));
    } finally {
      sourceFile.forget();
    }

    done++;
    if (onProgress && done % 250 === 0) onProgress(done, files.length);
  }

  return results;
}
