# Setup & Deploy — Next.js + Fumadocs + Cloudflare Pages

## Prerequisites

- Node.js 18+
- Cloudflare account (free tier OK)
- Wrangler CLI: `npm install -g wrangler`

## Tạo Repo Mới từ Template

```bash
# Clone từ aws-learn (recommended)
git clone https://github.com/vanhiep99w/aws-learn my-new-docs
cd my-new-docs
rm -rf .git && git init
npm install
```

## Dependencies

`package.json` chuẩn:

```json
{
  "name": "my-docs",
  "type": "module",
  "version": "1.0.0",
  "scripts": {
    "prepare-content": "node scripts/prepare-content.mjs",
    "predev": "node scripts/prepare-content.mjs",
    "dev": "next dev",
    "prebuild": "node scripts/prepare-content.mjs",
    "build": "next build",
    "preview": "wrangler pages dev dist",
    "deploy": "npm run build && wrangler pages deploy dist"
  },
  "dependencies": {
    "fumadocs-core": "^14.5.6",
    "fumadocs-mdx": "^11.1.3",
    "fumadocs-ui": "^14.5.6",
    "mermaid": "^11.13.0",
    "next": "^15.2.4",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "remark-github-admonitions-to-directives": "^2.1.0",
    "unist-util-visit": "^5.1.0"
  }
}
```

## Cloudflare Pages Config

`wrangler.toml` (tối thiểu):

```toml
name = "my-docs-site"
pages_build_output_dir = "./dist"
```

> Dùng `pages_build_output_dir` (Pages) thay vì `[assets] directory` (Workers). Static site docs không cần Workers.

## Auto Deploy qua GitHub

Kết nối GitHub → Cloudflare Pages Dashboard:
1. Workers & Pages → Create → Pages → Connect GitHub
2. Build command: `npm run build`
3. Output directory: `dist`

Cloudflare tự tạo webhook — mỗi khi push, site tự build và deploy.

## Local Development

```bash
npm run dev        # http://localhost:3000
npm run preview    # Preview với Wrangler
```

## Deploy Thủ Công

```bash
wrangler login     # Lần đầu
npm run deploy     # = npm run build && wrangler pages deploy dist
```

## Fumadocs Navigation Config

`content/docs/meta.json` — thứ tự sidebar:
```json
{
  "pages": ["fundamentals", "compute", "database"]
}
```

`content/docs/{category}/meta.json` — tên category:
```json
{
  "title": "Database"
}
```

## `page.tsx` Chuẩn — Có đầy đủ Fumadocs components

```tsx
// src/app/[[...slug]]/page.tsx
import { source } from '@/lib/source';
import { DocsPage, DocsBody, DocsTitle, DocsDescription } from 'fumadocs-ui/page';
import { notFound, redirect } from 'next/navigation';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { MermaidDiagram } from '@/components/mermaid';
import { Callout } from 'fumadocs-ui/components/callout';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import type { Metadata } from 'next';

export default async function Page({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  if (!slug || slug.length === 0) redirect('/your-first-page/');

  const page = source.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  return (
    <DocsPage toc={page.data.toc} full={false}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={{ ...defaultMdxComponents, MermaidDiagram, Callout, Card, Cards, Step, Steps, Tab, Tabs, Accordion, Accordions, TypeTable }} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return [{ slug: [] }, ...source.generateParams()];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  if (!slug || slug.length === 0) return { title: 'Docs' };
  const page = source.getPage(slug);
  if (!page) notFound();
  return { title: page.data.title, description: page.data.description };
}
```

## Mermaid Diagram Support

### 1. `source.config.ts` — remark plugin

```ts
import { defineDocs, defineConfig } from 'fumadocs-mdx/config';
import { visit } from 'unist-util-visit';

function remarkMermaid() {
  return (tree: import('mdast').Root) => {
    visit(tree, 'code', (node, index, parent) => {
      if (node.lang !== 'mermaid' || index === undefined || !parent) return;
      (parent.children as unknown[])[index] = {
        type: 'mdxJsxFlowElement',
        name: 'MermaidDiagram',
        attributes: [{ type: 'mdxJsxAttribute', name: 'chart', value: node.value }],
        children: [],
      };
    });
  };
}

export const docs = defineDocs({ dir: 'content/docs' });

export default defineConfig({
  mdxOptions: { remarkPlugins: [remarkMermaid] },
});
```

> [!IMPORTANT]
> Plugin **phải đặt trong `source.config.ts`**, không phải `next.config.mjs`.

### 2. `src/components/mermaid.tsx`

```tsx
'use client';
import { useEffect, useId, useRef } from 'react';

export function MermaidDiagram({ chart }: { chart: string }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const safeId = `mermaid-${id.replace(/:/g, '')}`;

  useEffect(() => {
    if (!ref.current) return;
    let cancelled = false;
    import('mermaid').then((m) => {
      if (cancelled) return;
      m.default.initialize({ startOnLoad: false });
      m.default.render(safeId, chart).then(({ svg }) => {
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      });
    });
    return () => { cancelled = true; };
  }, [chart, safeId]);

  return <div ref={ref} className="my-6 flex justify-center overflow-x-auto" />;
}
```

## Font — JetBrains Mono

Dùng [JetBrains Mono](https://www.jetbrains.com/lp/mono/) cho code blocks và monospace text.

### Cài qua npm (khuyến nghị)

```bash
npm install @fontsource/jetbrains-mono
```

Import vào `src/app/layout.tsx`:

```tsx
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
```

Apply trong `src/app/globals.css`:

```css
code, pre, kbd, samp {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
}
```

### Hoặc dùng next/font/google

```tsx
// src/app/layout.tsx
import { JetBrains_Mono } from 'next/font/google';

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" className={jetbrainsMono.variable}>
      <body>{children}</body>
    </html>
  );
}
```

```css
/* src/app/globals.css */
code, pre, kbd, samp {
  font-family: var(--font-mono), ui-monospace, monospace;
}
```

## Mở rộng Content Area

```css
/* src/app/globals.css */
#nd-page article {
  max-width: none;
}
```

## Route Conflict — Next.js 15.5+

Xóa `src/app/page.tsx`, xử lý redirect trong `[[...slug]]/page.tsx` (xem `page.tsx` chuẩn ở trên).

## Troubleshooting

| Vấn đề | Fix |
|--------|-----|
| Doc không hiện sidebar | Thêm vào `meta.json` → `"pages"` array |
| Wrangler deploy lỗi auth | `wrangler login` |
| `> [!IMPORTANT]` không render | Kiểm tra `remark-github-admonitions-to-directives` trong package.json |
| Mermaid không render | Plugin phải trong `source.config.ts`, không phải `next.config.mjs` |
| Build lỗi route conflict | Xóa `src/app/page.tsx` |
| Content bị giới hạn width | Thêm `#nd-page article { max-width: none }` vào `globals.css` |
| Component không work trong .md | Kiểm tra đã register trong `page.tsx` components prop |
