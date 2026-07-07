# Sets

## Mục lục

- [Tổng quan](#tổng-quan)
- [Use Cases phổ biến](#use-cases-phổ-biến)
- [1. Bên trong: intset, listpack, hashtable](#1-bên-trong-intset-listpack-hashtable)
- [2. Command chính & độ phức tạp](#2-command-chính--độ-phức-tạp)
- [3. Set algebra — UNION / INTER / DIFF hoạt động thế nào](#3-set-algebra--union--inter--diff-hoạt-động-thế-nào)
- [4. Random members — SRANDMEMBER & SPOP](#4-random-members--srandmember--spop)
- [5. Patterns thực tế](#5-patterns-thực-tế)
- [6. Case study thực tế](#6-case-study-thực-tế)
- [7. Best Practices](#7-best-practices)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## Tổng quan

Set là **tập hợp không thứ tự các string duy nhất** — thêm trùng sẽ bị bỏ qua (idempotent). Sức mạnh của Set nằm ở hai điểm: kiểm tra membership O(1) và **phép toán tập hợp chạy ngay trên server** (union, intersection, difference).

```
tags:post:1 = { "redis", "cache", "db" }
                    │
   SISMEMBER O(1)   │   SINTER tags:post:1 tags:post:2  → tag chung
   SADD idempotent  │   SUNION ... → gộp, tự khử trùng
```

---

## Use Cases phổ biến

| Use Case | Vì sao Set |
|----------|-----------|
| **Tag / label** | Phần tử unique, tìm giao giữa các tag bằng SINTER |
| **Unique visitor theo ngày** | SADD idempotent — cùng user tính 1 lần |
| **Quan hệ follow / friend** | SINTER tìm bạn chung, SDIFF gợi ý follow |
| **Whitelist / blacklist** | SISMEMBER O(1) trong request path |
| **Lottery / random sampling** | SPOP, SRANDMEMBER |
| **Job đã xử lý (dedup)** | SADD trả 0 nếu đã tồn tại → skip |

Nếu cần đếm unique với hàng trăm triệu phần tử mà chấp nhận sai số ~0.8% → [HyperLogLog](./bitmaps-hyperloglog.md) chỉ tốn 12KB.

---

## 1. Bên trong: intset, listpack, hashtable

Set có **3 encoding**, Redis tự nâng cấp khi dữ liệu thay đổi:

| Encoding | Điều kiện | Cấu trúc |
|----------|-----------|----------|
| `intset` | Tất cả phần tử là số nguyên, ≤ `set-max-intset-entries` (512) | Mảng số nguyên **sorted**, lookup bằng binary search O(log N) |
| `listpack` | Có phần tử không phải số, ít phần tử & ngắn (Redis 7.2+) | Khối memory liên tục, scan tuyến tính |
| `hashtable` | Vượt ngưỡng | dict với value = NULL, lookup O(1) |

```bash
set-max-intset-entries 512
set-max-listpack-entries 128
set-max-listpack-value 64      # độ dài tối đa mỗi phần tử để giữ listpack
```

Chi tiết đáng chú ý về `intset`:

- Mảng **sorted, không con trỏ** → memory tối thiểu (set 512 số int64 ≈ 4KB thay vì ~30KB hashtable)
- Có cơ chế **upgrade encoding nội bộ**: bắt đầu lưu int16, gặp số lớn hơn thì nâng cả mảng lên int32/int64 — không bao giờ downgrade
- Insert là O(N) (phải dịch mảng giữ sorted) — chấp nhận được vì N ≤ 512

```
127.0.0.1:6379> SADD nums 1 2 3         → OBJECT ENCODING nums  → "intset"
127.0.0.1:6379> SADD nums "abc"         → OBJECT ENCODING nums  → "listpack"
# thêm > 128 phần tử hoặc phần tử > 64 bytes → "hashtable"
```

Một khi đã lên `hashtable` thì **không quay lại** encoding nhỏ kể cả khi SREM bớt phần tử.

---

## 2. Command chính & độ phức tạp

| Command | Complexity | Ghi chú |
|---------|-----------|---------|
| `SADD key m1 m2 ...` | O(1)/phần tử | trả về số phần tử **mới** thêm được |
| `SREM key m` | O(1) | |
| `SISMEMBER key m` | O(1) | |
| `SMISMEMBER key m1 m2` | O(N) | check nhiều member 1 round-trip (Redis 6.2+) |
| `SCARD key` | O(1) | size lưu sẵn |
| `SMEMBERS key` | O(N) | **trả toàn bộ** — nguy hiểm với set lớn |
| `SSCAN key cursor` | O(1)/lần gọi | duyệt an toàn — cùng cơ chế cursor với SCAN |
| `SPOP key [count]` | O(1) | lấy ngẫu nhiên **và xóa** |
| `SRANDMEMBER key [count]` | O(N) worst | lấy ngẫu nhiên, **không xóa** |
| `SMOVE src dst m` | O(1) | atomic giữa 2 set |
| `SINTER` / `SUNION` / `SDIFF` | mục 3 | |
| `SINTERCARD numkeys k1 k2 [LIMIT n]` | như SINTER | chỉ đếm, không trả phần tử (Redis 7+) |

> [!IMPORTANT]
> `SMEMBERS` trên set 1 triệu phần tử = block event loop + đẩy vài chục MB vào output buffer. Với set lớn, luôn dùng `SSCAN`.

---

## 3. Set algebra — UNION / INTER / DIFF hoạt động thế nào

```bash
SADD skill:redis  alice bob carol
SADD skill:java   bob carol dave

SINTER skill:redis skill:java        → bob, carol      (giao)
SUNION skill:redis skill:java        → cả 4 người      (hợp)
SDIFF  skill:redis skill:java        → alice           (có redis, không java)

# Biến thể *STORE: lưu kết quả thành key mới thay vì trả về client
SINTERSTORE both:redis-java 2 skill:redis skill:java
```

Độ phức tạp — quan trọng khi set lớn:

| Phép | Complexity | Cách server thực hiện |
|------|-----------|----------------------|
| `SINTER` | O(N×M) — N = size set **nhỏ nhất**, M = số set | Sort các set theo size, duyệt set nhỏ nhất, check membership từng phần tử trong các set còn lại — vì vậy giao của set 100 phần tử với set 10 triệu phần tử vẫn nhanh |
| `SUNION` | O(N) — N = **tổng** phần tử | Duyệt hết tất cả |
| `SDIFF` | O(N) — N = tổng phần tử | Duyệt set đầu, loại phần tử có trong các set sau |

Hai điểm thực chiến:

1. **Kết quả có thể rất lớn** — `SUNION` 10 set × 1 triệu phần tử tạo reply khổng lồ. Dùng `*STORE` + `SSCAN` kết quả, hoặc `SINTERCARD` nếu chỉ cần đếm
2. **Cluster**: các key trong một phép set phải nằm **cùng hash slot** — dùng hash tag `{user}:a`, `{user}:b` — xem [Redis Cluster](./cluster.md)

---

## 4. Random members — SRANDMEMBER & SPOP

Hai lệnh này khác nhau ở chỗ có xóa hay không, và hành vi `count`:

```bash
SRANDMEMBER wheel 3     # 3 phần tử KHÁC nhau (count dương — không lặp)
SRANDMEMBER wheel -5    # 5 lần rút CÓ lặp (count âm)
SPOP lottery 2          # rút 2 và XÓA khỏi set — mỗi vé chỉ trúng 1 lần
```

Vì sao "random" được O(1): với encoding hashtable, Redis chọn **bucket ngẫu nhiên** rồi lấy phần tử trong đó. Hệ quả: phân bố chỉ *xấp xỉ* đều (bucket ít phần tử có xác suất nhỉnh hơn) — đủ tốt cho lottery/sampling, không dùng làm nguồn random mật mã.

---

## 5. Patterns thực tế

### 5.1 Dedup job / event

```bash
# Worker nhận event, chỉ xử lý nếu chưa từng thấy:
SADD processed:2026-07-07 evt:8812     # → 1 = mới, 0 = đã xử lý → skip
EXPIRE processed:2026-07-07 172800 NX
```

Atomic nhờ single-thread: hai worker cùng SADD một event thì chỉ đúng một worker nhận `1`.

### 5.2 Bạn chung / gợi ý kết bạn

```bash
SINTER follow:alice follow:bob            # bạn chung
SDIFF  follow:bob   follow:alice          # bob follow mà alice chưa → gợi ý
```

### 5.3 Filter đa điều kiện (faceted search thô)

```bash
SADD color:red   p1 p2 p5
SADD size:M      p2 p5 p9
SADD brand:nike  p5 p9

SINTER color:red size:M brand:nike        # → p5 (sản phẩm thỏa cả 3)
```

Cần filter phức tạp hơn (range, full-text) → [RediSearch](./redis-modules.md).

### 5.4 Online users

```bash
SADD online:now user:42                    # khi heartbeat
SREM online:now user:42                    # khi disconnect
SCARD online:now                           # đếm đang online
SISMEMBER online:now user:7                # user cụ thể có online?
```

---

## 6. Case study thực tế

### 6.1 Hệ thống follow — mạng xã hội quy mô vừa

Bài toán: 5 triệu user, trung bình 200 follow/người; cần "A có follow B?" trong request path (render nút Follow), bạn chung, gợi ý.

```bash
# Hai chiều — ghi cặp đôi trong MULTI để nhất quán:
MULTI
SADD following:alice bob
SADD followers:bob alice
EXEC

SISMEMBER following:alice bob          # nút Follow/Following — O(1), ~0.1ms
SCARD followers:bob                    # đếm follower hiển thị profile
SINTER following:alice following:carol # follow chung
SDIFF  following:carol following:alice # carol follow mà alice chưa → gợi ý
```

Điểm đau thực tế — **celebrity problem**: `followers:famous` có 10 triệu member là big key (SMEMBERS chết, migrate slot chậm, fan-out đắt). Hướng xử lý: đếm bằng `SCARD` (không bao giờ liệt kê toàn bộ), liệt kê phân trang bằng `SSCAN`, và cân nhắc chuyển danh sách follower của celebrity về DB — Redis chỉ giữ quan hệ chiều `following:` (bị chặn trên ~5K).

### 6.2 Dedup consumer — pipeline xử lý webhook

Bài toán: đối tác gửi webhook **at-least-once** (có retry) → cùng event ID đến 2–3 lần; xử lý trùng gây ghi sổ kép.

```bash
# Đầu handler — một lệnh quyết định tất cả:
SADD seen:webhook:2026-07-07 evt_8Kj2m
# → 1: lần đầu → xử lý
# → 0: đã thấy → trả 200 OK ngay, không xử lý
EXPIRE seen:webhook:2026-07-07 259200 NX     # giữ 3 ngày (> cửa sổ retry của đối tác)
```

Vì sao không dùng DB unique constraint? Được, nhưng check Redis ~0.1ms chặn được 99% bản trùng trước khi chạm DB; constraint vẫn giữ làm lưới cuối (Redis restart mất vài giây dữ liệu seen → vài bản trùng lọt xuống, constraint bắt nốt). Hai lớp — Redis cho tốc độ, DB cho đảm bảo.

Key theo ngày thay vì một set vĩnh viễn: memory bounded và khớp cửa sổ retry — set "seen" vĩnh viễn là memory leak.

### 6.3 Feature flag rollout theo tập user

Bài toán: bật tính năng mới cho beta tester + 5% user, tắt/bật tức thì không deploy.

```bash
SADD ff:new-checkout:users 42 88 1024        # beta tester chỉ định
SISMEMBER ff:new-checkout:users $uid         # check mỗi request — O(1)

# 5% ngẫu nhiên bền vững: không cần set — hash(uid) % 100 < 5 phía app;
# Set dành cho danh sách chỉ định đích danh + override (blacklist khỏi experiment):
SADD ff:new-checkout:excluded 555
```

Dùng kèm local cache 5–30s phía app (flag đổi không cần hiệu lực từng mili giây) — giảm 99% lượt gọi Redis; mẫu hoàn chỉnh với invalidation tại [Client-side Caching](./client-side-caching.md).

---

## 7. Best Practices

- **SSCAN thay cho SMEMBERS** với set không rõ size — mặc định coi set production là lớn
- **Tận dụng return value của SADD** (số phần tử mới) để làm dedup check — không cần SISMEMBER trước (2 round-trip + race)
- **Set toàn số nguyên rất rẻ** (intset) — thiết kế member là numeric id thay vì string dài khi có thể
- **`SINTERCARD` với `LIMIT`** khi chỉ cần biết "có ít nhất K phần tử chung không" — dừng sớm, không tính hết
- **Kết quả set-op lớn → `*STORE`** rồi đọc dần, kèm `EXPIRE` cho key kết quả
- **Set không có TTL per-member** — muốn "member tự hết hạn" thì dùng [Sorted Set](./sorted-sets.md) với score = timestamp rồi dọn bằng `ZREMRANGEBYSCORE`

---

## Tài liệu tham khảo

- [Redis Sets](https://redis.io/docs/latest/develop/data-types/sets/)
- [SINTERCARD](https://redis.io/docs/latest/commands/sintercard/)
- [Sorted Sets](./sorted-sets.md) — khi cần thứ tự và score
- [Bitmaps & HyperLogLog](./bitmaps-hyperloglog.md) — đếm unique tiết kiệm memory
