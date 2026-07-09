# Hashes

## Mục lục

- [1. Khi một object nên là Hash thay vì JSON](#1-khi-một-object-nên-là-hash-thay-vì-json)
- [2. Mental model: Hash là object phẳng trong một key](#2-mental-model-hash-là-object-phẳng-trong-một-key)
- [3. Bên trong Redis: listpack vs hashtable](#3-bên-trong-redis-listpack-vs-hashtable)
- [4. Command catalog & độ phức tạp](#4-command-catalog--độ-phức-tạp)
- [5. Field-level TTL: per-field expiration từ Redis 7.4](#5-field-level-ttl-per-field-expiration-từ-redis-74)
- [6. Hash vs String JSON: quyết định thiết kế quan trọng](#6-hash-vs-string-json-quyết-định-thiết-kế-quan-trọng)
- [7. Memory optimization: bucket nhiều key nhỏ vào Hash](#7-memory-optimization-bucket-nhiều-key-nhỏ-vào-hash)
- [8. Performance & benchmark: nhanh ở đâu, nguy hiểm ở đâu](#8-performance--benchmark-nhanh-ở-đâu-nguy-hiểm-ở-đâu)
- [9. Patterns thực tế](#9-patterns-thực-tế)
- [10. Case study thực tế](#10-case-study-thực-tế)
- [11. Anti-patterns cần tránh](#11-anti-patterns-cần-tránh)
- [12. Best Practices](#12-best-practices)
- [13. Tóm tắt: cheat-sheet & 3 nguyên tắc](#13-tóm-tắt-cheat-sheet--3-nguyên-tắc)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## 1. Khi một object nên là Hash thay vì JSON

Bạn cần lưu một object nhiều field vào Redis — session người dùng, giỏ hàng, profile. Phản xạ đầu tiên của hầu hết mọi người là serialize nó thành JSON rồi cất vào một String:

```bash
SET sess:tok_9f2a '{"uid":42,"role":"admin","last_seen":1783400100}' EX 1800
```

Cách này chạy tốt cho đến khi app phải **đọc hoặc sửa từng field** liên tục. Mỗi lần chỉ cần `uid` và `role`, ta vẫn phải kéo cả JSON về rồi parse. Mỗi lần cập nhật `last_seen`, ta phải đọc cả blob, sửa, rồi ghi lại — một chu trình read-modify-write không atomic, và hai request song song có thể ghi đè field của nhau.

Redis Hash cho một mô hình khác: coi object là **map field → value** nằm gọn trong một key, đọc/ghi được từng field mà không đụng tới phần còn lại.

```bash
HSET sess:tok_9f2a uid 42 role admin last_seen 1783400100
HMGET sess:tok_9f2a uid role         # lấy đúng 2 field cần
HINCRBY sess:tok_9f2a login_count 1  # tăng một field, atomic
```

Nhưng Hash không phải lúc nào cũng thắng String JSON, và bản thân nó cũng có cạm bẫy riêng (`HGETALL` trên hash lớn, big key — một key chứa quá nhiều dữ liệu nên khó shard/migrate và dễ gây latency spike). Doc này sẽ trả lời: Hash lưu trong memory thế nào (listpack và hashtable), khi nào nên chọn Hash thay vì JSON, vì sao hash nhỏ tiết kiệm memory đến mức Instagram từng dùng để nén hàng trăm triệu cặp key-value, và field-level TTL (Redis 7.4+) mở ra những gì.

---

## 2. Mental model: Hash là object phẳng trong một key

Hash là **record type**: một Redis key chứa nhiều cặp `field → value`.

```
user:42 (1 Redis key)
├── name        → "Hiệp"
├── email       → "hiep@example.com"
├── logins      → "128"        ← value vẫn là string, nhưng HINCRBY parse số
├── plan        → "pro"
└── updated_at  → "1783400100"
```

Điểm quan trọng:

| Đặc tính | Ý nghĩa thực tế |
|----------|-----------------|
| Field và value đều là string | Không có nested object native; số cũng lưu dạng string |
| Operation theo field | `HGET user:42 plan`, `HSET user:42 email ...` |
| Atomic theo command | `HINCRBY` không mất update giữa nhiều client |
| TTL mặc định theo key | `EXPIRE user:42 3600` xóa cả Hash; Redis 7.4+ có TTL theo field |
| Small Hash rất tiết kiệm memory | Nhờ encoding `listpack` |

So với các data type khác:

| Bạn cần... | Dùng |
|------------|------|
| Object phẳng, update từng thuộc tính | **Hash** |
| Một giá trị đơn hoặc JSON blob đọc/ghi nguyên khối | [Strings](./strings.md) |
| Range query, ranking, sort theo score | Sorted Set, không phải Hash |
| Event log append-only | Stream |
| Set membership | Set |

> [!NOTE]
> Hash không phải document database. Nếu bạn cần query theo field (`WHERE plan = 'pro'`) hoặc index secondary, cần Redis Search/JSON hoặc database khác. Hash chỉ tối ưu truy cập khi bạn **biết key và field**.

---

## 3. Bên trong Redis: listpack vs hashtable

Redis Hash có 2 encoding chính:

| Encoding | Khi nào dùng | Cấu trúc | Điểm mạnh | Điểm yếu |
|----------|--------------|----------|-----------|----------|
| `listpack` | Số field ≤ `hash-max-listpack-entries` (**128**) và mọi field/value ≤ `hash-max-listpack-value` (**64 bytes**) | field/value xen kẽ trong một khối memory liên tục | Rất tiết kiệm memory, cache locality (dữ liệu nằm gần nhau nên CPU cache đọc hiệu quả) tốt | Tìm field O(N) |
| `hashtable` | Vượt một trong hai ngưỡng | `dict` thật, tương tự keyspace chính | Lookup/update O(1) trung bình | Nhiều pointer/metadata hơn |

Các tên config cũ `hash-max-ziplist-entries` và `hash-max-ziplist-value` là alias lịch sử. Redis hiện dùng `listpack`, không còn ziplist cho Hash mới.

```conf
hash-max-listpack-entries 128
hash-max-listpack-value 64
```

> [!WARNING]
> Chỉ cần **một value dài 65 bytes** hoặc field thứ **129** là Hash chuyển sang `hashtable`. Sau khi đã chuyển, Hash **không tự downgrade** về `listpack` dù bạn xóa bớt field hoặc rút ngắn value.

### 3.1. listpack — vì sao O(N) vẫn nhanh?

Listpack là cách Redis “đóng gói” Hash nhỏ như một mảng field/value liền nhau để tiết kiệm overhead. Nhìn qua, O(N) nghe đáng sợ. Nhưng N mặc định chỉ tối đa 128 field, và listpack nằm trong một vùng memory liên tục:

```diagram
Bước 1: Redis đọc pointer tới value object của key "user:42"

Bước 2: object đang encoded=listpack

Bước 3: scan tuyến tính:
┌────────┬────────┬────────┬────────┬────────┬────────┬─────┐
│ header │ field1 │ value1 │ field2 │ value2 │ field3 │ ... │
└────────┴────────┴────────┴────────┴────────┴────────┴─────┘
                    ↑
                 so sánh field cần tìm

Bước 4: gặp field → trả value ngay bên cạnh
```

Vì sao nhanh trong thực tế?

| Lý do | Giải thích |
|-------|------------|
| Cache locality | CPU đọc một cache line kéo theo nhiều byte liền kề |
| Không pointer chasing | Không phải nhảy qua nhiều vùng heap rời rạc |
| Không dict bucket | Không cần tính hash + theo linked entry |
| N nhỏ | 20-100 field scan thường rẻ hơn overhead hashtable |

> [!TIP]
> Đừng nhìn Big-O một cách máy móc. `O(80)` trên mảng liên tục có thể nhanh hơn `O(1)` nhưng phải hash, dereference pointer, miss cache 2-3 lần.

### 3.2. hashtable — khi Hash lớn

Hashtable là chế độ Redis dùng khi Hash đã đủ lớn để scan tuyến tính không còn là lựa chọn tốt. Khi vượt ngưỡng, Redis chuyển Hash thành `dict`:

```diagram
hash object
└── dict
    ├── ht[0] bucket array
    │   ├── bucket 0 → dictEntry(field="uid", value="42")
    │   ├── bucket 1 → NULL
    │   └── bucket 2 → dictEntry(field="role", value="admin") → ...
    └── ht[1] bucket array (chỉ tồn tại trong lúc rehash)
```

Lookup trung bình O(1): hash field name → bucket → so sánh field trong chain.

Nhưng hashtable tốn memory hơn vì mỗi field/value có thêm:

- `dictEntry` metadata.
- Pointer tới key field và value.
- SDS (Simple Dynamic String — cấu trúc string nội bộ của Redis, lưu kèm length/alloc) header cho string.
- Bucket array có slot trống để giữ load factor (tỷ lệ số entry trên số bucket, ảnh hưởng trực tiếp tới collision/resize) hợp lý.

### 3.3. Incremental rehashing — resize không “đứng hình”

Incremental rehashing là cách Redis resize từ từ để không bắt một command gánh toàn bộ chi phí di chuyển bucket. Redis dict không resize bằng cách dời toàn bộ bucket trong một cú. Khi cần mở rộng/thu nhỏ, Redis giữ **2 hash table** (`ht[0]` cũ, `ht[1]` mới) và mỗi command làm một phần `rehashstep()`.

```diagram
ht[0] size=1024, used=1024          → bảng cũ
ht[1] size=2048, used tăng dần      → bảng mới
rehashidx = bucket đang được chuyển

Mỗi HGET/HSET/HDEL:
1. dời vài bucket từ ht[0] sang ht[1]
2. read/delete kiểm tra cả hai table
3. write mới đi vào ht[1]
4. khi ht[0] hết bucket → ht[1] trở thành table chính
```

> [!NOTE]
> Incremental rehashing tránh spike lớn, nhưng Hash cực lớn vẫn là big key: resize, replication, persistence, `HGETALL`, migrate slot đều có thể tạo latency đáng kể.

Kiểm tra encoding:

```bash
HSET h f1 v1
OBJECT ENCODING h                 # "listpack"
HSET h bigfield "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
OBJECT ENCODING h                 # "hashtable"
HDEL h bigfield
OBJECT ENCODING h                 # vẫn "hashtable"
```

---

## 4. Command catalog & độ phức tạp

### 4.1. Nhóm đọc/ghi cơ bản

| Command | Complexity | Dùng khi | Cảnh báo |
|---------|------------|----------|----------|
| `HSET key f v [f v ...]` | O(1) mỗi field/value pair | Tạo/sửa field, set nhiều field một lượt | `HMSET` đã deprecated; dùng `HSET` nhiều pair |
| `HGET key f` | O(1) trung bình | Đọc 1 field | Với listpack là O(N) nhỏ, docs ghi O(1) theo abstraction |
| `HMGET key f1 f2 ...` | O(N) với N field yêu cầu | Đọc vài field trong 1 round-trip | Field không tồn tại trả nil |
| `HDEL key f [f ...]` | O(N) với N field xóa | Xóa field | Field cuối bị xóa → key bị xóa |
| `HSETNX key f v` | O(1) | Set nếu field chưa tồn tại | Dùng cho lock/state nhẹ, nhưng không thay thế distributed lock |
| `HEXISTS key f` | O(1) | Check field tồn tại | Không phân biệt value rỗng và missing nếu chỉ dùng `HGET` |
| `HLEN key` | O(1) | Đếm field | Với field TTL, field hết hạn không nên được tính sau khi được cleanup |
| `HSTRLEN key f` | O(1) | Độ dài value của field | Hữu ích phát hiện field quá lớn |

### 4.2. Nhóm counter atomic

| Command | Complexity | Ví dụ | Ghi chú |
|---------|------------|-------|---------|
| `HINCRBY key f delta` | O(1) | `HINCRBY user:42 logins 1` | Field missing được coi là 0 |
| `HINCRBYFLOAT key f delta` | O(1) | `HINCRBYFLOAT stats spend 0.35` | Floating point string representation |

`HINCRBY` là lý do Hash rất hợp cho counters theo entity. Với String JSON, bạn phải `GET` → parse → tăng → `SET`; muốn atomic phải dùng Lua hoặc transaction. Với Hash, một lệnh chạy trọn trên **event loop** — không bị client khác chen giữa (xem [Redis Architecture](./redis-architecture.md)).

### 4.3. Nhóm “đọc toàn bộ” — tiện nhưng dễ thành bom

| Command | Complexity | Dùng khi | Không dùng khi |
|---------|------------|----------|----------------|
| `HGETALL key` | O(N) với N field | Object nhỏ, dashboard ít field, cart vài chục item | Hash hàng chục nghìn field |
| `HKEYS key` | O(N) | Debug/admin với Hash nhỏ | API hot path |
| `HVALS key` | O(N) | Hiếm khi cần | Hash lớn hoặc value lớn |
| `HRANDFIELD key [count [WITHVALUES]]` | O(N) worst-case | Lấy sample/random field | Không dùng thay sampling chính xác trên huge Hash |
| `HSCAN key cursor [MATCH pattern] [COUNT n] [NOVALUES]` | O(1) mỗi call, O(N) cả vòng | Duyệt Hash lớn từng phần | Không đảm bảo snapshot nhất quán |

> [!IMPORTANT]
> `HGETALL` trên Hash 100K field là cùng họ lỗi với `KEYS *`: reply khổng lồ **block event loop** — mọi client khác phải chờ ([Redis Architecture](./redis-architecture.md)). Hash lớn → `HSCAN` hoặc `HMGET` đúng field.

`HSCAN` mẫu:

```bash
HSCAN user_index:bucket:42 0 COUNT 500
# trả cursor mới + batch field/value
# lặp đến cursor = 0
```

> [!TIP]
> Redis 7.4 thêm `HSCAN ... NOVALUES` để chỉ trả field, giảm network khi bạn không cần value.

---

## 5. Field-level TTL: per-field expiration từ Redis 7.4

Trước Redis 7.4, TTL chỉ nằm ở **key**:

```bash
EXPIRE sess:tok_9f2a 1800   # cả Hash hết hạn cùng lúc
```

Muốn từng field tự hết hạn, bạn phải tách thành nhiều String key, tự quét bằng Sorted Set, hoặc viết Lua cleanup. Redis 7.4 thêm **Hash Field Expiration (HFE)**: mỗi field có TTL riêng.

### 5.1. Command family Redis 7.4

| Command | Mục đích | Đơn vị | Complexity |
|---------|----------|--------|------------|
| `HEXPIRE key seconds FIELDS n f...` | Set TTL tương đối | giây | O(N) field chỉ định |
| `HPEXPIRE key ms FIELDS n f...` | Set TTL tương đối | millisecond | O(N) |
| `HEXPIREAT key unix_seconds FIELDS n f...` | Expire tại timestamp | giây | O(N) |
| `HPEXPIREAT key unix_ms FIELDS n f...` | Expire tại timestamp | millisecond | O(N) |
| `HTTL key FIELDS n f...` | Đọc TTL còn lại | giây | O(N) |
| `HPTTL key FIELDS n f...` | Đọc TTL còn lại | millisecond | O(N) |
| `HEXPIRETIME key FIELDS n f...` | Đọc expire timestamp | giây | O(N) |
| `HPEXPIRETIME key FIELDS n f...` | Đọc expire timestamp | millisecond | O(N) |
| `HPERSIST key FIELDS n f...` | Gỡ TTL field | — | O(N) |

```bash
HSET sess:42 uid 42 role admin token abc device ios
HEXPIRE sess:42 1800 FIELDS 1 token
HTTL sess:42 FIELDS 2 token device
# 1) 1795
# 2) -1        # device tồn tại nhưng không có TTL
HPERSIST sess:42 FIELDS 1 token
```

> [!WARNING]
> `HSET` hoặc `HDEL` trên field sẽ clear/delete TTL của field đó vì nội dung field bị thay thế/xóa. Nếu update field vẫn muốn giữ TTL, re-apply TTL khi cần.

### 5.2. Redis 8.0 helpers: HGETEX, HSETEX, HGETDEL

Redis docs hiện ghi các helper sau có từ **Redis Open Source 8.0**:

| Command | Mục đích |
|---------|----------|
| `HGETEX key [EX/PX/EXAT/PXAT/PERSIST] FIELDS n f...` | Get field và set/gỡ TTL atomically |
| `HSETEX key [EX/PX/EXAT/PXAT/KEEPTTL...] FIELDS n f v...` | Set field kèm expiration atomically |
| `HGETDEL key FIELDS n f...` | Get field rồi delete atomically |

```bash
# Redis 8.0+
HGETEX sess:42 EX 1800 FIELDS 1 token   # get + gia hạn token trong 1 command
HGETDEL otp:user:42 FIELDS 1 code       # read-once OTP
```

> [!IMPORTANT]
> Per-field TTL là “big deal” vì nó xóa một trade-off cũ: trước đây bạn phải chọn giữa **gom field vào Hash để tiết kiệm memory** và **tách key để có TTL riêng**. Redis 7.4+ cho bạn cả hai trong nhiều use case.

---

## 6. Hash vs String JSON: quyết định thiết kế quan trọng

### 6.1. So sánh trực diện

| Tiêu chí | Hash | String chứa JSON |
|----------|------|------------------|
| Đọc 1 field | `HGET`/`HMGET`, chỉ trả field cần | `GET` cả blob, client parse |
| Ghi 1 field | `HSET` field đó | `GET` → parse → sửa → serialize → `SET` |
| Counter atomic | `HINCRBY`, `HINCRBYFLOAT` | Không atomic nếu không Lua/transaction |
| Race condition | Field độc lập ít ghi đè nhau | Read-modify-write dễ mất update |
| Đọc cả object | `HGETALL` O(N), reply nhiều bulk string | `GET` 1 value, rất tốt nếu luôn đọc cả blob |
| Nested data | Không native | Có JSON nested |
| Memory object nhỏ | Rất tốt nếu listpack | Có overhead JSON syntax + String object |
| TTL | Key TTL; field TTL từ 7.4 | Key TTL |
| Compatibility | Redis core | Redis core; dễ map sang app object |

### 6.2. Race condition: cùng sửa một JSON blob

```diagram
T0: Redis có sess = {"cart":"A", "last_seen":100}

T1: Request A GET sess              → cart=A, last_seen=100
T2: Request B GET sess              → cart=A, last_seen=100
T3: A đổi cart=B, SET sess          → {"cart":"B", "last_seen":100}
T4: B đổi last_seen=101, SET sess   → {"cart":"A", "last_seen":101}

Kết quả: cart=B bị mất.
```

Với Hash:

```bash
HSET sess:42 cart B
HSET sess:42 last_seen 101
```

Hai command sửa hai field khác nhau, không ghi đè toàn object.

> [!TIP]
> Nếu bạn vẫn muốn lưu JSON nhưng cần update từng path atomically, xem RedisJSON. Còn với object phẳng, Hash đơn giản hơn và là Redis core.

### 6.3. Decision table: String(JSON) hay Hash?

| Câu hỏi | Nếu câu trả lời là “có” | Chọn |
|---------|--------------------------|------|
| App thường chỉ cần 1-5 field trong object? | Có | Hash |
| Có counter bên trong object? | Có | Hash |
| Object phẳng, field count nhỏ? | Có | Hash |
| Luôn đọc/ghi cả object một lần? | Có | String JSON |
| Cần nested array/object sâu? | Có | String JSON hoặc RedisJSON |
| Cần range/sort/filter theo field? | Có | Không phải Hash đơn thuần; dùng ZSET/Search/DB |
| Cần TTL riêng cho từng attribute? | Redis 7.4+ | Hash với HFE |

### Khi nào KHÔNG nên dùng Hash

- **Luôn đọc/ghi nguyên object nested** → dùng String JSON hoặc RedisJSON để giữ cấu trúc object tự nhiên hơn.
- **Cần ranking/range/sort theo score** → dùng Sorted Set thay vì cố nhét score vào field rồi tự scan.
- **Chỉ cần membership đơn thuần** → dùng Set; Hash thêm value không cần thiết sẽ làm model rối hơn.
- **Một Hash phình vô hạn hoặc làm global namespace** → bucket hoặc shard theo entity/ngày/range để tránh big key.
- **Cần query theo giá trị field** như `plan = pro` hoặc `status = active` → dùng RediSearch hoặc database có index/query phù hợp.

---

## 7. Memory optimization: bucket nhiều key nhỏ vào Hash

Đây là trick kinh điển từng được Instagram phổ biến: nếu bạn có hàng chục/hàng trăm triệu cặp `id → value` rất nhỏ, **đừng lưu mỗi cặp thành một Redis key riêng**.

### 7.1. Vì sao nhiều String key tốn memory?

Một key-value nhỏ không chỉ có payload:

```bash
SET obj:123456789 "abc"
```

Redis còn cần metadata:

| Thành phần | Tồn tại ở đâu |
|------------|---------------|
| Keyspace dict entry | map key → object |
| Redis object (`robj`) cho key/value | type, encoding, LRU/LFU/refcount |
| SDS header cho key string | length, alloc, bytes |
| SDS/value allocation | value bytes + allocator overhead |
| Hash table bucket trống | giữ load factor |

Payload `"abc"` chỉ 3 bytes, nhưng overhead có thể là **hàng chục đến >100 bytes** tùy allocator/build/version.

### 7.2. Bucket pattern: id/1000 và id%1000

Thay vì 100 triệu key:

```bash
SET obj:123456789 "abc"
SET obj:123456790 "def"
```

Gom thành Hash bucket:

```bash
# bucket = id / 1000, field = id % 1000
HSET obj:123456 789 "abc"
HSET obj:123456 790 "def"
```

```diagram
ID 123456789
├── bucket key = obj:123456     (123456789 / 1000)
└── field      = 789            (123456789 % 1000)

100,000,000 logical entries
→ 100,000 Redis keys
→ mỗi key có ~1000 fields
```

Tại sao tiết kiệm?

| Trước | Sau |
|-------|-----|
| 100M Redis keys trong keyspace dict | 100K Redis keys |
| 100M key `robj`/SDS/dictEntry | 100K key metadata |
| Mỗi value là object riêng | Field/value nằm compact trong Hash |
| TTL/type riêng từng entry | TTL theo bucket hoặc field TTL 7.4+ nếu phù hợp |

> [!IMPORTANT]
> Để bucket 1000 field vẫn dùng `listpack`, bạn phải tăng `hash-max-listpack-entries` lên khoảng `1024` và đảm bảo field/value ≤ `hash-max-listpack-value`. Nếu không, bucket chuyển thành hashtable và mất phần lớn lợi ích memory.

### 7.3. Con số benchmark tham khảo

Các con số dưới đây là **minh họa thực tế thường gặp**, không phải cam kết tuyệt đối; hãy đo bằng `MEMORY USAGE` trên Redis/allocator/dataset của bạn.

| Layout | Payload | Encoding | Approx memory/entry | Memory cho 100M entry |
|--------|---------|----------|---------------------|-----------------------|
| String key riêng | field id + value 3-10 bytes | keyspace dict | 80-140 bytes | 8-14 GB |
| Hash bucket listpack | field 0-999, value 3-10 bytes | listpack | 10-25 bytes | 1-2.5 GB |
| Hash bucket hashtable | field/value nhỏ nhưng vượt ngưỡng | hashtable | 60-120 bytes | 6-12 GB |

Instagram từng báo cáo giảm memory cỡ **~4-5 lần** bằng hướng này cho hàng trăm triệu key-value nhỏ. Xem thêm [Memory Management](./memory-management.md).

> [!CAUTION]
> Bucket pattern đổi memory lấy complexity: bạn mất key-level operation riêng từng entry, phải tự map id → bucket/field, và bucket lớn có thể thành big key nếu chọn bucket size quá cao.

---

## 8. Performance & benchmark: nhanh ở đâu, nguy hiểm ở đâu

### 8.1. Latency thao tác field nhỏ

Benchmark tham khảo trên máy dev hiện đại, loopback, Redis local, payload ngắn; mục tiêu là hiểu tương quan:

| Operation | Dataset | Encoding | Latency p50 tham khảo | Ghi chú |
|-----------|---------|----------|-----------------------|---------|
| `HGET h f` | 32 field | listpack | 5-15 µs | scan nhỏ, cache-friendly |
| `HGET h f` | 10K field | hashtable | 5-20 µs | O(1) trung bình |
| `HMGET h 10 fields` | 32 field | listpack | 10-30 µs | 1 round-trip tốt hơn 10 HGET |
| `HINCRBY h c 1` | 32 field | listpack | 5-20 µs | atomic counter |
| `GET json` + client parse | 500B JSON | string | Redis nhanh, client parse tốn thêm | network trả nhiều byte hơn |

> [!NOTE]
> Với Redis, latency thực tế thường bị chi phối bởi network round-trip. Nếu cần nhiều operation liên tiếp, dùng [Pipelining & Batching](./pipelining-batching.md) trước khi micro-optimize encoding.

### 8.2. HGETALL blocking theo kích thước Hash

| Hash size | Reply size ước tính | Rủi ro |
|-----------|---------------------|--------|
| 20 field × 20B | < 2 KB | An toàn cho object/cart nhỏ |
| 1,000 field × 50B | ~100 KB | Cẩn thận trong hot path |
| 100,000 field × 50B | ~10 MB+ | Block event loop, socket backpressure |
| 1,000,000 field | 100 MB+ | Big key nghiêm trọng; có thể gây latency spike |

`HSCAN` thay thế khi cần duyệt:

```bash
cursor=0
repeat:
  HSCAN big:hash cursor COUNT 1000
  process batch
until cursor == 0
```

Trade-off của `HSCAN`:

| Ưu | Nhược |
|----|-------|
| Không trả toàn bộ một lần | Cần nhiều round-trip |
| Giảm block event loop | Có thể thấy duplicate/miss nếu Hash thay đổi trong lúc scan |
| Dễ checkpoint cursor | Không phải snapshot transaction |

---

## 9. Patterns thực tế

| Pattern | Lệnh mẫu | Khi nào an toàn |
|---------|----------|-----------------|
| Object cache partial update | `HSET user:42 plan pro`; `HMGET user:42 name plan` | Object phẳng, vài chục field |
| Counter dashboard theo ngày | `HINCRBY stats:2026-07-07 signup 1` | Số metric nhỏ, `HGETALL` trả ít dữ liệu |
| Shopping cart | `HINCRBY cart:user:42 sku:1001 1`; `HDEL ...` | Cart < vài trăm item |
| Rate limit nhiều tier | `HINCRBY rl:user42:min:202607070049 api 1` | Counter theo window nhỏ, TTL ngắn |
| Active sessions Redis 7.4+ | `HEXPIRE active:sessions 1800 FIELDS 1 tok_abc` | Cần TTL từng session trong một Hash |

```bash
# Object cache
HSET user:42 name "Hiệp" email "hiep@x.co" plan "free" logins 0
HSET user:42 plan "pro"
HINCRBY user:42 logins 1
HMGET user:42 name plan logins
EXPIRE user:42 3600

# Dashboard nhỏ
HINCRBY stats:2026-07-07 signup 1
HINCRBY stats:2026-07-07 revenue_cents 4990
HGETALL stats:2026-07-07
EXPIRE stats:2026-07-07 2592000
```

> [!TIP]
> Với cart, quantity về `0` không tự xóa field; app nên `HDEL`. Với dashboard cần ranking “top N”, cập nhật thêm Sorted Set, vì Hash không query theo score.

---

## 10. Case study thực tế

### 10.1. Session store — web app nhiều instance

Bài toán: app scale ngang 20 instance sau load balancer. Session in-memory không dùng được nữa; mỗi request đọc session, một số request ghi 1-2 field. Đây là pattern nền tảng của [Session Store](./session-store.md).

```bash
# Login
HSET sess:tok_9f2a uid 42 role admin cart_id c-881 last_seen 1783400000 csrf b1d device ios
EXPIRE sess:tok_9f2a 1800

# Mỗi request: đọc đúng field cần
HMGET sess:tok_9f2a uid role csrf

# Sliding expiration + update activity
HSET sess:tok_9f2a last_seen 1783400100
EXPIRE sess:tok_9f2a 1800
```

Nếu dùng Redis 7.4+:

```bash
# csrf/token hết hạn sớm hơn session metadata
HEXPIRE sess:tok_9f2a 600 FIELDS 1 csrf
```

| Vấn đề với JSON | Hash giải quyết |
|-----------------|-----------------|
| Parse cả blob mỗi request | `HMGET` vài field |
| Race khi 2 request sửa 2 field | `HSET` field độc lập |
| Counter login không atomic | `HINCRBY` |
| Field nhạy cảm cần TTL riêng | HFE Redis 7.4+ |

### 10.2. Giỏ hàng e-commerce

Bài toán: giỏ hàng thay đổi liên tục, phải sống qua login/logout, DB ghi mỗi click là quá tải.

```bash
HSET cart:user:42 sku:1001 2 sku:2005 1
HINCRBY cart:user:42 sku:1001 1
HINCRBY cart:user:42 sku:2005 -1
HDEL cart:user:42 sku:2005
HGETALL cart:user:42
EXPIRE cart:user:42 604800
```

Chi tiết hay bị bỏ sót:

| Quyết định | Lý do |
|------------|-------|
| Field = `sku`, value = quantity | update quantity atomic |
| Không lưu giá cuối cùng làm nguồn sự thật | checkout phải join bảng giá hiện hành |
| `HGETALL` được phép | cart thường < vài trăm item |
| TTL 7 ngày | giỏ bỏ quên tự dọn |

### 10.3. Realtime metrics per-entity — dashboard quảng cáo

Bài toán: mỗi campaign cần counters `impressions/clicks/spend` cập nhật realtime, hàng nghìn campaign, DB aggregate chạy theo giờ.

```bash
HINCRBY stats:camp:881:2026-07-07 impressions 1
HINCRBY stats:camp:881:2026-07-07 clicks 1
HINCRBYFLOAT stats:camp:881:2026-07-07 spend 0.35
HMGET stats:camp:881:2026-07-07 impressions clicks spend
EXPIRE stats:camp:881:2026-07-07 2592000
```

So với String key riêng:

| String key riêng | Hash per campaign/day |
|------------------|-----------------------|
| `stats:camp:881:clicks` | field `clicks` |
| Cần MGET nhiều key | `HMGET` một key |
| Namespace nhiều key | Key theo entity/day |
| Counter atomic vẫn được | Counter atomic + group locality |

> [!NOTE]
> Nếu dashboard cần top campaign theo clicks, Hash không đủ — bạn cần cập nhật thêm Sorted Set (`ZINCRBY`) để query ranking.

---

## 11. Anti-patterns cần tránh

| Anti-pattern ❌ | Vì sao nguy hiểm | Cách sửa ✅ |
|-----------------|------------------|-------------|
| `HGETALL` trên Hash 100K-1M field | Block event loop, reply khổng lồ, socket backpressure | `HMGET` field cần, hoặc `HSCAN COUNT n` |
| Một Hash global làm cả namespace (`HSET users <id> ...`) | Big key, không shard tốt trong Redis Cluster, migrate/replicate nặng | Bucket: `users:bucket:<id/1000>` + field `<id%1000>` |
| Dùng Hash cho ranking/range/sort | Hash không sắp xếp theo score/range | Sorted Set: `ZINCRBY`, `ZREVRANGE` |
| Read-modify-write JSON cho counter | Race condition, parse/serialize thừa | `HINCRBY user:42 login_count 1` |
| Field/value quá lớn | Vượt `hash-max-listpack-value` → chuyển `hashtable` âm thầm | Tách blob sang String JSON hoặc RedisJSON |
| Bucket quá lớn để tiết kiệm key | Biến thành big key, `HSCAN` dài, resize nặng | Chọn bucket size theo đo đạc; giữ listpack nếu mục tiêu là memory |
| Dựa vào TTL key khi cần TTL từng entry | Một `EXPIRE` xóa cả Hash | Redis 7.4+ dùng `HEXPIRE`; bản cũ tách key hoặc dùng ZSET cleanup |

> [!CAUTION]
> Hash là công cụ tuyệt vời cho **object phẳng và nhóm field nhỏ**. Khi bạn biến nó thành “database trong một key”, mọi vấn đề của big key sẽ quay lại: latency spike, khó shard, khó migrate, khó vận hành.

---

## 12. Best Practices

- **Dùng `HMGET` theo nhu cầu, đừng `HGETALL` theo thói quen** — nhất là API hot path.
- **Giữ Hash nhỏ trong `listpack`** nếu mục tiêu là memory: kiểm tra `OBJECT ENCODING`, `HLEN`, `HSTRLEN`.
- **Đừng để một Hash phình vô hạn**. Field = `user_id` trong một key global là red flag; bucket hoặc shard theo ngày/entity.
- **Dùng `HINCRBY`/`HINCRBYFLOAT` cho counters**, không đọc-sửa-ghi JSON.
- **Nhớ TTL mặc định là key-level**; Redis 7.4+ mới có HFE. `HSET` không reset TTL của key, khác `SET` String không kèm `KEEPTTL`.
- **Cẩn thận field lớn**: một field 5KB có thể làm Hash chuyển encoding và khiến `HGETALL` trả payload lớn.
- **Pipeline khi thao tác nhiều key/field độc lập** — xem [Pipelining & Batching](./pipelining-batching.md).
- **Đo bằng dữ liệu thật**: `MEMORY USAGE`, `OBJECT ENCODING`, `SLOWLOG`, latency monitor. Redis version/allocator/config ảnh hưởng lớn.

---

## 13. Tóm tắt: cheat-sheet & 3 nguyên tắc

### 13.1. Cheat-sheet String(JSON) vs Hash

| Tình huống | Chọn | Lệnh chính |
|------------|------|------------|
| Session/object phẳng, đọc vài field | Hash | `HMGET`, `HSET`, `EXPIRE` |
| Counter trong object | Hash | `HINCRBY`, `HINCRBYFLOAT` |
| Giỏ hàng | Hash | `HSET`, `HINCRBY`, `HDEL`, `HGETALL` |
| Dashboard ít metric/entity | Hash | `HINCRBY`, `HMGET` |
| Luôn đọc/ghi nguyên object nested | String JSON | `GET`, `SET` |
| Cần partial update nested JSON | RedisJSON | `JSON.SET`, `JSON.GET` |
| Cần ranking/range/sort | Sorted Set | `ZINCRBY`, `ZRANGE` |
| Hàng trăm triệu value nhỏ | Hash bucket | `HSET bucket field value` |
| Duyệt Hash lớn | Hash + scan | `HSCAN` |

### 13.2. Command nhớ nhanh

| Nhu cầu | Command |
|---------|---------|
| Set nhiều field | `HSET key f1 v1 f2 v2` |
| Get vài field | `HMGET key f1 f2` |
| Get cả object nhỏ | `HGETALL key` |
| Tăng counter | `HINCRBY key field delta` |
| Check field | `HEXISTS key field` |
| Xóa field | `HDEL key field` |
| Độ dài field value | `HSTRLEN key field` |
| Random/sample | `HRANDFIELD key [count] [WITHVALUES]` |
| Duyệt lớn | `HSCAN key cursor COUNT n` |
| TTL field Redis 7.4+ | `HEXPIRE`, `HTTL`, `HPERSIST` |
| Get + refresh TTL Redis 8.0+ | `HGETEX` |

### 13.3. Ba nguyên tắc

1. **Object phẳng + partial update → Hash.** Nếu bạn chỉ cần 2 field, đừng kéo cả JSON 700 bytes qua network.
2. **Hash nhỏ là vũ khí memory; Hash khổng lồ là big key.** Listpack giúp tiết kiệm, nhưng `HGETALL` trên 100K field vẫn có thể làm Redis khựng.
3. **Atomic field ops thay read-modify-write.** Counter, quantity, last_seen, token TTL — hãy để Redis xử lý bằng một command.

Quay lại câu chuyện mở đầu: 2 triệu session không chết vì Redis “chậm”; chúng chậm vì ta bắt Redis vận chuyển và ghi đè những blob lớn cho các thay đổi rất nhỏ. Hash cho bạn đúng đơn vị thao tác: **field**. Khi đơn vị dữ liệu khớp với đơn vị thay đổi, hệ thống tự nhiên nhẹ hơn — ít byte hơn, ít race hơn, ít bất ngờ hơn.

---

## Tài liệu tham khảo

- [Redis Hashes](https://redis.io/docs/latest/develop/data-types/hashes/)
- [Hash Field Expiration](https://redis.io/docs/latest/develop/data-types/hashes/#field-expiration)
- [Redis HEXPIRE command](https://redis.io/docs/latest/commands/hexpire/)
- [Redis HGETEX command](https://redis.io/docs/latest/commands/hgetex/)
- [Instagram: storing hundreds of millions of keys](https://instagram-engineering.com/storing-hundreds-of-millions-of-simple-key-value-pairs-in-redis-1091ae80f74c)
- [Redis Overview](./redis-overview.md)
- [Strings](./strings.md)
- [Memory Management](./memory-management.md)
- [Session Store](./session-store.md)
- [Pipelining & Batching](./pipelining-batching.md)
- [Streams](./streams.md) — data structure tiếp theo
