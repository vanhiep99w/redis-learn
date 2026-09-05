# Doc-type structure templates

Starting shapes per doc type. Adapt freely — these are skeletons, not rigid rules.

## Architecture / Design doc

```
---
title:
description:
---

<Callout type="info">Scope / audience / status (draft, approved...)</Callout>

## Mục lục
- [Problem / Context](#problem--context)
- [Goals & Non-goals](#goals--non-goals)
- [Overview](#overview)
- [Detailed design](#detailed-design)
- [Alternatives considered](#alternatives-considered)
- [Trade-offs / Risks](#trade-offs--risks)
- [Open questions](#open-questions)

## Problem / Context
## Goals & Non-goals
## Overview
  - Mermaid flowchart or sequence diagram of the system
## Detailed design
  - subsections per component
  - ASCII or Mermaid diagrams per component as needed
## Alternatives considered
## Trade-offs / Risks
<Callout type="warn">Known limitations</Callout>
## Open questions
```

## API documentation

```
---
title:
description:
---

## Mục lục
- [Overview](#overview)
- [Authentication](#authentication)
- [Endpoints](#endpoints)
- [Errors](#errors)

## Overview
## Authentication
## Endpoints
  ### POST /resource
  <TypeTable ... /> for request params
  ```json title="Request"
  ...
  ```
  ```json title="Response"
  ...
  ```
  <Callout type="warn">Rate limits / error codes</Callout>
## Errors
  table of status codes
```

## Runbook / Operations guide

```
---
title:
description:
---

<Callout type="warn">When to use this runbook / on-call context</Callout>

## Mục lục
- [Symptoms](#symptoms)
- [Diagnosis](#diagnosis)
- [Resolution steps](#resolution-steps)
- [Rollback](#rollback)
- [Escalation](#escalation)

## Symptoms
## Diagnosis
  - Mermaid flowchart as a decision tree (symptom -> check -> fix)
## Resolution steps
  <Steps>...</Steps>
## Rollback
## Escalation
```

## Getting started / How-to guide

```
---
title:
description:
---

## Mục lục
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Verify it works](#verify-it-works)
- [Next steps](#next-steps)

## Prerequisites
## Installation
  tabbed code block (npm/pnpm/yarn) or <Tabs>
<Steps>
  step-by-step setup
</Steps>
## Verify it works
## Next steps
  <Cards> to related docs
```
