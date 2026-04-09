import { Project, Node, CallExpression, SyntaxKind } from 'ts-morph';
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
 * Walk backward through a method chain starting at `call`, collecting each
 * method name and its string-literal arguments.
 *
 * e.g. firestore.collection('A').where('f','==',v).get()
 *  → [{ collection, ['A'] }, { where, ['f','==',null] }, { get, [] }]
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
 * Walk UP the AST from `node` to find the outermost CallExpression that is
 * still part of the same method chain (i.e., stop when the parent is not a
 * property-access of another call).
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
 * Given an unrolled Admin SDK chain, produce an ExtractedQuery.
 * Returns null if collection name is not a string literal (conservative rule).
 */
function queryFromAdminChain(
  steps: ChainStep[],
  sourceFile: string,
  sourceLine: number,
): ExtractedQuery | null {
  // Find the LAST 'collection' or 'collectionGroup' step (handles subcollection chains)
  let collectionStep: ChainStep | undefined;
  for (const step of steps) {
    if (step.name === 'collection' || step.name === 'collectionGroup') {
      collectionStep = step;
    }
  }
  if (!collectionStep) return null;

  // Collection name must be a string literal — conservative rule
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
      // dynamic field → skip (conservative)
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

/**
 * Client SDK: query(collection(db, 'name'), where(...), orderBy(...))
 */
function queryFromClientCall(
  call: CallExpression,
  sourceFile: string,
  sourceLine: number,
): ExtractedQuery | null {
  const args = call.getArguments();
  if (args.length < 2) return null;

  // First arg must be collection(db, 'name') or collectionGroup(db, 'name')
  const firstArg = args[0];
  if (!Node.isCallExpression(firstArg)) return null;

  const callee = firstArg.getExpression();
  if (!Node.isIdentifier(callee)) return null;

  const calleeName = callee.getText();
  if (calleeName !== 'collection' && calleeName !== 'collectionGroup') return null;

  const isCollectionGroup = calleeName === 'collectionGroup';

  // Collection name = last string literal arg of collection() (after the db ref)
  let collectionName: string | null = null;
  for (const arg of firstArg.getArguments()) {
    const lit = getStringLit(arg);
    if (lit) collectionName = lit;
  }
  if (!collectionName) return null;

  const whereClauses: WhereClause[] = [];
  const orderByClauses: OrderByClause[] = [];

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!Node.isCallExpression(arg)) continue;

    const argCallee = arg.getExpression();
    if (!Node.isIdentifier(argCallee)) continue;

    const fnName = argCallee.getText();
    const fnArgs = arg.getArguments().map(getStringLit);

    if (fnName === 'where') {
      const field = fnArgs[0];
      const op = parseOp(fnArgs[1]);
      if (field && op) whereClauses.push({ field, op });
    } else if (fnName === 'orderBy') {
      const field = fnArgs[0];
      if (field) {
        const dir = fnArgs[1]?.toLowerCase() === 'desc' ? 'desc' : 'asc';
        orderByClauses.push({ field, dir });
      }
    }
  }

  return { collection: collectionName, isCollectionGroup, whereClauses, orderByClauses, sourceFile, sourceLine };
}

export function extractQueries(project: Project): ExtractedQuery[] {
  const results: ExtractedQuery[] = [];

  // Track topmost node positions to avoid processing the same chain twice
  const processedChains = new Set<number>();

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    const callNodes = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const call of callNodes) {
      const expr = call.getExpression();

      // ── Admin SDK ─────────────────────────────────────────────────────────
      // Detect .collection('literal') or .collectionGroup('literal') method calls.
      // Walk up to the topmost call in the chain and unroll from there.
      if (Node.isPropertyAccessExpression(expr)) {
        const methodName = expr.getName();
        if (methodName === 'collection' || methodName === 'collectionGroup') {
          // First arg must be a string literal
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

      // ── Client SDK ────────────────────────────────────────────────────────
      // Detect query(collection(db, 'name'), where(...), orderBy(...))
      if (Node.isIdentifier(expr) && expr.getText() === 'query') {
        const query = queryFromClientCall(call, filePath, call.getStartLineNumber());
        if (query) results.push(query);
      }
    }
  }

  return results;
}
