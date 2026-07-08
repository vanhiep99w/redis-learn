# Memory Management

## Mục lục

- [Tổng quan](#tổng-quan)
- [Mental model: Redis dùng RAM như thế nào](#mental-model-redis-dùng-ram-như-thế-nào)
- [Các loại memory cần phân biệt](#các-loại-memory-cần-phân-biệt)
- [Cấu hình giới hạn bộ nhớ](#cấu-hình-giới-hạn-bộ-nhớ)
- [Object encoding và tối ưu data structure](#object-encoding-và-tối-ưu-data-structure)
- [Phân tích memory bằng command thực tế](#phân-tích-memory-bằng-command-thực-tế)
- [Fragmentation và allocator](#fragmentation-và-allocator)
- [Fork, persistence và copy-on-write](#fork-persistence-và-copy-on-write)
- [Big keys, hot keys và memory risk](#big-keys-hot-keys-và-memory-risk)
- [Capacity planning](#capacity-planning)
- [Best Practices](#best-practices)
- [Checklist debug memory](#checklist-debug-memory)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## Tổng quan

Redis là **in-memory data store**: dữ liệu chính nằm trong RAM để đạt latency rất thấp. Vì vậy, memory management không chỉ là chuyện “còn bao nhiêu GB RAM”, mà là cách Redis phân bổ bộ nhớ cho key/value, metadata, replication buffer, client buffer, persistence, allocator fragmentation và copy-on-write khi fork.

Một Redis production ổn định cần trả lời được 4 câu hỏi:

1. **Dataset thực tế chiếm bao nhiêu RAM?**
2. **Redis có được phép dùng tối đa bao nhiêu RAM?**
3. **Khi vượt giới hạn thì xử lý thế nào?** Evict, reject write, hay scale out?
4. **Có headroom đủ cho replica, AOF/RDB, fork, traffic spike không?**

> [!IMPORTANT]
> Lỗi phổ biến nhất là set `maxmemory` sát RAM máy. Redis còn cần RAM ngoài dataset cho client connections, replication backlog, output buffer, AOF rewrite/RDB fork copy-on-write và fragmentation. Production thường nên chừa headroom đáng kể thay vì dùng 100% RAM.

---

## Mental model: Redis dùng RAM như thế nào

Một entry Redis không chỉ gồm bytes của value. Nó thường gồm:

```text
┌─────────────────────────────────────────────────────────────┐
│                         Redis RAM                           │
├───────────────────────┬─────────────────────────────────────┤
│ Dataset               │ Key object + value object + metadata│
│ Expire dictionary     │ TTL metadata cho key có expire      │
│ Allocator overhead    │ jemalloc slab/arena overhead        │
│ Fragmentation         │ Lỗ hổng bộ nhớ chưa trả về OS       │
│ Client buffers        │ Input/output buffer per connection  │
│ Replication backlog   │ Buffer phục vụ partial resync       │
│ Lua/functions/cache   │ Script cache, function library      │
│ Persistence overhead  │ Fork COW khi RDB/AOF rewrite        │
└───────────────────────┴─────────────────────────────────────┘
```

### Vì sao cùng một payload nhưng Redis tốn nhiều hơn?

Ví dụ bạn lưu string `"hello"` ở key `user:1:name`:

```text
key bytes         = "user:1:name"                  ~11 bytes
value bytes       = "hello"                        ~5 bytes
Redis object      = type, encoding, refcount, LRU/LFU metadata
Dictionary entry  = hash table entry trỏ tới key/value
SDS header        = string header cho key và value
Allocator rounding= jemalloc cấp phát theo size class
```

Tổng memory có thể lớn hơn payload nhiều lần, đặc biệt với **nhiều key nhỏ**.

| Pattern | Payload | Memory risk |
|---------|---------|-------------|
| 100 triệu key nhỏ | Mỗi key vài bytes | Metadata overhead rất lớn |
| Một vài key cực lớn | Value vài trăm MB | Block event loop khi đọc/ghi/xóa |
| Hash nhỏ nhiều field | Gom object nhỏ | Thường tiết kiệm hơn nhiều key rời |
| List/Set/ZSet khổng lồ | Một key chứa nhiều item | Dễ thành big key, khó operate |

---

## Các loại memory cần phân biệt

Redis `INFO memory` có nhiều metric. Không nên chỉ nhìn một dòng.

### Metric quan trọng

```bash
redis-cli INFO memory
```

| Metric | Ý nghĩa | Cách đọc |
|--------|---------|----------|
| `used_memory` | Bộ nhớ Redis allocator đang dùng | Metric chính để so với `maxmemory` |
| `used_memory_human` | Bản dễ đọc của `used_memory` | Dùng khi thao tác nhanh |
| `used_memory_rss` | RAM process Redis đang giữ theo OS | Nếu cao hơn nhiều `used_memory` → fragmentation/COW |
| `used_memory_dataset` | Ước lượng memory dành cho dataset | Hữu ích khi tách overhead |
| `used_memory_overhead` | Metadata, buffers, internal overhead | Cao bất thường cần kiểm tra clients/replication |
| `mem_fragmentation_ratio` | `rss / used_memory` tương đối | > 1.5 thường cần điều tra |
| `allocator_frag_ratio` | Fragmentation phía allocator | Liên quan jemalloc |
| `mem_not_counted_for_evict` | Memory không tính vào eviction | AOF/replication buffers, cần headroom |
| `maxmemory` | Giới hạn Redis tự áp dụng | 0 nghĩa là không giới hạn bởi Redis |
| `maxmemory_policy` | Policy khi vượt `maxmemory` | Xem [Eviction Policies](./eviction-policies.md) |

### `used_memory` vs `used_memory_rss`

```text
used_memory      : Redis nghĩ allocator đang dùng bao nhiêu
used_memory_rss  : OS thấy process Redis giữ bao nhiêu RAM thật
```

Nếu `used_memory=8GB`, `used_memory_rss=12GB`, Redis có thể đã từng cấp phát nhiều, sau đó xóa bớt, nhưng allocator/OS chưa trả toàn bộ memory về hệ điều hành.

> [!NOTE]
> `used_memory_rss` cao hơn `used_memory` không luôn là bug. Nhưng nếu ratio tăng liên tục, đi kèm OOM hoặc swap, cần xử lý fragmentation, big key churn hoặc workload thay đổi kích thước value liên tục.

### Memory không tính vào eviction

Redis eviction dựa trên `maxmemory`, nhưng một số buffer có thể không được tính giống dataset. Ví dụ replication/AOF buffers có thể làm process dùng nhiều RAM hơn dự kiến. Vì vậy cần theo dõi:

```bash
redis-cli INFO memory | grep mem_not_counted_for_evict
redis-cli INFO clients
redis-cli INFO replication
```

---

## Cấu hình giới hạn bộ nhớ

### `maxmemory`

`maxmemory` đặt trần Redis dùng cho dataset/allocator theo cơ chế Redis. Khi đạt ngưỡng, Redis áp dụng `maxmemory-policy`.

```bash
# Runtime, mất sau restart nếu không ghi config
redis-cli CONFIG SET maxmemory 6gb

# Kiểm tra
redis-cli CONFIG GET maxmemory
```

Trong `redis.conf`:

```conf
maxmemory 6gb
maxmemory-policy allkeys-lfu
```

### Có nên để `maxmemory 0`?

`maxmemory 0` nghĩa là Redis không tự giới hạn. Khi memory tăng quá RAM thật, hệ điều hành có thể swap hoặc OOM kill Redis.

| Môi trường | Khuyến nghị |
|------------|-------------|
| Local/dev | Có thể để default nếu dataset nhỏ |
| Production cache | Luôn set `maxmemory` + eviction policy rõ ràng |
| Production source-of-truth | Set `maxmemory`, thường dùng `noeviction` và alert sớm |
| Container/Kubernetes | Set thấp hơn memory limit container |

### Headroom nên chừa bao nhiêu?

Không có số tuyệt đối, nhưng nguyên tắc:

```text
RAM máy/container
  > maxmemory
  + replication/client/AOF buffers
  + fork copy-on-write peak
  + fragmentation headroom
  + OS/process overhead
```

Ví dụ máy 16GB RAM:

```text
16GB physical RAM
- 2GB OS + overhead
- 2GB fragmentation/headroom
- 2GB COW peak khi BGSAVE/AOF rewrite
= khoảng 10GB maxmemory an toàn ban đầu
```

Sau khi có metric thật, tinh chỉnh bằng quan sát production.

> [!IMPORTANT]
> Nếu bật RDB/AOF rewrite trên dataset write-heavy, copy-on-write có thể làm Redis cần thêm vài GB RAM tạm thời. Set `maxmemory` quá sát RAM sẽ khiến fork/rewrite dễ gây OOM.

---

## Object encoding và tối ưu data structure

Redis dùng nhiều encoding nội bộ để tiết kiệm RAM. Cùng một logical type nhưng representation có thể khác nhau.

### String

String nhỏ dùng SDS, integer string có thể được tối ưu. Nhưng mỗi key vẫn có metadata overhead.

```bash
SET page:view:1 100
OBJECT ENCODING page:view:1
MEMORY USAGE page:view:1
```

Nếu có rất nhiều counter nhỏ:

```text
Không tối ưu:
page:view:1 -> "100"
page:view:2 -> "50"
page:view:3 -> "70"

Tối ưu hơn trong nhiều trường hợp:
HSET page:views 1 100 2 50 3 70
```

Hash gom nhiều field nhỏ vào một key, giảm overhead dictionary cấp top-level.

### Hash

Hash nhỏ thường dùng encoding compact như listpack. Khi vượt ngưỡng số field hoặc kích thước field, Redis chuyển sang hashtable.

```bash
HSET user:1 name "An" age "30" city "HCM"
OBJECT ENCODING user:1
MEMORY USAGE user:1
```

| Cách lưu | Ưu điểm | Nhược điểm |
|----------|---------|------------|
| Nhiều key string | TTL từng field, access đơn giản | Metadata overhead cao |
| Một hash/object | Tiết kiệm RAM, get nhiều field tiện | TTL chỉ ở cấp key, field quá nhiều thành big key |

### List

List hiện đại dùng quicklist/listpack: nhiều phần tử được đóng gói trong node compact.

Dùng tốt cho queue vừa phải, nhưng cần tránh list quá lớn không được trim.

```bash
LPUSH jobs pending:1 pending:2
LTRIM jobs 0 9999
```

### Set

Set nhỏ chứa integer có thể dùng intset rất tiết kiệm; set string hoặc set lớn chuyển sang hashtable.

```bash
SADD ids 1 2 3 4
OBJECT ENCODING ids
```

### Sorted Set

Sorted set cần cả mapping member→score và cấu trúc sorted order. Vì vậy thường tốn RAM hơn Set/List.

```text
ZSet memory ≈ member bytes + score + hash/dict overhead + skiplist/listpack overhead
```

Nếu chỉ cần membership, dùng Set. Nếu cần rank/range theo score, dùng ZSet.

### Stream

Streams lưu log theo radix tree/listpack. Rất mạnh cho event log, nhưng nếu không trim sẽ tăng vô hạn.

```bash
XADD orders * user 1 total 100
XTRIM orders MAXLEN ~ 100000
```

---

## Phân tích memory bằng command thực tế

### `MEMORY USAGE`

Dùng để xem một key tốn bao nhiêu bytes.

```bash
redis-cli MEMORY USAGE user:1
redis-cli MEMORY USAGE leaderboard:daily SAMPLES 1000
```

Với aggregate type lớn, `SAMPLES` giúp ước lượng nhanh hơn.

### `MEMORY STATS`

```bash
redis-cli MEMORY STATS
```

Cho breakdown sâu hơn về allocator, dataset, overhead.

### `MEMORY DOCTOR`

```bash
redis-cli MEMORY DOCTOR
```

Redis đưa ra nhận xét tự động về memory. Không thay thế phân tích thủ công, nhưng hữu ích khi mới debug.

### Scan key theo pattern và đo memory

Không dùng `KEYS *` trên production. Dùng `SCAN`:

```bash
redis-cli --scan --pattern 'session:*' | head
```

Ví dụ script shell đơn giản để xem top key theo memory:

```bash
redis-cli --scan | while read key; do
  usage=$(redis-cli MEMORY USAGE "$key" 2>/dev/null)
  if [ -n "$usage" ]; then
    echo "$usage $key"
  fi
done | sort -nr | head -20
```

> [!WARNING]
> Script trên gọi nhiều command, có thể gây tải nếu keyspace lớn. Chỉ chạy có giới hạn, ngoài giờ cao điểm, hoặc dùng tool chuyên dụng như `redis-cli --bigkeys`, `--memkeys`.

### `redis-cli --bigkeys`

```bash
redis-cli --bigkeys
```

Tìm key lớn theo cardinality/kích thước logical của type. Nó dùng SCAN nên an toàn hơn `KEYS`, nhưng vẫn tạo thêm load.

### `redis-cli --memkeys`

```bash
redis-cli --memkeys
```

Tìm key tiêu thụ nhiều memory hơn, hữu ích khi cần xử lý OOM.

---

## Fragmentation và allocator

Redis thường dùng jemalloc. Allocator cấp phát memory theo size class. Khi value được tạo/xóa/cập nhật liên tục với kích thước khác nhau, memory có thể bị phân mảnh.

```text
Trước:
[AAAA][BBBB][CCCC][DDDD]

Xóa B và D:
[AAAA][    ][CCCC][    ]

Cần cấp phát E lớn:
[AAAA][    ][CCCC][    ]  không có block liên tục đủ lớn
```

### Metric cần xem

```bash
redis-cli INFO memory | egrep 'fragmentation|allocator|rss|used_memory'
```

| Triệu chứng | Có thể do |
|-------------|-----------|
| `mem_fragmentation_ratio` cao | Fragmentation, COW, RSS chưa trả OS |
| `allocator_frag_ratio` cao | jemalloc fragmentation |
| `used_memory_rss` tăng sau BGSAVE | Copy-on-write peak |
| Memory không giảm sau DEL nhiều key | Allocator giữ memory, lazy free chưa xong |

### Active defragmentation

Redis hỗ trợ active defrag để giảm fragmentation trong background.

```conf
activedefrag yes
active-defrag-ignore-bytes 100mb
active-defrag-threshold-lower 10
active-defrag-threshold-upper 100
```

Runtime:

```bash
redis-cli CONFIG SET activedefrag yes
```

> [!TIP]
> Active defrag có CPU cost. Bật khi fragmentation gây vấn đề thật, theo dõi CPU/latency sau khi bật.

### `DEL` vs `UNLINK`

`DEL` xóa đồng bộ, có thể block event loop nếu key lớn. `UNLINK` tách key khỏi keyspace rồi giải phóng memory bất đồng bộ.

```bash
# Có thể block nếu key rất lớn
DEL huge:list

# Thường tốt hơn cho big key
UNLINK huge:list
```

Cấu hình lazy free:

```conf
lazyfree-lazy-eviction yes
lazyfree-lazy-expire yes
lazyfree-lazy-server-del yes
replica-lazy-flush yes
```

---

## Fork, persistence và copy-on-write

Các thao tác như `BGSAVE` và AOF rewrite dùng `fork()`. Process con ghi snapshot/rewrite, process cha tiếp tục phục vụ traffic. Hệ điều hành dùng copy-on-write: page memory chỉ bị copy khi process cha ghi thay đổi vào page đó.

```text
Before fork:
Redis parent -> memory pages

After fork:
Parent and child share pages

Parent writes page X:
OS copies page X for parent
Child still sees old page X
```

Nếu workload write-heavy trong lúc fork, COW memory tăng mạnh.

### Theo dõi COW

```bash
redis-cli INFO persistence | egrep 'rdb|aof|cow|rewrite|bgsave'
```

Metric thường gặp:

| Metric | Ý nghĩa |
|--------|---------|
| `rdb_last_cow_size` | COW memory lần RDB gần nhất |
| `aof_last_cow_size` | COW memory lần AOF rewrite gần nhất |
| `rdb_bgsave_in_progress` | Đang BGSAVE hay không |
| `aof_rewrite_in_progress` | Đang rewrite AOF hay không |

### Điều chỉnh để giảm risk

- Chừa headroom RAM.
- Tránh chạy rewrite/snapshot vào giờ write peak.
- Giảm update value lớn liên tục.
- Dùng replica để backup nếu phù hợp.
- Theo dõi `latest_fork_usec`; fork lâu có thể tạo latency spike.

---

## Big keys, hot keys và memory risk

### Big key

Big key là key có value/cardinality quá lớn so với operation bình thường. Ví dụ:

| Type | Big key ví dụ |
|------|---------------|
| String | JSON/blob 50MB |
| Hash | 5 triệu field |
| List | 20 triệu item |
| Set | 10 triệu member |
| ZSet | leaderboard toàn cầu không shard |
| Stream | Không trim, tăng vô hạn |

Big key gây vấn đề:

- `DEL`/expire block nếu free đồng bộ.
- `HGETALL`, `SMEMBERS`, `LRANGE 0 -1` trả response khổng lồ.
- Replication và AOF ghi command lớn.
- Reshard/migration trong Cluster chậm.

### Hot key

Hot key là key bị truy cập quá nhiều. Nó không nhất thiết lớn, nhưng gây CPU/network bottleneck ở một node.

```bash
redis-cli --hotkeys
```

`--hotkeys` cần eviction policy LFU để có counter phù hợp.

### Cách giảm big/hot key

| Vấn đề | Giải pháp |
|--------|-----------|
| Hash quá lớn | Shard theo bucket: `user:profile:{bucket}` |
| ZSet leaderboard quá lớn | Chia theo region/time window, archive lịch sử |
| Stream tăng vô hạn | `XTRIM MAXLEN ~` hoặc retention theo thời gian |
| String blob lớn | Lưu blob ở object storage, Redis chỉ giữ metadata/cache nhỏ |
| Hot counter | Local aggregation + batch flush, sharded counter |
| Hot config key | Client-side caching, local cache ngắn TTL |

---

## Capacity planning

Capacity planning nên dựa trên đo thực tế, không đoán.

### Công thức đơn giản

```text
Required RAM = dataset_peak
             + overhead_peak
             + fragmentation_headroom
             + persistence_cow_peak
             + replication/client_buffers
             + safety_margin
```

### Quy trình thực tế

1. Tạo sample data gần giống production.
2. Load vào Redis staging.
3. Đo `used_memory`, `used_memory_dataset`, `MEMORY USAGE` theo key type.
4. Chạy workload đọc/ghi representative.
5. Bật persistence/replication giống production.
6. Chạy BGSAVE/AOF rewrite để đo COW.
7. Tính peak và đặt `maxmemory` thấp hơn RAM thật.

### Ví dụ ước lượng session store

Giả sử:

- 5 triệu session active.
- Mỗi session JSON trung bình 1KB.
- Key dài trung bình 40 bytes.
- Overhead thực tế đo staging: 1.45x payload.

```text
Payload = 5,000,000 * 1KB ≈ 5GB
Dataset estimated = 5GB * 1.45 ≈ 7.25GB
Headroom COW/fragmentation/buffer ≈ 30-50%
RAM target ≈ 10-12GB+
```

Nếu chạy trên node 16GB, `maxmemory` ban đầu có thể đặt khoảng 10GB, sau đó quan sát metric.

---

## Best Practices

### Thiết kế dữ liệu

- Gom nhiều value nhỏ liên quan vào Hash nếu TTL chung được chấp nhận.
- Tránh key name quá dài nếu key count cực lớn.
- Không lưu blob lớn trực tiếp trong Redis.
- Luôn đặt retention cho Streams, Lists dạng log, leaderboard lịch sử.
- Tránh command trả toàn bộ collection lớn: `SMEMBERS`, `HGETALL`, `LRANGE 0 -1`, `ZRANGE 0 -1`.

### Vận hành

- Luôn set `maxmemory` trong production.
- Chọn `maxmemory-policy` theo use case, không để default một cách vô thức.
- Alert theo `used_memory / maxmemory`, không chờ OOM.
- Theo dõi `mem_fragmentation_ratio`, `used_memory_rss`, `mem_not_counted_for_evict`.
- Dùng `UNLINK` hoặc lazy free cho key lớn.
- Chạy `--bigkeys`/`--memkeys` định kỳ nhưng có kiểm soát.

### Khi dùng container/Kubernetes

- `maxmemory` phải nhỏ hơn container memory limit.
- Request/limit nên tính cả RSS, không chỉ `used_memory`.
- Cẩn thận OOM killer: Redis có thể bị kill trước khi kịp evict nếu buffer/COW làm RSS vượt limit.

```yaml
resources:
  requests:
    memory: "12Gi"
  limits:
    memory: "16Gi"
```

Redis config tương ứng có thể là:

```conf
maxmemory 10gb
maxmemory-policy allkeys-lfu
```

---

## Checklist debug memory

Khi Redis memory tăng bất thường:

```bash
redis-cli INFO memory
redis-cli INFO clients
redis-cli INFO replication
redis-cli INFO persistence
redis-cli DBSIZE
redis-cli --bigkeys
redis-cli --memkeys
```

Checklist:

- [ ] `used_memory` tăng hay chỉ `used_memory_rss` tăng?
- [ ] Có key type nào tăng cardinality bất thường không?
- [ ] TTL có bị thiếu không? `SCAN` sample + `TTL key`.
- [ ] Có Stream/List/ZSet nào không trim không?
- [ ] Có client output buffer lớn không?
- [ ] Có replica lag làm replication buffer tăng không?
- [ ] Có BGSAVE/AOF rewrite vừa chạy không?
- [ ] Fragmentation ratio có cao không?
- [ ] Eviction policy có đúng use case không?
- [ ] App có deploy mới thay đổi key pattern/value size không?

---

## Tài liệu tham khảo

- [Redis Documentation - Memory optimization](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/)
- [Redis Documentation - MEMORY command](https://redis.io/docs/latest/commands/memory-usage/)
- [Redis Documentation - INFO](https://redis.io/docs/latest/commands/info/)
- [Eviction Policies](./eviction-policies.md)
- [RDB Snapshots](./rdb.md)
- [AOF](./aof.md)
