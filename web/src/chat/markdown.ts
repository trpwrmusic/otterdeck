import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { highlightLine } from '../highlight';
import hljs from 'highlight.js/lib/common';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Text a copy button puts on the clipboard, kept safely in an attribute. */
const copyAttr = (s: string) => `data-copy="${encodeURIComponent(s)}"`;

/**
 * A mail Claude prepared, from a ```mail block:
 *   Betreff: …        (optional; also "Subject:")
 *   An: …             (optional; also "To:")
 *   <blank line>
 *   body
 */
function mailCard(text: string) {
  const lines = text.replace(/\r\n/g, '\n').replace(/^\n+|\s+$/g, '').split('\n');
  let subject = '';
  let to = '';
  while (lines.length) {
    const m = lines[0].match(/^\s*(Betreff|Subject|An|To)\s*:\s*(.*)$/i);
    if (!m) break;
    if (/^(Betreff|Subject)$/i.test(m[1])) subject = m[2].trim();
    else to = m[2].trim();
    lines.shift();
  }
  while (lines.length && !lines[0].trim()) lines.shift();
  const body = lines.join('\n');
  return `<div class="mail-card">
    <div class="mail-head">
      ${to ? `<div class="mail-to">An ${esc(to)}</div>` : ''}
      ${subject ? `<div class="mail-subject">${esc(subject)}</div>` : '<div class="mail-subject quiet">E-Mail</div>'}
    </div>
    <div class="mail-body">${esc(body)}</div>
    <div class="mail-actions">
      <button class="copy-btn primary" ${copyAttr(body)}>Text kopieren</button>
      ${subject ? `<button class="copy-btn" ${copyAttr(subject)}>Betreff kopieren</button>` : ''}
      ${subject ? `<button class="copy-btn" ${copyAttr(`${subject}\n\n${body}`)}>Beides</button>` : ''}
    </div>
  </div>`;
}

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      if (/^(mail|e-?mail|email)$/i.test(lang ?? '')) return mailCard(text);
      const language = lang && hljs.getLanguage(lang) ? lang : null;
      const html = text
        .split('\n')
        .map((l) => highlightLine(l, language))
        .join('\n');
      return `<div class="code-wrap"><button class="copy-btn small" ${copyAttr(text)}>Kopieren</button><pre class="md-code"><code>${html}</code></pre></div>`;
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
  const html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['data-copy'],
  });
  if (cache.size > 500) cache.clear();
  cache.set(text, html);
  return html;
}

/**
 * Click handler for the copy buttons inside rendered Markdown (they are plain HTML, so one
 * delegated listener on the chat handles them all).
 */
export function handleCopyClick(e: React.MouseEvent) {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-copy]');
  if (!btn) return;
  e.preventDefault();
  const text = decodeURIComponent(btn.dataset.copy ?? '');
  navigator.clipboard.writeText(text).then(() => {
    const label = btn.textContent;
    btn.textContent = 'Kopiert ✓';
    btn.classList.add('done');
    setTimeout(() => {
      btn.textContent = label;
      btn.classList.remove('done');
    }, 1400);
  });
}
