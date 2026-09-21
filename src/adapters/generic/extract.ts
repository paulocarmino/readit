import { gfm } from '@joplin/turndown-plugin-gfm';
import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import TurndownService from 'turndown';
import { scrubDocument } from './scrubber.js';

/** Result of extracting the readable part of an HTML document. */
export interface Extracted {
  title: string;
  markdown: string;
  meta: Record<string, string | number>;
  warnings: string[];
}

/** Below this many characters, Readability's output is considered a miss. */
const MIN_ARTICLE_CHARS = 250;

/**
 * Creates the HTML → markdown converter (GFM tables, fenced code, atx headings).
 *
 * @returns Configured Turndown instance
 */
export function createTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
    linkStyle: 'inlined',
  });
  service.use(gfm);
  // Images without alt text (icons, thumbnails) and data URIs are noise that costs tokens.
  service.addRule('dropNoiseImages', {
    filter: (node) =>
      node.nodeName === 'IMG' &&
      ((node.getAttribute('alt') ?? '').trim() === '' ||
        (node.getAttribute('src') ?? '').startsWith('data:')),
    replacement: () => '',
  });
  // Links without text (icon buttons) are noise.
  service.addRule('dropEmptyLinks', {
    filter: (node) =>
      node.nodeName === 'A' && (node.textContent ?? '').trim() === '' && !node.querySelector('img'),
    replacement: () => '',
  });
  return service;
}

const turndown = createTurndown();

/**
 * Converts an HTML fragment to tidy markdown.
 *
 * @param html - HTML fragment
 * @returns Markdown
 */
export function htmlToMarkdown(html: string): string {
  return turndown
    .turndown(html)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Rewrites relative href/src to absolute URLs, so links in the markdown are usable. */
function absolutizeLinks(root: Element | Document, baseUrl: string): void {
  for (const el of root.querySelectorAll('a[href], img[src]')) {
    const attr = el.tagName === 'A' ? 'href' : 'src';
    const value = el.getAttribute(attr);
    if (!value || value.startsWith('#') || value.startsWith('javascript:')) continue;
    try {
      el.setAttribute(attr, new URL(value, baseUrl).href);
    } catch {
      // Unparseable URL, keep as-is.
    }
  }
}

/**
 * Syntax highlighters render each code line as its own element inside <pre>, so textContent
 * loses the line breaks. Turn <br> and line elements into real newlines.
 */
function normalizeCodeBlocks(document: Document): void {
  for (const pre of document.querySelectorAll('pre')) {
    for (const br of pre.querySelectorAll('br')) br.replaceWith('\n');
    const lineSelector = 'div, p, .line, .cm-line, .code-line, [data-line]';
    // Innermost line elements only, so nested wrappers do not add blank lines.
    const lines = [...pre.querySelectorAll(lineSelector)].filter(
      (el) => !el.querySelector(lineSelector)
    );
    lines.forEach((line, i) => {
      const text = line.textContent ?? '';
      if (i < lines.length - 1 && !text.endsWith('\n')) line.append('\n');
    });
  }
}

function fallbackBody(document: Document): string {
  for (const el of document.querySelectorAll(
    'nav, header, footer, aside, form, [role="navigation"]'
  )) {
    el.remove();
  }
  const main = document.querySelector('main, [role="main"], article');
  return (main ?? document.body).innerHTML;
}

/**
 * Extracts the main content of an HTML page as markdown.
 *
 * Flow: parse (no scripts) → absolutize links → scrub noise → selector | Readability → markdown.
 * When Readability finds nothing substantial, falls back to the scrubbed `<main>`/`<body>`.
 *
 * @param html - Full page HTML (e.g. from `page.content()`)
 * @param url - Page URL, used to resolve relative links
 * @param selector - When given, only elements matching it are converted (Readability skipped)
 * @returns Title, markdown, metadata and warnings
 */
export function extractContent(html: string, url: string, selector?: string): Extracted {
  const virtualConsole = new VirtualConsole(); // swallow CSS/JS parse noise instead of printing it
  const dom = new JSDOM(html, { url, virtualConsole });
  const document = dom.window.document;
  const warnings: string[] = [];
  const meta: Record<string, string | number> = {};

  try {
    const pageTitle = document.title.trim();
    absolutizeLinks(document, url);
    normalizeCodeBlocks(document);

    if (selector) {
      let nodes: Element[] = [];
      try {
        nodes = [...document.querySelectorAll(selector)];
      } catch {
        warnings.push(`Invalid selector "${selector}".`);
      }
      if (nodes.length > 0) {
        if (nodes.length > 1) meta.matches = nodes.length;
        const markdown = nodes.map((n) => htmlToMarkdown(n.outerHTML)).join('\n\n---\n\n');
        return { title: pageTitle, markdown, meta, warnings };
      }
      warnings.push(`Selector "${selector}" matched nothing; returning the main content instead.`);
    }

    scrubDocument(document);

    const article = new Readability(document.cloneNode(true) as Document, {
      keepClasses: false,
    }).parse();
    if (article?.content && (article.textContent ?? '').trim().length >= MIN_ARTICLE_CHARS) {
      if (article.byline) meta.byline = article.byline.trim();
      if (article.siteName) meta.site = article.siteName.trim();
      if (article.publishedTime) meta.published = article.publishedTime;
      return {
        title: article.title?.trim() || pageTitle,
        markdown: htmlToMarkdown(article.content),
        meta,
        warnings,
      };
    }

    return { title: pageTitle, markdown: htmlToMarkdown(fallbackBody(document)), meta, warnings };
  } finally {
    dom.window.close();
  }
}
