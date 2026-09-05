# Fumadocs + Next.js project file templates

These are the files to write for a fresh Fumadocs project using the **manual installation** flow (App Router, `fumadocs-mdx` content source, `fumadocs-ui` layouts, Tailwind v4). This mirrors what `pnpm create fumadocs-app` would generate, written out directly since this sandbox can't run the interactive CLI or hit npm's registry.

Adjust the placeholder values (`<PROJECT_NAME>`, `<SITE_TITLE>`, `<SITE_DESCRIPTION>`) to match the topic. Package versions: use `latest`/caret ranges as shown — the user will resolve exact versions when they run `npm install` locally.

---

## `package.json`

```json
{
  "name": "<PROJECT_NAME>",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "postinstall": "fumadocs-mdx"
  },
  "dependencies": {
    "fumadocs-core": "^15",
    "fumadocs-mdx": "^11",
    "fumadocs-ui": "^15",
    "next": "^15",
    "react": "^19",
    "react-dom": "^19"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4",
    "@types/mdx": "^2",
    "@types/node": "^22",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "postcss": "^8",
    "tailwindcss": "^4",
    "typescript": "^5"
  }
}
```

---

## `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".source/index.ts"],
  "exclude": ["node_modules"]
}
```

---

## `next.config.ts`

```ts
import type { NextConfig } from 'next';
import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

const config: NextConfig = {
  reactStrictMode: true,
};

export default withMDX(config);
```

---

## `source.config.ts`

```ts
import { defineDocs, defineConfig } from 'fumadocs-mdx/config';

export const docs = defineDocs({
  dir: 'content/docs',
});

export default defineConfig();
```

---

## `postcss.config.mjs`

```js
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
```

---

## `mdx-components.tsx` (project root)

```tsx
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    ...components,
  };
}
```

---

## `lib/source.ts`

```ts
import { docs } from '@/.source';
import { loader } from 'fumadocs-core/source';

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
});
```

---

## `lib/layout.shared.ts`

```ts
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: '<SITE_TITLE>',
    },
  };
}
```

---

## `app/layout.tsx`

```tsx
import type { Metadata } from 'next';
import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';

export const metadata: Metadata = {
  title: '<SITE_TITLE>',
  description: '<SITE_DESCRIPTION>',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
```

---

## `app/global.css`

```css
@import 'tailwindcss';
@import 'fumadocs-ui/css/style.css';

/* --- layout width / padding tightening, see layout-padding-customization.md --- */
:root {
  --fd-layout-width: 100%;
}

#nd-docs-layout {
  padding-inline: 0.5rem;
}

@media (min-width: 768px) {
  #nd-docs-layout {
    padding-inline: 1rem;
  }
}
```

---

## `app/docs/layout.tsx`

```tsx
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import type { ReactNode } from 'react';
import { baseOptions } from '@/lib/layout.shared';
import { source } from '@/lib/source';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      {...baseOptions()}
      tree={source.pageTree}
      containerProps={{ className: 'px-0' }}
    >
      {children}
    </DocsLayout>
  );
}
```

---

## `app/docs/[[...slug]]/page.tsx`

```tsx
import { source } from '@/lib/source';
import {
  DocsPage,
  DocsBody,
  DocsDescription,
  DocsTitle,
} from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/mdx-components';

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDXContent = page.data.body;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDXContent components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
```

---

## `.gitignore`

```
node_modules
.next
.source
.env*.local
```

---

## Root `content/docs/meta.json` (top-level nav order)

```json
{
  "title": "<SITE_TITLE>",
  "pages": ["nen-tang", "bat-dau", "..."]
}
```
List the top-level category folder slugs in the order they should appear in the sidebar, per the plan from `topic-outline-guide.md`.

---

## Category folder `meta.json` (e.g. `content/docs/telemetry-signals/meta.json`)

```json
{
  "title": "Telemetry signals",
  "pages": ["index", "traces", "spans", "sampling", "metrics", "logs"]
}
```
`"index"` (or whatever the category landing page's filename is, minus extension) should usually be listed first so the category overview appears above its child pages.

---

## Root landing page `content/docs/index.mdx` (docs home / roadmap page)

```mdx
---
title: <SITE_TITLE>
description: <SITE_DESCRIPTION>
---

Tài liệu này là lộ trình học <TOPIC> theo từng phần, được tổ chức theo sidebar bên trái.

## Mục lục
- [Cách sử dụng](#cách-sử-dụng)
- [Lộ trình học](#lộ-trình-học)

## Cách sử dụng
Mỗi mục trong sidebar là một nhóm chủ đề. Bắt đầu từ trên xuống dưới để đi theo đúng thứ tự học đề xuất.

## Lộ trình học
- **Nền tảng** — khái niệm cơ bản, thuật ngữ.
- **Bắt đầu** — cài đặt và chạy thử.
- ... (liệt kê từng category theo plan)
```
