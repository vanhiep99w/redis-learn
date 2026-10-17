import { rehypeCodeDefaultOptions } from 'fumadocs-core/mdx-plugins';
import { defineDocs, defineConfig } from 'fumadocs-mdx/config';
import { visit } from 'unist-util-visit';
import { remarkD2 } from '@vanhiep99w/docs-kit/d2';
import { remarkTerminalSession } from '@vanhiep99w/docs-kit/terminal-session';
import { remarkCodeDiff } from '@vanhiep99w/docs-kit/code-diff';
import { remarkCodeWalkthrough } from '@vanhiep99w/docs-kit/code-walkthrough';
import { remarkSpanWaterfall } from '@vanhiep99w/docs-kit/span-waterfall';

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
    rehypeCodeOptions: {
      ...rehypeCodeDefaultOptions,
      fallbackLanguage: 'text',
    },
    // Compile diagrams/descriptors before Shiki processes ordinary code fences.
    // WASM and syntax highlighters stay in the build process, never the browser.
    remarkPlugins: [
      [remarkD2, {
        cacheDir: '.next/cache/docs-kit/d2',
        assetsRoot: 'public/icons/d2',
        concurrency: 1,
        interactive: true,
        sketch: false,
        defaultCaption: 'Sơ đồ',
      }],
      remarkTerminalSession,
      remarkCodeDiff,
      remarkCodeWalkthrough,
      remarkSpanWaterfall,
      remarkGithubAdmonition,
    ],
  },
});
