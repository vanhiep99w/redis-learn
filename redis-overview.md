# Redis Overview

## Mục lục

- [Tổng quan](#tổng-quan)
- [Redis là gì?](#redis-là-gì)
- [Redis không chỉ là cache](#redis-không-chỉ-là-cache)
- [Redis khác database truyền thống như thế nào?](#redis-khác-database-truyền-thống-như-thế-nào)
- [Mental model: Redis là server data structures trong RAM](#mental-model-redis-là-server-data-structures-trong-ram)
- [Redis nhanh vì đâu?](#redis-nhanh-vì-đâu)
- [Use cases phổ biến](#use-cases-phổ-biến)
- [Khi nào nên dùng Redis?](#khi-nào-nên-dùng-redis)
- [Khi nào không nên dùng Redis?](#khi-nào-không-nên-dùng-redis)
- [Các khái niệm nền tảng cần biết](#các-khái-niệm-nền-tảng-cần-biết)
- [Lộ trình học Redis trong repo này](#lộ-trình-học-redis-trong-repo-này)
- [Tài liệu liên quan](#tài-liệu-liên-quan)

---

## Tổng quan

Một query database quan hệ thường tốn vài đến vài chục millisecond; dưới traffic cao, session check, counter, cache product hay rate limit lặp lại hàng nghìn lần/giây sẽ đè DB. Redis xuất hiện để giữ **cấu trúc dữ liệu thao tác được ngay trong RAM**, latency micro-giây, command atomic — không chỉ “nhét JSON vào Map”.

**Redis** là một **in-memory data structure store**: dữ liệu theo dạng key-value, nhưng value có thể là String, Hash, List, Set, Sorted Set, Stream, Bitmap, HyperLogLog, Geospatial… — không chỉ blob bytes.

Các nhóm việc hay gặp (chi tiết ở section use cases bên dưới):

| Nhóm | Ví dụ |
|------|--------|
| Cache & session | Product cache, session store, feature flag |
| Realtime state | Counter, leaderboard, rate limit |
| Coordination | Distributed lock, lightweight queue/stream, Pub/Sub |

Điểm cần nhớ ngay từ đầu:

```text
Redis = data structures + RAM + network server + atomic commands
```

Không nên hiểu Redis chỉ là “Map nằm trong memory”. Redis là một server độc lập, nhận command qua TCP, quản lý memory, TTL, persistence, replication, high availability và cluster routing.

```text
┌──────────────┐       TCP/RESP       ┌──────────────────────────┐
│ Application  │ ───────────────────▶ │ Redis Server             │
│              │ ◀─────────────────── │                          │
└──────────────┘       response       │ keyspace: key → value    │
                                      │ TTL / eviction / AOF/RDB │
                                      │ replication / cluster    │
                                      └──────────────────────────┘
```

> [!IMPORTANT]
> Redis rất nhanh, nhưng không phải phép màu. Vì Redis chủ yếu chạy trong RAM và execute command rất nhanh, những lỗi như big key, hot key, command O(N), TTL sai, connection pool sai hoặc persistence/failover sai có thể tạo sự cố rất lớn trong production.

---

## Redis là gì?

Tên Redis là viết tắt của **REmote DIctionary Server**. “Dictionary” ở đây có thể hiểu là map/hash table từ key sang value.

Ví dụ đơn giản:

```bash
SET user:1:name "Hiep"
GET user:1:name
```

Nhưng Redis không dừng ở `GET/SET`. Redis cho phép thao tác trực tiếp lên data structure ở server:

```bash
HSET user:1 name "Hiep" age 28
LPUSH queue:email job-123
SADD post:1:likes user:1 user:2
ZADD leaderboard 9999 user:1
XADD events:* type signup user_id 1
```

Điều này rất khác với việc lưu JSON string rồi application tự parse/sửa/ghi lại. Redis cung cấp operation atomic ở server cho từng structure.

Ví dụ tăng counter:

```bash
INCR page:home:views
```

Nếu 100 clients cùng gọi `INCR`, Redis serialize command và đảm bảo counter tăng đúng, không cần application lock.

---

## Redis không chỉ là cache

Nhiều người học Redis từ cache, nhưng Redis rộng hơn cache.

### Redis như cache

```text
App → Redis cache → Database
```

Nếu cache hit, app tránh query database. Nếu cache miss, app query DB rồi ghi lại Redis với TTL.

```bash
SET product:123 '{...json...}' EX 300
GET product:123
```

### Redis như data structure server

Redis có thể giữ trạng thái realtime mà database quan hệ xử lý kém hơn:

```bash
ZINCRBY leaderboard:daily 10 user:123
ZRANGE leaderboard:daily 0 9 REV WITHSCORES
```

### Redis như coordination primitive

```bash
SET lock:order:123 token NX PX 30000
```

Lệnh trên là nền tảng của distributed lock đơn giản vì `SET NX PX` atomic.

### Redis như streaming engine

```bash
XADD order-events * order_id 123 status paid
XREADGROUP GROUP workers worker-1 STREAMS order-events >
```

Redis Streams hỗ trợ event log, consumer groups, ack/retry.

> [!NOTE]
> Redis có thể dùng làm primary database cho một số workload, nhưng cần hiểu rõ persistence, memory limit, backup, failover và consistency. Với dữ liệu critical, đừng dùng Redis như source of truth nếu chưa thiết kế durability đầy đủ.

---

## Redis khác database truyền thống như thế nào?

| Khía cạnh | Redis | Database quan hệ / document DB thường gặp |
|----------|-------|--------------------------------------------|
| Storage chính | RAM | Disk/SSD + buffer cache |
| Latency | Thường sub-ms đến vài ms | Thường cao hơn, tùy query/index |
| Data model | Key-value + data structures | Table/document/graph/... |
| Query | Command theo key/structure | SQL/query language/index phong phú |
| Transaction | Atomic command, `MULTI/EXEC`, Lua | ACID transaction mạnh hơn |
| Scale write | Cluster sharding theo hash slots | Tùy database, thường phức tạp hơn |
| Durability | RDB/AOF tùy config | Thường durable mặc định hơn |
| Memory cost | Cao vì giữ dataset trong RAM | Tối ưu lưu trữ disk tốt hơn |

Redis giỏi nhất khi bạn biết key cần truy cập. Redis không phải hệ thống query ad-hoc mạnh như PostgreSQL/Elasticsearch.

Ví dụ phù hợp Redis:

```bash
GET session:abc
HGET user:123 profile_json
ZRANGE leaderboard 0 99 REV
```

Ví dụ không phù hợp Redis nếu làm trực tiếp:

```sql
SELECT * FROM orders
WHERE amount > 1000
  AND created_at BETWEEN ...
  AND status IN (...)
ORDER BY created_at DESC
LIMIT 50;
```

Muốn làm kiểu query phức tạp trong Redis cần thiết kế index thủ công hoặc dùng module như RediSearch/Redis Stack. Đó là câu chuyện khác.

---

## Mental model: Redis là server data structures trong RAM

Hãy hình dung Redis như một process quản lý một keyspace lớn:

```text
Redis keyspace
├── "session:abc"       → String      "{user_id:123,...}"   TTL 30m
├── "user:123"          → Hash        name/email/plan
├── "queue:email"       → List        [job3, job2, job1]
├── "post:9:likes"      → Set         {user1,user2,user3}
├── "leaderboard"       → Sorted Set  user → score
└── "events"            → Stream      append-only entries
```

Mỗi command đi vào Redis event loop, được execute tuần tự:

```text
Client A: INCR counter
Client B: INCR counter
Client C: GET counter

Redis execute:
1. INCR counter
2. INCR counter
3. GET counter
```

Vì command được execute tuần tự trên main thread, từng command đơn lẻ là atomic.

### Key là đơn vị định danh

Key là tên duy nhất trong database Redis. Thiết kế key tốt giúp:

- Dễ debug.
- Tránh conflict namespace.
- Hỗ trợ TTL đúng.
- Hạn chế hot key/big key.
- Dễ dùng Cluster hash tags.

Ví dụ tốt:

```text
user:123:profile
session:8f3a...
rate:user:123:2026-07-08T10:30
product:456:cache
```

Chi tiết xem [Keys, Naming & TTL](./keys-and-ttl.md).

---

## Redis nhanh vì đâu?

Redis nhanh do kết hợp nhiều yếu tố, không phải chỉ vì “viết bằng C”.

| Yếu tố | Tác dụng |
|--------|----------|
| In-memory | Không phải đọc disk trong request path thông thường |
| Event loop | Xử lý nhiều connections với overhead thấp |
| Single-threaded command execution | Không lock khi thao tác keyspace |
| Data structures tối ưu | Hash table, listpack, skiplist, intset, SDS |
| Protocol đơn giản | RESP dễ parse, ít overhead |
| Pipelining | Giảm round-trip network |
| Background work | RDB/AOF rewrite/lazy free giảm block main path |

Nhưng Redis cũng có giới hạn:

- Một command chậm block các command sau.
- Dataset phải vừa RAM.
- Network round-trip vẫn quan trọng.
- Persistence/fork có thể gây latency spike.
- Replication async có thể mất write mới nhất khi failover.

Nếu muốn hiểu sâu cơ chế event loop, command lifecycle, memory object, hãy đọc [Redis Architecture](./redis-architecture.md).

---

## Use cases phổ biến

### Cache

Redis phù hợp làm cache vì latency thấp, hỗ trợ TTL per-key và eviction policy.

```bash
SET product:123 '{"id":123,"name":"Keyboard"}' EX 300
GET product:123
```

Đọc thêm: [Caching Patterns](./caching-patterns.md), [Eviction Policies](./eviction-policies.md).

### Session store

Session cần lookup nhanh theo token/session id và tự hết hạn.

```bash
SET session:abc '{"user_id":123}' EX 1800
```

Đọc thêm: [Session Store](./session-store.md).

### Rate limiting

Counter + TTL rất phù hợp cho fixed window rate limit.

```bash
INCR rate:user:123:minute:202607081030
EXPIRE rate:user:123:minute:202607081030 60
```

Đọc thêm: [Rate Limiting](./rate-limiting.md).

### Leaderboard

Sorted Set là data structure kinh điển cho ranking.

```bash
ZADD game:rank 1200 user:1
ZREVRANGE game:rank 0 9 WITHSCORES
```

Đọc thêm: [Sorted Sets](./sorted-sets.md), [Leaderboard & Counting](./leaderboard-counting.md).

### Queue đơn giản

List hỗ trợ push/pop và blocking pop.

```bash
LPUSH queue:email job-1
BRPOP queue:email 5
```

Đọc thêm: [Lists](./lists.md).

### Event stream

Streams phù hợp hơn List khi cần consumer groups, ack, replay.

```bash
XADD events:* type signup user_id 123
```

Đọc thêm: [Streams](./streams.md).

### Pub/Sub

Redis Pub/Sub phù hợp broadcast realtime fire-and-forget.

```bash
PUBLISH notifications "hello"
SUBSCRIBE notifications
```

Đọc thêm: [Pub/Sub](./pub-sub.md).

---

## Khi nào nên dùng Redis?

Redis phù hợp khi bạn có một hoặc nhiều đặc điểm sau:

| Dấu hiệu | Ví dụ |
|----------|-------|
| Cần latency rất thấp | session lookup, feature flag, cache hot data |
| Access theo key rõ ràng | `GET session:<id>`, `HGET user:<id>` |
| Cần TTL tự động | cache, token, OTP, rate limit window |
| Cần counter atomic | view count, quota, inventory hold ngắn hạn |
| Cần data structure realtime | leaderboard, set membership, queue |
| Cần giảm tải database | cache-aside, read-through cache |
| Có thể chịu eventual consistency | replica reads, async failover |

Một câu hỏi thực tế:

```text
Nếu Redis mất dữ liệu 1 phút gần nhất, hệ thống có chấp nhận không?
```

Nếu câu trả lời là “không bao giờ”, bạn cần thiết kế persistence/replication/failover rất cẩn thận hoặc dùng database khác làm source of truth.

---

## Khi nào không nên dùng Redis?

### 1. Dataset lớn hơn RAM quá nhiều

Redis giữ dataset trong RAM. Nếu dữ liệu hàng TB và access không quá hot, database disk-based có thể hợp lý hơn.

### 2. Cần query phức tạp ad-hoc

Redis không thay thế SQL database cho report/query tùy ý.

### 3. Cần transaction ACID phức tạp

Redis có atomic command, `MULTI/EXEC`, Lua, nhưng không giống transaction engine của PostgreSQL.

### 4. Cần strong consistency đa node

Replication/Sentinel/Cluster của Redis OSS dùng async replication. Có cửa sổ mất write khi failover.

### 5. Không có khả năng vận hành memory/latency

Redis production cần monitor memory, fragmentation, big keys, slow commands, persistence, replication lag.

> [!WARNING]
> Redis rất dễ bắt đầu, nhưng cũng rất dễ bị dùng sai: lưu object quá lớn, không TTL cho cache, dùng `KEYS *`, đọc replica ngay sau write, hard-code master IP, không backup, hoặc không test failover.

---

## Các khái niệm nền tảng cần biết

| Khái niệm | Ý nghĩa | Đọc thêm |
|----------|---------|----------|
| Keyspace | Tập key trong Redis DB | [Keys, Naming & TTL](./keys-and-ttl.md) |
| Data type | Loại value: string/hash/list/... | [Strings](./strings.md), [Hashes](./hashes.md) |
| TTL | Thời gian sống của key | [Keys, Naming & TTL](./keys-and-ttl.md) |
| Atomic command | Command đơn lẻ không bị interleave | [Redis Architecture](./redis-architecture.md) |
| Pipelining | Gửi nhiều command không chờ từng response | [Pipelining & Batching](./pipelining-batching.md) |
| Persistence | Ghi dữ liệu xuống disk bằng RDB/AOF | [Persistence Strategies](./persistence-strategies.md) |
| Replication | Master gửi stream thay đổi sang replica | [Replication](./replication.md) |
| Sentinel | HA/failover cho Redis không sharding | [Redis Sentinel](./sentinel.md) |
| Cluster | Sharding bằng 16384 hash slots | [Redis Cluster](./cluster.md) |
| Eviction | Xóa key khi vượt `maxmemory` | [Eviction Policies](./eviction-policies.md) |

---

## Lộ trình học Redis trong repo này

Nếu bạn mới học Redis, nên đi theo flow:

```text
1. Redis Overview
2. Redis Architecture
3. Keys, Naming & TTL
4. Data Structures
5. Persistence
6. Replication / Sentinel / Cluster
7. Performance
8. Patterns & Use Cases
9. Operations
```

Gợi ý cụ thể:

1. Đọc doc này để có mental model.
2. Đọc [Redis Architecture](./redis-architecture.md) để hiểu vì sao Redis nhanh và vì sao command chậm nguy hiểm.
3. Đọc [Keys, Naming & TTL](./keys-and-ttl.md) trước khi thiết kế key production.
4. Đọc lần lượt Data Structures: [Strings](./strings.md), [Hashes](./hashes.md), [Lists](./lists.md), [Sets](./sets.md), [Sorted Sets](./sorted-sets.md), [Streams](./streams.md).
5. Đọc Persistence và HA nếu Redis giữ dữ liệu quan trọng.
6. Đọc Performance/Operations trước khi deploy production.

### 5 ý nhớ lâu

1. **Redis = data structures + RAM + network server**, không chỉ cache Map.
2. **Command chạy tuần tự trên một execution path** — atomic từng lệnh, nhưng lệnh chậm làm chậm mọi client.
3. **Truy cập theo key**, không phải SQL ad-hoc; model dữ liệu phải khớp access pattern.
4. **RAM + persistence là trade-off**: mất điện / restart / RPO phụ thuộc RDB/AOF/replica, không “tự an toàn”.
5. **Big key, hot key, TTL sai, pool sai** thường phá production hơn “Redis chậm”.

Chi tiết event loop, command lifecycle, expire engine → [Redis Architecture](./redis-architecture.md).

---

## Tài liệu liên quan

- [Redis Architecture](./redis-architecture.md) - Event loop, single-threaded execution, command lifecycle, memory internals.
- [Keys, Naming & TTL](./keys-and-ttl.md) - Thiết kế key, TTL, expire, hot key, big key.
- [Strings](./strings.md) - Data type cơ bản nhất trong Redis.
- [Caching Patterns](./caching-patterns.md) - Cache-aside, write-through, stampede, TTL strategies.
- [Persistence Strategies](./persistence-strategies.md) - RDB/AOF/hybrid.
- [Replication](./replication.md) - Master-replica, offset, backlog.
- [Redis Sentinel](./sentinel.md) - Automatic failover.
- [Redis Cluster](./cluster.md) - Sharding với hash slots.
- [Redis official docs: Get started](https://redis.io/docs/latest/develop/get-started/)
