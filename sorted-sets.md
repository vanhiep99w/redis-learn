# Sorted Sets

## Mục lục

- [Tổng quan](#tổng-quan)
- [Use Cases phổ biến](#use-cases-phổ-biến)
- [1. Bên trong: skiplist + dict](#1-bên-trong-skiplist--dict)
- [2. Command chính & độ phức tạp](#2-command-chính--độ-phức-tạp)
- [3. Score, tie-breaking và range queries](#3-score-tie-breaking-và-range-queries)
- [4. Leaderboard hoạt động thế nào](#4-leaderboard-hoạt-động-thế-nào)
- [5. Patterns: delayed queue, sliding window, time-index](#5-patterns-delayed-queue-sliding-window-time-index)
- [6. Case study thực tế](#6-case-study-thực-tế)
- [7. Best Practices](#7-best-practices)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## Tổng quan

Sorted Set (ZSet) = Set (member unique) + mỗi member gắn một **score kiểu double**, luôn được giữ **sắp xếp theo score**. Đây là data structure "đắt giá" nhất của Redis: vừa lookup member O(1), vừa truy vấn theo thứ hạng/khoảng score O(log N).

```
leaderboard
score:   150      420       990       1200
member:  "dave"   "carol"   "bob"     "alice"
          ▲ ZRANGEBYSCORE / ZRANGE / ZRANK hoạt động trên trục này
```

---

## Use Cases phổ biến

| Use Case | Score là gì |
|----------|-------------|
| **Leaderboard** | Điểm số — xem [Leaderboard & Counting](./leaderboard-counting.md) |
| **Delayed / scheduled job queue** | Timestamp lúc job đến hạn |
| **Rate limiting (sliding window)** | Timestamp mỗi request — xem [Rate Limiting](./rate-limiting.md) |
| **Feed sắp theo thời gian** | Timestamp bài đăng |
| **Priority queue** | Độ ưu tiên |
| **Autocomplete** | Score = 0, khai thác thứ tự lexicographic (mục 3.3) |
| **"Member có TTL"** | Score = expire time, dọn bằng ZREMRANGEBYSCORE |

---

## 1. Bên trong: skiplist + dict

### 1.1 Vì sao cần HAI cấu trúc cùng lúc

ZSet lớn được lưu bằng **hai cấu trúc trỏ chung dữ liệu**:

```
dict:      member ──▶ score          → ZSCORE O(1)
skiplist:  sắp theo (score, member)  → ZRANGE / ZRANK O(log N)
```

Một mình dict không trả lời được "top 10", một mình skiplist tra score của member phải O(N). Kết hợp cả hai — trả giá bằng memory (mỗi member có mặt ở cả 2 nơi, nhưng string chỉ lưu 1 bản, share con trỏ).

### 1.2 Skiplist hoạt động thế nào

Skiplist = linked list sắp xếp + nhiều **tầng "đường tắt"** xếp chồng:

```
L3: head ──────────────────────▶ 990 ─────────▶ NULL
L2: head ─────────▶ 420 ───────▶ 990 ─────────▶ NULL
L1: head ─▶ 150 ──▶ 420 ───────▶ 990 ─▶ 1200 ─▶ NULL   ← đủ mọi node
```

- Tìm kiếm bắt đầu từ tầng cao nhất, đi ngang tới khi vượt quá target thì **rơi xuống một tầng** → bỏ qua được phần lớn node → O(log N) kỳ vọng
- Node mới được gán số tầng **ngẫu nhiên** (xác suất 25% lên mỗi tầng, tối đa 32) — không cần re-balance như cây đỏ-đen
- Mỗi node còn lưu **span** (số node mà con trỏ nhảy qua) → tính rank bằng cách cộng dồn span trên đường tìm kiếm → `ZRANK` cũng O(log N), không phải đếm từng node

Vì sao Redis chọn skiplist thay vì balanced tree: cài đặt đơn giản hơn, range query tự nhiên (đi ngang tầng 1), và hiệu năng tương đương.

### 1.3 Encoding nhỏ: listpack

| Encoding | Điều kiện |
|----------|-----------|
| `listpack` | ≤ `zset-max-listpack-entries` (128) và mỗi member ≤ `zset-max-listpack-value` (64 bytes) |
| `skiplist` (kèm dict) | vượt ngưỡng |

Với listpack, member và score lưu xen kẽ trong một khối liên tục, mọi thao tác O(N) — nhưng N ≤ 128 nên vẫn nhanh và tiết kiệm memory hơn hẳn.

---

## 2. Command chính & độ phức tạp

| Command | Complexity | Ghi chú |
|---------|-----------|---------|
| `ZADD key score member` | O(log N) | option `NX/XX/GT/LT/CH/INCR` |
| `ZSCORE key member` | O(1) | qua dict |
| `ZINCRBY key delta member` | O(log N) | atomic — lõi của leaderboard |
| `ZRANK` / `ZREVRANK` | O(log N) | nhờ span; `WITHSCORE` từ 7.2 |
| `ZRANGE key start stop [REV]` | O(log N + M) | theo rank; `BYSCORE`/`BYLEX` gộp từ 6.2 |
| `ZRANGEBYSCORE key min max` | O(log N + M) | `(` = exclusive, `-inf`/`+inf` |
| `ZCOUNT key min max` | O(log N) | đếm trong khoảng score |
| `ZCARD` | O(1) | |
| `ZREM key member` | O(log N) | |
| `ZREMRANGEBYSCORE` / `BYRANK` | O(log N + M) | dọn hàng loạt |
| `ZPOPMIN` / `ZPOPMAX` / `BZPOPMIN` | O(log N) | ZSet như priority queue, có bản blocking |
| `ZRANGESTORE` | O(log N + M) | lưu kết quả range thành key mới |
| `ZUNIONSTORE` / `ZINTERSTORE` | O(N)+ | gộp nhiều ZSet, `WEIGHTS`/`AGGREGATE SUM\|MIN\|MAX` |

M = số phần tử trả về. `ZRANGE key 0 -1` vẫn là O(N) — cẩn thận như mọi lệnh "lấy tất cả".

---

## 3. Score, tie-breaking và range queries

### 3.1 Score là double — có bẫy

Score là IEEE-754 double: số nguyên chỉ chính xác đến **2⁵³**. Dùng timestamp micro giây × id lớn có thể mất chính xác. Cần 64-bit id đầy đủ → lưu id trong member, không nhét vào score.

### 3.2 Tie-breaking

Hai member cùng score → sắp theo **thứ tự lexicographic của member**. Muốn tie-break theo thời gian (ai đạt trước xếp trên), pack thêm vào score:

```
score = points * 10^10 + (10^10 - timestamp)
       # cùng points → timestamp nhỏ hơn (sớm hơn) có score lớn hơn
```

### 3.3 Lexicographic range — ZRANGEBYLEX

Khi **mọi member cùng score** (thường là 0), ZSet trở thành index chuỗi có thứ tự:

```bash
ZADD autocomplete 0 "ha noi" 0 "hai phong" 0 "ho chi minh"
ZRANGEBYLEX autocomplete "[ha" "[ha\xff"     # → mọi entry bắt đầu bằng "ha"
```

`[` = inclusive, `(` = exclusive, `-`/`+` = vô cực. Đây là cách làm autocomplete/prefix search thuần Redis.

---

## 4. Leaderboard hoạt động thế nào

```bash
ZINCRBY lb:2026-07 25 player:42        # cộng điểm — atomic, O(log N)
ZREVRANK lb:2026-07 player:42          # hạng (0-based, cao nhất = 0)
ZSCORE lb:2026-07 player:42            # điểm hiện tại
ZRANGE lb:2026-07 0 9 REV WITHSCORES   # top 10

# "Hiển thị quanh tôi" (±2 hạng):
rank = ZREVRANK lb:2026-07 player:42
ZRANGE lb:2026-07 (rank-2) (rank+2) REV WITHSCORES
```

Vì sao nhanh hơn RDBMS: `SELECT ... ORDER BY score DESC LIMIT 10` phải sort hoặc duy trì index B-tree + `COUNT(*) WHERE score > x` để tính rank là full scan; ZSet duy trì thứ tự **ngay khi ghi**, rank có sẵn nhờ span. 1 triệu player: ZINCRBY ~log₂(10⁶) ≈ 20 bước.

Leaderboard theo kỳ (tuần/tháng): mỗi kỳ một key + `EXPIRE`; bảng tổng = `ZUNIONSTORE` các kỳ. Chi tiết: [Leaderboard & Counting](./leaderboard-counting.md).

---

## 5. Patterns: delayed queue, sliding window, time-index

### 5.1 Delayed job queue

```bash
# Producer: hẹn job chạy lúc T
ZADD delayed:jobs 1783400000 "job:341"

# Worker poll:
ZRANGEBYSCORE delayed:jobs -inf <now> LIMIT 0 10   # job đã đến hạn
ZREM delayed:jobs "job:341"                         # claim
```

Race giữa nhiều worker (2 worker cùng lấy 1 job): dùng `ZPOPMIN` (atomic lấy + xóa job sớm nhất) rồi kiểm tra score ≤ now, hoặc gói ZRANGEBYSCORE+ZREM vào [Lua script](./lua-scripting.md).

### 5.2 Sliding window rate limit

```bash
# Mỗi request: ghi timestamp, dọn window cũ, đếm — trong MULTI/pipeline
ZADD rl:user42 <now_ms> <now_ms>:<rand>
ZREMRANGEBYSCORE rl:user42 -inf <now_ms - 60000>
ZCARD rl:user42                        # > limit → chặn
EXPIRE rl:user42 61
```

Chính xác hơn fixed-window INCR (không bị burst ở biên cửa sổ) — so sánh đầy đủ tại [Rate Limiting](./rate-limiting.md).

### 5.3 Index theo thời gian

```bash
ZADD user:42:orders <created_at> order:9911
ZRANGEBYSCORE user:42:orders <7_days_ago> +inf     # đơn 7 ngày gần nhất
ZREMRANGEBYSCORE user:42:orders -inf <90_days_ago> # dọn dữ liệu cũ
```

Đây cũng là cách mô phỏng "member có TTL" mà [Set](./sets.md) không làm được.

---

## 6. Case study thực tế

### 6.1 Leaderboard game mobile — hàng chục triệu người chơi

Bài toán: leaderboard mùa giải (reset mỗi tháng), 30 triệu người chơi, mỗi trận cộng điểm; cần rank của tôi + top 100 + "những người quanh tôi".

```bash
# Kết thúc trận:
ZINCRBY lb:s27 35 player:88420

# Ba màn hình chính, mỗi màn 1-2 lệnh:
ZREVRANGE lb:s27 0 99 WITHSCORES              # top 100
ZREVRANK  lb:s27 player:88420                 # rank của tôi — O(log N)
rank = ZREVRANK(...); ZREVRANGE lb:s27 rank-5 rank+5 WITHSCORES   # quanh tôi
```

Quyết định thiết kế:
- **Key theo mùa** (`lb:s27`) — reset = tạo key mới, key cũ giữ làm lịch sử rồi EXPIRE 90 ngày; không bao giờ phải DEL 30 triệu member
- **Tie-breaking công bằng**: score = điểm thật × 2³⁰ + (2³⁰ − timestampđạtđược) — cùng điểm thì ai đạt trước xếp trên, thay vì thứ tự alphabet mặc định
- ZSet 30 triệu member ≈ 3-4GB — một key không shard được trong [Cluster](./cluster.md); nếu vượt, chia leaderboard theo region/league (vốn cũng là yêu cầu sản phẩm)
- Đây là kiến trúc leaderboard của hầu hết game studio dùng Redis; DB chỉ lưu snapshot cuối mùa để trao thưởng

### 6.2 Delayed job scheduler — nhắc hẹn & retry

Bài toán: "gửi push sau 30 phút", "retry webhook sau 1/5/25 phút" — hàng triệu job hẹn giờ, không dùng cron per-job được.

```bash
# Score = timestamp đến hạn:
ZADD delayed 1783401800 '{"type":"push","uid":42}'

# Poller mỗi giây — lấy-và-xóa atomic (7.0+), không lo 2 poller lấy trùng:
ZMPOP 1 delayed MIN COUNT 100
# kiểm tra score ≤ now thì xử lý; phần tử chưa đến hạn → ZADD trả lại
# (hoặc chuẩn hơn: Lua script ZRANGEBYSCORE 0 now + ZREM trong 1 script)
```

Đây chính là cơ chế delayed job của Sidekiq/Bull: List làm queue chính, **ZSet làm phòng chờ theo thời gian**, poller chuyển job đến hạn từ ZSet sang List. Retry backoff = ZADD lại với score lùi xa dần.

### 6.3 Sliding-window rate limiter — API gateway

Bài toán: 100 request/60s **trượt thật** (không phải cửa sổ nhảy của INCR+EXPIRE vốn cho phép burst 200 quanh ranh giới phút).

```bash
# Mỗi request — gói trong MULTI hoặc Lua:
ZREMRANGEBYSCORE rl:user:42 0 (now-60000)     # dọn request ra khỏi cửa sổ
ZADD rl:user:42 now-ms req-uuid
ZCARD rl:user:42                              # > 100 → 429
EXPIRE rl:user:42 61
```

Trade-off so với INCR cửa sổ cố định: chính xác hơn nhưng tốn memory O(limit)/user và 4 lệnh/request — gateway lớn thường dùng INCR cho tầng thô + ZSet cho endpoint nhạy cảm (login, OTP). So sánh đầy đủ các thuật toán tại [Rate Limiting](./rate-limiting.md).

---

## 7. Best Practices

- **Member nhỏ, dữ liệu lớn để chỗ khác**: ZSet lưu `order:9911` (id), body đơn hàng nằm ở [Hash](./hashes.md)/String — member xuất hiện trong cả dict lẫn skiplist nên member dài tốn gấp đôi
- **Dọn định kỳ bằng `ZREMRANGEBYSCORE`/`BYRANK`** — ZSet time-index chỉ ghi không dọn là memory leak
- **Cẩn thận độ chính xác double** với score > 2⁵³
- **`ZADD GT/LT`** để "chỉ cập nhật nếu điểm cao hơn/thấp hơn" — atomic, khỏi cần đọc-so-ghi
- **Multi-step phải atomic** (đọc rank rồi range, ZRANGEBYSCORE rồi ZREM) → [MULTI/EXEC](./transactions.md) hoặc [Lua](./lua-scripting.md)
- **Cluster**: `ZUNIONSTORE`/`ZINTERSTORE` yêu cầu các key cùng hash slot — dùng hash tag `{lb}:...`

---

## Tài liệu tham khảo

- [Redis Sorted Sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/)
- [Skip Lists: A Probabilistic Alternative to Balanced Trees (Pugh)](https://15721.courses.cs.cmu.edu/spring2018/papers/08-oltpindexes1/pugh-skiplists-cacm1990.pdf)
- [Hashes](./hashes.md) — data structure tiếp theo
- [Leaderboard & Counting](./leaderboard-counting.md) — pattern chuyên sâu
