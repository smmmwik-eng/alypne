import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useMemo } from 'react';
import { cn } from './format';

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

/** Markdown → sanitised HTML. Raw HTML in the source is escaped by DOMPurify's allow-list. */
export function renderMarkdown(src: string): string {
  const withMentions = src.replace(/(^|[\s(])@([a-zA-Z0-9_]{2,32})\b/g, '$1<span class="mention">@$2</span>');
  const html = marked.parse(withMentions, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'input'],
    ALLOWED_ATTR: ['href', 'class', 'type', 'checked', 'disabled', 'title'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|\/|#)/i,
  });
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className={cn('prose-alypne', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
