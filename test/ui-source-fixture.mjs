// UI state fixtures use a minimal DOM. Parser/XSS and real rendering are covered
// separately; keep these fixtures focused on message identity and lifecycle.
export function appFixtureSource(source) {
  return source.replace(/^import \{ renderMessageMarkdown \} from '\.\/message-markdown\.js';\r?\n/, 'const renderMessageMarkdown = (node, text) => { node.textContent = text; };\n')
    .replace(/run\(\(\) => hydrate\(\)\);\s*$/, '');
}
