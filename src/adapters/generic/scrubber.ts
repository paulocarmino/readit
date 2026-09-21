/**
 * Selectors of page chrome that is noise for reading: cookie banners, chat widgets, modals,
 * newsletter prompts. Taken from plugin-screenshot/scrubber.ts; here the elements are removed
 * from the parsed DOM instead of hidden.
 */
export const NOISE_SELECTORS: readonly string[] = [
  // Cookie banners
  '[class*="cookie"]',
  '[id*="cookie"]',
  '[class*="gdpr"]',
  '[id*="gdpr"]',
  '[class*="consent"]',
  '[id*="consent"]',
  '#onetrust-consent-sdk',
  '#onetrust-banner-sdk',
  '.cookiebot',
  '#CybotCookiebotDialog',
  '.cc-banner',
  '.cc-window',
  '.osano-cm-dialog',
  '.osano-cm-window',

  // Chat widgets
  '[class*="intercom"]',
  '[id*="intercom"]',
  '[class*="drift"]',
  '[id*="drift"]',
  '[class*="hubspot"]',
  '[class*="crisp"]',
  '[class*="zendesk"]',
  '[class*="tawk"]',
  '#tidio-chat',

  // Popups and modals
  '[class*="popup"]',
  '[class*="modal"]',
  '[class*="overlay"]',
  '[role="dialog"]',
  '[aria-modal="true"]',

  // Newsletter
  '[class*="newsletter"]',
  '[class*="subscribe"]',
  '[class*="signup-modal"]',

  // Notification bars
  '[class*="notification-bar"]',
  '[class*="announcement"]',
  '[class*="promo-bar"]',

  // Social proof
  '[class*="social-proof"]',
  '[class*="fomo"]',
  '[class*="recent-sales"]',
];

/** Elements that never carry readable content. */
const ALWAYS_REMOVE = 'script, style, noscript, template, iframe, svg, canvas, link, meta';

/** Containers that must survive even if a class like "modal-open" matches a noise selector. */
const PROTECTED_TAGS = new Set(['HTML', 'BODY', 'MAIN', 'ARTICLE']);

/**
 * Removes noise elements from a parsed document, in place.
 * An element is kept when it is a main container or wraps the main content
 * (loose selectors like `[class*="modal"]` also match things like `body.modal-open`).
 *
 * @param document - Parsed DOM (jsdom)
 * @returns Number of removed elements
 */
export function scrubDocument(document: Document): number {
  let removed = 0;
  for (const el of document.querySelectorAll(ALWAYS_REMOVE)) {
    el.remove();
    removed += 1;
  }

  for (const selector of NOISE_SELECTORS) {
    let matches: NodeListOf<Element>;
    try {
      matches = document.querySelectorAll(selector);
    } catch {
      continue;
    }
    for (const el of matches) {
      if (!el.isConnected || PROTECTED_TAGS.has(el.tagName)) continue;
      if (el.querySelector('main, article, h1')) continue;
      el.remove();
      removed += 1;
    }
  }
  return removed;
}
