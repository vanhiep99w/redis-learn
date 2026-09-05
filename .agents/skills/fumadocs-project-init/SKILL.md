---
name: fumadocs-project-init
description: Use this skill when the user wants to scaffold a brand-new Next.js + Fumadocs documentation site from an empty folder for a given topic (e.g. "tạo project docs cho Redis", "khởi tạo site Fumadocs về Kafka", "init a Kubernetes docs site"). It sets up the full Next.js + Fumadocs project (latest version), plans out every doc page the topic needs, writes them all as placeholder pages (no detailed content), and applies a tightened-padding layout so content fills more of the screen. Do NOT use this for writing the detailed content of a single doc page (use fumadocs-technical-writer for that) — this skill only initializes the project and lays out placeholders; each placeholder is meant to be filled in later, one page at a time, by fumadocs-technical-writer.
---

# Fumadocs Project Init

Scaffold a complete Next.js + Fumadocs documentation project from an empty folder, for a given technical topic (Redis, Kafka, Java, Kubernetes, microservices, interview-question collections, etc.). This skill produces the **project skeleton and every page as a placeholder** — not the detailed content. Detailed content for each page is written later, one page at a time, using the `fumadocs-technical-writer` skill.

## Relationship to `fumadocs-technical-writer`

These two skills are a pair, used in sequence:
1. **`fumadocs-project-init`** (this skill) — run once per topic. Creates the project, decides the full page/category structure, writes every page as a lightweight placeholder.
2. **`fumadocs-technical-writer`** — run once per page afterward, whenever the user says "viết chi tiết phần X" / "fill in the Redis persistence page". It replaces one placeholder's body with full content, following the same frontmatter/TOC/component conventions this skill already set up.

Mention this handoff to the user at the end: which page to tackle first, and that they can ask you to write it in detail next.

## Critical environment constraint: no network access

This sandbox's bash tool has **no network access**. That means `npm install`, `npx create-next-app`, `pnpm create fumadocs-app`, etc. cannot actually run here — they need the registry. So the workflow is:

- **Write every project file directly** (package.json, configs, content files) using the file-creation tools, reproducing exactly what the Fumadocs manual-installation flow would produce.
- **Do not attempt to run `npm install`, the dev server, or a build** in this sandbox — it will fail with a network error. Tell the user this upfront: they need to run `npm install` (or `pnpm install`) themselves once they have the project locally.
- Package the resulting folder so the user can download it and unzip locally, then run `npm install && npm run dev`.

## Workflow

### 1. Confirm the topic and scope
If the user already named a clear topic (as in the trigger examples), proceed without asking. Only ask a clarifying question if the topic is genuinely ambiguous (e.g. "docs" with no subject) or if language (Vietnamese vs English docs) isn't clear from context — default to matching the language the user is writing in.

### 2. Plan the full doc outline
Before writing any files, design the complete page tree for the topic: top-level categories (folders) and the pages inside each. Read `references/topic-outline-guide.md` for the planning pattern and worked examples (Redis, Kafka, Kubernetes, Java, microservices, interview questions) — follow that pattern's shape: a learning-roadmap style structure with foundational categories first, topic-core categories in the middle, and operational/troubleshooting categories at the end, mirroring the reference screenshot's structure (Nền tảng → Bắt đầu → topic-specific groups → Instrumentation/framework-specific → Deployment/Production → Troubleshooting).

Write this plan out as a simple nested list before generating files, so structure is decided once and applied consistently (folder names, ordering, page slugs).

### 3. Scaffold the Next.js + Fumadocs project files
Read `references/project-file-templates.md` for the exact file contents (package.json, next.config.ts, source.config.ts, mdx-components.tsx, lib/source.ts, lib/layout.shared.ts, app/layout.tsx, app/global.css, app/docs/layout.tsx, app/docs/[[...slug]]/page.tsx, tsconfig.json, postcss.config). Write every one of these into the target folder — this is the latest Fumadocs App Router setup (fumadocs-mdx content source + fumadocs-ui layouts, Tailwind v4).

### 4. Generate the content tree with placeholders
For every folder in the plan from step 2:
- Add a `meta.json` (title + page ordering — see reference for exact schema).
- Add an `index.mdx` (or a same-named `.mdx`) **category landing page** styled like the reference screenshot's "trang khung" pattern: frontmatter title/description, a short intro sentence stating this is a placeholder page for the group, a "## Phạm vi dự kiến" (or "## Expected scope" in English) section, and a "## Các bài trong nhóm" (or "## Pages in this group") bullet list linking to each child page with a one-line description of what that page will cover. Include the manual mục lục convention from `fumadocs-technical-writer` here too, for consistency.

For every leaf/detail page in the plan:
- Frontmatter with `title`/`description`.
- A short placeholder body: one or two sentences describing what this page will cover, plus a `<Callout type="info">` noting it's a placeholder to be filled in via the detailed-writing pass.
- Do **not** write full detailed content, diagrams, or long explanations here — that's `fumadocs-technical-writer`'s job later. Keep every leaf placeholder brief and consistent in shape.

Every generated `.mdx` file must still be valid, buildable Fumadocs MDX (correct frontmatter, no broken syntax) even though the content is a placeholder.

### 5. Apply the tightened-padding layout
The user wants: (a) the overall docs layout to extend closer to both screen edges instead of capping out with large empty margins on wide screens, and (b) the padding between the sidebar/content/TOC columns reduced so the article content area is wider. Read `references/layout-padding-customization.md` and apply its recommended CSS variable overrides and container prop changes to `app/global.css` and `app/docs/layout.tsx` as part of step 3's files (don't skip this — it's a firm requirement every time this skill runs, not optional polish).

### 6. Wrap up
- Present the project folder to the user (zip it if it's large — see file-sharing guidance).
- Tell them explicitly: this sandbox has no network access, so they must run `npm install` (or `pnpm install`) and `npm run dev` themselves after downloading/unzipping.
- Point out the doc outline you generated (categories + page count) and suggest which page to write first with `fumadocs-technical-writer`.
