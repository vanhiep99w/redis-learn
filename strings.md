# Strings

## Mục lục

- [1. String: đơn giản nhưng không hề tầm thường](#1-string-đơn-giản-nhưng-không-hề-tầm-thường)
- [2. Tổng quan: String là byte array, không chỉ là text](#2-tổng-quan-string-là-byte-array-không-chỉ-là-text)
- [3. Use Cases phổ biến](#3-use-cases-phổ-biến)
- [4. Bên trong: SDS — Simple Dynamic String](#4-bên-trong-sds--simple-dynamic-string)
- [5. Bên trong: 3 encoding int / embstr / raw](#5-bên-trong-3-encoding-int--embstr--raw)
- [6. Command chính & độ phức tạp](#6-command-chính--độ-phức-tạp)
- [7. Atomic counter — INCR hoạt động thế nào](#7-atomic-counter--incr-hoạt-động-thế-nào)
- [8. SET và các option — nền tảng của lock & cache](#8-set-và-các-option--nền-tảng-của-lock--cache)
- [9. TTL hoạt động thế nào](#9-ttl-hoạt-động-thế-nào)
- [10. Bit operations — String như bitmap](#10-bit-operations--string-như-bitmap)
- [11. Performance & benchmark thực chiến](#11-performance--benchmark-thực-chiến)
- [12. Case study thực tế](#12-case-study-thực-tế)
- [13. Anti-patterns cần tránh](#13-anti-patterns-cần-tránh)
- [14. Chọn String hay Hash/List/Bitmap?](#14-chọn-string-hay-hashlistbitmap)
- [15. Best Practices](#15-best-practices)
- [16. Tóm tắt / Cheat sheet](#16-tóm-tắt--cheat-sheet)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## 1. String: đơn giản nhưng không hề tầm thường

String là kiểu dữ liệu đầu tiên ai cũng gặp khi học Redis, và cũng là kiểu dễ bị xem nhẹ nhất. Nhìn qua thì nó chỉ là "một key trỏ tới một chuỗi": `SET` rồi `GET`, xong. Nhưng chính vì đơn giản, String lại gánh phần lớn công việc hằng ngày của Redis — cache JSON, đếm view, distributed lock, session token, feature flag, rate limit đều xây trên nó.

Điểm hay bị hiểu lầm nằm ở chữ "string". Với Redis, một String **không nhất thiết là text**: nó là một chuỗi byte binary-safe, dài tối đa 512MB, có thể chứa số (để `INCR`), JSON, ảnh, protobuf hay bất kỳ blob nào.

```bash
SET user:42:name "Alice"            # text
SET counter 1000                    # số — Redis tự hiểu để INCR
INCR counter                        # → 1001, atomic, không cần lock
SET lock:order:42 tok NX PX 30000   # distributed lock chỉ với một lệnh
```

Cũng vì đơn giản mà String dễ dùng sai theo cách khó thấy: một value phình từ vài chục KB lên vài MB có thể làm chậm cả instance, một lần `SET` vô tình xóa mất TTL, hay hàng triệu key tên dài âm thầm ngốn RAM. Những cái bẫy này không nằm ở cú pháp lệnh, mà nằm ở **cách Redis lưu String bên trong**.

Vì vậy doc này đi từ trong ra ngoài: String nằm trong memory ra sao (SDS và ba encoding), vì sao `INCR` atomic mà không cần lock, các option của `SET` tạo nên lock/cache thế nào, TTL hoạt động ra sao — và cuối cùng là khi nào nên đổi sang [Hash](./hashes.md), [Bitmap](./bitmaps-hyperloglog.md) hoặc tách nhỏ value.

---

## 2. Tổng quan: String là byte array, không chỉ là text

String là kiểu dữ liệu cơ bản nhất của Redis: một key trỏ tới một chuỗi byte **binary-safe** dài tối đa **512MB**. “String” ở đây có thể là số, JSON, HTML, token, protobuf, ảnh nhỏ, hoặc bitmap.

```diagram
key ──▶ redisObject(type=string)
              │ encoding?
              ├── int     : value là số nguyên 64-bit → lưu thẳng trong pointer
              ├── embstr  : ≤ 44 bytes → robj + SDS trong MỘT khối malloc
              └── raw     : > 44 bytes → robj và SDS cấp phát riêng
```

> [!NOTE]
> `STRLEN` đếm **byte**, không đếm ký tự Unicode. `STRLEN "phở"` trả 5 vì UTF-8 dùng 5 byte. String binary-safe: byte `\0` ở giữa value không làm Redis dừng đọc như C string.

---

## 3. Use Cases phổ biến

| Use Case | Command chính | Khi nào hợp |
|----------|--------------|-------------|
| **Cache object/HTML/JSON** | `SET key val EX ttl`, `GET` — xem [Caching Patterns](./caching-patterns.md) | Đọc/ghi cả blob |
| **Counter** view/like/quota | `INCR`, `INCRBY`, `DECR` | Số nguyên 64-bit, atomic |
| **Distributed lock** | `SET key token NX PX 30000` — xem [Distributed Lock](./distributed-lock.md) | Lock ngắn, có TTL, có token |
| **Rate limiting** | `INCR` + `EXPIRE` — xem [Rate Limiting](./rate-limiting.md) | Fixed window đơn giản |
| **Session token → user id** | `SET sess:abc123 user:42 EX 1800` | Lookup O(1), TTL tự dọn |
| **Feature flag / config** | `GET config:feature-x` | Value nhỏ, read-heavy |
| **Tracking theo bit** | `SETBIT`, `BITCOUNT` — xem [Bitmaps & HyperLogLog](./bitmaps-hyperloglog.md) | Boolean theo user/time |

---

## 4. Bên trong: SDS — Simple Dynamic String

### 4.1 Vì sao Redis không dùng C string?

C string chỉ biết kết thúc bằng `\0`, nên muốn biết length phải scan O(N) và không lưu binary an toàn. Redis cần `STRLEN` O(1), `APPEND` nhanh, và value có thể chứa byte bất kỳ. Vì vậy Redis dùng **SDS**:

```diagram
┌────────────── SDS header ──────────────┐┌──────────── buf ────────────┐
│ len = 11 │ alloc = 15 │ flags = sdshdr8││ hello\0world │ \0 terminator│
└────────────────────────────────────────┘└─────────────────────────────┘
       │            │              │
       │            │              └─ chọn header 5/8/16/32/64
       │            └─ capacity đã cấp phát, giúp append không realloc liên tục
       └─ length thật → STRLEN O(1), binary-safe
```

5 header size:

| Header | Dùng cho length | Field chính | Ý nghĩa |
|--------|-----------------|-------------|---------|
| `sdshdr5` | string rất nhỏ | flags chứa length | tiết kiệm nhất, ít dùng cho mutable string |
| `sdshdr8` | ≤ 255 bytes | `uint8 len/alloc` | token, id, key ngắn |
| `sdshdr16` | ≤ 65KB | `uint16 len/alloc` | HTML fragment nhỏ, JSON vừa |
| `sdshdr32` | ≤ 4GB | `uint32 len/alloc` | value lớn; Redis String vẫn giới hạn 512MB |
| `sdshdr64` | rất lớn về mặt SDS | `uint64 len/alloc` | dùng chung thư viện SDS |

> [!IMPORTANT]
> SDS có `len`, nhưng vẫn giữ byte `\0` cuối buffer để tiện gọi hàm C/debug. Byte này **không** quyết định length.

### 4.2 APPEND pre-allocation: vì sao O(1) amortized?

Khi `APPEND` làm `len` vượt `alloc`, SDS cấp phát dư:

1. Nếu size mới < 1MB → cấp phát khoảng **gấp đôi** size mới.
2. Nếu size mới ≥ 1MB → cấp phát thêm **1MB** free space, tránh nhân đôi quá lãng phí.

```diagram
len=10 alloc=10 + APPEND 5 bytes
        │
        ▼
need=15 < 1MB → alloc≈30
┌──────────── 15 bytes used ────────────┬──── 15 bytes free ────┐
│ data                                  │ future append         │
└───────────────────────────────────────┴───────────────────────┘
```

Nếu append từng byte 1 triệu lần, Redis không realloc 1 triệu lần. Tổng chi phí copy được trải đều → **O(N) tổng**, tức **O(1) amortized** cho append nhỏ.

> [!CAUTION]
> `SETRANGE key 500000000 1` trên key rỗng vẫn phải cấp phát/pad gần 500MB. SDS không biến offset khổng lồ thành miễn phí.

---

## 5. Bên trong: 3 encoding int / embstr / raw

| Encoding | Điều kiện | Memory/CPU | Chuyển đổi |
|----------|-----------|------------|------------|
| `int` | Value parse được thành số nguyên 64-bit | Không cấp phát SDS cho value; số `0–9999` thường dùng **shared integers** | `APPEND`, `SETRANGE`, `INCRBYFLOAT` có thể chuyển sang string |
| `embstr` | String không phải số, dài **≤ 44 bytes** | `redisObject` + SDS trong **1 malloc**, cache locality tốt | **Read-only**: modify là chuyển sang `raw` |
| `raw` | > 44 bytes hoặc `embstr` bị modify | `redisObject` và SDS là **2 malloc** | Mutable, dùng cho value lớn |

```bash
SET n 12345          # OBJECT ENCODING n → "int"
SET s "hello"        # OBJECT ENCODING s → "embstr"
APPEND s "!"         # OBJECT ENCODING s → "raw"
```

### 5.1 “Aha”: con số 44 byte từ đâu ra?

Redis muốn nhét object nhỏ vào allocator class **64 bytes**:

```diagram
64-byte allocation
┌──────────────┬───────────────┬───────┬──────────────┐
│ redisObject  │ SDS hdr nhỏ   │ \0    │ usable value │
│ ~16 bytes    │ ~3 bytes      │ 1     │ 44 bytes     │
└──────────────┴───────────────┴───────┴──────────────┘
64 - 16 - 3 - 1 = 44
```

> [!TIP]
> Token, session id, feature flag value ngắn thường rơi vào `embstr`: ít allocation hơn, free nhanh hơn. Nhưng chỉ cần `APPEND` một ký tự, nó thành `raw` vì embstr không sửa tại chỗ.

### 5.2 MEMORY USAGE mẫu

Số liệu thay đổi theo Redis version, jemalloc, độ dài key; bảng dưới là kiểu kết quả thường gặp để thấy xu hướng:

| Value | Encoding | `MEMORY USAGE` xấp xỉ | Bình luận |
|-------|----------|-----------------------|-----------|
| `SET a 7` | `int` shared | ~48–56B | key/dict overhead chiếm chính |
| `SET b 123456` | `int` | ~48–56B | value nằm trong pointer |
| `SET c "hello world"` | `embstr` | ~56–72B | 1 allocation cho object+SDS |
| 44-byte string | `embstr` | ~96–104B | sát ngưỡng allocator |
| 45-byte string | `raw` | ~112–128B | thêm allocation riêng cho SDS |
| JSON 2KB | `raw` | ~2.1–2.3KB | payload là phần lớn |

> [!NOTE]
> Tên key cũng là SDS trong dict. 100 triệu key tên dài thêm 20 byte có thể tốn thêm khoảng **2GB payload tên key**, chưa tính allocator overhead. Xem thêm [Memory Management](./memory-management.md).

---

## 6. Command chính & độ phức tạp

| Command | Complexity | Điểm cần nhớ |
|---------|------------|--------------|
| `SET` / `GET` | O(1) | Nhưng reply size lớn vẫn tốn network/copy |
| `MSET` / `MGET` | O(N) | N key trong 1 round-trip |
| `APPEND` | O(1) amortized | Nhờ SDS pre-allocation |
| `STRLEN` | O(1) | Đọc `len`, không scan buffer |
| `GETRANGE start end` | O(N) | N = bytes trả về |
| `SETRANGE offset val` | O(1) amortized; O(M) nếu value dài | M = bytes ghi; offset xa có chi phí cấp phát/pad |
| `GETDEL` | O(1) | get rồi delete atomic (Redis 6.2+) |
| `GETEX` | O(1) | get + set/remove TTL atomic (Redis 6.2+) |
| `INCR`/`INCRBY` | O(1) | atomic counter 64-bit signed |
| `INCRBYFLOAT` | O(1) | lưu lại dạng string, không còn `int` |
| `SETBIT`/`GETBIT`/`BITCOUNT` | O(1)/O(1)/O(N) | N theo bytes scan |

---

## 7. Atomic counter — INCR hoạt động thế nào

```bash
SET pageviews 0
INCR pageviews        # 1
INCRBY pageviews 10   # 11
INCR notanumber       # ERR value is not an integer
```

Redis xử lý command trong event loop single-threaded (xem [Redis Overview](./redis-overview.md)):

```diagram
Client A: INCR counter ─┐
Client B: INCR counter ─┼─▶ command queue ─▶ [read 5][+1][write 6] ─▶ [read 6][+1][write 7]
Client C: GET counter  ─┘
```

Không có hai `INCR` chen giữa nhau, nên không có lost update. Sai lầm là kéo phép cộng về client:

```bash
# ❌ Sai — race condition
val = GET counter        # A đọc 5, B cũng đọc 5
SET counter val+1        # cả hai ghi 6

# ✅ Đúng — server-side atomic
INCR counter             # 6, rồi 7
```

`INCRBYFLOAT` hữu ích cho điểm số/tổng tiền tạm thời, nhưng kết quả là chuỗi số thực nên encoding chuyển khỏi `int`. Với tiền thật, dùng integer minor unit (`VND`, cent) trong DB transaction; Redis counter phù hợp quota, view, rate limit hơn.

Pattern rate limit fixed-window:

```bash
INCR req:user42:202607071230
EXPIRE req:user42:202607071230 60 NX   # Redis 7+: chỉ set TTL lần đầu
```

---

## 8. SET và các option — nền tảng của lock & cache

`SET` là lệnh “dao đa năng”:

```bash
SET key value [NX | XX] [GET] [EX sec | PX ms | EXAT ts | PXAT ts | KEEPTTL]
```

| Option | Ý nghĩa | Ví dụ |
|--------|---------|-------|
| `NX` | Set nếu key chưa tồn tại | idempotency, lock |
| `XX` | Set nếu key đã tồn tại | update cache không tạo mới |
| `EX` / `PX` | TTL giây / millisecond | session, cache |
| `EXAT` / `PXAT` | expire tại Unix timestamp | hết hạn đúng 00:00 |
| `KEEPTTL` | giữ TTL cũ khi ghi value mới | refresh nội dung nhưng giữ vòng đời |
| `GET` | trả value cũ khi set | atomic swap, thay `GETSET` |

> [!NOTE]
> Redis `SET` hiện có các option trên; không có option `IDLE` cho `SET`. Nếu cần xem idle time của key, dùng `OBJECT IDLETIME`; nếu restore kèm idle metadata, đó là ngữ cảnh `RESTORE IDLETIME`, không phải String `SET`.

```bash
# ❌ Lock sai: client chết giữa SETNX và EXPIRE → lock vĩnh viễn
SETNX lock:order:42 token
EXPIRE lock:order:42 30

# ✅ Lock đúng: một lệnh atomic, TTL millisecond, value là token owner
SET lock:order:42 "uuid-cua-toi" NX PX 30000
```

> [!WARNING]
> `SET key newval` thành công sẽ **xóa TTL cũ** nếu không dùng option expiration hoặc `KEEPTTL`. Đây là bẫy gây cache sống mãi sau một lần refresh.

```bash
SET cache:page1 "v1" EX 300
SET cache:page1 "v2"          # TTL mất
SET cache:page1 "v3" KEEPTTL  # giữ TTL hiện có
```

Phân tích lock đầy đủ: [Distributed Lock](./distributed-lock.md).

---

## 9. TTL hoạt động thế nào

TTL không nằm trực tiếp trong object String. Redis có dict dữ liệu chính và dict `expires` riêng:

```diagram
┌──────────── main dict ────────────┐       ┌──────── expires dict ────────┐
│ "cache:a" ─▶ redisObject          │       │ "cache:a" ─▶ 1783420800000ms │
│ "counter" ─▶ redisObject          │       │ "sess:x"  ─▶ 1783420900000ms │
└───────────────────────────────────┘       └──────────────────────────────┘
        key không TTL → không có entry bên expires
```

Redis xóa expired key bằng 2 cơ chế:

| Cơ chế | Khi nào chạy | Tác dụng |
|--------|--------------|----------|
| Lazy expiration | Khi key được truy cập | Nếu đã hết hạn → xóa ngay rồi trả như không tồn tại |
| Active expiration | Vòng nền lấy mẫu định kỳ khoảng **10Hz** mặc định | Dọn key hết hạn ngay cả khi không ai đọc |

> [!NOTE]
> Vì active expiration dùng sampling, key hết hạn không nhất thiết biến mất đúng từng millisecond. Về mặt semantic, khi truy cập nó được xem như không tồn tại; về memory, có thể trễ một chút trước khi được dọn.

---

## 10. Bit operations — String như bitmap

String cũng là bit array: 1 byte = 8 bit, 512MB = 2^32 bit.

```bash
SETBIT active:2026-07-07 42 1
GETBIT active:2026-07-07 42
BITCOUNT active:2026-07-07
BITOP OR active:week active:2026-07-01 active:2026-07-02
```

| Bài toán | Dung lượng xấp xỉ | Ghi chú |
|----------|-------------------|---------|
| 10 triệu user active/ngày | 10,000,000 / 8 = **1.25MB/ngày** | Rất rẻ nếu user id dense |
| 100 triệu user | **12.5MB/ngày** | `BITCOUNT` scan 12.5MB |
| user id = 4 tỷ | **~500MB** nếu set bit cao nhất | Cực nguy hiểm nếu sparse |

Deep-dive và HyperLogLog: [Bitmaps & HyperLogLog](./bitmaps-hyperloglog.md).

---

## 11. Performance & benchmark thực chiến

### 11.1 Round-trip math: MGET thắng ở đâu?

Giả sử network RTT app → Redis là **0.5ms**, Redis xử lý mỗi `GET` nhỏ khoảng **5µs**:

| Cách làm | 100 key | Thời gian xấp xỉ |
|----------|---------|------------------|
| Loop `GET` tuần tự | 100 RTT + 100×5µs | ~50.5ms |
| Pipeline 100 `GET` | 1 RTT + 100×5µs | ~1.0ms |
| `MGET` 100 key | 1 RTT + O(100) server | ~0.8–1.2ms |

> [!TIP]
> `MGET`/pipeline không làm Redis xử lý ít key hơn; nó loại bỏ **N round-trip**. Xem [Pipelining & Batching](./pipelining-batching.md).

### 11.2 Big value block event loop

| Value size | 1,000 GET/s outbound | Rủi ro | Khuyến nghị |
|------------|----------------------|--------|-------------|
| 1KB | ~1MB/s | thấp | OK |
| 50KB | ~50MB/s | network/copy bắt đầu đáng kể | cân nhắc gzip, fragment |
| 500KB | ~500MB/s | latency lệnh nhỏ tăng | tách object, CDN/blob store |
| 8MB | ~8GB/s lý thuyết | gần như chắc chắn nghẽn | không dùng String hot-key kiểu này |

Aha moment: `GET` là O(1) theo lookup key, **không phải O(1) theo số byte phải gửi**.

---

## 12. Case study thực tế

### 12.1 Cache HTML fragment — báo điện tử

Bài toán: trang chi tiết bài viết render tốn 80ms, 95% request đọc cùng nội dung.

```bash
SET html:article:9911:v3 "<article>..." EX 3600
GET html:article:9911:v3          # hit → trả thẳng, ~0.2ms nếu value nhỏ
```

- Nhúng version/updated_at vào key để invalidate tự nhiên; key cũ tự hết hạn.
- HTML 50–200KB: cân nhắc gzip trước khi `SET`.
- Chống stampede: `SET lock:render:9911 1 NX EX 10` — xem [Caching Patterns](./caching-patterns.md).

### 12.2 Idempotency key — cổng thanh toán

```bash
SET idem:550e8400 "processing" NX EX 86400
# OK: lần đầu; nil: retry/duplicate
SET idem:550e8400 '{"status":"success","txn":"T123"}' XX KEEPTTL
```

`NX` biến check-then-act thành một lệnh atomic.

### 12.3 Counter tổng hợp ghi-nhiều đọc-ít — đếm view video

```bash
INCR views:video:777
# Cron mỗi phút:
val = GET views:video:777
UPDATE videos SET views = views + val WHERE id = 777
DECRBY views:video:777 val
```

Redis restart giữa 2 lần flush có thể mất counter tùy [Persistence Strategies](./persistence-strategies.md). Chấp nhận cho view count; không chấp nhận cho số dư ví.

### 12.4 Distributed rate-limit token

```bash
# Mỗi API key có 100 request/phút
INCR rl:api:abc:202607071230
EXPIRE rl:api:abc:202607071230 70 NX
```

Nếu kết quả `INCR` > 100 → reject. Muốn sliding window/token bucket chính xác hơn, xem [Rate Limiting](./rate-limiting.md).

### 12.5 Feature flag kill-switch

```bash
SET flag:checkout:v2 "off"
GET flag:checkout:v2
```

Value nhỏ, đọc rất nhiều, cập nhật ít: String là lựa chọn tối giản. App nên cache local 1–5 giây để tránh biến Redis thành config hot spot.

### 12.6 Session token → uid

```bash
SET sess:7f9a "uid:42" EX 1800
GET sess:7f9a
GETEX sess:7f9a EX 1800   # sliding session: đọc và gia hạn atomic
```

`GETEX` tránh race “GET xong app chết trước EXPIRE”.

---

## 13. Anti-patterns cần tránh

### 13.1 SET làm mất TTL

```bash
# ❌ Sai
SET cache:user:42 "v1" EX 300
SET cache:user:42 "v2"

# ✅ Đúng
SET cache:user:42 "v2" KEEPTTL
# hoặc set TTL mới rõ ràng
SET cache:user:42 "v2" EX 300
```

### 13.2 Huge JSON blob trong khi Hash phù hợp hơn

```bash
# ❌ Sai: update email phải rewrite cả 200KB profile
SET user:42 '{"name":"An", "email":"a@x", "prefs":{...}}'

# ✅ Đúng nếu hay đọc/ghi từng field
HSET user:42 name "An" email "a@x"
HGET user:42 email
```

Xem [Hashes](./hashes.md).

### 13.3 KEYS trong production

```bash
# ❌ Sai: block Redis khi keyspace lớn
KEYS cache:user:*

# ✅ Đúng: scan incremental
SCAN 0 MATCH cache:user:* COUNT 1000
```

### 13.4 Unbounded APPEND

```bash
# ❌ Sai: log vô hạn trong một String
APPEND log:payment "..."

# ✅ Đúng: dùng List/Stream hoặc rotate key theo ngày
RPUSH log:payment:2026-07-07 "..."
EXPIRE log:payment:2026-07-07 604800
```

Nếu dùng List, xem [Lists](./lists.md).

### 13.5 Counter lưu dạng JSON/string phải parse ở client

```bash
# ❌ Sai
GET stats:video:777      # {"views":123}
SET stats:video:777      # parse + rewrite + race

# ✅ Đúng
INCR views:video:777
```

### 13.6 Giant MGET

```bash
# ❌ Sai: một reply khổng lồ làm nghẽn event loop/socket
MGET $(cat 50000_keys.txt)

# ✅ Đúng: batch vừa phải hoặc pipeline có backpressure
MGET key1 ... key500
```

### 13.7 Cache không TTL

```bash
# ❌ Sai
SET cache:product:42 "..."

# ✅ Đúng
SET cache:product:42 "..." EX 600
```

Không TTL làm eviction khó dự đoán; đọc [Eviction Policies](./eviction-policies.md).

---

## 14. Chọn String hay Hash/List/Bitmap?

| Nhu cầu | Chọn | Vì sao | Link |
|---------|------|--------|------|
| Value nhỏ, đọc/ghi nguyên khối | String | đơn giản, O(1), TTL dễ | — |
| Object nhiều field, update từng field | Hash | tránh rewrite blob, field-level ops | [Hashes](./hashes.md) |
| Queue/log ordered append/pop | List/Stream | thao tác đầu/cuối, consumer | [Lists](./lists.md) |
| Boolean theo user id dense | Bitmap trong String | 1 bit/user | [Bitmaps & HyperLogLog](./bitmaps-hyperloglog.md) |
| Approx distinct count | HyperLogLog | memory cố định nhỏ | [Bitmaps & HyperLogLog](./bitmaps-hyperloglog.md) |
| Cache có nguy cơ eviction | String + TTL | phối hợp policy | [Eviction Policies](./eviction-policies.md) |

```diagram
Bạn có dữ liệu gì?
├─ Một scalar/token/counter/blob nhỏ? ─────▶ String
├─ Object nhiều field, update từng field? ─▶ Hash
├─ Danh sách/queue? ──────────────────────▶ List/Stream
├─ Cờ true/false theo id? ────────────────▶ Bitmap
└─ Đếm unique xấp xỉ? ────────────────────▶ HyperLogLog
```

---

## 15. Best Practices

- Đặt tên key có cấu trúc: `object:id:field` (`user:42:profile`) để dễ debug/SCAN.
- Luôn có TTL cho cache; key không TTL chỉ dành cho dữ liệu chủ đích lưu lâu.
- Tránh big value: >100KB nên cân nhắc nén/tách; >1MB hot key là tín hiệu nguy hiểm.
- Dùng `MGET`/`MSET`/pipeline thay vì loop tuần tự — xem [Pipelining & Batching](./pipelining-batching.md).
- Dùng `GETDEL`, `GETEX`, `SET ... GET` khi cần read-modify-write atomic.
- Theo dõi `MEMORY USAGE`, `--bigkeys`, slowlog, network throughput; String chậm thường do size/traffic chứ không do lookup.

---

## 16. Tóm tắt / Cheat sheet

```diagram
┌──────────────────── Redis String cheat sheet ─────────────────────┐
│ Small scalar/token/counter  → int/embstr, rất rẻ                  │
│ JSON/HTML blob              → OK nếu nhỏ, có TTL, không hot quá   │
│ Counter                     → INCR/INCRBY, đừng GET+SET           │
│ Lock/idempotency            → SET NX PX/EX + token                │
│ Refresh cache               → nhớ KEEPTTL hoặc EX mới             │
│ Many keys                   → MGET/pipeline, batch vừa phải       │
│ Huge value                  → tách/nén/chọn data structure khác   │
└───────────────────────────────────────────────────────────────────┘
```

3 nguyên tắc nhớ lâu:

1. **Atomic phải ở server**: `INCR`, `SET NX EX`, `GETEX`, `GETDEL` tốt hơn check-then-act ở client.
2. **O(1) không có nghĩa là miễn phí theo byte**: value 8MB vẫn phải copy 8MB qua event loop và network.
3. **TTL là thiết kế, không phải trang trí**: cache không TTL và `SET` mất TTL là hai nguồn memory leak phổ biến.

Nếu quay lại sự cố đầu bài, fix không phải “mua Redis lớn hơn” trước tiên. Fix là chia payload 8.7MB, đặt TTL đúng, batch hợp lý, và chọn Hash/Bitmap/List khi String không còn là hình dạng tự nhiên của dữ liệu. **String là con dao sắc; dùng đúng, nó cắt latency từ 80ms xuống 0.2ms — dùng sai, nó cắt luôn p99 của bạn.**

---

## Tài liệu tham khảo

- [Redis Strings](https://redis.io/docs/latest/develop/data-types/strings/)
- [SET command đầy đủ options](https://redis.io/docs/latest/commands/set/)
- [OBJECT ENCODING](https://redis.io/docs/latest/commands/object-encoding/)
- [APPEND command](https://redis.io/docs/latest/commands/append/)
- [Hashes](./hashes.md) — khi value là object nhiều field
- [Lists](./lists.md) — data structure tiếp theo
- [Memory Management](./memory-management.md) — key/value overhead, allocator, big keys
