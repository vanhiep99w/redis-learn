import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';

const { staticGET: GET } = createFromSource(source, (page) => ({
  title: page.data.title,
  description: page.data.description,
  url: page.url,
  id: page.url,
  // Keep search focused on titles/descriptions/headings so the exported
  // static search index stays below Cloudflare Pages' 25 MiB asset limit.
  structuredData: {
    headings: page.data.structuredData.headings,
    contents: [],
  },
}));

export { GET };

// Required for Next.js static export
export const dynamic = 'force-static';
