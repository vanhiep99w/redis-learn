# Redis Learning - Mục lục

Tài liệu học Redis tiếng Việt — Next.js + Fumadocs, deploy trên Cloudflare Pages.

---

## Fundamentals

- [x] [Redis Overview](redis-overview.md) - Redis là gì, in-memory data store, use cases, khi nào nên/không nên dùng
- [x] [Redis Architecture](redis-architecture.md) - Event loop, single-threaded execution, command lifecycle, keyspace internals
- [x] [Keys, Naming & TTL](keys-and-ttl.md) - Key design, namespace, TTL, expire behavior, hot keys và big keys

## Data Structures

**Lộ trình đọc (sidebar theo thứ tự này):** Strings → Hashes → Lists → Sets → Sorted Sets → Bitmaps & HLL → Geospatial → **Streams** (nên đọc **sau [Lists](lists.md)** — queue đơn giản trước, log có ack/replay sau).

- [x] [Strings](strings.md) - GET/SET, INCR/DECR, TTL, bit operations, use cases counter và cache
- [x] [Hashes](hashes.md) - HSET/HGETALL, object storage, field-level operations, memory efficiency
- [x] [Lists](lists.md) - LPUSH/RPUSH, LRANGE, blocking operations (BLPOP), queue patterns
- [x] [Sets](sets.md) - SADD/SMEMBERS, set operations (union, intersect, diff), random members
- [x] [Sorted Sets](sorted-sets.md) - ZADD/ZRANGE, score-based ranking, leaderboard, range queries
- [x] [Bitmaps & HyperLogLog](bitmaps-hyperloglog.md) - SETBIT/BITCOUNT, PFADD/PFCOUNT, đếm unique với memory tối thiểu
- [x] [Geospatial](geospatial.md) - GEOADD/GEOSEARCH, tìm kiếm theo vị trí, radius queries
- [x] [Streams](streams.md) - XADD/XREAD, consumer groups, event sourcing; đọc sau Lists, so sánh Pub/Sub/Kafka

## Persistence

- [x] [RDB Snapshots](rdb.md) - Point-in-time snapshots, SAVE vs BGSAVE, fork và copy-on-write
- [x] [AOF](aof.md) - Append Only File, fsync policies, AOF rewrite, recovery
- [x] [Persistence Strategies](persistence-strategies.md) - So sánh RDB vs AOF vs hybrid, chọn strategy theo use case

## Replication & High Availability

- [x] [Replication](replication.md) - Master-replica, full sync vs partial sync, replication offset, read scaling
- [x] [Redis Sentinel](sentinel.md) - Automatic failover, quorum, sentinel discovery, client integration
- [x] [Redis Cluster](cluster.md) - Sharding với hash slots, cluster topology, resharding, multi-key operations

## Performance

- [x] [Memory Management](memory-management.md) - maxmemory, memory usage analysis, encoding optimizations, fragmentation
- [x] [Eviction Policies](eviction-policies.md) - LRU vs LFU vs TTL-based, noeviction, chọn policy phù hợp
- [x] [Pipelining & Batching](pipelining-batching.md) - Round-trip time, pipeline vs transaction vs script, batching best practices
- [x] [Benchmarking](benchmarking.md) - redis-benchmark, latency monitoring, đo throughput thực tế
- [x] [Slow Log & Latency](slow-log-latency.md) - SLOWLOG, latency spikes, big keys, hot keys, debug performance

## Patterns & Use Cases

- [x] [Caching Patterns](caching-patterns.md) - Cache-aside, write-through, write-behind, cache stampede, TTL strategies
- [x] [Session Store](session-store.md) - Lưu session với TTL, Spring Session, serialization
- [x] [Rate Limiting](rate-limiting.md) - Fixed window, sliding window, token bucket với Redis
- [x] [Leaderboard & Counting](leaderboard-counting.md) - Sorted set leaderboard, real-time ranking, counting patterns
- [x] [Distributed Lock](distributed-lock.md) - SET NX, lock expiry, Redlock algorithm, fencing tokens
- [x] [Pub/Sub](pub-sub.md) - PUBLISH/SUBSCRIBE, pattern matching, so sánh với Streams, giới hạn

## Advanced

- [x] [Transactions](transactions.md) - MULTI/EXEC, WATCH optimistic locking, giới hạn so với DB transactions
- [x] [Lua Scripting](lua-scripting.md) - EVAL/EVALSHA, atomicity, script caching, khi nào dùng Lua
- [x] [Keyspace Notifications](keyspace-notifications.md) - Event notifications, expired events, config và use cases
- [x] [Client-Side Caching](client-side-caching.md) - Tracking mode, invalidation, RESP3 protocol
- [x] [Redis Modules](redis-modules.md) - RedisJSON, RediSearch, RedisBloom, Redis Stack overview

## Operations

- [x] [Security](security.md) - AUTH, ACL, TLS, protected mode, network security best practices
- [x] [Monitoring](monitoring.md) - INFO metrics, redis_exporter + Prometheus + Grafana, alerts quan trọng
- [x] [Backup & Restore](backup-restore.md) - RDB backup strategies, restore procedures, disaster recovery
- [x] [Troubleshooting](troubleshooting.md) - Common issues, OOM, connection limits, debug checklist
