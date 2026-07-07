# Case Study Doc — Structure & Depth

Dùng cho docs kiểu `25-case-study-ecommerce.md` — end-to-end system design.

## Table of Contents Structure

Case study cần TOC đầy đủ vì doc dài (100+ sections):

```markdown
## Mục lục

- [1. Yêu cầu hệ thống](#1-yêu-cầu-hệ-thống)
  - [1.1 Functional Requirements](#11-functional-requirements)
  - [1.2 Non-Functional Requirements](#12-non-functional-requirements)
- [2. Domain Analysis](#2-domain-analysis)
- [3. Service Decomposition](#3-service-decomposition)
- [4. Communication Patterns](#4-communication-patterns)
- [5. Data Management](#5-data-management)
- [6. Resilience Design](#6-resilience-design)
- [7. Security Architecture](#7-security-architecture)
- [8. Infrastructure & Deployment](#8-infrastructure--deployment)
- [9. Architecture Decision Records (ADRs)](#9-architecture-decision-records-adrs)
- [10. Migration Roadmap](#10-migration-roadmap)
```

## Sections Bắt buộc

### 1. Yêu cầu hệ thống

```markdown
### 1.1 Functional Requirements
- Order management: tạo, update, cancel, track
- Inventory: real-time stock, reservation
- Payment: multiple methods, refund

### 1.2 Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Concurrent users | 20,000 (peak flash sale) |
| Orders/day | 50,000 |
| Uptime | 99.9% (< 8.7h downtime/year) |
| P95 response time | < 300ms |
| Data retention | 7 years (compliance) |
```

### 2. Service Decomposition

Luôn kèm diagram:
```
┌─────────────────────────────────────────────┐
│                  API Gateway                │
└──────┬────────┬──────────┬──────────────────┘
       │        │          │
  ┌────▼──┐ ┌───▼───┐ ┌───▼──────┐
  │ Order │ │Inventory│ │ Payment │
  └────┬──┘ └───┬───┘ └───┬──────┘
       │        │          │
  ┌────▼────────▼──────────▼──────┐
  │         Event Bus (SQS/SNS)   │
  └───────────────────────────────┘
```

### 9. Architecture Decision Records (ADRs)

```markdown
#### ADR-001: Chọn Event Sourcing cho Order Service

**Status:** Accepted
**Context:** Order state thay đổi nhiều, cần audit trail đầy đủ
**Decision:** Dùng Event Sourcing + CQRS
**Consequences:**
- ✅ Full audit trail
- ✅ Replay events để rebuild state
- ❌ Query complexity tăng
- ❌ Learning curve cho team
```

### 10. Migration Roadmap

Dùng 90-day plan với milestones:

```markdown
#### Phase 1 (Week 1-4): Foundation
- [ ] Setup Kubernetes cluster
- [ ] Deploy API Gateway
- [ ] Migrate User Service

#### Phase 2 (Week 5-8): Core Services
- [ ] Order Service
- [ ] Inventory Service
- [ ] Payment Service

#### Phase 3 (Week 9-12): Stabilization
- [ ] Load testing (target: 20k concurrent)
- [ ] Chaos engineering
- [ ] Runbook documentation
```

## Depth Expectations

Case study docs nên:
- Có số liệu cụ thể (không dùng "many users", dùng "50k orders/day")
- Có ít nhất 2-3 alternatives cho mỗi decision lớn
- Có weighted decision matrix khi có 3+ alternatives
- Có runbook cho SEV-1 incidents (top 2-3 failure scenarios)
- Có STRIDE threat model hoặc security checklist
