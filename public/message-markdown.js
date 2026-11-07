import MarkdownIt from './vendor/markdown-it.js';

// No raw HTML, plugins, remote assets or syntax-highlighter HTML enter this renderer.
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false, maxNesting: 20 });
markdown.validateLink = value => {
  if (/[\u0000-\u0020\u007f\\]/.test(value)) return false;
  try { return ['http:', 'https:', 'mailto:'].includes(new URL(value, 'https://markdown.invalid/').protocol); }
  catch { return false; }
};
const linkOpen = markdown.renderer.rules.link_open || ((tokens, index, options, env, renderer) => renderer.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return linkOpen(tokens, index, options, env, renderer);
};
// Uploaded attachments have their own UI. Markdown images remain descriptive text.
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content || '');
markdown.renderer.rules.table_open = () => '<div class="markdown-table" role="region" aria-label="表格" tabindex="0"><table>\n';
markdown.renderer.rules.table_close = () => '</table></div>\n';
for (const name of ['th_open', 'td_open']) markdown.renderer.rules[name] = (tokens, index, options, env, renderer) => {
  const token = tokens[index], alignment = token.attrGet('style')?.match(/^text-align:(left|center|right)$/)?.[1];
  if (token.attrs) token.attrs = token.attrs.filter(([name]) => name !== 'style');
  if (alignment) token.attrSet('class', `markdown-align-${alignment}`);
  return renderer.renderToken(tokens, index, options);
};

export function renderMarkdown(text) { return markdown.render(String(text ?? '')); }

const renders = new WeakMap();
// Replace complete content synchronously so history and stream updates share scroll timing.
export function renderMessageMarkdown(element, text) {
  const source = String(text ?? ''), previous = renders.get(element);
  if (previous?.text === source && element.innerHTML === previous.html) return false;
  const html = renderMarkdown(source); element.classList.add('message-markdown'); element.innerHTML = html;
  renders.set(element, { text: source, html }); return true;
}
