import { source } from '@/lib/source';
import { DocsPage, DocsBody, DocsTitle, DocsDescription } from 'fumadocs-ui/page';
import { notFound, redirect } from 'next/navigation';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { D2Diagram } from '@vanhiep99w/docs-kit/components/d2';
import { D2InteractiveDiagram } from '@vanhiep99w/docs-kit/components/d2-interactive';
import { TerminalSession } from '@vanhiep99w/docs-kit/components/terminal-session';
import { CodeDiff } from '@vanhiep99w/docs-kit/components/code-diff';
import { CodeWalkthrough } from '@vanhiep99w/docs-kit/components/code-walkthrough';
import { SpanWaterfall } from '@vanhiep99w/docs-kit/components/span-waterfall';
import { Callout } from 'fumadocs-ui/components/callout';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import { File, Folder, Files } from 'fumadocs-ui/components/files';
import type { Metadata } from 'next';

const mdxComponents = {
  ...defaultMdxComponents,
  D2Diagram,
  D2InteractiveDiagram,
  TerminalSession,
  CodeDiff,
  CodeWalkthrough,
  SpanWaterfall,
  Callout,
  Card,
  Cards,
  Step,
  Steps,
  Tab,
  Tabs,
  Accordion,
  Accordions,
  TypeTable,
  File,
  Folder,
  Files,
};

export default async function Page({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  if (!slug) redirect('/fundamentals/redis-overview/');
  const page = source.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  return (
    <DocsPage toc={page.data.toc} full={false}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={mdxComponents} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return [{ slug: [] as string[] }, ...source.generateParams()];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();
  return {
    title: page.data.title,
    description: page.data.description,
  };
}
