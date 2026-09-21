import { z } from 'zod';
import { defineAdapter } from '../types.js';
import { extractContent } from './extract.js';

const optionsSchema = z.object({
  wait_stable: z
    .boolean()
    .default(true)
    .describe('Wait until the visible text stops changing before extracting (JS-heavy pages).'),
});

/**
 * Fallback adapter for any site: renders the page in Chromium, then extracts the main content
 * with Readability and converts it to markdown.
 */
export const genericAdapter = defineAdapter({
  name: 'generic',
  description:
    'Any site. Renders JS, removes cookie banners/modals, extracts the main content (Readability).',
  hosts: [],
  optionsSchema,
  read: (url, options, ctx) =>
    ctx.withPage(
      url.href,
      async (page, warnings) => {
        const html = await page.content();
        const finalUrl = page.url();
        const extracted = extractContent(html, finalUrl, ctx.common.selector);
        return {
          title: extracted.title,
          url: finalUrl,
          markdown: extracted.markdown,
          meta: extracted.meta,
          warnings: [...warnings, ...extracted.warnings],
        };
      },
      { waitForStableContent: options.wait_stable }
    ),
});
