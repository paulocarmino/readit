import { z } from 'zod';

/** A comment in the tree. `body` is markdown. */
export interface CommentNode {
  type: 'comment';
  id: string;
  /** Fullname, e.g. t1_abc. */
  name: string;
  parentId: string;
  author: string;
  body: string;
  score: number | null;
  createdUtc: number;
  edited: boolean;
  isSubmitter: boolean;
  stickied: boolean;
  distinguished: string | null;
  flair: string | null;
  children: TreeNode[];
}

/** A "load more comments" / "continue this thread" placeholder. */
export interface MoreNode {
  type: 'more';
  id: string;
  parentId: string;
  count: number;
  /** Ids to request from /api/morechildren. Empty means "continue this thread". */
  childIds: string[];
}

export type TreeNode = CommentNode | MoreNode;

/** The submission. */
export interface RedditPost {
  id: string;
  title: string;
  subreddit: string;
  author: string;
  score: number;
  upvoteRatio: number | null;
  numComments: number;
  createdUtc: number;
  selftext: string;
  url: string;
  permalink: string;
  isSelf: boolean;
  flair: string | null;
  nsfw: boolean;
  spoiler: boolean;
  locked: boolean;
  media: string[];
  crosspostFrom: string | null;
}

const thingSchema = z.object({ kind: z.string(), data: z.record(z.string(), z.unknown()) });

const listingSchema = z.object({
  kind: z.literal('Listing'),
  data: z.object({
    children: z.array(thingSchema),
    after: z.string().nullable().optional(),
  }),
});

const commentSchema = z.object({
  id: z.string(),
  name: z.string(),
  parent_id: z.string(),
  author: z.string().catch('[deleted]'),
  body: z.string().catch(''),
  score: z.number().catch(0),
  score_hidden: z.boolean().catch(false),
  created_utc: z.number().catch(0),
  edited: z.union([z.boolean(), z.number()]).catch(false),
  is_submitter: z.boolean().catch(false),
  stickied: z.boolean().catch(false),
  distinguished: z.string().nullable().catch(null),
  author_flair_text: z.string().nullable().catch(null),
  replies: z.unknown().optional(),
});

const moreSchema = z.object({
  id: z.string(),
  parent_id: z.string(),
  count: z.number().catch(0),
  children: z.array(z.string()).catch([]),
});

const mediaMetadataSchema = z.record(
  z.string(),
  z.object({ s: z.object({ u: z.string().optional(), gif: z.string().optional() }).optional() })
);

const postSchema = z.object({
  id: z.string(),
  title: z.string(),
  subreddit: z.string(),
  author: z.string().catch('[deleted]'),
  score: z.number().catch(0),
  upvote_ratio: z.number().nullable().catch(null),
  num_comments: z.number().catch(0),
  created_utc: z.number().catch(0),
  selftext: z.string().catch(''),
  url: z.string().catch(''),
  permalink: z.string(),
  is_self: z.boolean().catch(true),
  link_flair_text: z.string().nullable().catch(null),
  over_18: z.boolean().catch(false),
  spoiler: z.boolean().catch(false),
  locked: z.boolean().catch(false),
  media_metadata: mediaMetadataSchema.nullable().catch(null),
  gallery_data: z
    .object({ items: z.array(z.object({ media_id: z.string() })) })
    .nullable()
    .catch(null),
  secure_media: z
    .object({ reddit_video: z.object({ fallback_url: z.string() }).optional() })
    .nullable()
    .catch(null),
  crosspost_parent_list: z.array(z.object({ permalink: z.string() })).catch([]),
});

/** Parsed listing: raw things plus the pagination cursor. */
export interface Listing {
  children: Array<{ kind: string; data: Record<string, unknown> }>;
  after: string | null;
}

/**
 * Validates a Reddit Listing.
 *
 * @param value - Unknown JSON
 * @returns The listing, or null if it is not one
 */
export function parseListing(value: unknown): Listing | null {
  const parsed = listingSchema.safeParse(value);
  if (!parsed.success) return null;
  return { children: parsed.data.data.children, after: parsed.data.data.after ?? null };
}

/**
 * Converts raw t1/more things (optionally with nested `replies`) into tree nodes.
 *
 * @param things - Items of a Listing's `children`, or the flat `things` of /api/morechildren
 * @returns Tree nodes, preserving order
 */
export function parseCommentThings(
  things: ReadonlyArray<{ kind: string; data: unknown }>
): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const thing of things) {
    if (thing.kind === 't1') {
      const c = commentSchema.safeParse(thing.data);
      if (!c.success) continue;
      const replies = parseListing(c.data.replies);
      nodes.push({
        type: 'comment',
        id: c.data.id,
        name: c.data.name,
        parentId: c.data.parent_id,
        author: c.data.author,
        body: c.data.body,
        score: c.data.score_hidden ? null : c.data.score,
        createdUtc: c.data.created_utc,
        edited: c.data.edited !== false,
        isSubmitter: c.data.is_submitter,
        stickied: c.data.stickied,
        distinguished: c.data.distinguished,
        flair: c.data.author_flair_text,
        children: replies ? parseCommentThings(replies.children) : [],
      });
    } else if (thing.kind === 'more') {
      const m = moreSchema.safeParse(thing.data);
      if (!m.success) continue;
      const childIds = m.data.id === '_' ? [] : m.data.children;
      nodes.push({
        type: 'more',
        id: m.data.id,
        parentId: m.data.parent_id,
        count: m.data.count,
        childIds,
      });
    }
  }
  return nodes;
}

function decodeMediaUrl(url: string): string {
  return url.replace(/&amp;/g, '&');
}

/**
 * Converts a raw t3 `data` object into a post.
 *
 * @param data - The `data` of a t3 thing
 * @returns The post, or null if it does not look like one
 */
export function parsePost(data: unknown): RedditPost | null {
  const parsed = postSchema.safeParse(data);
  if (!parsed.success) return null;
  const p = parsed.data;

  const media: string[] = [];
  if (p.gallery_data && p.media_metadata) {
    for (const item of p.gallery_data.items) {
      const source = p.media_metadata[item.media_id]?.s;
      const url = source?.u ?? source?.gif;
      if (url) media.push(decodeMediaUrl(url));
    }
  }
  const video = p.secure_media?.reddit_video?.fallback_url;
  if (video) media.push(decodeMediaUrl(video));

  return {
    id: p.id,
    title: p.title,
    subreddit: p.subreddit,
    author: p.author,
    score: p.score,
    upvoteRatio: p.upvote_ratio,
    numComments: p.num_comments,
    createdUtc: p.created_utc,
    selftext: p.selftext,
    url: p.url,
    permalink: `https://www.reddit.com${p.permalink}`,
    isSelf: p.is_self,
    flair: p.link_flair_text,
    nsfw: p.over_18,
    spoiler: p.spoiler,
    locked: p.locked,
    media,
    crosspostFrom: p.crosspost_parent_list[0]
      ? `https://www.reddit.com${p.crosspost_parent_list[0].permalink}`
      : null,
  };
}
