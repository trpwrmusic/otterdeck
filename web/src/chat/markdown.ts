import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { highlightLine } from '../highlight';
import hljs from 'highlight.js/lib/common';

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const language = lang && hljs.getLanguage(lang) ? lang : null;
      const html = text
        .split('\n')
        .map((l) => highlightLine(l, language))
        .join('\n');
      return `<pre class="md-code"><code>${html}</code></pre>`;
    },
  },
});

// Links from Claude open outside the app window.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const cache = new Map<string, string>();

/** Claude's Markdown as safe HTML (sanitized, so a transcript can't inject scripts). */
export function renderMarkdown(text: string): string {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { USE_PROFILES: { html: true } });
  if (cache.size > 500) cache.clear();
  cache.set(text, html);
  return html;
}
