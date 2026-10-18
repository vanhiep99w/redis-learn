#!/usr/bin/env node
// Parse Markdown rather than guessing fence languages/indentation with grep.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';

const parser = unified().use(remarkParse);
const visual = /[\u2500-\u257f]|^\s*\+(?:[-=]+\+)+\s*$/m;
const oldLanguages = new Set(['diagram', 'mermaid', 'ascii', 'flowchart', 'graphviz', 'dot', 'plantuml']);

export function inspectMarkdown(markdown, path = '<markdown>') {
  const blocks = [];
  const violations = [];
  visit(parser.parse(markdown), 'code', (node, index, parent) => {
    const language = node.lang ?? 'unlabelled';
    const previous = parent?.children[(index ?? 0) - 1];
    const reason = previous?.type === 'html'
      ? previous.value.match(/^<!--\s*diagram-text:\s*([^\n]+?)\s*-->$/)?.[1]
      : undefined;
    const block = { path, line: node.position.start.line, language, reason, value: node.value };
    blocks.push(block);
    if (oldLanguages.has(language.toLowerCase())) {
      violations.push({ ...block, problem: 'Legacy diagram fence: dùng D2, Markdown table/list hoặc component phù hợp.' });
    } else if (language !== 'd2' && visual.test(node.value) && !reason) {
      violations.push({ ...block, problem: 'ASCII/box-drawing chưa review: chuyển diagram hoặc ghi lý do giữ text ngay trước fence.' });
    }
  });
  return { blocks, violations };
}

export function publishedFiles(readme) {
  return [...readme.matchAll(/^- \[x\] \[[^\]]+\]\(([^)]+\.md)\)/gm)].map((match) => match[1]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = publishedFiles(readFileSync('README.md', 'utf8'));
  const results = files.map((path) => inspectMarkdown(readFileSync(path, 'utf8'), path));
  const blocks = results.flatMap((result) => result.blocks);
  const violations = results.flatMap((result) => result.violations);
  for (const item of violations) console.error(`${item.path}:${item.line}: ${item.problem}`);
  if (process.argv.includes('--list-text')) {
    for (const item of blocks.filter((item) => ['text', 'plaintext', 'unlabelled'].includes(item.language))) {
      console.log(`${item.path}:${item.line} [${item.reason ?? 'text'}] ${item.value.slice(0, 220).replaceAll('\n', ' / ')}`);
    }
  }
  console.log(`Diagram audit: ${files.length} bài, ${blocks.length} code blocks, ${blocks.filter((item) => item.language === 'd2').length} D2, ${blocks.filter((item) => item.reason).length} text có lý do giữ nguyên, ${violations.length} lỗi.`);
  if (violations.length) process.exitCode = 1;
}
