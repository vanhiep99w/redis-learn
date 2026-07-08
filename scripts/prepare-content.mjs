#!/usr/bin/env node

/**
 * Prepare Redis Learning markdown files for Fumadocs.
 *
 * 1. Parse README.md → extract file-to-category/title/description/order mapping
 * 2. For each .md file: add YAML frontmatter, strip manual TOC, rewrite cross-doc links
 * 3. Copy files into content/docs/{category}/
 * 4. Write meta.json per category for Fumadocs sidebar labels
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

// ── Category mapping ───────────────────────────────────────────────────────────
const SECTION_TO_DIR = {
  'Fundamentals': 'fundamentals',
  'Data Structures': 'data-structures',
  'Persistence': 'persistence',
  'Replication & High Availability': 'replication-ha',
  'Performance': 'performance',
  'Patterns & Use Cases': 'patterns',
  'Advanced': 'advanced',
  'Operations': 'operations',
};

// ── Step 1: Parse README.md ────────────────────────────────────────────────────

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const lines = readme.split('\n');

/** @type {Map<string, {category: string, dir: string, title: string, description: string, order: number}>} */
const fileMap = new Map();

let currentSection = null;
let orderInSection = 0;

for (const line of lines) {
  // Detect section headers: ## Fundamentals, ## Compute, etc.
  const sectionMatch = line.match(/^## (.+)$/);
  if (sectionMatch) {
    const sectionName = sectionMatch[1].trim();
    if (SECTION_TO_DIR[sectionName]) {
      currentSection = sectionName;
      orderInSection = 0;
    } else {
      currentSection = null;
    }
    continue;
  }

  if (!currentSection) continue;

  // Detect file entries: - [x] [Title](filename.md) - Description
  const entryMatch = line.match(/^- \[x\] \[(.+?)\]\((.+?\.md)\)\s*-\s*(.+)$/);
  if (entryMatch) {
    orderInSection++;
    const [, readmeTitle, filename, description] = entryMatch;
    fileMap.set(filename, {
      category: currentSection,
      dir: SECTION_TO_DIR[currentSection],
      title: readmeTitle,
      description: description.trim(),
      order: orderInSection,
    });
  }
}

console.log(`Parsed ${fileMap.size} files from README.md`);

// ── Copy static diagram assets ────────────────────────────────────────────────
// Markdown files can embed diagrams with absolute URLs such as:
//   ![Diagram](/diagrams/example.png)
// Next.js serves files under public/ from the site root. Keep editable
// .excalidraw sources in docs/diagrams/, and publish rendered PNG/SVG assets
// by copying the folder to public/diagrams during content preparation.
const diagramsSrc = join(ROOT, 'docs', 'diagrams');
const diagramsDest = join(ROOT, 'public', 'diagrams');
if (existsSync(diagramsSrc)) {
  rmSync(diagramsDest, { recursive: true, force: true });
  mkdirSync(diagramsDest, { recursive: true });
  cpSync(diagramsSrc, diagramsDest, { recursive: true });
  console.log(`Copied diagrams → public/diagrams/`);
}

// ── Build lookup: filename.md → /category-dir/slug/ ──────────────────────────

/** @type {Map<string, string>} */
const linkMap = new Map();
for (const [filename, meta] of fileMap) {
  const slug = basename(filename, '.md');
  linkMap.set(filename, `/${meta.dir}/${slug}/`);
}

// ── Step 2–3: Process each file ────────────────────────────────────────────────

// Output to content/docs/ (Fumadocs convention)
const docsBase = join(ROOT, 'content', 'docs');

for (const [filename, meta] of fileMap) {
  const srcPath = join(ROOT, filename);
  if (!existsSync(srcPath)) {
    console.warn(`  SKIP (not found): ${filename}`);
    continue;
  }

  let content = readFileSync(srcPath, 'utf8');

  // 2a. Extract title from first # heading
  const titleMatch = content.match(/^# (.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : meta.title;

  // 2b. Remove manual TOC section: from "## Mục lục" to next "---"
  content = content.replace(
    /\n## Mục lục\n[\s\S]*?\n---\n/,
    '\n'
  );

  // 2c. Rewrite cross-document links: [text](./filename.md) or [text](filename.md)
  content = content.replace(
    /\[([^\]]+)\]\(\.?\/?([a-z][a-z0-9\-]*\.md)\)/g,
    (match, text, linkedFile) => {
      const target = linkMap.get(linkedFile);
      if (target) {
        return `[${text}](${target})`;
      }
      return match; // leave unchanged if not in our map
    }
  );

  // 2d. Build frontmatter (Fumadocs uses title + description natively)
  const frontmatter = [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `description: "${meta.description.replace(/"/g, '\\"')}"`,
    '---',
  ].join('\n');

  // 2e. Remove existing title line (first # heading) since frontmatter provides it
  content = content.replace(/^# .+\n+/, '');

  // 2f. Combine
  const finalContent = frontmatter + '\n\n' + content.trimStart();

  // 2g. Write to target directory
  const targetDir = join(docsBase, meta.dir);
  mkdirSync(targetDir, { recursive: true });
  const targetPath = join(targetDir, filename.replace(/.*\//, ''));
  writeFileSync(targetPath, finalContent, 'utf8');
  console.log(`  ✓ ${filename} → ${meta.dir}/`);
}

// ── Step 4: Write meta.json per category for Fumadocs sidebar labels/order ───

for (const [sectionName, dir] of Object.entries(SECTION_TO_DIR)) {
  const categoryDir = join(docsBase, dir);
  if (existsSync(categoryDir)) {
    const pages = [...fileMap.entries()]
      .filter(([, meta]) => meta.category === sectionName)
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([filename]) => basename(filename, '.md'));

    const metaPath = join(categoryDir, 'meta.json');
    writeFileSync(metaPath, JSON.stringify({ title: sectionName, pages }, null, 2), 'utf8');
  }
}

// ── Step 5: Write root meta.json to define sidebar category order ──────────────

const CATEGORY_ORDER = [
  'fundamentals',
  'data-structures',
  'persistence',
  'replication-ha',
  'performance',
  'patterns',
  'advanced',
  'operations',
];

writeFileSync(
  join(docsBase, 'meta.json'),
  JSON.stringify({ pages: CATEGORY_ORDER }, null, 2),
  'utf8'
);

console.log(`\nDone! Files written to content/docs/`);
