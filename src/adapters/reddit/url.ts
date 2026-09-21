/** What a Reddit URL points to. */
export type RedditTarget =
  | { kind: 'thread'; postId: string; commentId?: string }
  | { kind: 'share'; url: string }
  | { kind: 'listing'; path: string; search: string };

/** Paths that are app pages, not content. Left to the generic adapter. */
const NON_CONTENT_PATH =
  /^\/(login|register|settings|prefs|submit|message|notifications|chat|mod|premium|coins)(\/|$)/i;

/** Base36 Reddit id. */
const ID = '[a-z0-9]{2,10}';
const THREAD_PATH = new RegExp(`/comments/(${ID})(?:/[^/]*(?:/(${ID}))?)?/?$`, 'i');
const GALLERY_PATH = new RegExp(`^/gallery/(${ID})/?$`, 'i');
const SHARE_PATH = /^\/r\/[^/]+\/s\/[A-Za-z0-9]+\/?$/;

/**
 * Tells whether the Reddit adapter should handle this URL.
 *
 * @param url - URL on a Reddit host
 * @returns False for login/settings/etc. pages
 */
export function isRedditContentUrl(url: URL): boolean {
  return !NON_CONTENT_PATH.test(url.pathname);
}

/**
 * Classifies a Reddit URL (www/old/new/np/redd.it, share links, permalinks, listings).
 *
 * @param url - URL on a Reddit host
 * @returns Thread (post id + optional focused comment), share link, or listing path
 */
export function parseRedditUrl(url: URL): RedditTarget {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\.json$/i, '');

  if (host === 'redd.it' || host.endsWith('.redd.it')) {
    const id = path.split('/').filter(Boolean)[0];
    if (id) return { kind: 'thread', postId: id.toLowerCase() };
  }

  const thread = THREAD_PATH.exec(path);
  if (thread?.[1]) {
    return {
      kind: 'thread',
      postId: thread[1].toLowerCase(),
      ...(thread[2] ? { commentId: thread[2].toLowerCase() } : {}),
    };
  }

  const gallery = GALLERY_PATH.exec(path);
  if (gallery?.[1]) return { kind: 'thread', postId: gallery[1].toLowerCase() };

  if (SHARE_PATH.test(path)) return { kind: 'share', url: `https://www.reddit.com${path}` };

  const params = new URLSearchParams(url.search);
  params.delete('raw_json');
  const search = params.toString();
  return {
    kind: 'listing',
    path: path.replace(/\/+$/, '') || '/',
    search: search ? `?${search}` : '',
  };
}

/**
 * JSON endpoint of a thread.
 *
 * @param postId - Post id (without t3_)
 * @param options - Sort, a comment to focus on, and how many parent comments to include above it
 * @returns www.reddit.com .json URL
 */
export function threadJsonUrl(
  postId: string,
  options: { sort: string; commentId?: string; context?: number }
): string {
  const focus = options.commentId ? `/_/${options.commentId}` : '';
  const params = new URLSearchParams({ raw_json: '1', limit: '500', sort: options.sort });
  if (options.commentId && options.context) params.set('context', String(options.context));
  return `https://www.reddit.com/comments/${postId}${focus}.json?${params.toString()}`;
}

/**
 * JSON endpoint of a listing (subreddit, user, search, front page).
 *
 * @param path - Listing path without .json
 * @param search - Original query string (with leading ?), may be empty
 * @param limit - Items per page
 * @returns www.reddit.com .json URL
 */
export function listingJsonUrl(path: string, search: string, limit: number): string {
  const params = new URLSearchParams(search);
  params.set('raw_json', '1');
  if (!params.has('limit')) params.set('limit', String(limit));
  const base = path === '/' ? '/' : `${path}/`;
  return `https://www.reddit.com${base}.json?${params.toString()}`;
}
