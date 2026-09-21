import type { Page } from 'playwright';

/** Title fragments used by Cloudflare and similar interstitials (from scoutify-shared/cloudflare.ts). */
const CHALLENGE_TITLE_PATTERNS: readonly string[] = [
  'just a moment',
  'attention required',
  'checking your browser',
  'ddos protection',
  'access denied',
  'verify you are human',
  'security check',
  'prove your humanity',
];

/** Body text fragments of block pages (Reddit network security, rate limit pages, captchas). */
const CHALLENGE_BODY_PATTERNS: readonly string[] = [
  "you've been blocked by network security",
  'complete the challenge below and let us know you’re a real person',
  'whoa there, pardner',
  'verify you are human',
  'please complete the security check',
  'enable javascript and cookies to continue',
  'press & hold to confirm you are',
];

/**
 * Checks a title/body pair against known challenge patterns.
 *
 * @param title - Document title
 * @param bodyText - Start of the visible body text
 * @returns A human-readable reason if it looks like a challenge, otherwise null
 */
export function matchChallenge(title: string, bodyText: string): string | null {
  const lowerTitle = title.toLowerCase();
  const titleHit = CHALLENGE_TITLE_PATTERNS.find((p) => lowerTitle.includes(p));
  if (titleHit) return `challenge page detected (title: "${title}")`;

  const lowerBody = bodyText.toLowerCase();
  const bodyHit = CHALLENGE_BODY_PATTERNS.find((p) => lowerBody.includes(p));
  if (bodyHit) return `block/challenge page detected ("${bodyHit}")`;

  return null;
}

/**
 * Detects whether the page currently shows a bot challenge or block page.
 * Never throws: if the page cannot be inspected, it is assumed not blocked.
 *
 * @param page - Playwright page
 * @returns Reason string when blocked, otherwise null
 */
export async function detectChallenge(page: Page): Promise<string | null> {
  try {
    const { title, text } = await page.evaluate(() => ({
      title: document.title,
      text: (document.body?.innerText ?? '').slice(0, 2000),
    }));
    return matchChallenge(title, text);
  } catch {
    return null;
  }
}
