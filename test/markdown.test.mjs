import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { renderMarkdown, renderMessageMarkdown } from '../public/message-markdown.js';

function body() {
  let html = '', writes = 0;
  const classes = new Set();
  return { classList: { add: value => classes.add(value) }, classes, get innerHTML() { return html; }, set innerHTML(value) { html = value; writes++; }, get writes() { return writes; } };
}

test('Chinese replies render emphasis, paragraphs and headings without losing characters', () => {
  const html = renderMarkdown('## 结果\n\n这是**粗体**和*强调*，保留中文与 emoji 🧪。\n\n下一段。');
  assert.match(html, /<h2>结果<\/h2>/); assert.match(html, /这是<strong>粗体<\/strong>和<em>强调<\/em>/);
  assert.match(html, /中文与 emoji 🧪。<\/p>\n<p>下一段。/); assert.doesNotMatch(html, /\*\*/);
});

test('ordered and nested unordered lists use semantic list elements', () => {
  const html = renderMarkdown('1. 第一项\n2. 第二项\n   - 子项甲\n   - 子项乙\n\n> 引用说明');
  assert.equal((html.match(/<ol>/g) || []).length, 1); assert.equal((html.match(/<ul>/g) || []).length, 1);
  assert.equal((html.match(/<li>/g) || []).length, 4); assert.match(html, /<blockquote>\n<p>引用说明/);
});

test('fenced code and inline code are escaped and retain literal Markdown', () => {
  const html = renderMarkdown('执行 `x < y && **literal**`。\n\n```html\n<script>alert(1)</script>\n**not bold**\n```');
  assert.match(html, /<code>x &lt; y &amp;&amp; \*\*literal\*\*<\/code>/);
  assert.match(html, /<pre><code class="language-html">&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /\*\*not bold\*\*/); assert.doesNotMatch(html, /<script|<strong>/i);
});

test('tables preserve Chinese cells, inline formatting and CSP-compatible alignment', () => {
  const html = renderMarkdown('| 名称 | 状态 | 数量 |\n| :--- | :---: | ---: |\n| **项目甲** | 就绪 | 2 |');
  assert.match(html, /role="region" aria-label="表格" tabindex="0"><table>/);
  assert.match(html, /<th class="markdown-align-left">名称/); assert.match(html, /<th class="markdown-align-center">状态/);
  assert.match(html, /<td class="markdown-align-right">2/); assert.match(html, /<strong>项目甲<\/strong>/);
  assert.doesNotMatch(html, /\bstyle=|<style/i);
});

test('safe links retain escaped labels and open without an opener or referrer', () => {
  const html = renderMarkdown('[文档](https://example.com/docs?a=1&b=2 "说明") [邮件](mailto:demo@example.com) [页内](#section) [相对路径](../notes)');
  assert.match(html, /href="https:\/\/example.com\/docs\?a=1&amp;b=2" title="说明"/);
  assert.equal((html.match(/rel="noopener noreferrer"/g) || []).length, 4);
  assert.match(html, /href="mailto:demo@example.com"/); assert.match(html, /href="\.\.\/notes"/);
});

for (const destination of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java&#x73;cript:alert(1)', 'javascript&#58;alert(1)', 'vbscript:msgbox(1)', 'file:///etc/passwd', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/svg+xml;base64,PHN2Zz4=', 'ftp://example.com/file', 'ssh://example.com', 'vscode://file/workspace/demo']) test(`dangerous or unapproved link destination stays inert: ${destination.split(':')[0]}`, () => {
  const html = renderMarkdown(`[打开](${destination})`);
  assert.doesNotMatch(html, /<a\b|<img\b|<iframe\b/i);
});

test('raw HTML, SVG, event handlers and DOM-clobbering forms remain visible text', () => {
  const payload = '<script>globalThis.markdownXss=1</script>\n<img src=x onerror="alert(1)">\n<svg onload="alert(1)"></svg>\n<form id="location"><input name="href"></form>\n<iframe srcdoc="<script>alert(1)</script>"></iframe>';
  const html = renderMarkdown(payload);
  assert.doesNotMatch(html, /<(?:script|img|svg|form|input|iframe)\b/i);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;img src=x/); assert.match(html, /&lt;form id=&quot;location&quot;&gt;/);
});

test('link titles and fenced language labels cannot break out into attributes', () => {
  const html = renderMarkdown('[链接](https://example.com "&quot; onmouseover=&quot;alert(1)")\n\n```js\"onmouseover=alert(1)\nconst safe = true;\n```');
  assert.doesNotMatch(html, /<[^>]+\sonmouseover="|<[^>]+\sonerror=/i);
  assert.match(html, /&quot;/); assert.match(html, /const safe = true;/);
});

test('Markdown images do not load remote, data or local resources', () => {
  const html = renderMarkdown('![图片说明](https://example.com/track.png) ![本地](file:///workspace/demo.png) ![嵌入](data:image/png;base64,aGVsbG8=)');
  assert.doesNotMatch(html, /<img\b|\bsrc=/i); assert.match(html, /图片说明/);
});

test('repeated streaming replacements produce one final document without duplicate blocks', () => {
  const element = body();
  for (const text of ['**准', '**准备**\n\n- 第', '**准备**\n\n- 第一项\n- 第二项\n\n```js\nconst x = 1;', '**准备**\n\n- 第一项\n- 第二项\n\n```js\nconst x = 1;\n```']) renderMessageMarkdown(element, text);
  const final = element.innerHTML, writes = element.writes;
  assert.equal(renderMessageMarkdown(element, '**准备**\n\n- 第一项\n- 第二项\n\n```js\nconst x = 1;\n```'), false);
  assert.equal(element.writes, writes); assert.equal(element.classes.has('message-markdown'), true);
  assert.equal((final.match(/<strong>/g) || []).length, 1); assert.equal((final.match(/<li>/g) || []).length, 2); assert.equal((final.match(/<pre>/g) || []).length, 1);
  assert.equal(final, renderMarkdown('**准备**\n\n- 第一项\n- 第二项\n\n```js\nconst x = 1;\n```'));
});

test('an externally cleared body is restored and an empty reply clears old content', () => {
  const element = body(); renderMessageMarkdown(element, '**完成**'); element.innerHTML = '';
  assert.equal(renderMessageMarkdown(element, '**完成**'), true); assert.match(element.innerHTML, /<strong>完成/);
  renderMessageMarkdown(element, null); assert.equal(element.innerHTML, '');
});

test('large and incomplete streamed syntax remains renderable with bounded nesting', { timeout: 5000 }, () => {
  const input = '- 项目\n'.repeat(1500) + '\n' + '<!--'.repeat(5000) + '\n\n```text\n' + 'literal <script> **code**\n'.repeat(3000);
  const html = renderMarkdown(input);
  assert.equal((html.match(/<li>/g) || []).length, 1500); assert.doesNotMatch(html, /<script/); assert.match(html, /<pre><code class="language-text">/);
});

test('the self-hosted parser and notices match the pinned official bundle manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/vendor/markdown-it-vendor.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '15.0.3'); assert.equal(manifest.license, 'MIT'); assert.equal(manifest.bundledDependencies.length, 5);
  assert.equal(manifest.tarball, 'https://registry.npmjs.org/markdown-it/-/markdown-it-15.0.3.tgz');
  for (const [name, expected] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(await readFile(new URL('../public/vendor/' + name, import.meta.url))).digest('hex'), expected, name);
  const bundle = await readFile(new URL('../public/vendor/markdown-it.js', import.meta.url), 'utf8');
  assert.doesNotMatch(bundle, /sourceMappingURL|\bfrom\s*['"]https?:|\bimport\s*\(/);
});
