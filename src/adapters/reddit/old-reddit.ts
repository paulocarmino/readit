import type { Page } from 'playwright';
import { UserFacingError } from '../../errors.js';
import { htmlToMarkdown } from '../generic/extract.js';
import type { RedditPost, TreeNode } from './model.js';

interface RawComment {
  kind: 'comment';
  id: string;
  author: string;
  score: number | null;
  timestamp: number;
  bodyHtml: string;
  isOp: boolean;
  children: RawNode[];
}

interface RawMore {
  kind: 'more';
  count: number;
}

type RawNode = RawComment | RawMore;

interface RawThread {
  post: {
    id: string;
    title: string;
    author: string;
    subreddit: string;
    score: number;
    comments: number;
    timestamp: number;
    url: string;
    permalink: string;
    selftextHtml: string;
  } | null;
  comments: RawNode[];
}

/**
 * Throws a clear error when old.reddit redirected to the login page.
 *
 * @param page - Page after navigation
 */
export function assertNotLoginWall(page: Page): void {
  if (/\/login\b/.test(new URL(page.url()).pathname)) {
    throw new UserFacingError(
      'Reddit requires login for this browser profile. Call open_browser("https://www.reddit.com/login"), log in in the window, then call read_page again.',
      'login'
    );
  }
}

function toTree(nodes: RawNode[], parentId: string): TreeNode[] {
  return nodes.map((node): TreeNode => {
    if (node.kind === 'more') {
      return { type: 'more', id: `more-${parentId}`, parentId, count: node.count, childIds: [] };
    }
    const name = `t1_${node.id}`;
    return {
      type: 'comment',
      id: node.id,
      name,
      parentId,
      author: node.author,
      body: htmlToMarkdown(node.bodyHtml),
      score: node.score,
      createdUtc: Math.floor(node.timestamp / 1000),
      edited: false,
      isSubmitter: node.isOp,
      stickied: false,
      distinguished: null,
      flair: null,
      children: toTree(node.children, name),
    };
  });
}

/**
 * Reads a thread from an already-open old.reddit.com comments page, in a single `page.evaluate`.
 * Used when the JSON endpoints are rejected.
 *
 * @param page - Page showing an old.reddit thread
 * @returns Post and comment tree ("load more" links become placeholders that are not expanded)
 * @throws UserFacingError on login wall
 */
export async function readOldRedditThread(
  page: Page
): Promise<{ post: RedditPost; comments: TreeNode[] }> {
  assertNotLoginWall(page);

  const raw = await page.evaluate((): RawThread => {
    const num = (value: string | undefined | null): number => {
      const n = Number.parseInt(value ?? '', 10);
      return Number.isFinite(n) ? n : 0;
    };

    const walk = (container: Element | null): RawNode[] => {
      if (!container) return [];
      const out: RawNode[] = [];
      for (const el of container.querySelectorAll(':scope > .thing')) {
        if (el.classList.contains('morechildren') || el.classList.contains('morerecursion')) {
          out.push({ kind: 'more', count: num(/\d+/.exec(el.textContent ?? '')?.[0]) });
          continue;
        }
        if (!el.classList.contains('comment')) continue;
        const html = el as HTMLElement;
        const scoreTitle = el
          .querySelector(':scope > .entry .tagline .score.unvoted')
          ?.getAttribute('title');
        const time = el.querySelector(':scope > .entry .tagline time')?.getAttribute('datetime');
        out.push({
          kind: 'comment',
          id: (html.dataset.fullname ?? '').replace(/^t1_/, ''),
          author: html.dataset.author ?? '[deleted]',
          score: scoreTitle ? num(scoreTitle) : null,
          timestamp: time ? Date.parse(time) : 0,
          bodyHtml: el.querySelector(':scope > .entry .usertext-body .md')?.innerHTML ?? '',
          isOp: el.querySelector(':scope > .entry .tagline .submitter') !== null,
          children: walk(el.querySelector(':scope > .child > .sitetable')),
        });
      }
      return out;
    };

    const postEl = document.querySelector<HTMLElement>('#siteTable > .thing.link');
    const post = postEl
      ? {
          id: (postEl.dataset.fullname ?? '').replace(/^t3_/, ''),
          title: postEl.querySelector('a.title')?.textContent?.trim() ?? document.title,
          author: postEl.dataset.author ?? '[deleted]',
          subreddit: postEl.dataset.subreddit ?? '',
          score: num(postEl.dataset.score),
          comments: num(postEl.dataset.commentsCount),
          timestamp: num(postEl.dataset.timestamp),
          url: postEl.dataset.url ?? '',
          permalink: postEl.dataset.permalink ?? location.pathname,
          selftextHtml: postEl.querySelector('.usertext-body .md')?.innerHTML ?? '',
        }
      : null;

    return { post, comments: walk(document.querySelector('.commentarea > .sitetable')) };
  });

  if (!raw.post) throw new Error(`Could not find the post on ${page.url()}`);
  const p = raw.post;
  const isSelf = p.url.startsWith('/r/') || p.url.includes(p.permalink);

  return {
    post: {
      id: p.id,
      title: p.title,
      subreddit: p.subreddit,
      author: p.author,
      score: p.score,
      upvoteRatio: null,
      numComments: p.comments,
      createdUtc: Math.floor(p.timestamp / 1000),
      selftext: htmlToMarkdown(p.selftextHtml),
      url: p.url,
      permalink: `https://www.reddit.com${p.permalink}`,
      isSelf,
      flair: null,
      nsfw: false,
      spoiler: false,
      locked: false,
      media: [],
      crosspostFrom: null,
    },
    comments: toTree(raw.comments, `t3_${p.id}`),
  };
}
