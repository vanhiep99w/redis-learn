import { defineDocs, defineConfig } from 'fumadocs-mdx/config';
import { visit } from 'unist-util-visit';

function remarkMermaid() {
  return (tree: import('mdast').Root) => {
    visit(tree, 'code', (node, index, parent) => {
      if (node.lang !== 'mermaid' || index === undefined || !parent) return;
      (parent.children as unknown[])[index] = {
        type: 'mdxJsxFlowElement',
        name: 'MermaidDiagram',
        attributes: [
          {
            type: 'mdxJsxAttribute',
            name: 'chart',
            value: node.value,
          },
        ],
        children: [],
      };
    });
  };
}

const ADMONITION_TYPES: Record<string, { type: string; title: string }> = {
  NOTE: { type: 'info', title: 'Note' },
  TIP: { type: 'info', title: 'Tip' },
  IMPORTANT: { type: 'warn', title: 'Important' },
  WARNING: { type: 'warn', title: 'Warning' },
  CAUTION: { type: 'error', title: 'Caution' },
};

function remarkGithubAdmonition() {
  return (tree: import('mdast').Root) => {
    visit(tree, 'blockquote', (node, index, parent) => {
      if (index === undefined || !parent) return;
      const first = node.children[0];
      if (!first || first.type !== 'paragraph') return;
      const firstText = first.children[0];
      if (!firstText || firstText.type !== 'text') return;
      const match = firstText.value.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/);
      if (!match) return;
      const meta = ADMONITION_TYPES[match[1]];
      firstText.value = firstText.value.slice(match[0].length);
      if (!firstText.value) first.children.shift();
      if (first.children.length === 0) node.children.shift();
      (parent.children as unknown[])[index] = {
        type: 'mdxJsxFlowElement',
        name: 'Callout',
        attributes: [
          { type: 'mdxJsxAttribute', name: 'type', value: meta.type },
          { type: 'mdxJsxAttribute', name: 'title', value: meta.title },
        ],
        children: node.children,
      };
    });
  };
}

export const docs = defineDocs({
  dir: 'content/docs',
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMermaid, remarkGithubAdmonition],
  },
});
