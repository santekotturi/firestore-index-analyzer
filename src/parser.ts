import { Project, Node, CallExpression, SourceFile, SyntaxKind } from 'ts-morph';
import type { ExtractedQuery, FirestoreOp, WhereClause, OrderByClause } from './types.js';

const VALID_OPS = new Set<string>([
  '==', '!=', '<', '<=', '>', '>=',
  'in', 'not-in', 'array-contains', 'array-contains-any',
]);

function getStringLit(node: Node): string | null {
  if (Node.isStringLiteral(node)) return node.getLiteralText();
  return null;
}

function parseOp(raw: string | null): FirestoreOp | null {
  if (raw && VALID_OPS.has(raw)) return raw as FirestoreOp;
  return null;
}

interface ChainStep {
  name: string;
  literalArgs: (string | null)[];
}

/**
 * Walk backward through a method chain starting at `call`.
 */
function unrollChain(call: CallExpression): ChainStep[] {
  const steps: ChainStep[] = [];
  let node: Node = call;

  while (Node.isCallExpression(node)) {
    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) break;

    steps.unshift({
      name: expr.getName(),
      literalArgs: node.getArguments().map(getStringLit),
    });
    node = expr.getExpression();
  }

  return steps;
}

/**
 * Walk UP to find the outermost CallExpression in a method chain.
 */
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

/**
 * Build an ExtractedQuery from an Admin SDK chain.
 */
function queryFromAdminChain(
  steps: ChainStep[],
  sourceFile: string,
  sourceLine: number,
): ExtractedQuery | null {
  let collectionStep: ChainStep | undefined;
  for (const step of steps) {
    if (step.name === 'collection' || step.name === 'collectionGroup') {
      collectionStep = step;
    }
  }
  if (!collectionStep) return null;

  const collectionName = collectionStep.literalArgs[0];
  if (!collectionName) return null;

  const isCollectionGroup = collectionStep.name === 'collectionGroup';
  const whereClauses: WhereClause[] = [];
  const orderByClauses: OrderByClause[] = [];

  for (const step of steps) {
    if (step.name === 'where') {
      const field = step.literalArgs[0];
      const op = parseOp(step.literalArgs[1]);
      if (field && op) whereClauses.push({ field, op });
    } else if (step.name === 'orderBy') {
      const field = step.literalArgs[0];
      if (field) {
        const dir = step.literalArgs[1]?.toLowerCase() === 'desc' ? 'desc' : 'asc';
        orderByClauses.push({ field, dir });
      }
    }
  }

  return { collection: collectionName, isCollectionGroup, whereClauses, orderByClauses, sourceFile, sourceLine };
}

// ─── Constraint extraction helpers ──────────────────────────────────────────

interface Constraints {
  wheres: WhereClause[];
  orderBys: OrderByClause[];
}

function emptyConstraints(): Constraints {
  return { wheres: [], orderBys: [] };
}

/**
 * Extract where/orderBy constraints from an ArrayLiteralExpression.
 */
function extractFromArray(arr: Node): Constraints {
  if (!Node.isArrayLiteralExpression(arr)) return emptyConstraints();
  const result = emptyConstraints();
  for (const el of arr.getElements()) {
    if (!Node.isCallExpression(el)) continue;
    const callee = el.getExpression();
    if (!Node.isIdentifier(callee)) continue;
    const fnName = callee.getText();
    const fnArgs = el.getArguments().map(getStringLit);
    if (fnName === 'where') {
      const field = fnArgs[0]; const op = parseOp(fnArgs[1]);
      if (field && op) result.wheres.push({ field, op });
    } else if (fnName === 'orderBy') {
      const field = fnArgs[0];
      if (field) {
        const dir = fnArgs[1]?.toLowerCase() === 'desc' ? 'desc' : 'asc';
        result.orderBys.push({ field, dir });
      }
    }
  }
  return result;
}

/**
 * Resolve a spread variable reference to fixed/conditional constraints.
 *
 * Handles:
 *   const x = cond ? [where('f', '==', v)] : []   → conditional
 *   const x = [where('f', '==', v), orderBy(...)]  → fixed
 */
function resolveSpreadVar(
  varName: string,
  sourceFile: SourceFile,
): { fixed: Constraints; conditional: Constraints } {
  const empty = { fixed: emptyConstraints(), conditional: emptyConstraints() };

  for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (decl.getName() !== varName) continue;
    const init = decl.getInitializer();
    if (!init) break;

    // cond ? [where(...)] : []
    if (Node.isConditionalExpression(init)) {
      const t = init.getWhenTrue();
      const f = init.getWhenFalse();
      const nonEmpty = Node.isArrayLiteralExpression(t) && t.getElements().length > 0 ? t
        : Node.isArrayLiteralExpression(f) && f.getElements().length > 0 ? f
        : null;
      if (nonEmpty) return { fixed: emptyConstraints(), conditional: extractFromArray(nonEmpty) };
    }

    // [where(...), orderBy(...)]
    if (Node.isArrayLiteralExpression(init)) {
      return { fixed: extractFromArray(init), conditional: emptyConstraints() };
    }

    break;
  }

  return empty;
}

// ─── Collection reference map ────────────────────────────────────────────────

interface CollRef { name: string; isGroup: boolean }

/**
 * Build a map of variable name → collection reference for the source file.
 * Handles: const ref = collection(db, ..., 'X')
 *          const ref = collectionGroup(db, 'X')
 */
function buildCollRefMap(sourceFile: SourceFile): Map<string, CollRef> {
  const map = new Map<string, CollRef>();
  for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    const callee = init.getExpression();
    if (!Node.isIdentifier(callee)) continue;
    const fnName = callee.getText();
    if (fnName !== 'collection' && fnName !== 'collectionGroup') continue;
    let collectionName: string | null = null;
    for (const a of init.getArguments()) {
      const lit = getStringLit(a);
      if (lit) collectionName = lit;
    }
    if (collectionName) {
      map.set(decl.getName(), { name: collectionName, isGroup: fnName === 'collectionGroup' });
    }
  }
  return map;
}

// ─── Client SDK: query() with spread args ───────────────────────────────────

/**
 * Client SDK: query(collection(db,'name')|refVar, where(...), orderBy(...), ...spreadVar)
 * Now handles spread variables and collection ref variables.
 */
function queryFromClientCall(
  call: CallExpression,
  sourceFile: SourceFile,
  collRefMap: Map<string, CollRef>,
  filePath: string,
  sourceLine: number,
): ExtractedQuery | null {
  const args = call.getArguments();
  if (args.length < 1) return null;

  // Resolve collection from first arg
  const firstArg = args[0];
  let collectionName: string | null = null;
  let isCollectionGroup = false;

  if (Node.isCallExpression(firstArg)) {
    const callee = firstArg.getExpression();
    if (Node.isIdentifier(callee)) {
      const fnName = callee.getText();
      if (fnName === 'collection' || fnName === 'collectionGroup') {
        isCollectionGroup = fnName === 'collectionGroup';
        for (const a of firstArg.getArguments()) {
          const lit = getStringLit(a);
          if (lit) collectionName = lit;
        }
      }
    }
  } else if (Node.isIdentifier(firstArg)) {
    const ref = collRefMap.get(firstArg.getText());
    if (ref) { collectionName = ref.name; isCollectionGroup = ref.isGroup; }
  }

  if (!collectionName) return null;

  const whereClauses: WhereClause[] = [];
  const orderByClauses: OrderByClause[] = [];
  const conditionalWhereClauses: WhereClause[] = [];
  const conditionalOrderByClauses: OrderByClause[] = [];

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];

    // SpreadElement: ...constraintsVar
    if (arg.getKind() === SyntaxKind.SpreadElement) {
      // SpreadElement children: [DotDotDotToken, Expression]
      const children = arg.getChildren();
      const spreadExpr = children.length >= 2 ? children[1] : null;
      if (spreadExpr && Node.isIdentifier(spreadExpr)) {
        const { fixed, conditional } = resolveSpreadVar(spreadExpr.getText(), sourceFile);
        whereClauses.push(...fixed.wheres);
        orderByClauses.push(...fixed.orderBys);
        conditionalWhereClauses.push(...conditional.wheres);
        conditionalOrderByClauses.push(...conditional.orderBys);
      }
      continue;
    }

    if (!Node.isCallExpression(arg)) continue;
    const argCallee = arg.getExpression();
    if (!Node.isIdentifier(argCallee)) continue;

    const fnName = argCallee.getText();
    const fnArgs = arg.getArguments().map(getStringLit);

    if (fnName === 'where') {
      const field = fnArgs[0]; const op = parseOp(fnArgs[1]);
      if (field && op) whereClauses.push({ field, op });
    } else if (fnName === 'orderBy') {
      const field = fnArgs[0];
      if (field) {
        const dir = fnArgs[1]?.toLowerCase() === 'desc' ? 'desc' : 'asc';
        orderByClauses.push({ field, dir });
      }
    }
  }

  return {
    collection: collectionName,
    isCollectionGroup,
    whereClauses,
    orderByClauses,
    conditionalWhereClauses: conditionalWhereClauses.length > 0 ? conditionalWhereClauses : undefined,
    conditionalOrderByClauses: conditionalOrderByClauses.length > 0 ? conditionalOrderByClauses : undefined,
    sourceFile: filePath,
    sourceLine,
  };
}

// ─── Dynamic query reassignment detection ───────────────────────────────────

/**
 * Returns true if `node` is inside an if/ternary conditional (not crossing a function boundary).
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

/**
 * Strip TypeScript cast suffixes: `(ref as CollectionReference<X>)` → `ref`
 */
function stripCast(text: string): string {
  const m = text.match(/^\(?\s*(\w+)\s+as\s+[\w<>\[\].,| ]+\)?\s*$/);
  return m ? m[1] : text.trim();
}

interface DynQueryState {
  collection: string;
  isCollectionGroup: boolean;
  fixedWheres: WhereClause[];
  fixedOrderBys: OrderByClause[];
  conditionalWheres: WhereClause[];
  conditionalOrderBys: OrderByClause[];
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
      const steps = unrollChain(init);
      let collectionName: string | null = null;
      let isCollectionGroup = false;
      const fixedWheres: WhereClause[] = [];
      const fixedOrderBys: OrderByClause[] = [];

      for (const step of steps) {
        if (step.name === 'collection' || step.name === 'collectionGroup') {
          if (step.literalArgs[0]) {
            collectionName = step.literalArgs[0];
            isCollectionGroup = step.name === 'collectionGroup';
          }
        } else if (step.name === 'where') {
          const field = step.literalArgs[0]; const op = parseOp(step.literalArgs[1]);
          if (field && op) fixedWheres.push({ field, op });
        } else if (step.name === 'orderBy') {
          const field = step.literalArgs[0];
          if (field) {
            const dir = step.literalArgs[1]?.toLowerCase() === 'desc' ? 'desc' : 'asc';
            fixedOrderBys.push({ field, dir });
          }
        }
      }
      if (collectionName) {
        queryVars.set(varName, {
          collection: collectionName, isCollectionGroup,
          fixedWheres, fixedOrderBys,
          conditionalWheres: [], conditionalOrderBys: [],
          sourceLine: decl.getStartLineNumber(),
        });
      }
      continue;
    }

    // Client SDK: let q = query(collection(db, 'X'), ...) or query(refVar, ...)
    if (Node.isIdentifier(callee) && callee.getText() === 'query') {
      const qArgs = init.getArguments();
      if (qArgs.length < 1) continue;

      const firstQArg = qArgs[0];
      let collectionName: string | null = null;
      let isCollectionGroup = false;

      if (Node.isCallExpression(firstQArg)) {
        const fc = firstQArg.getExpression();
        if (Node.isIdentifier(fc) && (fc.getText() === 'collection' || fc.getText() === 'collectionGroup')) {
          isCollectionGroup = fc.getText() === 'collectionGroup';
          for (const a of firstQArg.getArguments()) {
            const lit = getStringLit(a); if (lit) collectionName = lit;
          }
        }
      } else if (Node.isIdentifier(firstQArg)) {
        const ref = collRefMap.get(firstQArg.getText());
        if (ref) { collectionName = ref.name; isCollectionGroup = ref.isGroup; }
      }

      if (!collectionName) continue;

      const fixedWheres: WhereClause[] = [];
      const fixedOrderBys: OrderByClause[] = [];

      for (let i = 1; i < qArgs.length; i++) {
        const a = qArgs[i];
        if (!Node.isCallExpression(a)) continue;
        const ac = a.getExpression();
        if (!Node.isIdentifier(ac)) continue;
        const fn = ac.getText();
        const fArgs = a.getArguments().map(getStringLit);
        if (fn === 'where') {
          const field = fArgs[0]; const op = parseOp(fArgs[1]);
          if (field && op) fixedWheres.push({ field, op });
        } else if (fn === 'orderBy') {
          const field = fArgs[0];
          if (field) {
            const dir = fArgs[1]?.toLowerCase() === 'desc' ? 'desc' : 'asc';
            fixedOrderBys.push({ field, dir });
          }
        }
      }

      queryVars.set(varName, {
        collection: collectionName, isCollectionGroup,
        fixedWheres, fixedOrderBys,
        conditionalWheres: [], conditionalOrderBys: [],
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

    const conditional = isInsideConditional(binary);
    const rightCallee = right.getExpression();

    // Pattern A: ref = ref.where('f', '==', v) or ref = (ref as any).where(...)
    if (Node.isPropertyAccessExpression(rightCallee)) {
      const methodName = rightCallee.getName();
      if (methodName !== 'where' && methodName !== 'orderBy') continue;
      const targetText = stripCast(rightCallee.getExpression().getText());
      if (targetText !== varName) continue;

      const argLits = right.getArguments().map(getStringLit);
      if (methodName === 'where') {
        const field = argLits[0]; const op = parseOp(argLits[1]);
        if (field && op) {
          if (conditional) state.conditionalWheres.push({ field, op });
          else state.fixedWheres.push({ field, op });
        }
      } else {
        const field = argLits[0];
        if (field) {
          const dir = argLits[1]?.toLowerCase() === 'desc' ? 'desc' : 'asc';
          if (conditional) state.conditionalOrderBys.push({ field, dir });
          else state.fixedOrderBys.push({ field, dir });
        }
      }
      continue;
    }

    // Pattern B: q = query(q, where('f', '==', v)) or q = query(q, orderBy(...))
    if (Node.isIdentifier(rightCallee) && rightCallee.getText() === 'query') {
      const rArgs = right.getArguments();
      for (let i = 1; i < rArgs.length; i++) {
        const a = rArgs[i];
        if (!Node.isCallExpression(a)) continue;
        const ac = a.getExpression();
        if (!Node.isIdentifier(ac)) continue;
        const fn = ac.getText();
        const fArgs = a.getArguments().map(getStringLit);
        if (fn === 'where') {
          const field = fArgs[0]; const op = parseOp(fArgs[1]);
          if (field && op) {
            if (conditional) state.conditionalWheres.push({ field, op });
            else state.fixedWheres.push({ field, op });
          }
        } else if (fn === 'orderBy') {
          const field = fArgs[0];
          if (field) {
            const dir = fArgs[1]?.toLowerCase() === 'desc' ? 'desc' : 'asc';
            if (conditional) state.conditionalOrderBys.push({ field, dir });
            else state.fixedOrderBys.push({ field, dir });
          }
        }
      }
    }
  }

  // ── Phase 3: Emit queries that have at least one conditional constraint ──
  const results: ExtractedQuery[] = [];
  for (const [, state] of queryVars) {
    if (state.conditionalWheres.length === 0 && state.conditionalOrderBys.length === 0) continue;
    results.push({
      collection: state.collection,
      isCollectionGroup: state.isCollectionGroup,
      whereClauses: state.fixedWheres,
      orderByClauses: state.fixedOrderBys,
      conditionalWhereClauses: state.conditionalWheres,
      conditionalOrderByClauses: state.conditionalOrderBys,
      sourceFile: filePath,
      sourceLine: state.sourceLine,
    });
  }
  return results;
}

// ─── Main extraction entry point ─────────────────────────────────────────────

export function extractQueries(project: Project): ExtractedQuery[] {
  const results: ExtractedQuery[] = [];
  const processedChains = new Set<number>();

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    const collRefMap = buildCollRefMap(sourceFile);
    const callNodes = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const call of callNodes) {
      const expr = call.getExpression();

      // ── Admin SDK static chains ──────────────────────────────────────────
      if (Node.isPropertyAccessExpression(expr)) {
        const methodName = expr.getName();
        if (methodName === 'collection' || methodName === 'collectionGroup') {
          const firstArg = call.getArguments()[0];
          if (!firstArg || !Node.isStringLiteral(firstArg)) continue;

          const topmost = getTopmostChain(call);
          const pos = topmost.getStart();
          if (processedChains.has(pos)) continue;
          processedChains.add(pos);

          const steps = unrollChain(topmost);
          const query = queryFromAdminChain(steps, filePath, call.getStartLineNumber());
          if (query) results.push(query);
        }
      }

      // ── Client SDK: query(collection|refVar, ...args, ...spreadVars) ─────
      if (Node.isIdentifier(expr) && expr.getText() === 'query') {
        const query = queryFromClientCall(call, sourceFile, collRefMap, filePath, call.getStartLineNumber());
        if (query) results.push(query);
      }
    }

    // ── Dynamic reassignment queries ────────────────────────────────────────
    const dynamicQueries = extractDynamicQueries(sourceFile, collRefMap, filePath);
    results.push(...dynamicQueries);
  }

  return results;
}
