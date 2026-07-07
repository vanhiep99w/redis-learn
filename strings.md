# Strings

## Mục lục

- [Tổng quan](#tổng-quan)
- [Use Cases phổ biến](#use-cases-phổ-biến)
- [1. Bên trong: SDS và 3 encoding](#1-bên-trong-sds-và-3-encoding)
- [2. Command chính & độ phức tạp](#2-command-chính--độ-phức-tạp)
- [3. Atomic counter — INCR hoạt động thế nào](#3-atomic-counter--incr-hoạt-động-thế-nào)
- [4. SET và các option — nền tảng của lock & cache](#4-set-và-các-option--nền-tảng-của-lock--cache)
- [5. TTL hoạt động thế nào](#5-ttl-hoạt-động-thế-nào)
- [6. Bit operations](#6-bit-operations)
- [7. Best Practices](#7-best-practices)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## Tổng quan

String là kiểu dữ liệu cơ bản nhất của Redis: một key trỏ tới một chuỗi byte **binary-safe** dài tối đa 512MB. "String" ở đây không chỉ là text — có thể là số (Redis tự hiểu để INCR), JSON, ảnh, protobuf, bất kỳ blob nào.

```
key ──▶ redisObject(type=string)
              │ encoding?
              ├── int     : value là số nguyên 64-bit → lưu thẳng trong pointer
              ├── embstr  : ≤ 44 bytes → robj + SDS trong MỘT khối malloc
              └── raw     : > 44 bytes → robj và SDS cấp phát riêng
```

---

## Use Cases phổ biến

| Use Case | Command chính |
|----------|--------------|
| **Cache object/HTML/JSON** | `SET key val EX ttl`, `GET` — xem [Caching Patterns](./caching-patterns.md) |
| **Counter** (view, like, quota) | `INCR`, `INCRBY`, `DECR` |
| **Distributed lock** | `SET key token NX PX 30000` — xem [Distributed Lock](./distributed-lock.md) |
| **Rate limiting** | `INCR` + `EXPIRE` — xem [Rate Limiting](./rate-limiting.md) |
| **Session token → user id** | `SET sess:abc123 user:42 EX 1800` |
| **Feature flag / config** | `GET config:feature-x` |
| **Tracking theo bit** | `SETBIT`, `BITCOUNT` — xem thêm [Bitmaps & HyperLogLog](./bitmaps-hyperloglog.md) |

---

## 1. Bên trong: SDS và 3 encoding

### 1.1 SDS — vì sao không dùng C string

Redis lưu string bằng **Simple Dynamic String**:

```
struct sdshdr {
    len    : độ dài hiện tại      → STRLEN O(1), binary-safe
    alloc  : dung lượng cấp phát  → append không realloc mỗi lần
    flags  : loại header (8/16/32/64-bit tùy size — tiết kiệm từng byte)
    buf[]  : dữ liệu + '\0' cuối (để tương thích printf khi debug)
}
```

Chiến lược cấp phát khi APPEND làm string vượt `alloc`:
- String mới < 1MB → cấp phát **gấp đôi** `len` mới
- ≥ 1MB → cấp phát thêm đúng 1MB

→ APPEND N lần là O(N) amortized thay vì O(N²) như realloc từng lần.

### 1.2 Ba encoding và điều kiện chuyển

| Encoding | Điều kiện | Chi tiết |
|----------|-----------|---------|
| `int` | Value parse được thành số nguyên 64-bit | Không cấp phát SDS; số 0–9999 dùng **shared integers** (cache sẵn, refcount chung) → gần như 0 byte |
| `embstr` | ≤ 44 bytes và không phải số | `robj` + SDS nằm trong **một** khối malloc liên tiếp → 1 lần cấp phát, 1 lần giải phóng, cache locality tốt. **Read-only** — mọi modify đều chuyển sang raw |
| `raw` | > 44 bytes, hoặc embstr bị modify | robj và SDS là 2 khối riêng |

```
127.0.0.1:6379> SET n 12345          → OBJECT ENCODING n   → "int"
127.0.0.1:6379> SET s "hello"        → OBJECT ENCODING s   → "embstr"
127.0.0.1:6379> APPEND s "!"         → OBJECT ENCODING s   → "raw"  (embstr là read-only)
```

Con số 44: khối malloc 64 bytes − 16 (robj) − 3 (sds header nhỏ nhất) − 1 (`\0`) = 44.

> [!TIP]
> Hệ quả thực tiễn: giữ value ngắn (id, token, số) rất rẻ. Hàng triệu counter kiểu `int` encoding tốn ít memory hơn nhiều so với JSON blob — xem [Memory Management](./memory-management.md).

---

## 2. Command chính & độ phức tạp

| Command | Complexity | Ghi chú |
|---------|-----------|---------|
| `SET key val` / `GET key` | O(1) | |
| `SET key val EX 60 NX` | O(1) | option — xem mục 4 |
| `MSET k1 v1 k2 v2` / `MGET k1 k2` | O(N) | N key trong 1 round-trip — rẻ hơn N lần GET |
| `SETRANGE key offset val` | O(1)* | ghi đè từ offset; tự pad `\0` nếu offset > len |
| `GETRANGE key start end` | O(N) | N = độ dài đoạn cắt |
| `APPEND key val` | O(1) amortized | nhờ pre-allocation của SDS |
| `STRLEN key` | O(1) | đọc `len` của SDS |
| `INCR` / `INCRBY` / `INCRBYFLOAT` | O(1) | mục 3 |
| `GETDEL key` | O(1) | get rồi xóa — atomic (Redis 6.2+) |
| `GETEX key EX 60` | O(1) | get + đặt/bỏ TTL — atomic (Redis 6.2+) |
| `SETBIT` / `GETBIT` / `BITCOUNT` | O(1) / O(1) / O(N) | mục 6 |

\* `SETRANGE` với offset lớn trên key rỗng phải cấp phát cả khối → thực tế O(offset).

```bash
# MGET: 1 round-trip thay vì N — điểm ăn tiền khi latency mạng ~0.5ms
MGET user:1:name user:2:name user:3:name
```

---

## 3. Atomic counter — INCR hoạt động thế nào

```
127.0.0.1:6379> SET pageviews 0
127.0.0.1:6379> INCR pageviews        → (integer) 1
127.0.0.1:6379> INCRBY pageviews 10   → (integer) 11
127.0.0.1:6379> INCR notanumber       → (error) ERR value is not an integer
```

Cơ chế bên trong:

1. Key có encoding `int` → value là số nằm ngay trong con trỏ `ptr` của robj. INCR chỉ là phép cộng trên số nguyên đó — **không parse string, không cấp phát**
2. Vì event loop single-threaded (xem [Redis Overview](./redis-overview.md)), **không thể có 2 INCR chen ngang nhau** → không cần lock, không có lost update

So sánh với cách làm sai ở client:

```
# SAI — race condition giữa 2 client:
val = GET counter        # client A đọc 5, client B cũng đọc 5
SET counter val+1        # cả hai ghi 6 → mất 1 lượt đếm

# ĐÚNG — server-side atomic:
INCR counter             # 6, rồi 7
```

Giới hạn: chỉ trong phạm vi số nguyên 64-bit có dấu. `INCRBYFLOAT` cho số thực (lưu ý: kết quả chuyển encoding sang `embstr`/`raw`).

Pattern counter có TTL (reset theo chu kỳ) — lõi của [Rate Limiting](./rate-limiting.md):

```bash
INCR req:user42:202607071230
EXPIRE req:user42:202607071230 60 NX   # chỉ set TTL lần đầu (Redis 7+)
```

---

## 4. SET và các option — nền tảng của lock & cache

`SET` từ Redis 2.6.12 gộp SETNX/SETEX/PSETEX thành option để **atomic trong một lệnh**:

```bash
SET key value [NX | XX] [EX sec | PX ms | EXAT ts | KEEPTTL] [GET]
```

| Option | Ý nghĩa | Dùng cho |
|--------|---------|----------|
| `NX` | Chỉ set nếu key **chưa** tồn tại | Distributed lock, "chỉ ghi lần đầu" |
| `XX` | Chỉ set nếu key **đã** tồn tại | Update không tạo mới |
| `EX`/`PX` | TTL giây/ms | Cache, session |
| `EXAT`/`PXAT` | TTL theo unix timestamp | Expire đồng bộ theo giờ tuyệt đối |
| `KEEPTTL` | Ghi value mới nhưng **giữ TTL cũ** | Update cache không reset vòng đời |
| `GET` | Trả về value cũ | Atomic swap (thay GETSET) |

Vì sao "một lệnh atomic" quan trọng — lock đúng vs lock sai:

```bash
# SAI — 2 bước, client chết giữa chừng → lock không bao giờ expire:
SETNX lock:order:42 token
EXPIRE lock:order:42 30

# ĐÚNG — một lệnh, có token để chỉ chủ lock mới unlock được:
SET lock:order:42 "uuid-cua-toi" NX PX 30000
```

Phân tích đầy đủ (Redlock, fencing token): [Distributed Lock](./distributed-lock.md).

---

## 5. TTL hoạt động thế nào

- TTL lưu trong dict `expires` **riêng**, tách khỏi dict dữ liệu chính — key không TTL không tốn gì thêm
- Xóa theo 2 cơ chế: **lazy** (check khi truy cập) + **active** (sampling định kỳ ~10Hz) — chi tiết tại [Redis Overview](./redis-overview.md)
- `SET key newval` (không option) **xóa TTL cũ** — bẫy kinh điển; dùng `KEEPTTL` nếu muốn giữ
- `PERSIST key` gỡ TTL; `EXPIRE key sec NX|XX|GT|LT` (Redis 7+) điều kiện hóa việc đổi TTL

```
127.0.0.1:6379> SET cache:page1 "<html>" EX 300
127.0.0.1:6379> TTL cache:page1     → (integer) 297
127.0.0.1:6379> SET cache:page1 "<html v2>"
127.0.0.1:6379> TTL cache:page1     → (integer) -1   ← TTL đã mất!
```

---

## 6. Bit operations

String cũng là **bit array**: mỗi byte 8 bit, key 512MB = 2³² bit. Đủ để track 4 tỷ user id chỉ với 1 key:

```bash
SETBIT active:2026-07-07 42 1     # user id 42 hoạt động hôm nay
GETBIT active:2026-07-07 42       # → 1
BITCOUNT active:2026-07-07        # bao nhiêu user hoạt động

# DAU trong 7 ngày (OR các bitmap ngày):
BITOP OR active:week active:2026-07-01 active:2026-07-02 ...
BITCOUNT active:week
```

Chi phí: bitmap n user ≈ n/8 bytes. 10 triệu user ≈ 1.25MB/ngày. Cẩn thận: `SETBIT key 4000000000 1` trên key rỗng cấp phát ngay ~500MB.

Deep-dive và so sánh với HyperLogLog: [Bitmaps & HyperLogLog](./bitmaps-hyperloglog.md).

---

## 7. Best Practices

- **Đặt tên key có cấu trúc**: `object:id:field` (`user:42:profile`) — dễ SCAN theo pattern, dễ đọc khi debug
- **Luôn có TTL cho cache**: key không TTL chỉ dành cho dữ liệu chủ đích lưu lâu; kiểm soát bằng `maxmemory-policy volatile-*` — xem [Eviction Policies](./eviction-policies.md)
- **Tránh big value**: value vài MB làm nghẽn network buffer và block event loop khi serialize; > 100KB nên cân nhắc nén hoặc tách
- **Dùng MSET/MGET hoặc pipeline** thay vì loop GET/SET — xem [Pipelining & Batching](./pipelining-batching.md)
- **Số 0–9999**: được share sẵn, không tốn memory — cứ tự nhiên dùng counter nhỏ
- **Cẩn thận `SET` ghi đè TTL** — dùng `KEEPTTL` khi update cache

> [!TIP]
> Lưu object nhiều field: nếu luôn đọc/ghi cả object → String (JSON) đơn giản; nếu hay đọc/ghi từng field → [Hash](./hashes.md) tiết kiệm hơn và có field-level operation.

---

## Tài liệu tham khảo

- [Redis Strings](https://redis.io/docs/latest/develop/data-types/strings/)
- [SET command đầy đủ options](https://redis.io/docs/latest/commands/set/)
- [Hashes](./hashes.md) — khi value là object nhiều field
- [Lists](./lists.md) — data structure tiếp theo
