# Hashes

## Mục lục

- [Tổng quan](#tổng-quan)
- [Use Cases phổ biến](#use-cases-phổ-biến)
- [1. Bên trong: listpack và hashtable](#1-bên-trong-listpack-và-hashtable)
- [2. Command chính & độ phức tạp](#2-command-chính--độ-phức-tạp)
- [3. Hash vs String (JSON) — chọn cái nào?](#3-hash-vs-string-json--chọn-cái-nào)
- [4. Field-level TTL (Redis 7.4+)](#4-field-level-ttl-redis-74)
- [5. Patterns thực tế](#5-patterns-thực-tế)
- [6. Best Practices](#6-best-practices)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## Tổng quan

Hash là **map field → value** bên trong một key — mô hình tự nhiên cho object: một user, một sản phẩm, một session. Điểm mạnh: đọc/ghi/tăng **từng field** mà không cần serialize cả object.

```
user:42 (1 key duy nhất)
├── name    → "Hiệp"
├── email   → "hiep@example.com"
├── logins  → 128          ← HINCRBY được
└── plan    → "pro"
```

---

## Use Cases phổ biến

| Use Case | Vì sao Hash |
|----------|-------------|
| **Object cache** (user, product) | Update 1 field không cần đọc-ghi cả JSON |
| **Session store** | Mỗi attribute một field — xem [Session Store](./session-store.md) |
| **Counter theo nhóm** | `HINCRBY stats:2026-07-07 page:home 1` — nhiều counter chung 1 key |
| **Shopping cart** | field = product_id, value = quantity |
| **Cấu hình / feature flags theo nhóm** | `HGETALL config:payments` lấy cả nhóm 1 lệnh |
| **Rút gọn memory cho hàng triệu object nhỏ** | listpack encoding — mục 3.2 |

---

## 1. Bên trong: listpack và hashtable

| Encoding | Điều kiện | Cấu trúc |
|----------|-----------|----------|
| `listpack` | ≤ `hash-max-listpack-entries` (128 field) và mỗi field/value ≤ `hash-max-listpack-value` (64 bytes) | field, value xen kẽ trong một khối memory liên tục |
| `hashtable` | vượt ngưỡng | dict thật — như keyspace chính (xem [Redis Overview](./redis-overview.md)) |

### 1.1 listpack — vì sao O(N) mà vẫn nhanh

```
┌────────┬─────────┬─────────┬─────────┬─────────┬─────┐
│ header │ field1  │ value1  │ field2  │ value2  │ END │
└────────┴─────────┴─────────┴─────────┴─────────┴─────┘
   HGET = scan tuyến tính tìm field → O(N), nhưng N ≤ 128
   và toàn bộ nằm trong 1 khối memory → vài lần cache miss là xong
```

Với N nhỏ, scan mảng liên tục **nhanh hơn** hashtable trong thực tế (không pointer chasing, không hash function) và tiết kiệm memory gấp nhiều lần (không bucket, không con trỏ, không robj cho từng value).

### 1.2 hashtable — khi hash lớn

Khi vượt ngưỡng, chuyển sang dict với **incremental rehashing** giống keyspace chính: khi resize, hai bảng tồn tại song song, mỗi thao tác dời dần vài bucket — không có khoảnh khắc "đứng hình" để rehash cả bảng.

```
127.0.0.1:6379> HSET h f1 v1
127.0.0.1:6379> OBJECT ENCODING h        → "listpack"
127.0.0.1:6379> HSET h bigfield <chuỗi 100 bytes>
127.0.0.1:6379> OBJECT ENCODING h        → "hashtable"   (không quay lại)
```

> [!TIP]
> Ngưỡng 128/64 chỉnh được trong redis.conf. Nếu object của bạn có ~150 field toàn value ngắn, nâng `hash-max-listpack-entries 256` có thể giảm memory đáng kể — đo bằng `MEMORY USAGE` trước/sau.

---

## 2. Command chính & độ phức tạp

| Command | Complexity | Ghi chú |
|---------|-----------|---------|
| `HSET key f v [f v ...]` | O(1)/field | HSET nhiều field 1 lệnh (HMSET đã deprecated) |
| `HGET key f` | O(1) | |
| `HMGET key f1 f2` | O(N) | N field chỉ định — 1 round-trip |
| `HGETALL key` | O(N) | **cả field lẫn value** — cẩn thận hash lớn |
| `HDEL key f [f ...]` | O(1)/field | |
| `HEXISTS key f` | O(1) | |
| `HLEN key` | O(1) | số field |
| `HINCRBY key f delta` | O(1) | atomic — như INCR nhưng theo field |
| `HINCRBYFLOAT key f delta` | O(1) | |
| `HRANDFIELD key [count [WITHVALUES]]` | O(N) worst | random field (6.2+) |
| `HSCAN key cursor [NOVALUES]` | O(1)/lần | duyệt an toàn; `NOVALUES` (7.4) chỉ trả field |
| `HKEYS` / `HVALS` | O(N) | như HGETALL, chỉ một phía |

> [!IMPORTANT]
> `HGETALL` trên hash 100K field là bản sao của lỗi `SMEMBERS`/`KEYS`: block event loop + reply khổng lồ. Hash lớn → `HSCAN`, hoặc `HMGET` đúng những field cần.

`HINCRBY` atomic nhờ single-thread — nhiều app server cùng `HINCRBY stats:today api_calls 1` không bao giờ mất lượt đếm (so sánh cơ chế tại [Strings — INCR](./strings.md)).

---

## 3. Hash vs String (JSON) — chọn cái nào?

### 3.1 So sánh trực diện

| Tiêu chí | Hash | String chứa JSON |
|----------|------|------------------|
| Đọc/ghi 1 field | `HGET`/`HSET` — chỉ field đó qua network | GET cả blob → parse → sửa → SET cả blob (2 round-trip + race) |
| Tăng counter trong object | `HINCRBY` atomic | Không thể atomic (trừ khi Lua) |
| Đọc cả object | `HGETALL` | `GET` — nhanh hơn, 1 value |
| Nested structure | Không (value là string phẳng) | Có (JSON lồng nhau) |
| TTL | Cả key; per-field từ 7.4 (mục 4) | Cả key |
| Memory (object nhỏ) | Rất tốt với listpack | robj + JSON overhead |

**Quy tắc chọn nhanh:**
- Đọc/ghi **từng phần**, có counter bên trong, object phẳng → **Hash**
- Luôn đọc/ghi **cả object**, cần nested, client đã có sẵn serializer → **String JSON**
- Cần nested + update từng path (`$.a.b[0]`) → module RedisJSON — xem [Redis Modules](./redis-modules.md)

### 3.2 Trick kinh điển: gom key nhỏ vào hash

Bài toán: 100 triệu cặp `id → giá trị ngắn`. Lưu 100 triệu String key → mỗi key tốn ~90+ bytes overhead (dict entry, robj, SDS key). Thay vào đó **bucket hóa**:

```
# Thay vì:  SET obj:123456789 "abc"
# Chia id: bucket = id / 1000, field = id % 1000
HSET obj:123456 789 "abc"          # 100 triệu key → 100K hash × 1000 field
```

Mỗi hash ≤ 1000 field... nhưng chú ý: để hưởng listpack phải giữ dưới ngưỡng → chỉnh `hash-max-listpack-entries 1024`. Kết quả thực tế (case study của Instagram): giảm memory **~4-5 lần**. Đánh đổi: mất TTL/type riêng cho từng entry. Chi tiết: [Memory Management](./memory-management.md).

---

## 4. Field-level TTL (Redis 7.4+)

Trước 7.4, TTL chỉ áp cho **cả key** — muốn "field tự hết hạn" phải tự chế bằng [Sorted Set](./sorted-sets.md). Từ 7.4 có HFE (Hash Field Expiration):

```bash
HSET sess:42 token abc device ios
HEXPIRE sess:42 1800 FIELDS 1 token     # riêng field token sống 30 phút
HTTL sess:42 FIELDS 2 token device      # → 1795, -1 (device không TTL)
HPERSIST sess:42 FIELDS 1 token         # gỡ TTL
HGETEX sess:42 EX 1800 FIELDS 1 token   # get + gia hạn — atomic (7.4+)
```

Cơ chế xóa giống key TTL: **lazy** (đụng tới field đã hết hạn thì xóa) + **active** (quét định kỳ). Field cuối cùng hết hạn → key tự biến mất.

Use case điển hình: session với "remember me" — field nhạy cảm hết hạn sớm, field còn lại sống lâu; hoặc cache per-attribute có độ tươi khác nhau.

---

## 5. Patterns thực tế

### 5.1 Object cache với partial update

```bash
HSET user:42 name "Hiệp" email "hiep@x.co" plan "free" logins 0
HSET user:42 plan "pro"            # upgrade — chỉ ghi 1 field
HINCRBY user:42 logins 1           # mỗi lần login
HMGET user:42 name plan            # trang chỉ cần 2 field → lấy đúng 2
EXPIRE user:42 3600
```

### 5.2 Counter dashboard theo ngày

```bash
HINCRBY stats:2026-07-07 signup 1
HINCRBY stats:2026-07-07 order 1
HINCRBY stats:2026-07-07 revenue_cents 4990
HGETALL stats:2026-07-07           # cả dashboard 1 lệnh (ít field — an toàn)
EXPIRE stats:2026-07-07 2592000    # giữ 30 ngày
```

So với mỗi metric một String key: chung TTL, lấy cả nhóm 1 round-trip, ít key hơn.

### 5.3 Shopping cart

```bash
HSET cart:sess:abc p:1001 2 p:2005 1
HINCRBY cart:sess:abc p:1001 1     # thêm 1 sản phẩm
HDEL cart:sess:abc p:2005          # bỏ khỏi giỏ
HGETALL cart:sess:abc              # render giỏ
EXPIRE cart:sess:abc 86400
```

### 5.4 Rate limit nhiều tier chung 1 key

```bash
HINCRBY rl:user42:min:202607070049 api 1
HINCRBY rl:user42:min:202607070049 upload 1
EXPIRE rl:user42:min:202607070049 120 NX
```

---

## 6. Best Practices

- **Field cần thiết → HMGET, đừng HGETALL theo quán tính** — nhất là khi hash có field to (blob, JSON con)
- **Giữ hash dưới ngưỡng listpack** khi có hàng triệu hash nhỏ — kiểm tra `OBJECT ENCODING`, chỉnh ngưỡng theo dữ liệu thật
- **Đừng để hash phình vô hạn** (field = user_id là red flag) — hash 10 triệu field là một big key: HGETALL chết, migrate/rehash tốn kém; bucket hóa như 3.2
- **HINCRBY thay cho đọc-sửa-ghi** với mọi counter trong object
- **TTL: nhớ là của cả key** (trừ HFE 7.4+) — HSET không reset TTL của key (khác `SET` với String!)
- **Value là string phẳng** — đừng nhét JSON vào từng field rồi lại parse; lúc đó cân nhắc RedisJSON

---

## Tài liệu tham khảo

- [Redis Hashes](https://redis.io/docs/latest/develop/data-types/hashes/)
- [Hash Field Expiration](https://redis.io/docs/latest/develop/data-types/hashes/#field-expiration)
- [Instagram: storing hundreds of millions of keys](https://instagram-engineering.com/storing-hundreds-of-millions-of-simple-key-value-pairs-in-redis-1091ae80f74c)
- [Streams](./streams.md) — data structure tiếp theo
