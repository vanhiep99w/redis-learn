import { createMDX } from 'fumadocs-mdx/next';
import remarkGithubAdmonitions from 'remark-github-admonitions-to-directives';

const withMDX = createMDX({
  mdxOptions: {
    remarkPlugins: [remarkGithubAdmonitions],
  },
});

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  distDir: 'dist',
  trailingSlash: true,
  images: { unoptimized: true },
};

export default withMDX(config);
