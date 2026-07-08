# Sorted Sets

## Mục lục

- [1. Bài toán xếp hạng và ý tưởng cốt lõi của Sorted Set](#1-bài-toán-xếp-hạng-và-ý-tưởng-cốt-lõi-của-sorted-set)
- [2. Sorted Set là gì — Set + score + thứ tự luôn sẵn sàng](#2-sorted-set-là-gì--set--score--thứ-tự-luôn-sẵn-sàng)
- [3. Bên trong Redis: dict + skiplist, đổi memory lấy tốc độ](#3-bên-trong-redis-dict--skiplist-đổi-memory-lấy-tốc-độ)
- [4. Skiplist deep dive — tầng ngẫu nhiên, span và ZRANK O(log N)](#4-skiplist-deep-dive--tầng-ngẫu-nhiên-span-và-zrank-olog-n)
- [5. Encoding nhỏ: listpack và ngưỡng chuyển đổi](#5-encoding-nhỏ-listpack-và-ngưỡng-chuyển-đổi)
- [6. Score, tie-breaking và lexicographic range](#6-score-tie-breaking-và-lexicographic-range)
- [7. Command catalog & độ phức tạp](#7-command-catalog--độ-phức-tạp)
- [8. Performance profile — nhanh ở đâu, đắt ở đâu](#8-performance-profile--nhanh-ở-đâu-đắt-ở-đâu)
- [9. Sorted Set vs Set vs List vs Stream](#9-sorted-set-vs-set-vs-list-vs-stream)
- [10. Pattern deep dive](#10-pattern-deep-dive)
- [11. Case study thực tế](#11-case-study-thực-tế)
- [12. Anti-patterns cần tránh](#12-anti-patterns-cần-tránh)
- [13. Best Practices](#13-best-practices)
- [14. Tóm tắt — cheat-sheet & 3 nguyên tắc](#14-tóm-tắt--cheat-sheet--3-nguyên-tắc)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## 1. Bài toán xếp hạng và ý tưởng cốt lõi của Sorted Set

Bảng xếp hạng game, feed ưu tiên theo điểm, hàng đợi theo thời gian đến hạn, top sản phẩm bán chạy — rất nhiều tính năng quy về cùng một nhu cầu: **giữ một tập phần tử luôn được sắp xếp theo một con số, rồi truy vấn theo thứ hạng hoặc theo khoảng giá trị**.

Làm việc này bằng database truyền thống thì tốn kém một cách âm thầm. Câu hỏi tưởng đơn giản "hạng của tôi là bao nhiêu?" thường biến thành một phép đếm:

```sql
SELECT COUNT(*) + 1 FROM players WHERE score > 987654;
```

Với hàng triệu dòng, kể cả có index, đây vẫn là quét một khoảng lớn — lặp lại mỗi lần refresh màn hình.

Sorted Set (ZSet) giải quyết bằng một ý tưởng ngược với trực giác: **đừng sort lúc đọc, mà duy trì thứ tự ngay lúc ghi**. Mỗi member gắn với một `score` kiểu số, và Redis luôn giữ chúng theo đúng thứ tự. Nhờ vậy, đọc top N, tính rank, hay lấy một khoảng điểm đều rất nhẹ:

```bash
ZINCRBY lb:s27 35 player:88420       # cộng điểm, atomic
ZREVRANK lb:s27 player:88420         # hạng (giảm dần), O(log N)
ZRANGE lb:s27 0 99 REV WITHSCORES    # top 100
```

Ở đây, `O(log N)` là độ phức tạp tăng chậm theo logarit của số phần tử N (xem thêm [tổng quan Redis](./redis-overview.md)). Cái giá phải trả là mỗi lần ghi tốn O(log N) thay vì O(1) — đổi lại ta không bao giờ phải sort lại khi đọc. Doc này sẽ giải thích Redis làm được điều đó bằng cách nào: vì sao `ZSCORE` là O(1) nhưng `ZRANK` là O(log N), tại sao cùng là "range" mà `ZRANGE 0 9` rất nhẹ còn `ZRANGE 0 -1` có thể làm nghẽn server — rồi đi qua các pattern kinh điển: leaderboard, delayed queue, sliding-window rate limit và autocomplete.

---

## 2. Sorted Set là gì — Set + score + thứ tự luôn sẵn sàng

Sorted Set (ZSet) là collection gồm **member unique** giống [Set](./sets.md), nhưng mỗi member có thêm một **score kiểu double**. Redis luôn sắp xếp theo cặp `(score, member)`:

```diagram
key: leaderboard

score thấp                                                score cao
   150              420              990              1200
 "dave"          "carol"          "bob"            "alice"
   │                │                │                │
   └── ZRANGE asc   └── ZRANGEBYSCORE └── ZRANK       └── ZRANGE REV top
```

| Use case | Score thường là gì? | Lệnh trung tâm |
|----------|---------------------|----------------|
| **Leaderboard** | Điểm số | `ZINCRBY`, `ZREVRANK`, `ZRANGE REV` — xem [Leaderboard & Counting](./leaderboard-counting.md) |
| **Delayed / scheduled queue** | Timestamp đến hạn | `ZRANGEBYSCORE`, `ZPOPMIN`, `ZMPOP` |
| **Sliding-window rate limit** | Timestamp request | `ZADD`, `ZREMRANGEBYSCORE`, `ZCARD` — xem [Rate Limiting](./rate-limiting.md) |
| **Time-index** | `created_at`, `expires_at` | `ZRANGEBYSCORE`, `ZREMRANGEBYSCORE` |
| **Priority queue** | Priority hoặc due time | `ZPOPMIN/MAX`, `BZPOPMIN/MAX` |
| **Autocomplete** | Tất cả score = 0 | `ZRANGE BYLEX`, `ZRANGEBYLEX` |
| **Set có trọng số** | Weight, popularity | `ZUNION`, `ZINTER`, `ZDIFF` |

So với [Streams](./streams.md), Sorted Set không có consumer group, ack, pending list. Nó là **ordered index**; nếu cần event log bền vững và replay nhiều consumer, dùng Stream. Nếu cần “lấy top N / phần tử đến hạn / rank”, ZSet là vũ khí chính.

---

## 3. Bên trong Redis: dict + skiplist, đổi memory lấy tốc độ

### 3.1. Vì sao cần hai cấu trúc cùng lúc?

Để hiểu vì sao ZSet vừa lấy điểm rất nhanh vừa trả top/rank nhanh, hãy nhìn nó như một cuốn danh bạ có hai mục lục: một mục lục theo tên, một mục lục theo thứ tự điểm. Mục lục theo thứ tự đó là `skiplist` — danh sách nhiều tầng cho phép nhảy cóc qua nhiều node. Một ZSet lớn trong Redis dùng **hai cấu trúc dữ liệu trỏ tới cùng member**:

```diagram
                 ┌──────────────────────────────┐
                 │          Sorted Set          │
                 └──────────────┬───────────────┘
                                │
        ┌───────────────────────┴───────────────────────┐
        │                                               │
┌───────▼────────┐                              ┌────────▼─────────┐
│ dict/hashtable │                              │ skiplist         │
│ member → score │                              │ ordered by score │
└───────┬────────┘                              └────────┬─────────┘
        │                                                │
        ├─ ZSCORE player:42       O(1)                   ├─ ZRANGE top 10        O(log N + M)
        ├─ tồn tại member?        O(1)                   ├─ ZRANK/ZREVRANK       O(log N)
        └─ update score cũ?       O(1)                   └─ ZRANGEBYSCORE        O(log N + M)
```

Nếu chỉ có `dict`, Redis biết điểm của `player:42` rất nhanh nhưng không biết top 10 là ai nếu không sort toàn bộ. Nếu chỉ có `skiplist`, Redis lấy top 10/range tốt nhưng mỗi lần `ZSCORE player:42` phải dò theo thứ tự.

> [!NOTE]
> Đây là redundancy có chủ đích: **tốn thêm memory để tránh tốn CPU ở mọi request quan trọng**. Member string không bị copy thành hai bản độc lập; các cấu trúc chia sẻ con trỏ, nhưng mỗi member vẫn có metadata/node trong cả dict và skiplist.

### 3.2. Luồng `ZADD` một member đã tồn tại

Khi score thay đổi, Redis không chỉ sửa một con số; nó phải tháo member khỏi vị trí cũ trong thứ tự rồi đặt lại vào vị trí mới. Phần `span` (số node mà một đường tắt nhảy qua) cũng được cập nhật để rank vẫn tính nhanh.

```diagram
ZADD lb 1300 player:42

1) dict lookup member
   player:42 → score cũ = 1200                  O(1)

2) skiplist delete node cũ (1200, player:42)
   tìm đường đi qua nhiều tầng                   O(log N)

3) skiplist insert node mới (1300, player:42)
   level ngẫu nhiên + cập nhật span              O(log N)

4) dict update score
   player:42 → 1300                              O(1)
```

Vì vậy `ZADD`/`ZINCRBY` là `O(log N)` cho mỗi member: phần đắt nằm ở việc **đưa node về đúng vị trí trong skiplist**.

---

## 4. Skiplist deep dive — tầng ngẫu nhiên, span và ZRANK O(log N)

### 4.1. Skiplist là linked list có “đường cao tốc”

Skiplist là cách Redis tạo “đường tắt” trên một danh sách đã sắp xếp, để tìm kiếm không phải đi từng phần tử từ đầu. Nó gồm nhiều level: level thấp nhất chứa mọi node; level cao hơn chỉ chứa một phần node được chọn ngẫu nhiên.

```diagram
Tìm score = 990

L4: head ────────────────────────────────────────────────▶ NULL
L3: head ─────────────────────▶ 990:bob ─────────────────▶ NULL
L2: head ─────────▶ 420:carol ─▶ 990:bob ────────────────▶ NULL
L1: head ─▶150:dave─▶420:carol─▶990:bob─▶1200:alice──────▶ NULL
        đi ngang tới khi node kế tiếp vượt target, rồi rơi xuống 1 tầng
```

Redis không cần rotate/rebalance như tree. Tầng ngẫu nhiên quan trọng vì nó phân bố các đường tắt đủ đều mà không cần thao tác cân bằng phức tạp. Khi insert node mới, Redis tung “đồng xu lệch”:

| Tham số Redis | Giá trị | Ý nghĩa |
|---------------|---------|---------|
| `ZSKIPLIST_P` | `0.25` | Xác suất node được nâng thêm một level |
| `ZSKIPLIST_MAXLEVEL` | `32` | Trần số level |
| Expected search | `O(log N)` | Kỳ vọng, không phải worst-case tuyệt đối |

Với `p = 0.25`, trung bình:

| Level | Tỷ lệ node xuất hiện xấp xỉ | Với 1.000.000 node |
|-------|-----------------------------|--------------------|
| 1 | 100% | 1.000.000 |
| 2 | 25% | 250.000 |
| 3 | 6,25% | 62.500 |
| 4 | 1,56% | 15.625 |
| 8 | 0,006% | ~60 |
| 12 | 0,000006% | ~0–1 |

> [!TIP]
> Hình dung như đường thành phố: level 1 là đường ngõ đi qua mọi nhà; level cao là cao tốc bỏ qua hàng nghìn nhà. Search không đi từng node, mà “phóng ngang” ở tầng cao rồi hạ dần.

### 4.2. Span: bí mật phía sau `ZRANK`

`span` là “đồng hồ đo quãng đường” của từng đường tắt: không chỉ biết nhảy tới đâu, Redis còn biết cú nhảy đó vượt qua bao nhiêu node. Nếu skiplist chỉ có pointer, muốn biết rank của `player:42` Redis vẫn phải đếm bao nhiêu node đứng trước. Vì vậy mỗi forward pointer trong skiplist node lưu thêm **span**: con trỏ đó nhảy qua bao nhiêu node ở level dưới.

```diagram
Tính rank của score 990

L3: head ───────────────(span=3)──────────────▶ 990:bob
       rank += 3

L2/L1: nếu cần đi thêm, cộng tiếp span trên đường tìm kiếm

Kết quả: rank ascending của bob = 2 (0-based)
```

Nhờ span, trên đường tìm kiếm Redis cộng dồn số node đã vượt qua, nên `ZRANK`/`ZREVRANK` là `O(log N)`, không phải `O(N)`. Đây là chi tiết làm leaderboard “rank của tôi” thật sự nhanh.

### 4.3. Vì sao không dùng balanced tree?

| Tiêu chí | Skiplist | Red-black tree / AVL |
|----------|----------|----------------------|
| Search/insert/delete | `O(log N)` kỳ vọng | `O(log N)` worst-case |
| Range scan | Rất tự nhiên: đi ngang level 1 | Cần traversal qua successor |
| Rank | Thêm `span` tương đối đơn giản | Cần subtree size và rotation phải cập nhật đúng |
| Implementation | Đơn giản, ít case xoay cây | Nhiều case cân bằng |
| Memory | Nhiều pointer theo level | Pointer cố định hơn |

Redis chọn skiplist vì nó đủ nhanh, code đơn giản, và range query là use case cốt lõi.

---

## 5. Encoding nhỏ: listpack và ngưỡng chuyển đổi

Không phải ZSet nào cũng dùng skiplist ngay từ đầu. ZSet nhỏ được Redis lưu bằng **listpack**: một vùng memory liên tục chứa member/score xen kẽ.

| Encoding | Điều kiện mặc định Redis 7+ | Đặc điểm |
|----------|-----------------------------|----------|
| `listpack` | `zset-max-listpack-entries 128` và `zset-max-listpack-value 64` bytes | Tiết kiệm memory; thao tác `O(N)` nhưng N nhỏ |
| `skiplist` + `dict` | Vượt một trong hai ngưỡng trên | Nhanh cho lookup/range/rank; tốn memory hơn |

```diagram
listpack nhỏ:
[member:"a"][score:1][member:"b"][score:2][member:"c"][score:3]

Khi entries > 128 hoặc member dài > 64 bytes:
convert one-way → dict + skiplist
```

> [!WARNING]
> Đừng tối ưu bằng cách tăng ngưỡng listpack quá cao nếu workload có nhiều `ZRANGE`/`ZRANK`. Listpack tiết kiệm RAM nhưng scan tuyến tính; khi N không còn nhỏ, CPU sẽ trả giá.

---

## 6. Score, tie-breaking và lexicographic range

### 6.1. Score là IEEE 754 double — chính xác tới 2^53 cho integer

Score trong Redis là **IEEE 754 double** (chuẩn số thực dấu phẩy động 64-bit; Redis gọi ngắn là double). Nó biểu diễn chính xác các số nguyên trong khoảng:

```text
-(2^53) đến +(2^53)
= -9,007,199,254,740,992 đến +9,007,199,254,740,992
```

Ngoài khoảng này, integer có thể bị làm tròn.

| Nhu cầu | Có nên nhét vào score? | Cách đúng |
|---------|-------------------------|-----------|
| Điểm game 0–10 tỷ | ✅ Có | Score = points |
| Unix timestamp milliseconds | ✅ Có | ~1,7e12, dưới 2^53 |
| Unix timestamp microseconds hiện nay | ✅ Còn an toàn cho integer | ~1,7e15, dưới 9e15 nhưng ít dư địa để pack thêm |
| Snowflake/64-bit id | ❌ Không | Để id trong member, score là timestamp/priority riêng |
| `points * 10^12 + timestamp` | ⚠️ Dễ vượt 2^53 | Dùng tie-break trong member hoặc scale nhỏ hơn |

Redis chấp nhận `+inf` và `-inf` trong range và cả score khi cần sentinel, nhưng đừng lạm dụng: điểm vô cực làm logic ranking khó hiểu.

### 6.2. Tie-breaking: cùng score thì member lexicographic quyết định

Tie-breaking là luật phân xử khi nhiều member có cùng score; nếu không hiểu luật này, leaderboard có thể “đúng kỹ thuật nhưng sai kỳ vọng sản phẩm”. Sorted Set sắp theo `(score, member)`. Nếu hai member có score bằng nhau, member có thứ tự lexicographic nhỏ hơn đứng trước trong `ZRANGE` ascending; `ZRANGE REV` đảo chiều.

```bash
ZADD lb 100 bob 100 alice 100 carol
ZRANGE lb 0 -1
# alice, bob, carol
```

Muốn “ai đạt điểm trước đứng trên” trong leaderboard descending, có 3 cách:

| Cách | Ví dụ | Ưu | Nhược |
|------|-------|----|-------|
| Pack vào score | `score = points * 1_000_000 + tie` | Một lệnh range là đủ | Phải kiểm soát 2^53 |
| Pack vào member | `0000001234:player:42` | Không mất precision | Member phình; phải parse |
| Lưu metadata ngoài | ZSet score = points, Hash lưu thời điểm | Rõ ràng | Tie-break khi hiển thị cần thêm logic |

> [!IMPORTANT]
> Nếu bạn pack score, hãy tính worst-case trước. `points_max * multiplier + tie_max` phải nhỏ hơn `2^53`, nếu không leaderboard sẽ có những tie-break “ma”.

### 6.3. Lexicographic range: `BYLEX` chỉ đúng khi score bằng nhau

Lexicographic range là cách dùng ZSet như một index prefix theo chuỗi, hữu ích cho autocomplete đơn giản. Lex range dùng thứ tự member, nhưng chỉ có ý nghĩa khi **mọi member trong tập có cùng score** (thường là 0). Redis so sánh byte kiểu `memcmp`, không có collation tiếng Việt/Unicode thông minh.

```bash
ZADD autocomplete 0 "ha noi" 0 "hai phong" 0 "ho chi minh" 0 "da nang"

# Redis 6.2+ — cú pháp hiện đại
ZRANGE autocomplete "[ha" "[ha\xff" BYLEX
# hai phong, ha noi

# Cú pháp cũ vẫn tồn tại
ZRANGEBYLEX autocomplete "[ha" "[ha\xff"
```

| Ký hiệu range | Nghĩa |
|---------------|-------|
| `[` | Inclusive: `[ha` gồm cả `ha` |
| `(` | Exclusive: `(ha` không gồm `ha` |
| `-` | Âm vô cực lexicographic |
| `+` | Dương vô cực lexicographic |

Autocomplete tiếng Việt thực tế nên normalize trước (`lowercase`, bỏ dấu nếu sản phẩm yêu cầu) rồi lưu vào member hoặc key phụ.

---

## 7. Command catalog & độ phức tạp

### 7.1. Ghi và cập nhật score

| Command | Complexity | Khi dùng | Ghi chú |
|---------|------------|----------|---------|
| `ZADD key score member [score member ...]` | `O(log N)` mỗi member | Set/update score | Tạo key nếu chưa có |
| `ZADD NX` | `O(log N)` | Chỉ add member mới | Không update member cũ |
| `ZADD XX` | `O(log N)` | Chỉ update member đã tồn tại | Không add member mới |
| `ZADD GT` | `O(log N)` | Chỉ update nếu score mới lớn hơn | Không chặn add mới; không dùng chung với `LT` |
| `ZADD LT` | `O(log N)` | Chỉ update nếu score mới nhỏ hơn | Hữu ích cho “best time” |
| `ZADD CH` | `O(log N)` | Muốn return số phần tử changed | Tính cả add mới và update score |
| `ZADD INCR` | `O(log N)` | Increment như `ZINCRBY` | Chỉ được một cặp score/member |
| `ZINCRBY key delta member` | `O(log N)` | Cộng/trừ điểm atomic | Lõi leaderboard |
| `ZREM key member ...` | `O(M log N)` | Xóa member cụ thể | M = số member xóa |

### 7.2. Đọc điểm, rank, range

| Command | Complexity | Khi dùng | Ghi chú |
|---------|------------|----------|---------|
| `ZSCORE` | `O(1)` | Lấy score một member | Qua dict |
| `ZMSCORE` | `O(M)` | Lấy score nhiều member | Redis 6.2+ |
| `ZCARD` | `O(1)` | Tổng số member | Rất rẻ |
| `ZRANK` / `ZREVRANK` | `O(log N)` | Rank asc/desc | Redis 7.2 thêm option `WITHSCORE` |
| `ZRANGE start stop` | `O(log N + M)` | Range theo rank asc | M = số phần tử trả về |
| `ZRANGE ... REV` | `O(log N + M)` | Range desc / top N | Thay `ZREVRANGE` cũ |
| `ZRANGE ... BYSCORE` | `O(log N + M)` | Range theo score | Thay `ZRANGEBYSCORE` cũ |
| `ZRANGE ... BYLEX` | `O(log N + M)` | Range theo member | Score nên bằng nhau |
| `ZRANGE ... LIMIT offset count` | `O(log N + M)` + offset cost | Pagination theo score/lex | Offset lớn vẫn tốn |
| `ZRANGESTORE dst src ...` | `O(log N + M)` | Lưu kết quả range | Redis 6.2+ |
| `ZCOUNT` / `ZLEXCOUNT` | `O(log N)` | Đếm trong range | Không trả member |

`ZRANGE` hiện đại (Redis 6.2+) gom nhiều command cũ:

```bash
ZRANGE lb 0 9 REV WITHSCORES                         # top 10
ZRANGE jobs -inf 1783400000 BYSCORE LIMIT 0 100      # due jobs
ZRANGE autocomplete "[ha" "[ha\xff" BYLEX           # prefix
ZRANGESTORE tmp:top lb 0 999 REV                     # materialize top 1000
```

### 7.3. Pop, blocking pop, random và set algebra

| Command | Complexity | Khi dùng | Ghi chú |
|---------|------------|----------|---------|
| `ZPOPMIN` / `ZPOPMAX` | `O(log N * M)` | Pop priority nhỏ/lớn nhất | Atomic lấy + xóa |
| `BZPOPMIN` / `BZPOPMAX` | `O(log N)` khi pop | Blocking priority queue | Chờ tới khi key có phần tử, không chờ theo due time |
| `ZMPOP` / `BZMPOP` | `O(K) + O(M log N)` | Pop từ nhiều ZSet | Redis 7.0+; `MIN`/`MAX`, `COUNT` |
| `ZRANDMEMBER` | `O(N)` với N requested | Lấy random member | Có `WITHSCORES`, count âm cho phép duplicate |
| `ZUNION` / `ZINTER` / `ZDIFF` | Phụ thuộc input + output | Gộp/tìm giao/trừ không store | Redis 6.2+ |
| `ZUNIONSTORE` / `ZINTERSTORE` | `O(N)+O(M log M)` | Materialize kết quả | Có `WEIGHTS`, `AGGREGATE SUM|MIN|MAX` |
| `ZDIFFSTORE` | `O(N)` tương đối | Materialize hiệu | Redis 6.2+ |
| `ZSCAN` | `O(1)` mỗi call, `O(N)` đủ vòng | Duyệt nền | Không đảm bảo snapshot |

Ví dụ weighted leaderboard:

```bash
ZUNIONSTORE lb:total 3 lb:daily lb:weekly lb:monthly \
  WEIGHTS 1 7 30 AGGREGATE SUM
```

> [!WARNING]
> Trong [Cluster](./cluster.md), các lệnh nhiều key như `ZUNIONSTORE`/`ZINTERSTORE` yêu cầu key cùng hash slot (ô phân vùng trong Redis Cluster quyết định key nằm ở shard nào). Dùng hash tag: `lb:{season27}:daily`, `lb:{season27}:weekly`, `lb:{season27}:total`.

---

## 8. Performance profile — nhanh ở đâu, đắt ở đâu

### 8.1. Benchmark tham khảo

Các số dưới đây là **minh họa có kiểm soát**, không phải cam kết SLA: Redis local, single instance, dataset đã warm cache, member ngắn, client dùng pipeline vừa phải. `p50` là latency trung vị, `p99` là 1% request chậm nhất — mục tiêu là thấy xu hướng.

| Dataset | Operation | Shape | Latency p50 | Latency p99 | Nhận xét |
|---------|-----------|-------|-------------|-------------|----------|
| 1M members | `ZADD` 1 member | random score | ~8–20 µs | ~80–200 µs | `O(log N)`, chủ yếu update skiplist |
| 1M members | `ZSCORE` | 1 member | ~1–5 µs | ~20–50 µs | Dict lookup rất rẻ |
| 1M members | `ZRANGE 0 9 REV` | top 10 | ~10–30 µs | ~100–300 µs | M nhỏ nên nhanh |
| 1M members | `ZRANGE 0 999 REV` | top 1000 | ~0,3–1,5 ms | ~2–5 ms | Chi phí trả dữ liệu bắt đầu chiếm ưu thế |
| 1M members | `ZRANGEBYSCORE -inf +inf` | trả 1M | 100–800 ms+ | giây | Vấn đề là M quá lớn |
| 10 x 1M | `ZUNIONSTORE` | output lớn | hàng trăm ms–giây | giây+ | Không đặt trong request path |

> [!IMPORTANT]
> Complexity `O(log N + M)` có hai nửa. `log N` rất nhỏ; **M mới là thứ giết latency**. “Range query” không tự động nhanh nếu bạn trả về nửa triệu phần tử.

### 8.2. Cost model nhanh trong đầu

| Câu hỏi | Công thức nhẩm | Hệ quả |
|---------|----------------|--------|
| Thêm/cập nhật một player trong 30M | `log₂(30M) ≈ 25` bước | Ghi thường ổn nếu member nhỏ |
| Lấy top 100 | `log N + 100` | Rất phù hợp request path |
| Lấy toàn leaderboard | `log N + 30M` | Không phù hợp request path |
| Dọn 10.000 request cũ | `log N + 10.000` | Có thể spike; chia batch nếu cần |
| Union 5 bảng lớn | đọc input + sort/merge output | Nên chạy background/materialize |

### 8.3. Pipeline và Lua

Nhiều pattern ZSet cần 3–4 lệnh/request. Network round-trip có thể lớn hơn thời gian Redis xử lý. Dùng [Pipelining & Batching](./pipelining-batching.md) để giảm RTT, và dùng [Lua scripting](./lua-scripting.md) khi cần atomic read-modify-write.

| Nhu cầu | Pipeline đủ? | Cần Lua/MULTI? |
|---------|--------------|----------------|
| Gửi 1000 `ZADD` độc lập | ✅ Có | ❌ Không |
| Rate limit: add + trim + count phải nhất quán | ⚠️ Pipeline giảm RTT nhưng không khóa logic | ✅ Lua/MULTI |
| Claim delayed job bằng `ZRANGEBYSCORE` + `ZREM` | ❌ Race giữa worker | ✅ Lua hoặc `ZPOPMIN`/`ZMPOP` cẩn thận |
| Top 10 + score vài member độc lập | ✅ Có | ❌ Không |

---

## 9. Sorted Set vs Set vs List vs Stream

| Use case | Sorted Set | Set | List | Stream |
|----------|------------|-----|------|--------|
| Membership unique | ✅ Có, kèm score | ✅ Tốt nhất nếu chỉ cần membership | ❌ Có duplicate | ❌ Event id unique, không phải membership set |
| Ranking / leaderboard | ✅ Rất mạnh | ❌ Không có thứ tự score | ❌ Chỉ thứ tự insert | ⚠️ Phải tự tính |
| Queue FIFO | ⚠️ Làm được nhưng thừa | ❌ Không ordered FIFO | ✅ `LPUSH`/`BRPOP` đơn giản | ✅ Có consumer group |
| Priority queue | ✅ `ZPOPMIN/MAX` | ❌ | ⚠️ Cần scan/sort ngoài | ⚠️ Priority không native |
| Delayed queue | ✅ Score = due time | ❌ | ❌ Không range theo time | ⚠️ Có timestamp nhưng claim due phức tạp |
| Time-index / retention | ✅ `ZRANGEBYSCORE` | ❌ | ⚠️ Theo vị trí, không theo timestamp | ✅ Event log theo time |
| Autocomplete prefix | ✅ `BYLEX` khi score bằng nhau | ❌ | ❌ | ❌ |
| Pub/sub-like durable log | ❌ | ❌ | ⚠️ Queue đơn | ✅ [Streams](./streams.md) |
| Memory tối thiểu cho unique ids | ⚠️ Đắt hơn | ✅ [Set](./sets.md) | ⚠️ | ❌ |

### Khi nào KHÔNG nên dùng Sorted Set

> [!TIP]
> Nếu bạn không cần **score/rank/range**, đừng dùng Sorted Set. ZSet mạnh vì nó duy trì index có thứ tự; nếu không dùng index đó, bạn chỉ đang trả thêm memory.

- Chỉ cần membership unique → dùng [Set](./sets.md).
- FIFO queue đơn giản → dùng List.
- Event log hoặc consumer group → dùng [Stream](./streams.md).
- Đếm unique rất lớn, chỉ cần ước lượng → dùng HyperLogLog.
- Không cần thứ tự → ZSet chỉ làm tốn thêm memory và biến ghi từ `O(1)` thành `O(log N)`.

---

## 10. Pattern deep dive

### 10.1. Leaderboard: top N, rank của tôi, hàng xóm quanh tôi

```bash
# Ghi điểm
ZINCRBY lb:2026-07 25 player:42
ZADD lb:2026-07 GT 9000 player:99        # chỉ giữ high score cao hơn

# Đọc
ZSCORE lb:2026-07 player:42
ZREVRANK lb:2026-07 player:42            # 0-based: rank hiển thị = +1
ZRANGE lb:2026-07 0 9 REV WITHSCORES     # top 10
```

Hiển thị “quanh tôi”:

```text
rank = ZREVRANK(lb, player:42)
start = max(rank - 5, 0)
stop  = rank + 5
ZRANGE lb start stop REV WITHSCORES
```

| Vấn đề sản phẩm | Thiết kế ZSet |
|-----------------|---------------|
| Reset theo tuần/tháng | Key theo kỳ: `lb:2026-W28`, `lb:2026-07` + `EXPIRE` |
| Leaderboard region/league | Key riêng: `lb:{s27}:asia:gold` |
| Tổng điểm nhiều kỳ | `ZUNIONSTORE` background, không tính lúc user mở màn hình |
| Chống spam update | Batch/pipeline `ZINCRBY`, snapshot DB định kỳ |

Chi tiết pattern leaderboard và counting: [Leaderboard & Counting](./leaderboard-counting.md).

### 10.2. Delayed queue: score = due time

Producer:

```bash
ZADD delayed:jobs 1783400000 "job:341"
```

Worker polling an toàn bằng Lua:

```lua
-- KEYS[1] = delayed key, ARGV[1] = now, ARGV[2] = limit
local jobs = redis.call('ZRANGE', KEYS[1], '-inf', ARGV[1], 'BYSCORE', 'LIMIT', 0, ARGV[2])
for _, job in ipairs(jobs) do
  redis.call('ZREM', KEYS[1], job)
end
return jobs
```

`ZPOPMIN`/`ZMPOP` atomic hơn cho pop, nhưng có một bẫy: nó pop phần tử nhỏ nhất **dù chưa đến hạn**. Nếu score > now, worker phải `ZADD` trả lại hoặc dùng Lua `ZRANGE BYSCORE ... ZREM` như trên.

| Cách claim | Race-free? | Có tránh pop job chưa đến hạn? | Ghi chú |
|------------|------------|---------------------------------|---------|
| `ZRANGEBYSCORE` rồi `ZREM` ở client | ❌ | ✅ | 2 worker có thể thấy cùng job |
| `ZPOPMIN` | ✅ | ❌ | Cần kiểm tra score và add lại |
| `ZMPOP MIN COUNT n` | ✅ | ❌ | Redis 7.0+, pop batch/nhiều key |
| Lua `ZRANGE BYSCORE + ZREM` | ✅ | ✅ | Phổ biến nhất cho delayed scheduler |
| `BZPOPMIN` | ✅ | ❌ | Blocking theo “có phần tử”, không theo “đến hạn” |

### 10.3. Sliding-window rate limit

Mỗi request là một event trong ZSet, score = timestamp milliseconds, member = timestamp + random để unique.

```bash
# Nên gói trong MULTI hoặc Lua
ZREMRANGEBYSCORE rl:user:42 -inf 1783399940000
ZADD rl:user:42 1783400000000 1783400000000:9f3a
ZCARD rl:user:42
EXPIRE rl:user:42 61
```

| Thuật toán | Độ chính xác | Memory | Lệnh/request | Khi dùng |
|------------|--------------|--------|--------------|----------|
| Fixed window `INCR` | Thấp ở biên cửa sổ | `O(1)` | 1–2 | Limit thô, rẻ |
| Sliding counter | Trung bình | `O(1)` | 2–3 | API phổ thông |
| Sliding log bằng ZSet | Rất cao | `O(limit/user)` | 3–4 | Login, OTP, payment |

Gateway lớn thường dùng tầng thô bằng counter, rồi dùng ZSet cho endpoint nhạy cảm. Xem thêm [Rate Limiting](./rate-limiting.md).

### 10.4. Time-index và “member có TTL”

```bash
ZADD user:42:orders 1783400000 order:9911
ZRANGE user:42:orders 1782795200 +inf BYSCORE       # 7 ngày gần nhất
ZREMRANGEBYSCORE user:42:orders -inf 1775624000     # dọn quá 90 ngày
```

[Set](./sets.md) không có TTL từng member. ZSet mô phỏng bằng score = expire time, rồi job nền dọn range cũ.

### 10.5. Autocomplete prefix bằng `BYLEX`

```bash
ZADD ac:cities 0 "ha noi" 0 "hai phong" 0 "hue" 0 "ho chi minh"
ZRANGE ac:cities "[h" "[h\xff" BYLEX LIMIT 0 10
```

| Điểm mạnh | Giới hạn |
|-----------|----------|
| Rất nhanh cho prefix đơn giản | Không fuzzy search |
| Không cần service search ngoài | Không ranking theo BM25 |
| Dễ cache top suggestions | Cần normalize tiếng Việt nếu muốn bỏ dấu/case-insensitive |

---

## 11. Case study thực tế

### 11.1. Game leaderboard — hàng chục triệu người chơi

Bài toán: leaderboard mùa giải reset mỗi tháng, 30 triệu player, mỗi trận cộng điểm; cần top 100, rank của tôi, và hàng xóm quanh tôi trong < 50 ms ở p99 app-level.

```bash
# Kết thúc trận
ZINCRBY lb:{s27}:global 35 player:88420

# Màn hình leaderboard
ZRANGE lb:{s27}:global 0 99 REV WITHSCORES
ZREVRANK lb:{s27}:global player:88420
ZSCORE lb:{s27}:global player:88420
```

Thiết kế vận hành:

- **Key theo mùa**: reset = đổi key, không `DEL` key 30 triệu member ngay trên hot path.
- **Region/league shard theo sản phẩm**: `lb:{s27}:asia:gold`, `lb:{s27}:eu:silver`. Một key ZSet không tự shard member trong [Cluster](./cluster.md).
- **Tie-break công bằng**: pack score có kiểm soát hoặc member prefix. Luôn kiểm tra `2^53`.
- **Snapshot cuối mùa**: Redis phục vụ realtime; DB/object storage lưu kết quả cuối mùa để audit/trao thưởng.

> [!WARNING]
> “Một leaderboard global duy nhất cho mọi thứ” nghe đơn giản nhưng là điểm nóng memory + CPU + cluster. Nếu sản phẩm đã có league/region/platform, hãy dùng chúng làm biên phân vùng tự nhiên.

### 11.2. Delayed scheduler — push notification và webhook retry

Bài toán: “gửi push sau 30 phút”, “retry webhook sau 1/5/25 phút”, hàng triệu job hẹn giờ. Cron per job là không thực tế.

```bash
ZADD delayed:push 1783401800 '{"type":"push","uid":42}'
ZADD delayed:webhook 1783400060 '{"event":"invoice.paid","attempt":2}'
```

Kiến trúc phổ biến:

```diagram
Producer ──ZADD due_time──▶ ZSet delayed
                              │
                              │ Lua poll due jobs
                              ▼
                         List/Stream ready queue ──▶ Workers
```

ZSet làm “phòng chờ theo thời gian”, còn List/Stream làm queue xử lý. Nếu cần consumer group/retry/ack mạnh, chuyển job due sang [Streams](./streams.md).

### 11.3. Sliding-window limiter — API gateway

Bài toán: 100 request/60s trượt thật. Fixed window có thể cho burst 200 request quanh ranh giới phút; sliding log bằng ZSet không bị lỗi đó.

```diagram
Window 60s

now-60s                                                now
   │-----------------------------------------------------│
      req req       req        req             req
      score=timestamp ms, member=req-id unique

Mỗi request:
1) xóa req cũ hơn now-60s
2) add req hiện tại
3) count ZCARD
4) nếu count > limit → reject 429
```

Trade-off: chính xác hơn nhưng memory tăng theo số request còn trong cửa sổ. Đừng dùng cho mọi endpoint nếu fixed/sliding counter đã đủ.

---

## 12. Anti-patterns cần tránh

| ❌ Anti-pattern | Vì sao đau? | ✅ Cách làm đúng |
|-----------------|-------------|------------------|
| `ZRANGE key 0 -1` trên ZSet hàng triệu member trong request | `O(N)` + network payload khổng lồ | Pagination: `LIMIT`, top N, export background |
| Leaderboard không pagination | User/page bot kéo toàn bộ bảng | API bắt buộc `limit <= 100/1000` |
| Dùng score float cho 64-bit id hoặc pack vượt `2^53` | Mất precision, order sai khó debug | Lưu id trong member; score chỉ là metric/rank key |
| `ZUNIONSTORE` nhiều ZSet lớn trong request path | CPU spike, block event loop Redis (vòng xử lý lệnh single-threaded chính, nên một lệnh nặng có thể làm lệnh khác phải chờ) | Materialize định kỳ/background, cache kết quả |
| Quên same-slot trong Cluster | Multi-key command fail `CROSSSLOT` | Hash tag: `lb:{s27}:daily`, `lb:{s27}:weekly` |
| Dùng ZSet khi Set/List đủ | Tốn memory + `O(log N)` vô ích | Membership → Set; FIFO queue → List/Stream |
| Delayed queue bằng `ZRANGEBYSCORE` + `ZREM` không atomic | Hai worker xử lý trùng job | Lua hoặc pop atomic có kiểm tra due time |
| Sliding window không dọn key/old entries | Memory leak theo user | `ZREMRANGEBYSCORE` + `EXPIRE` mỗi request |
| Offset pagination rất sâu | `LIMIT offset count` vẫn phải bỏ qua offset | Seek pagination theo score/member cursor |

---

## 13. Best Practices

- **Member nhỏ, payload để chỗ khác**: ZSet lưu `order:9911`, body nằm ở Hash/String. Member dài làm tăng memory ở dict/skiplist và network.
- **Luôn giới hạn M**: mọi range command có phần `+ M`; đặt hard limit ở API.
- **Dùng `ZADD GT/LT` cho update có điều kiện**: high score (`GT`) hoặc best time (`LT`) atomic, khỏi read-then-write.
- **Atomic cho multi-step**: claim job, rate limit, trim+count nên dùng [Lua scripting](./lua-scripting.md) hoặc transaction phù hợp.
- **Pipeline batch độc lập**: nhiều `ZADD`/`ZSCORE` độc lập nên dùng [Pipelining & Batching](./pipelining-batching.md).
- **Thiết kế key cho Cluster từ đầu**: các phép union/intersection/store phải cùng slot; xem [Cluster](./cluster.md).
- **Dọn dữ liệu cũ theo score**: time-index, rate limit, delayed job đều cần retention bằng `ZREMRANGEBYSCORE`.
- **Theo dõi hot key và command latency**: `ZRANGEBYSCORE` trả nhiều phần tử và `ZUNIONSTORE` lớn thường là thủ phạm.

---

## 14. Tóm tắt — cheat-sheet & 3 nguyên tắc

### 14.1. Pattern → command mapping

| Pattern | Ghi | Đọc/claim | Dọn/maintenance |
|---------|----|-----------|-----------------|
| Leaderboard | `ZINCRBY`, `ZADD GT` | `ZREVRANK`, `ZRANGE REV WITHSCORES` | `EXPIRE` key theo mùa, `ZUNIONSTORE` background |
| “Around me” | `ZINCRBY` | `ZREVRANK` → `ZRANGE start stop REV` | Cache ngắn nếu traffic cao |
| Delayed queue | `ZADD due_ts job` | Lua `ZRANGE BYSCORE + ZREM`, hoặc `ZMPOP` cẩn thận | Retry = `ZADD` due mới |
| Sliding rate limit | `ZADD now req_id` | `ZCARD` sau trim | `ZREMRANGEBYSCORE`, `EXPIRE` |
| Time-index | `ZADD created_at id` | `ZRANGE BYSCORE` | `ZREMRANGEBYSCORE` |
| Autocomplete | `ZADD 0 normalized_text` | `ZRANGE BYLEX LIMIT` | Rebuild index khi source đổi |
| Weighted merge | `ZADD` nhiều key | `ZUNION/ZINTER` | `ZUNIONSTORE` materialized cùng slot |

### 14.2. Command nhớ nhanh

| Bạn muốn... | Dùng... |
|-------------|---------|
| Lấy điểm của member | `ZSCORE` / `ZMSCORE` |
| Cộng điểm atomic | `ZINCRBY` |
| Chỉ cập nhật nếu tốt hơn | `ZADD GT` hoặc `ZADD LT` |
| Top N descending | `ZRANGE key 0 N-1 REV WITHSCORES` |
| Rank descending | `ZREVRANK` |
| Range theo timestamp | `ZRANGE key min max BYSCORE` |
| Pop priority nhỏ nhất | `ZPOPMIN` / `ZMPOP MIN` |
| Blocking priority queue | `BZPOPMIN` / `BZMPOP` |
| Prefix search | `ZRANGE key "[prefix" "[prefix\xff" BYLEX` |
| Gộp leaderboard | `ZUNIONSTORE ... WEIGHTS ... AGGREGATE` |

### 14.3. Ba nguyên tắc

1. **Sorted Set là index có thứ tự, không phải kho payload.** Lưu id/member ngắn; dữ liệu lớn để nơi khác.
2. **`log N` hiếm khi là vấn đề; `M` mới là vấn đề.** Luôn hỏi: range này trả bao nhiêu phần tử?
3. **Atomicity quan trọng hơn “ít lệnh”.** Nếu logic là read-modify-write (claim job, rate limit), dùng Lua/MULTI hoặc command pop atomic.

Sorted Set giống một bảng xếp hạng luôn được Redis giữ nóng trong RAM: thêm điểm là nó tự đặt player vào đúng vị trí; hỏi top/rank/range là nó trả lời ngay. Sức mạnh nằm ở chỗ đó — và cái giá cũng nằm ở chỗ đó. Dùng khi bạn thật sự cần **thứ tự sống**; khi đã cần, rất ít cấu trúc nào thay thế được.

---

## Tài liệu tham khảo

- [Redis Sorted Sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/)
- [Redis ZADD](https://redis.io/docs/latest/commands/zadd/) — flags `NX/XX/GT/LT/CH/INCR`, score double và `2^53`
- [Redis memory optimization](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/) — `zset-max-listpack-entries`, `zset-max-listpack-value`
- [Skip Lists: A Probabilistic Alternative to Balanced Trees (Pugh)](https://15721.courses.cs.cmu.edu/spring2018/papers/08-oltpindexes1/pugh-skiplists-cacm1990.pdf)
- [Leaderboard & Counting](./leaderboard-counting.md) — pattern chuyên sâu
- [Rate Limiting](./rate-limiting.md) — thuật toán giới hạn tốc độ với Redis
