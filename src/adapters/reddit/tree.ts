import type { Logger } from '../../logger.js';
import type { CommentNode, MoreNode, TreeNode } from './model.js';

/** /api/morechildren accepts at most 100 ids per call. */
const MORE_CHILDREN_BATCH = 100;

/** Network calls the expansion needs, injected by the adapter. */
export interface ExpandDeps {
  /** Calls /api/morechildren and returns the flat list of nodes it produced. */
  moreChildren: (ids: string[]) => Promise<TreeNode[]>;
  /** Fetches the replies of a comment ("continue this thread"). */
  continueThread: (commentId: string) => Promise<TreeNode[]>;
}

interface Slot {
  container: TreeNode[];
  index: number;
  node: MoreNode;
}

/**
 * Rebuilds nesting for the flat list returned by /api/morechildren: a node goes under its parent
 * when the parent came in the same batch; otherwise it takes the place of the expanded "more".
 */
function nestFlat(flat: TreeNode[]): TreeNode[] {
  const batch = new Map<string, CommentNode>();
  const top: TreeNode[] = [];
  for (const node of flat) {
    const parent = batch.get(node.parentId);
    if (parent) parent.children.push(node);
    else top.push(node);
    if (node.type === 'comment') batch.set(node.name, node);
  }
  return top;
}

/**
 * Expands "load more comments" and "continue this thread" placeholders in place,
 * shallowest first, until none are left or the request budget runs out.
 * Failed requests leave the placeholder in the tree (rendered as "not loaded").
 *
 * @param roots - Top-level comment nodes (mutated)
 * @param deps - Network calls
 * @param maxRequests - Request budget
 * @param log - Logger
 * @returns Number of requests made
 */
export async function expandMore(
  roots: TreeNode[],
  deps: ExpandDeps,
  maxRequests: number,
  log: Logger
): Promise<number> {
  let requests = 0;
  const skipped = new Set<MoreNode>();

  while (requests < maxRequests) {
    const slot = findShallowestMore(roots, skipped);
    if (!slot) break;
    const { container, index, node } = slot;
    requests += 1;

    try {
      if (node.childIds.length === 0) {
        const commentId = node.parentId.replace(/^t1_/, '');
        const replies = await deps.continueThread(commentId);
        container.splice(index, 1, ...replies);
        continue;
      }

      const ids = node.childIds.slice(0, MORE_CHILDREN_BATCH);
      const rest = node.childIds.slice(MORE_CHILDREN_BATCH);
      const added = nestFlat(await deps.moreChildren(ids));
      const remainder: TreeNode[] =
        rest.length > 0
          ? [{ ...node, childIds: rest, count: Math.max(rest.length, node.count - ids.length) }]
          : [];
      container.splice(index, 1, ...added, ...remainder);
    } catch (error) {
      log.warn(
        { moreId: node.id, error: error instanceof Error ? error.message : String(error) },
        'Could not expand more comments'
      );
      skipped.add(node);
    }
  }
  return requests;
}

/** Finds the shallowest pending "more" node (breadth-first), so top-level comments load first. */
function findShallowestMore(roots: TreeNode[], skipped: Set<MoreNode>): Slot | null {
  let level: TreeNode[][] = [roots];
  while (level.length > 0) {
    const next: TreeNode[][] = [];
    for (const container of level) {
      for (let index = 0; index < container.length; index++) {
        const node = container[index];
        if (!node) continue;
        if (node.type === 'more') {
          if (!skipped.has(node)) return { container, index, node };
        } else if (node.children.length > 0) {
          next.push(node.children);
        }
      }
    }
    level = next;
  }
  return null;
}

/**
 * Counts comments in a subtree (placeholders count as their `count`).
 *
 * @param nodes - Subtree roots
 * @returns Number of comments, loaded or not
 */
export function countComments(nodes: readonly TreeNode[]): { loaded: number; notLoaded: number } {
  let loaded = 0;
  let notLoaded = 0;
  for (const node of nodes) {
    if (node.type === 'more') {
      notLoaded += Math.max(node.count, node.childIds.length, 1);
    } else {
      loaded += 1;
      const sub = countComments(node.children);
      loaded += sub.loaded;
      notLoaded += sub.notLoaded;
    }
  }
  return { loaded, notLoaded };
}
