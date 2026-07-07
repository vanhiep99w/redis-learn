# AWS-Style Doc — Sections & Conventions

Dùng cho các doc kiểu `aws-learn`: service reference, certification prep.

## Sections bắt buộc (theo thứ tự)

1. **Tổng quan** — Service là gì, key features, managed/serverless hay không
2. **Use Cases phổ biến** — Table: Use Case | Mô tả
3. **Exam Tips** — `> [!IMPORTANT]` blocks với câu hỏi exam mẫu
4. **Core Concepts** — Numbered sections (1. Data Model, 2. Capacity, 3. Replication, ...)
5. **So sánh** — Table so sánh với alternatives (e.g., DynamoDB vs RDS vs MongoDB)
6. **Cấu hình / AWS CLI** — Code examples ngắn gọn
7. **Best Practices** — Bullet list
8. **Pricing** — Key pricing dimensions, không cần exact numbers
9. **Tài liệu tham khảo** — Link AWS docs chính thức

## Exam Tips Format

```markdown
> [!IMPORTANT]
> **Khi exam hỏi:** "Which service has LEAST operational overhead for X?"
> → Đáp án: [Service] vì [lý do ngắn gọn]
>
> **Sample Question:**
> A company needs... Which solution MOST cost-effectively...?
> - A) Option A
> - B) **Option B ✓** — vì ...
> - C) Option C
```

## Comparison Tables

Luôn dùng table khi so sánh 2+ options:

```markdown
| Tiêu chí | DynamoDB | RDS | MongoDB Atlas |
|----------|----------|-----|---------------|
| Type | Key-Value/Document | Relational | Document |
| Scale | Unlimited | Vertical | Horizontal |
| Latency | Single-digit ms | ms-s | ms |
| Managed | Fully | Partially | Fully |
| Use Case | High-scale NoSQL | ACID transactions | Flexible schema |
```

## Naming Convention

Files: `{service-name}.md` — lowercase, hyphens
Ví dụ: `dynamodb.md`, `api-gateway.md`, `elastic-load-balancing.md`

Category folders: `compute/`, `database/`, `storage/`, `security/`, `networking/`, v.v.

## meta.json Structure & Page Ordering

**Category level** — phải có `"pages"` array với đúng thứ tự:
```json
{
  "title": "Database",
  "pages": [
    "rds",
    "aurora",
    "dynamodb",
    "elasticache",
    "neptune"
  ]
}
```

**Root `/content/docs/meta.json`** — thứ tự học tập từ cơ bản đến nâng cao:
```json
{
  "pages": [
    "fundamentals",
    "compute",
    "storage",
    "database",
    "networking",
    "security",
    "monitoring-management",
    "messaging-streaming",
    "iac"
  ]
}
```

**Thứ tự trong `"pages"` = thứ tự sidebar.** Khi thêm service mới, đặt gần các service liên quan (không append cuối mảng ngẫu nhiên).
