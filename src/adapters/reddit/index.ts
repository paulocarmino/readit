import { z } from 'zod';
import { UserFacingError } from '../../errors.js';
import { extractContent } from '../generic/extract.js';
import type { AdapterContext, PageResult } from '../types.js';
import { defineAdapter } from '../types.js';
import { RedditBlockedError, RedditClient } from './client.js';
import { parseCommentThings, parseListing, parsePost, type TreeNode } from './model.js';
import { assertNotLoginWall, readOldRedditThread } from './old-reddit.js';
import { formatDate, renderListing, renderThread } from './render.js';
import { expandMore } from './tree.js';
import {
  isRedditContentUrl,
  listingJsonUrl,
  parseRedditUrl,
  threadJsonUrl,
  type RedditTarget,
} from './url.js';

const optionsSchema = z.object({
  sort: z
    .enum(['confidence', 'top', 'new', 'controversial', 'old', 'qa'])
    .default('confidence')
    .describe('Comment sort (confidence = "best").'),
  expand_more: z.boolean().default(true).describe('Load "more comments" / "continue this thread".'),
  max_more_requests: z
    .number()
    .int()
    .min(0)
    .max(100)
    .default(15)
    .describe('Budget of extra requests used to expand hidden comments.'),
  max_depth: z.number().int().min(0).optional().describe('Summarize replies deeper than this.'),
  min_score: z
    .number()
    .int()
    .optional()
    .describe('Hide comments (and their replies) below this score.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe('Items per page for subreddit/user/search listings.'),
});

type RedditOptions = z.infer<typeof optionsSchema>;

type ThreadTarget = Extract<RedditTarget, { kind: 'thread' }>;
type ListingTarget = Extract<RedditTarget, { kind: 'listing' }>;

const moreChildrenSchema = z.object({
  json: z.object({
    data: z
      .object({ things: z.array(z.object({ kind: z.string(), data: z.unknown() })) })
      .optional(),
  }),
});

function threadMeta(
  post: {
    subreddit: string;
    author: string;
    score: number;
    upvoteRatio: number | null;
    numComments: number;
    createdUtc: number;
  },
  source: string
): Record<string, string | number> {
  const meta: Record<string, string | number> = {
    subreddit: `r/${post.subreddit}`,
    author: `u/${post.author}`,
    score:
      post.upvoteRatio === null
        ? post.score
        : `${post.score} (${Math.round(post.upvoteRatio * 100)}% upvoted)`,
    comments: post.numComments,
    posted: formatDate(post.createdUtc),
    source,
  };
  return meta;
}

async function readThread(
  target: ThreadTarget,
  options: RedditOptions,
  client: RedditClient,
  ctx: AdapterContext
): Promise<PageResult> {
  const json = await client.getJson(
    threadJsonUrl(target.postId, { sort: options.sort, commentId: target.commentId, context: 3 })
  );
  if (!Array.isArray(json) || json.length < 2) throw new Error('Unexpected thread JSON shape');

  const post = parsePost(parseListing(json[0])?.children[0]?.data);
  if (!post) throw new Error('Could not parse the post from the thread JSON');
  const comments = parseCommentThings(parseListing(json[1])?.children ?? []);

  let requests = 0;
  if (options.expand_more && options.max_more_requests > 0) {
    requests = await expandMore(
      comments,
      {
        moreChildren: async (ids) => {
          const params = new URLSearchParams({
            api_type: 'json',
            link_id: `t3_${post.id}`,
            children: ids.join(','),
            sort: options.sort,
            limit_children: 'false',
            raw_json: '1',
          });
          const res = moreChildrenSchema.parse(
            await client.getJson(
              `https://www.reddit.com/api/morechildren.json?${params.toString()}`
            )
          );
          return parseCommentThings(res.json.data?.things ?? []);
        },
        continueThread: async (commentId): Promise<TreeNode[]> => {
          const sub = await client.getJson(
            threadJsonUrl(post.id, { sort: options.sort, commentId })
          );
          if (!Array.isArray(sub)) return [];
          const focused = parseCommentThings(parseListing(sub[1])?.children ?? [])[0];
          return focused?.type === 'comment' ? focused.children : [];
        },
      },
      options.max_more_requests,
      ctx.logger
    );
  }

  const warnings: string[] = [];
  if (target.commentId) {
    warnings.push(
      'This is a single-comment permalink (with 3 parent comments). Drop the comment id from the URL to read the full thread.'
    );
  }

  return {
    title: post.title,
    url: target.commentId ? `${post.permalink}${target.commentId}/` : post.permalink,
    markdown: renderThread(
      post,
      comments,
      { maxDepth: options.max_depth, minScore: options.min_score },
      options.sort
    ),
    meta: { ...threadMeta(post, `json via ${client.strategy}`), 'expand requests': requests },
    warnings,
  };
}

async function readListing(
  target: ListingTarget,
  options: RedditOptions,
  client: RedditClient
): Promise<PageResult> {
  const listing = parseListing(
    await client.getJson(listingJsonUrl(target.path, target.search, options.limit))
  );
  if (!listing) throw new Error('Unexpected listing JSON shape');

  const pageUrl = `https://www.reddit.com${target.path}${target.search}`;
  let markdown = renderListing(listing.children, parsePost) || '_Empty listing._';
  if (listing.after) {
    const next = new URL(pageUrl);
    next.searchParams.set('after', listing.after);
    markdown += `\n\nNext page: ${next.href}`;
  }
  return {
    title: target.path === '/' ? 'Reddit front page' : target.path,
    url: pageUrl,
    markdown,
    meta: { source: `json via ${client.strategy}` },
  };
}

async function readThreadFromOldReddit(
  target: ThreadTarget,
  options: RedditOptions,
  ctx: AdapterContext
): Promise<PageResult> {
  const focus = target.commentId ? `/_/${target.commentId}` : '';
  const url = `https://old.reddit.com/comments/${target.postId}${focus}/?limit=500&sort=${options.sort}`;
  return ctx.withPage(
    url,
    async (page, warnings) => {
      const { post, comments } = await readOldRedditThread(page);
      return {
        title: post.title,
        url: post.permalink,
        markdown: renderThread(
          post,
          comments,
          { maxDepth: options.max_depth, minScore: options.min_score },
          options.sort
        ),
        meta: threadMeta(post, 'old.reddit DOM (JSON was blocked)'),
        warnings: [
          ...warnings,
          'Read from old.reddit HTML: "load more comments" were not expanded.',
        ],
      };
    },
    { waitForStableContent: false }
  );
}

async function readListingFromOldReddit(
  target: ListingTarget,
  ctx: AdapterContext
): Promise<PageResult> {
  const url = `https://old.reddit.com${target.path}${target.search}`;
  return ctx.withPage(
    url,
    async (page, warnings) => {
      assertNotLoginWall(page);
      const extracted = extractContent(await page.content(), page.url(), '#siteTable');
      return {
        title: extracted.title,
        url: page.url(),
        markdown: extracted.markdown,
        meta: { source: 'old.reddit DOM (JSON was blocked)' },
        warnings: [...warnings, ...extracted.warnings],
      };
    },
    { waitForStableContent: false }
  );
}

/**
 * Reddit adapter: threads (post + full comment tree, expanding "more comments") and listings
 * (subreddits, users, search), read from Reddit's JSON with the logged-in profile's cookies.
 * Falls back to old.reddit.com HTML when the JSON endpoints are rejected.
 */
export const redditAdapter = defineAdapter({
  name: 'reddit',
  description:
    'Reddit threads (post + full nested comment tree with author/score) and listings (subreddit, user, search) via the JSON API with your logged-in cookies.',
  hosts: ['reddit.com', 'redd.it'],
  matches: isRedditContentUrl,
  optionsSchema,
  read: (url, options, ctx) =>
    ctx.withTab(async (tab) => {
      const client = new RedditClient(ctx.request, tab, ctx.timeoutMs, ctx.logger);
      let target = parseRedditUrl(url);

      try {
        if (target.kind === 'share') {
          target = parseRedditUrl(new URL(await client.resolveRedirect(target.url)));
          if (target.kind === 'share')
            throw new UserFacingError(`Could not resolve Reddit share link ${url.href}`);
        }
        return target.kind === 'thread'
          ? await readThread(target, options, client, ctx)
          : await readListing(target, options, client);
      } catch (error) {
        if (!(error instanceof RedditBlockedError) || target.kind === 'share') throw error;
        ctx.logger.warn(
          { error: error.message },
          'Reddit JSON blocked, falling back to old.reddit DOM'
        );
        return target.kind === 'thread'
          ? readThreadFromOldReddit(target, options, ctx)
          : readListingFromOldReddit(target, ctx);
      }
    }),
});
