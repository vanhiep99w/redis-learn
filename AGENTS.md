# AGENTS.md

## Project Overview
Redis learning documentation repository — Markdown files tiếng Việt về Redis, hiển thị qua webapp Next.js + Fumadocs, deploy Cloudflare Pages.

## Structure
- `README.md` - Table of contents với links tới mọi topic (**source of truth cho webapp**)
- `*.md` - Doc files cho từng Redis topic
- `content/docs/` - Auto-generated bởi `scripts/prepare-content.mjs`, gitignored
- `scripts/prepare-content.mjs` - Script build content từ README.md → content/docs/
- `src/` - Next.js + Fumadocs webapp

## Commands
```bash
npm install
npm run dev      # localhost:3000 (tự chạy prepare-content trước)
npm run build    # next build → dist/
npm run deploy   # build + wrangler pages deploy dist
```

## ⚠️ Thêm file doc mới — PHẢI update README.md

Webapp **chỉ hiển thị các file có entry `- [x]` trong README.md**. Script `prepare-content.mjs` parse README.md để biết file nào thuộc category nào.

**Khi tạo file `.md` mới, BẮT BUỘC phải:**

1. Thêm entry vào đúng section trong `README.md` với format:
   ```
   - [x] [Tên Hiển Thị](ten-file.md) - Mô tả ngắn
   ```
2. File `.md` phải dùng `# Heading` làm title (KHÔNG dùng YAML frontmatter — script tự tạo)
3. Đặt entry vào đúng section

**Nếu quên bước này → file sẽ KHÔNG hiển thị trên webapp.**

Các section hợp lệ trong README.md:
`Fundamentals` · `Data Structures` · `Persistence` · `Replication & High Availability` · `Performance` · `Patterns & Use Cases` · `Advanced` · `Operations`

(Thêm section mới → update `SECTION_TO_DIR` và `CATEGORY_ORDER` trong `scripts/prepare-content.mjs`.)

## Guidelines
- Toàn bộ nội dung viết bằng tiếng Việt (giữ tiếng Anh cho tên kỹ thuật, commands, config)
- Theo write-docs skill: `.agents/skills/write-docs/SKILL.md`
- Ưu tiên bảng so sánh và diagram (ASCII/Mermaid) hơn prose dài
- Link related topics giữa các documents: `[text](./other-doc.md)` — script tự rewrite link

## Table of Contents (Mục lục)

Mỗi doc file (trừ `README.md`, `AGENTS.md`) cần **mục lục** ở đầu file:

- Đặt ngay sau tiêu đề chính (`# ...`)
- Heading `## Mục lục`, liệt kê các `##` headings dưới dạng anchor links
- Kết thúc bằng `---` (script strip TOC khi build vì Fumadocs có TOC riêng)
