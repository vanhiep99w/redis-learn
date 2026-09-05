# Planning a full doc outline for a topic

Goal: before writing any files, produce a complete category + page plan, shaped like the reference screenshot (an "OpenTelemetry Learning" sidebar): foundational categories first, topic-core categories in the middle, operational categories last.

## Generic shape (adapt per topic, don't force every topic into exactly this)

1. **Nền tảng / Foundations** — what it is, core concepts, terminology, when to use it vs alternatives.
2. **Bắt đầu / Getting started** — install, minimal setup, first run/hello-world.
3. **Core topic categories** (the bulk of the docs — 3 to 6 categories, each with 4 to 8 pages) — this is where the topic-specific breakdown happens; see worked examples below.
4. **Instrumentation / language & framework integration** (if applicable to the topic) — how to use it from specific languages/frameworks/clients.
5. **Ecosystem / protocols / backends** (if applicable) — integrations, exporters, plugins, related tools.
6. **Deployment / Triển khai** — how to run it in a real environment (single node, cluster, cloud-managed).
7. **Production** — performance, security, monitoring, scaling, upgrade paths.
8. **Troubleshooting** — common errors, debugging techniques, FAQ.

Not every topic needs all 8 groups — skip what doesn't apply, merge small groups together. Interview-question collections in particular use a different shape (see below).

## Worked examples

### Redis
- Nền tảng: What is Redis, in-memory model, use cases vs other DBs
- Bắt đầu: Install, redis-cli basics, first commands
- Data structures: Strings, Lists, Hashes, Sets, Sorted sets, Streams, Bitmaps/HyperLogLog
- Persistence & durability: RDB, AOF, hybrid, backup/restore
- Replication & clustering: Master-replica, Sentinel, Redis Cluster, sharding
- Client libraries: Node.js, Python, Java, Go clients
- Deployment: Docker, Kubernetes, managed services (ElastiCache, etc.)
- Production: Memory management/eviction policies, security (ACLs, TLS), monitoring
- Troubleshooting: Common errors, latency debugging, memory issues

### Kafka
- Nền tảng: Pub/sub model, topics/partitions/offsets, brokers
- Bắt đầu: Install, create a topic, produce/consume from CLI
- Core concepts: Producers, Consumers & consumer groups, Partitioning & replication, Delivery semantics (at-least-once etc.)
- Kafka Connect & Streams: Connectors, Kafka Streams basics, ksqlDB
- Client libraries: Java, Python, Node.js clients
- Deployment: KRaft vs ZooKeeper, Docker, Kubernetes (Strimzi), managed (MSK, Confluent Cloud)
- Production: Performance tuning, security (SASL/SSL/ACLs), monitoring (JMX, lag)
- Troubleshooting: Rebalancing issues, lag, common errors

### Kubernetes
- Nền tảng: Container orchestration concepts, cluster architecture
- Bắt đầu: kubectl basics, minikube/kind, first deployment
- Core objects: Pods, Deployments, Services, ConfigMaps & Secrets, Volumes & PersistentVolumes
- Networking: Ingress, Network Policies, DNS
- Workload patterns: StatefulSets, Jobs/CronJobs, Autoscaling (HPA/VPA)
- Ecosystem: Helm, Operators/CRDs, Service mesh basics
- Deployment: Managed clusters (EKS/GKE/AKS), self-hosted (kubeadm)
- Production: RBAC & security, resource limits, monitoring (Prometheus), upgrades
- Troubleshooting: Debugging pods, common errors, crash loops

### Java
- Nền tảng: JVM model, language basics vs other languages
- Bắt đầu: JDK install, first program, build tools overview
- Core language: OOP in Java, Collections framework, Generics, Streams & Lambdas, Exception handling
- Concurrency: Threads, Executors, java.util.concurrent, virtual threads
- Frameworks & ecosystem: Spring Boot basics, build tools (Maven/Gradle), testing (JUnit)
- Deployment: Packaging (JAR/WAR), containers, JVM tuning flags
- Production: Performance/GC tuning, security, observability
- Troubleshooting: Common exceptions, debugging, memory leaks

### Microservices
- Nền tảng: Monolith vs microservices, when (not) to use it
- Bắt đầu: Minimal two-service example
- Core patterns: Service discovery, API gateway, Communication (sync/async), Data consistency (saga, outbox)
- Resilience: Circuit breakers, retries/timeouts, rate limiting
- Observability: Distributed tracing, centralized logging, metrics
- Deployment: Containers, Kubernetes, CI/CD for microservices
- Production: Security (service-to-service auth), scaling, versioning APIs
- Troubleshooting: Debugging distributed failures, common anti-patterns

### Interview questions (different shape — Q&A collections, not a learning roadmap)
Use categories per sub-topic instead of the foundations→production arc:
- Câu hỏi cơ bản / Fundamentals
- Cấu trúc dữ liệu & giải thuật / Data structures & algorithms
- [Topic]-specific questions (e.g. "Java core", "Spring", "Database", "System design")
- Câu hỏi tình huống / Behavioral & scenario questions
- Mock interview / practice sets

Each page here is usually a themed set of Q&A rather than a single concept — plan page granularity around "how many questions fit comfortably on one page" (10-20 per page is reasonable) rather than one page per concept.

## Naming conventions

- Folder/file slugs: lowercase, ASCII, hyphen-separated, no diacritics (e.g. `telemetry-signals`, `du-lieu-co-ban` for "dữ liệu cơ bản") — URLs should stay clean even if the visible titles are in Vietnamese.
- `meta.json` `title` field carries the human-readable name (with diacritics if the doc is in Vietnamese) — this is what actually renders in the sidebar.
- Keep the category landing page filename consistent across the project — pick one convention (`index.mdx` is recommended) and use it for every category.
