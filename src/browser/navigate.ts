import type { Page } from 'playwright';
import { UserFacingError } from '../errors.js';
import { detectChallenge } from './challenge.js';

/** Options for {@link navigate}. */
export interface NavigateOptions {
  timeoutMs: number;
  /** CSS selector that must be attached before extraction. */
  waitFor?: string;
  /** Selector the caller will extract; if it is already there, the page is considered ready. */
  selector?: string;
  /** Wait until the visible text stops changing (for JS-rendered pages). Default true. */
  waitForStableContent?: boolean;
  /** Throw on challenge/block pages. Default true (false for screenshots, where you want to see them). */
  checkChallenge?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls the visible text length until it stops changing, so SPAs have time to render.
 * Uses one `page.evaluate` per sample (cheap) instead of `networkidle` (slow, often never idle).
 *
 * @param page - Playwright page
 * @param maxMs - Upper bound for the wait
 */
export async function waitForStableContent(page: Page, maxMs = 6000): Promise<void> {
  const start = Date.now();
  let previous = -1;
  let stableSamples = 0;
  const pollMs = 250;

  while (Date.now() - start < maxMs) {
    const length = await page.evaluate(() => document.body?.innerText.length ?? 0).catch(() => 0);

    if (length > 0 && length === previous) {
      stableSamples += 1;
      // Short pages might be an SPA shell still loading: give them a bit longer.
      if (stableSamples >= (length > 200 ? 2 : 4)) return;
    } else {
      stableSamples = 0;
    }
    previous = length;
    await sleep(pollMs);
  }
}

/**
 * Opens `url` with `domcontentloaded`, optionally waits for a selector and for the content to
 * settle, then checks for challenge pages.
 *
 * @param page - Playwright page
 * @param url - URL to open
 * @param options - Wait options
 * @returns Warnings worth surfacing to the agent (e.g. wait_for timed out)
 * @throws UserFacingError when a challenge/block page is detected
 */
export async function navigate(
  page: Page,
  url: string,
  options: NavigateOptions
): Promise<string[]> {
  const warnings: string[] = [];
  const response = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: options.timeoutMs,
  });

  let targetFound = false;
  if (options.waitFor) {
    try {
      await page
        .locator(options.waitFor)
        .first()
        .waitFor({
          state: 'attached',
          timeout: Math.min(options.timeoutMs, 15_000),
        });
      targetFound = true;
    } catch {
      warnings.push(`wait_for selector "${options.waitFor}" did not appear; extracted anyway.`);
    }
  } else if (options.selector) {
    // The caller only wants this element: once it is there, waiting for the rest is wasted time.
    targetFound = await page
      .locator(options.selector)
      .first()
      .waitFor({ state: 'attached', timeout: 2000 })
      .then(() => true)
      .catch(() => false);
  }

  if (options.waitForStableContent !== false && !targetFound) await waitForStableContent(page);

  const challenge = options.checkChallenge === false ? null : await detectChallenge(page);
  if (challenge) {
    throw new UserFacingError(
      `Blocked: ${challenge} at ${page.url()}. Call open_browser with this URL, solve it (or log in) in the visible window, then call read_page again.`,
      'blocked'
    );
  }

  const status = response?.status();
  if (status !== undefined && status >= 400) warnings.push(`HTTP ${status} for ${page.url()}`);

  return warnings;
}
