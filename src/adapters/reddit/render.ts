import type { CommentNode, RedditPost, TreeNode } from './model.js';
import { countComments } from './tree.js';

/** Filters applied while rendering comments. */
export interface RenderOptions {
  /** Deeper replies are summarized as a count. */
  maxDepth?: number;
  /** Comments (and their replies) below this score are hidden. */
  minScore?: number;
}

/**
 * Formats a unix timestamp as `YYYY-MM-DD HH:MM UTC`.
 *
 * @param seconds - Unix time in seconds
 * @returns Formatted date, or empty string for 0
 */
export function formatDate(seconds: number): string {
  if (!seconds) return '';
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function indentBlock(text: string, indent: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `${indent}${line}`))
    .join('\n');
}

function commentHeader(c: CommentNode): string {
  const tags: string[] = [];
  if (c.isSubmitter) tags.push('OP');
  if (c.distinguished) tags.push(c.distinguished);
  if (c.stickied) tags.push('pinned');
  const tagText = tags.length > 0 ? ` (${tags.join(', ')})` : '';
  const flair = c.flair ? ` [${c.flair}]` : '';
  const score = c.score === null ? 'score hidden' : `${c.score} pts`;
  const date = formatDate(c.createdUtc);
  return `**u/${c.author}**${tagText}${flair} · ${score}${date ? ` · ${date}` : ''}${c.edited ? ' · edited' : ''}`;
}

interface RenderState {
  lines: string[];
  hiddenByScore: number;
}

function renderNodes(
  nodes: readonly TreeNode[],
  depth: number,
  opts: RenderOptions,
  state: RenderState
): void {
  const indent = '  '.repeat(depth);
  for (const node of nodes) {
    if (node.type === 'more') {
      const n = Math.max(node.count, node.childIds.length);
      const label = node.childIds.length === 0 ? 'continue this thread' : `${n} more replies`;
      state.lines.push(`${indent}- _[${label} — not loaded]_`);
      continue;
    }

    if (
      opts.minScore !== undefined &&
      node.score !== null &&
      node.score < opts.minScore &&
      !node.stickied
    ) {
      state.hiddenByScore += 1 + countComments(node.children).loaded;
      continue;
    }

    state.lines.push(`${indent}- ${commentHeader(node)}`);
    const body = node.body.trim() === '' ? '_[empty]_' : node.body;
    state.lines.push(indentBlock(body, `${indent}  `));

    if (node.children.length === 0) continue;
    if (opts.maxDepth !== undefined && depth + 1 > opts.maxDepth) {
      const { loaded, notLoaded } = countComments(node.children);
      state.lines.push(`${indent}  - _[${loaded + notLoaded} replies below max_depth]_`);
      continue;
    }
    renderNodes(node.children, depth + 1, opts, state);
  }
}

/**
 * Renders the comment tree as a nested markdown list.
 *
 * @param comments - Top-level nodes
 * @param opts - Depth/score filters
 * @returns Markdown and how many comments were hidden by min_score
 */
export function renderComments(
  comments: readonly TreeNode[],
  opts: RenderOptions = {}
): { markdown: string; hiddenByScore: number } {
  const state: RenderState = { lines: [], hiddenByScore: 0 };
  renderNodes(comments, 0, opts, state);
  return { markdown: state.lines.join('\n'), hiddenByScore: state.hiddenByScore };
}

/**
 * Renders the post body: link/media, flags and selftext.
 *
 * @param post - The submission
 * @returns Markdown
 */
export function renderPostBody(post: RedditPost): string {
  const parts: string[] = [];
  const flags = [post.nsfw && 'NSFW', post.spoiler && 'spoiler', post.locked && 'locked'].filter(
    Boolean
  );
  if (flags.length > 0) parts.push(`_[${flags.join(', ')}]_`);
  if (post.flair) parts.push(`Flair: ${post.flair}`);
  if (post.crosspostFrom) parts.push(`Crossposted from: ${post.crosspostFrom}`);
  if (!post.isSelf && post.url && post.media.length === 0) parts.push(`Link: ${post.url}`);
  if (post.media.length > 0) parts.push(`Media:\n${post.media.map((m) => `- ${m}`).join('\n')}`);
  if (post.selftext.trim()) parts.push(post.selftext.trim());
  return parts.join('\n\n');
}

/**
 * Renders a whole thread: post, then comments with a count line.
 *
 * @param post - The submission
 * @param comments - Top-level comment nodes (already expanded)
 * @param opts - Depth/score filters
 * @param sort - Sort used, for the heading
 * @returns Markdown
 */
export function renderThread(
  post: RedditPost,
  comments: readonly TreeNode[],
  opts: RenderOptions,
  sort: string
): string {
  const { loaded, notLoaded } = countComments(comments);
  const rendered = renderComments(comments, opts);
  const counts = [`${loaded} loaded`];
  if (notLoaded > 0) counts.push(`~${notLoaded} not loaded`);
  if (rendered.hiddenByScore > 0) counts.push(`${rendered.hiddenByScore} hidden by min_score`);

  const sections = [
    renderPostBody(post),
    `## Comments (sort: ${sort}; ${counts.join(', ')}; post says ${post.numComments})`,
  ];
  sections.push(rendered.markdown || '_No comments._');
  return sections.filter((s) => s.trim() !== '').join('\n\n');
}

/**
 * Renders a listing (subreddit, user page, search) as a numbered list.
 *
 * @param items - Raw things of the listing
 * @param parsePostFn - Post parser (t3)
 * @returns Markdown
 */
export function renderListing(
  items: ReadonlyArray<{ kind: string; data: Record<string, unknown> }>,
  parsePostFn: (data: unknown) => RedditPost | null
): string {
  const lines: string[] = [];
  let n = 0;
  for (const item of items) {
    if (item.kind === 't3') {
      const post = parsePostFn(item.data);
      if (!post) continue;
      n += 1;
      const date = formatDate(post.createdUtc);
      lines.push(
        `${n}. **${post.title}** — r/${post.subreddit} · u/${post.author} · ${post.score} pts · ${post.numComments} comments${date ? ` · ${date}` : ''}${post.flair ? ` · [${post.flair}]` : ''}`
      );
      lines.push(`   ${post.permalink}`);
      if (!post.isSelf && post.url) lines.push(`   Link: ${post.url}`);
      const snippet = post.selftext.trim().replace(/\s+/g, ' ');
      if (snippet)
        lines.push(`   > ${snippet.length > 300 ? `${snippet.slice(0, 300)}…` : snippet}`);
    } else if (item.kind === 't1') {
      const d = item.data;
      const str = (key: string): string => (typeof d[key] === 'string' ? d[key] : '');
      const score = typeof d.score === 'number' ? d.score : 0;
      const created = typeof d.created_utc === 'number' ? d.created_utc : 0;
      n += 1;
      lines.push(
        `${n}. **u/${str('author')}** in r/${str('subreddit')} on "${str('link_title')}" · ${score} pts · ${formatDate(created)}`
      );
      lines.push(`   https://www.reddit.com${str('permalink')}`);
      lines.push(indentBlock(str('body'), '   > '));
    }
  }
  return lines.join('\n');
}
