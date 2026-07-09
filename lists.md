# Lists

## Mục lục

- [1. List: hàng đợi và dòng thời gian](#1-list-hàng-đợi-và-dòng-thời-gian)
- [2. Mental model: List là deque, không phải array](#2-mental-model-list-là-deque-không-phải-array)
- [3. Bên trong Redis List: quicklist, listpack và compression](#3-bên-trong-redis-list-quicklist-listpack-và-compression)
- [4. Command chính và Big-O đọc đúng cách](#4-command-chính-và-big-o-đọc-đúng-cách)
- [5. Blocking operations: BLPOP/BRPOP/BLMOVE/BLMPOP hoạt động thế nào](#5-blocking-operations-blpopbrpopblmoveblmpop-hoạt-động-thế-nào)
- [6. Queue patterns: từ đơn giản đến reliable](#6-queue-patterns-từ-đơn-giản-đến-reliable)
- [7. Capped list: recent-N, timeline và circular buffer](#7-capped-list-recent-n-timeline-và-circular-buffer)
- [8. Performance & benchmark: khi O(N) làm nghẽn event loop](#8-performance--benchmark-khi-on-làm-nghẽn-event-loop)
- [9. So sánh: List vs Stream vs Pub/Sub vs Sorted Set queue](#9-so-sánh-list-vs-stream-vs-pubsub-vs-sorted-set-queue)
- [10. Case study thực tế](#10-case-study-thực-tế)
- [11. Anti-patterns cần tránh](#11-anti-patterns-cần-tránh)
- [12. Best Practices](#12-best-practices)
- [13. Tóm tắt / Cheat sheet](#13-tóm-tắt--cheat-sheet)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## 1. List: hàng đợi và dòng thời gian

Hình dung một hàng người xếp trước quầy: ai đến trước đứng đầu, người mới nối vào cuối, và ta luôn phục vụ từ một đầu. Đó chính là Redis List — một danh sách các string có thứ tự, được tối ưu cho việc thêm và lấy ở **hai đầu**.

Nhờ đặc tính đó, List là lựa chọn tự nhiên cho hai nhóm bài toán rất phổ biến: **hàng đợi công việc** (producer đẩy job vào một đầu, worker lấy ra ở đầu kia) và **dòng sự kiện gần đây** (activity feed, log tạm, giữ N item mới nhất).

```bash
# Hàng đợi: API đẩy job, worker chờ lấy
LPUSH q:email '{"uid":42,"template":"promo"}'
BRPOP q:email 0        # worker block cho tới khi có job

# Dòng thời gian: chỉ giữ 100 hoạt động mới nhất
LPUSH feed:user:42 "đã đăng bài"
LTRIM feed:user:42 0 99
```

Sức mạnh của List nằm ở hai đầu, và cạm bẫy của nó cũng vậy: mọi thao tác ở **giữa** list (`LINDEX`, `LINSERT`, `LRANGE` một khoảng lớn) đều là O(N). Một lệnh nhìn vô hại như `LRANGE 0 -1` trên list cả triệu phần tử có thể serialize hàng trăm MB và **block event loop** — làm chậm mọi client khác ([Redis Architecture](./redis-architecture.md)).

Doc này trả lời các câu hỏi cốt lõi: vì sao `LPUSH`/`RPOP` là O(1) còn thao tác giữa list là O(N); List thật sự nằm trong memory thế nào (**quicklist** = danh sách liên kết các node, mỗi node thường chứa **listpack** = khối memory liên tục nhồi nhiều entry nhỏ); blocking queue "block" client ra sao mà server vẫn chạy; pattern reliable queue với `LMOVE`/`BLMOVE` tránh mất job; và khi nào nên chuyển sang [Streams](./streams.md), [Pub/Sub](./pub-sub.md) hay [Sorted Set](./sorted-sets.md).

---

## 2. Mental model: List là deque, không phải array

Redis List là một chuỗi string có thứ tự, tối ưu cho thao tác ở **left/head** và **right/tail**.

```diagram
        LPUSH                                      RPUSH
          │                                          │
          ▼                                          ▼
   ╭──────────╮   ╭──────────╮   ╭──────────╮   ╭──────────╮
   │ index 0  │──▶│ index 1  │──▶│ index 2  │──▶│ index -1 │
   │  head    │◀──│          │◀──│          │◀──│  tail    │
   ╰──────────╯   ╰──────────╯   ╰──────────╯   ╰──────────╯
          ▲                                          ▲
          │                                          │
        LPOP                                        RPOP
```

Quy ước nhớ nhanh:

| Ký hiệu | Ý nghĩa | Ví dụ |
|---------|---------|-------|
| `L` | Left/head, index `0` | `LPUSH`, `LPOP`, `LINDEX key 0` |
| `R` | Right/tail, index `-1` | `RPUSH`, `RPOP`, `LINDEX key -1` |
| Index âm | Đếm từ tail | `-1` cuối cùng, `-2` áp cuối |
| Pop | Lấy ra và xóa | Queue destructive read |

> [!NOTE]
> Redis tự tạo key khi push vào list chưa tồn tại, và tự xóa key khi phần tử cuối cùng bị pop. Read-only command trên key không tồn tại thường được xem như list rỗng (`LLEN` trả 0, pop trả nil).

Use cases phù hợp:

| Use Case | Pattern | Vì sao List hợp |
|----------|---------|-----------------|
| Job queue đơn giản | `LPUSH` + `BRPOP` | Một job chỉ cần một worker xử lý |
| Stack | `LPUSH` + `LPOP` | LIFO (Last-In, First-Out: vào sau ra trước) O(1) |
| Recent history | `LPUSH` + `LTRIM` | Giữ N item mới nhất, memory bounded |
| Batch buffer | `LPOP key count` | Lấy nhiều item atomic trong một lệnh |
| Reliable queue thủ công | `BLMOVE` + processing list | At-least-once (xử lý ít nhất một lần, có thể trùng) nếu worker idempotent (chạy lại cùng job không gây sai kết quả) |

Không phù hợp:

- Cần fan-out: một message cho nhiều subscriber → dùng [Pub/Sub](./pub-sub.md) hoặc [Streams](./streams.md)
- Cần ack/retry/pending tracking built-in → dùng [Streams](./streams.md)
- Cần priority/delayed job theo timestamp/score → dùng [Sorted Set](./sorted-sets.md)
- Cần random access như array → List sẽ thành O(N)

---

## 3. Bên trong Redis List: quicklist, listpack và compression

### 3.1. Vấn đề của linked list thuần

Đây là điểm xuất phát để hiểu vì sao Redis không lưu List theo kiểu “mỗi item một cục riêng” như ví dụ trong sách. Linked list “sách giáo khoa” có vẻ hợp cho queue: push/pop hai đầu O(1). Nhưng nếu mỗi element là một node malloc riêng, memory rất tốn:

```diagram
╭────────────╮     ╭────────────╮     ╭────────────╮
│ prev ptr   │◀───▶│ prev ptr   │◀───▶│ prev ptr   │
│ next ptr   │     │ next ptr   │     │ next ptr   │
│ malloc hdr │     │ malloc hdr │     │ malloc hdr │
│ "job:1"    │     │ "job:2"    │     │ "job:3"    │
╰────────────╯     ╰────────────╯     ╰────────────╯
```

Một payload 20 bytes có thể kéo theo 16 bytes pointer + allocator overhead + cache miss. Với 10 triệu item, overhead này biến thành hàng trăm MB.

### 3.2. listpack: nhồi nhiều entry vào một khối liên tục

Listpack giống một hộp nhỏ chứa nhiều món liền nhau: mục tiêu là giảm pointer rời rạc và tận dụng cache CPU tốt hơn. Redis hiện đại dùng **listpack** để lưu nhiều entry nhỏ trong một vùng memory liên tục:

```diagram
╭────────────────────────────────────────────────────────────────╮
│ total-bytes │ num-elems │ entry1 │ entry2 │ entry3 │ ... │ END │
╰────────────────────────────────────────────────────────────────╯
                         mỗi entry ≈ [encoding + data + backlen]
```

Lợi ích:

| Điểm | listpack thắng ở đâu |
|------|----------------------|
| Không pointer per element | Ít overhead hơn linked list thuần |
| Memory liên tục | Cache-friendly, CPU prefetch tốt hơn |
| Encoding compact | Số nhỏ/string ngắn tốn ít byte hơn |
| Duyệt xuôi/ngược | `backlen` giúp đi ngược mà không cần pointer mỗi entry |

Nhược điểm: chèn/xóa giữa listpack phải `memmove` phần sau. Vì vậy Redis không dùng **một listpack khổng lồ**, mà chia nhỏ.

### 3.3. quicklist: linked list của listpack nodes

Quicklist là cách Redis ghép nhiều “hộp” listpack thành một chuỗi, để vẫn push/pop nhanh ở hai đầu mà không tạo một khối khổng lồ khó sửa. Redis List được encode bằng **quicklist**: một doubly-linked list, mỗi node chứa một listpack hoặc plain node.

```diagram
╭──────────────────╮      ╭──────────────────╮      ╭──────────────────╮
│ quicklist node A │◀────▶│ quicklist node B │◀────▶│ quicklist node C │
│ ╭──────────────╮ │      │ ╭──────────────╮ │      │ ╭──────────────╮ │
│ │ listpack     │ │      │ │ listpack     │ │      │ │ listpack     │ │
│ │ e1 e2 ... eN │ │      │ │ ...          │ │      │ │ ... tail     │ │
│ ╰──────────────╯ │      │ ╰──────────────╯ │      │ ╰──────────────╯ │
╰──────────────────╯      ╰──────────────────╯      ╰──────────────────╯
        head                    có thể nén                  tail
```

Đây là thỏa hiệp thông minh:

- Head/tail chỉ đụng node đầu/cuối → O(1)
- Pointer overhead chia cho hàng chục/hàng trăm entry
- `memmove` chỉ xảy ra trong một node nhỏ, không phải cả list
- Duyệt giữa list vẫn phải đi qua node/entry → O(N)

> [!IMPORTANT]
> Redis 3.2 chuyển List sang quicklist (trước đó là ziplist + linkedlist). Redis 7 dùng **listpack** thay ziplist trong quicklist để tránh vấn đề cascade update và giảm overhead. Tên config cũ `list-max-ziplist-size` nay tương ứng với `list-max-listpack-size`.

### 3.4. Config: list-max-listpack-size và list-compress-depth

Hai config này quyết định mỗi “hộp” listpack to đến đâu và phần giữa list có được nén để tiết kiệm memory hay không.

Trong `redis.conf` mặc định hiện nay:

```bash
list-max-listpack-size -2
list-compress-depth 0
```

Ý nghĩa quan trọng:

| Config | Ý nghĩa | Ghi chú vận hành |
|--------|---------|------------------|
| `list-max-listpack-size 128` | Tối đa 128 entry mỗi listpack node | Dễ hiểu, nhưng không giới hạn byte nếu payload lớn |
| `list-max-listpack-size -1` | Tối đa khoảng 4KB mỗi node | Giới hạn theo kích thước memory |
| `list-max-listpack-size -2` | Tối đa khoảng 8KB mỗi node | Mặc định phổ biến, cân bằng cache/memory |
| `list-max-listpack-size -3` | Tối đa khoảng 16KB mỗi node | Ít node hơn, nhưng memmove lớn hơn |
| `list-compress-depth 0` | Không nén node | Mặc định, latency ổn định |
| `list-compress-depth 1` | Chừa 1 node mỗi đầu, nén node bên trong bằng LZF | Head/tail nhanh, giữa list tốn decompress |
| `list-compress-depth 2` | Chừa 2 node mỗi đầu | An toàn hơn nếu hay đọc gần hai đầu |

```diagram
list-compress-depth 2

╭────────╮ ╭────────╮ ╭────────╮ ╭────────╮ ╭────────╮ ╭────────╮
│ plain  │▶│ plain  │▶│  LZF   │▶│  LZF   │▶│ plain  │▶│ plain  │
╰────────╯ ╰────────╯ ╰────────╯ ╰────────╯ ╰────────╯ ╰────────╯
  head      head+1     interior   interior    tail-1     tail
```

> [!TIP]
> Chỉ bật compression khi list rất dài, payload lặp/nhỏ, và workload chủ yếu push/pop hai đầu. Nếu thường `LRANGE` sâu vào giữa list, compression có thể đổi memory lấy CPU latency.

### 3.5. Quan sát encoding

Khi nghi ngờ List đang được Redis lưu ra sao, cách nhanh nhất là hỏi trực tiếp object encoding và memory usage.

```bash
RPUSH demo:list a b c
OBJECT ENCODING demo:list
# "quicklist" trên Redis hiện đại

MEMORY USAGE demo:list
LLEN demo:list
```

> [!NOTE]
> Một số tài liệu cũ nói list nhỏ là `ziplist` hoặc `listpack`. Với Redis 7+, cách hiểu an toàn là: Redis List object encode là **quicklist**, và bên trong quicklist node thường là **listpack**.

---

## 4. Command chính và Big-O đọc đúng cách

### 4.1. Bảng command cốt lõi

| Command | Complexity | Dùng khi | Cạm bẫy |
|---------|------------|----------|---------|
| `LPUSH key v [v...]` | O(1) mỗi element | Push vào head | Multi-value giữ thứ tự ngược theo từng push |
| `RPUSH key v [v...]` | O(1) mỗi element | Push vào tail | Tương tự |
| `LPOP key [count]` | O(N) với N item trả về | Pop head, batch pop | Reply lớn vẫn tốn network |
| `RPOP key [count]` | O(N) với N item trả về | Pop tail, batch pop | N=1 thực tế O(1) |
| `LLEN key` | O(1) | Đo backlog | Không nói job già hay trẻ |
| `LRANGE key start stop` | O(S+N) | Đọc range nhỏ | `0 -1` trên list lớn rất nguy hiểm |
| `LINDEX key index` | O(N) | Debug/index nhỏ | Không phải array lookup |
| `LSET key index v` | O(N) | Sửa vị trí biết trước trong list nhỏ | Duyệt tới index trước |
| `LINSERT key BEFORE/AFTER pivot v` | O(N) | Chèn quanh pivot trong list nhỏ | Tìm pivot tuyến tính |
| `LREM key count v` | O(N+M) | Xóa theo value | Dùng làm dedup/set là sai |
| `LTRIM key start stop` | O(N removed) | Cap list | Rẻ nếu cắt ít, đắt nếu cắt nhiều |
| `LMOVE src dst LEFT/RIGHT LEFT/RIGHT` | O(1) | Atomic move 1 item | Thay `RPOPLPUSH` cũ |
| `LMPOP numkeys k... LEFT/RIGHT COUNT n` | O(N+M) | Pop batch từ nhiều list | Redis 7.0+ |
| `BLPOP`/`BRPOP` | O(K) với K keys | Blocking queue | Client giữ connection |
| `BLMOVE`/`BLMPOP` | O(1) / O(K+M) | Blocking reliable/batch pop | Redis 6.2+/7.0+ |

### 4.2. Vì sao hai đầu O(1), còn giữa O(N)?

```diagram
Muốn LPOP:

╭──────╮    ╭──────╮    ╭──────╮
│ head │───▶│ node │───▶│ tail │
╰──────╯    ╰──────╯    ╰──────╯
   ▲
   ╰─ biết sẵn pointer head → pop ngay

Muốn LINDEX 700000:

╭──────╮──▶╭──────╮──▶╭──────╮──▶ ... ──▶ ╭────────────╮
│ head │   │ node │   │ node │            │ index 700k │
╰──────╯   ╰──────╯   ╰──────╯            ╰────────────╯
   phải đi từng node/listpack đến vị trí gần nhất từ head hoặc tail
```

`LRANGE key start stop` có hai phần chi phí:

1. **S = seek cost**: đi tới `start` từ đầu gần hơn (head hoặc tail).
2. **N = output cost**: gom và serialize số phần tử trả về.

Ví dụ list 1.000.000 item:

| Lệnh | Seek | Output | Nhận xét |
|------|------|--------|----------|
| `LRANGE q 0 49` | Gần 0 | 50 item | OK cho page đầu |
| `LRANGE q 999950 999999` | Gần tail | 50 item | OK vì Redis đi từ tail ngược |
| `LRANGE q 500000 500049` | ~500k | 50 item | Chậm vì seek giữa |
| `LRANGE q 0 -1` | 0 | 1M item | Rất chậm vì reply khổng lồ |

> [!WARNING]
> `LIMIT/OFFSET` kiểu deep pagination trên List không miễn phí. Nếu cần đọc theo mốc thời gian/score hoặc phân trang sâu, cân nhắc [Sorted Set](./sorted-sets.md) hoặc [Streams](./streams.md).

---

## 5. Blocking operations: BLPOP/BRPOP/BLMOVE/BLMPOP hoạt động thế nào

### 5.1. “Block” client, không block server

“Blocking” ở đây nên hiểu như worker ngồi chờ ở quầy, còn Redis vẫn phục vụ các quầy khác bình thường. `BLPOP key [key ...] timeout` hoặc `BRPOP key [key ...] timeout` pop từ list có dữ liệu; nếu tất cả rỗng, client bị park cho tới khi có push hoặc timeout. `timeout 0` nghĩa là chờ vô hạn.

```diagram
╭────────────╮      BRPOP jobs 0       ╭──────────────────────╮
│ Worker A   │────────────────────────▶│ Redis event loop     │
╰────────────╯                         │ jobs rỗng            │
                                       │ park Worker A        │
                                       │ tiếp tục xử lý client│
╭────────────╮      LPUSH jobs j1      │ khác                 │
│ Producer   │────────────────────────▶│                      │
╰────────────╯                         │ wake Worker A        │
╭────────────╮      [jobs, j1]         │ pop j1 atomic        │
│ Worker A   │◀────────────────────────│                      │
╰────────────╯                         ╰──────────────────────╯
```

Chi tiết đáng nhớ:

| Cơ chế | Hành vi |
|--------|---------|
| Client parked | Redis lưu client vào danh sách blocked theo key, không busy-wait |
| Wake on push | Sau lệnh push, Redis phục vụ client đang chờ key đó |
| FIFO fairness | Nhiều client block cùng key → client block trước được phục vụ trước |
| Multi-key | `BRPOP high normal low 0` kiểm tra key theo thứ tự truyền vào |
| Timeout | Hết timeout trả nil, connection vẫn sống |
| Cluster | Multi-key blocking cần các key cùng hash slot (nhóm key được Redis Cluster đặt chung shard) trong Redis Cluster; dùng hash tag nếu cần, xem [Cluster](./cluster.md) |

> [!IMPORTANT]
> Blocking command tốt hơn polling vì không tạo request rỗng. Nhưng mỗi worker blocked vẫn giữ một TCP connection; hãy cấu hình connection pool riêng cho worker.

### 5.2. BLPOP vs BRPOP vs BLMOVE vs BLMPOP

Các lệnh này khác nhau chủ yếu ở “lấy từ đầu nào”, “có move sang list khác không”, và “lấy một hay nhiều item”.

| Command | Since | Trả về | Phù hợp |
|---------|-------|--------|---------|
| `BLPOP` | 2.0 | 1 item từ head | LIFO/FIFO (First-In, First-Out: vào trước ra trước) tùy chiều push |
| `BRPOP` | 2.0 | 1 item từ tail | Queue FIFO với `LPUSH` |
| `BRPOPLPUSH` | 2.2 | Move tail src → head dst | Reliable queue kiểu cũ |
| `BLMOVE` | 6.2 | Move 1 item src → dst theo chiều chọn | Thay thế tổng quát cho `BRPOPLPUSH` |
| `BLMPOP` | 7.0 | Pop nhiều item từ list đầu tiên có dữ liệu | Batch worker, multi-key |

> [!TIP]
> Nếu đang thiết kế mới, ưu tiên `LMOVE`/`BLMOVE` thay cho `RPOPLPUSH`/`BRPOPLPUSH`: tên rõ hơn, chọn được LEFT/RIGHT cả source và destination.

### 5.3. Priority queue thô bằng nhiều key

Nếu chỉ cần vài mức ưu tiên đơn giản, nhiều list theo mức độ có thể đủ dùng trước khi phải chuyển sang Sorted Set.

```bash
BRPOP q:critical q:normal q:low 0
```

Redis kiểm tra theo thứ tự key. Nếu `q:critical` có dữ liệu, worker lấy critical trước. Nhưng đây chỉ là priority thô:

- Không có score/timestamp
- Không dễ reprioritize job đã enqueue
- Dễ starve `q:low` nếu `q:critical` luôn đầy

Priority/delayed queue nghiêm túc nên dùng [Sorted Set](./sorted-sets.md) với score là priority hoặc `run_at` timestamp.

---

## 6. Queue patterns: từ đơn giản đến reliable

### 6.1. Simple FIFO work queue

Đây là pattern nhỏ nhất: producer đẩy job vào một đầu, worker chờ và lấy job ở đầu còn lại.

```bash
# Producer: vào bên trái
LPUSH q:email '{"id":"e-1001","to":"a@b.c"}'

# Worker: ra bên phải → FIFO
BRPOP q:email 5
```

```diagram
LPUSH e1, e2, e3

head                                      tail
╭────╮     ╭────╮     ╭────╮
│ e3 │────▶│ e2 │────▶│ e1 │  ──BRPOP──▶ xử lý e1 trước
╰────╯     ╰────╯     ╰────╯
```

Ưu điểm: đơn giản, nhanh, ít command. Nhược điểm lớn: worker crash sau khi pop nhưng trước khi xử lý xong → job đã bị xóa khỏi queue.

### 6.2. Reliable queue với BLMOVE + processing list

Pattern này thêm một “khu đang xử lý” để job không biến mất ngay khi worker vừa lấy ra. Pattern đáng dùng khi job không được mất:

```bash
# Worker lấy job atomic: pop từ q:email, push sang processing của worker
BLMOVE q:email q:email:processing:worker-7 RIGHT LEFT 5

# Xử lý thành công
LREM q:email:processing:worker-7 1 '{"id":"e-1001",...}'
```

Flow:

```diagram
╭────────────╮   BLMOVE RIGHT LEFT   ╭────────────────────────────╮
│ q:email    │──────────────────────▶│ q:email:processing:worker  │
│ pending    │                       │ in-flight                  │
╰────────────╯                       ╰────────────────────────────╯
        ▲                                         │
        │ janitor requeue nếu quá hạn             │ LREM khi ack thành công
        ╰─────────────────────────────────────────╯
```

Đây là **at-least-once delivery**:

| Tình huống | Kết quả |
|------------|---------|
| Worker xử lý xong rồi `LREM` | Job biến mất đúng cách |
| Worker chết sau `BLMOVE` | Job còn trong processing list |
| Janitor phát hiện timeout | Requeue job về `q:email` |
| Worker cũ sống lại và worker mới cũng xử lý | Có thể trùng → handler phải idempotent |

> [!CAUTION]
> Processing list chỉ chứa payload, không tự lưu timestamp. Nếu cần janitor chính xác, hãy nhúng `started_at`, dùng key phụ `job:{id}`, hoặc dùng [Streams](./streams.md) vì Streams có Pending Entries List built-in.

Ví dụ janitor tối thiểu:

```bash
# Pseudo-code, không chạy LRANGE 0 -1 nếu processing có thể rất lớn
for job in LRANGE q:email:processing:worker-7 0 99:
    if now - job.started_at > 300:
        LREM q:email:processing:worker-7 1 job
        LPUSH q:email job_with_attempts_plus_1
```

### 6.3. Batch pop với LMPOP/BLMPOP (Redis 7.0+)

Batch pop giống lấy cả xấp phiếu thay vì từng phiếu một, hữu ích khi chi phí qua mạng lớn hơn chi phí xử lý từng job. Khi mỗi job nhỏ nhưng round-trip/network là bottleneck:

```bash
# Pop tối đa 100 item từ q:a hoặc q:b, chờ tối đa 2 giây
BLMPOP 2 2 q:a q:b LEFT COUNT 100
```

| Pattern | Lệnh | Khi nào dùng |
|---------|------|--------------|
| Single job | `BRPOP q 0` | Xử lý từng task tốn CPU/IO lớn |
| Batch một key | `LPOP q 100` | Buffer/log, không cần block lâu |
| Batch nhiều key blocking | `BLMPOP ... COUNT 100` | Gom nhiều queue nhỏ, giảm round-trip |

> [!NOTE]
> Batch lớn giảm round-trip nhưng tăng thời gian một command chiếm event loop và tăng rủi ro mất cả batch nếu không reliable. Chọn batch theo p95 latency, không theo cảm giác.

---

## 7. Capped list: recent-N, timeline và circular buffer

### 7.1. Recent-N bằng LPUSH + LTRIM

```bash
LPUSH user:42:feed "post:9911"
LTRIM user:42:feed 0 99
```

Vì sao cặp này hiệu quả? Sau mỗi `LPUSH`, list dài 101, `LTRIM 0 99` chỉ bỏ 1 item ở tail. Complexity danh nghĩa O(N removed), thực tế gần O(1) nếu cap đều đặn.

```diagram
Trước: giữ 100 item
╭───── newest ─────╮ ... ╭──── oldest ────╮

LPUSH item mới → 101 item
╭─ new ─╮ ╭──── 100 item cũ ────╮ ╭─ dư ─╮

LTRIM 0 99 → cắt đúng phần dư ở tail
╭─ new ─╮ ╭──── 99 item cũ ─────╮
```

> [!TIP]
> Dùng pipeline hoặc `MULTI/EXEC` cho `LPUSH` + `LTRIM` để tránh round-trip kép; xem [Pipelining & Batching](./pipelining-batching.md). Nếu bắt buộc atomic tuyệt đối, dùng transaction hoặc Lua.

### 7.2. Circular buffer cho log gần nhất

```bash
# Ghi log gần nhất của service, giữ 10.000 dòng
LPUSH log:api:recent "$(date +%s) GET /checkout 200 34ms"
LTRIM log:api:recent 0 9999
EXPIRE log:api:recent 604800
```

So với file log/DB:

| Tiêu chí | Redis capped List | DB table log |
|----------|-------------------|--------------|
| Ghi mới nhất | O(1) | INSERT + index cost |
| Đọc 100 dòng gần nhất | `LRANGE 0 99` nhanh | `ORDER BY ts DESC LIMIT 100` cần index |
| Lưu lâu dài | Không nên | Có |
| Query phức tạp | Kém | Tốt |
| Mất Redis | Mất cache/log gần | DB bền hơn |

### 7.3. Đừng để cap là lời hứa miệng

Unbounded list thường sinh ra từ một dòng code thiếu `LTRIM`:

```bash
# Ngày 1: 10 item/user, ổn
LPUSH activity:user:42 "..."

# Sau 6 tháng: user power-user có 2.4 triệu item, LRANGE profile chết
```

> [!WARNING]
> Với recent history, `LTRIM` không phải tối ưu phụ; nó là một phần của data model. Không có cap nghĩa là bạn đang tạo memory leak có cấu trúc.

---

## 8. Performance & benchmark: khi O(N) làm nghẽn event loop

Các số dưới đây là benchmark minh họa trên Redis local, payload JSON ~180 bytes, network loopback, máy 8-core laptop. Đừng copy làm SLA; hãy dùng để thấy **tương quan**.

### 8.1. Latency command theo kích thước list

| Lệnh | List size | Reply | Latency p50 | Latency p95 | Bình luận |
|------|-----------|-------|-------------|-------------|-----------|
| `LPUSH q job` | 1M | 1 integer | 0.08ms | 0.18ms | Gần như không phụ thuộc list size |
| `BRPOP q 1` | 1M | 1 item | 0.10ms | 0.25ms | Pop tail O(1) thực tế |
| `LLEN q` | 1M | 1 integer | 0.03ms | 0.08ms | Length lưu sẵn |
| `LRANGE q 0 49` | 1M | 50 item | 0.20ms | 0.55ms | Output nhỏ |
| `LRANGE q 500000 500049` | 1M | 50 item | 4.5ms | 9.8ms | Seek giữa list |
| `LRANGE q 0 99999` | 1M | 100k item | 95ms | 180ms | Serialize/network lớn |
| `LRANGE q 0 -1` | 1M | 1M item | 1.1s | 1.8s | Làm nghẽn event loop |
| `LREM q 0 job-x` | 1M | scan 1M | 35ms | 90ms | Dùng làm set là anti-pattern |

> [!IMPORTANT]
> Một lệnh reply 100MB không chỉ chậm cho client đó; nó **block event loop** và trì hoãn mọi lệnh khác ([Redis Architecture](./redis-architecture.md)).

### 8.2. Memory: listpack tiết kiệm nhưng không miễn phí

Minh họa với 1.000.000 element:

| Payload trung bình | Encoding thực tế | Ước lượng data thô | Memory observed | Overhead chính |
|--------------------|------------------|--------------------|-----------------|----------------|
| 8 bytes (`job:123`) | quicklist/listpack | ~8MB | ~18–28MB | entry encoding + listpack/node allocator |
| 64 bytes JSON | quicklist/listpack | ~64MB | ~85–110MB | payload dominates, node overhead nhỏ |
| 512 bytes JSON | quicklist/listpack/plain nodes có thể xuất hiện | ~512MB | ~560–700MB | allocator fragmentation, large entry |
| 2KB payload | quicklist/plain-heavy | ~2GB | >2.1GB | Queue chỉ nên chứa reference/id |

> [!TIP]
> Đẩy `job_id` vào List, lưu body lớn ở DB/object storage/key riêng. Queue càng nhỏ, replication/AOF/network càng nhẹ. Kết hợp với [Memory Management](./memory-management.md) để đo `MEMORY USAGE`, fragmentation và eviction policy.

### 8.3. Tuning listpack size: đổi memory lấy CPU

| `list-max-listpack-size` | Memory | Push/pop | Middle operations | Khi cân nhắc |
|--------------------------|--------|----------|-------------------|--------------|
| `-1` (~4KB/node) | Nhiều node hơn | Rất ổn định | Seek nhiều node hơn | Payload nhỏ, latency nhạy |
| `-2` (~8KB/node) | Cân bằng | Mặc định tốt | Cân bằng | Hầu hết workload |
| `-4` (~32KB/node) | Ít node hơn | Có thể memmove lớn hơn | Ít node nhưng node nặng | List cực dài, ít sửa trong node |
| `128` entry/node | Dễ dự đoán theo count | Tùy payload | Tùy payload | Payload kích thước đồng đều |

> [!CAUTION]
> Đừng tuning config toàn Redis chỉ vì một queue. Thay đổi listpack size ảnh hưởng mọi List trên instance. Tối ưu data model trước, config sau.

---

## 9. So sánh: List vs Stream vs Pub/Sub vs Sorted Set queue

| Tiêu chí | List (`BRPOP`) | [Streams](./streams.md) | [Pub/Sub](./pub-sub.md) | [Sorted Set queue](./sorted-sets.md) |
|----------|----------------|-------------------------|--------------------------|--------------------------------------|
| Delivery semantics | At-most-once mặc định; at-least-once nếu tự làm `BLMOVE` + ack | At-least-once với consumer group, `XACK`, `XPENDING` | Best-effort realtime, subscriber offline là mất | Tự thiết kế, thường at-least-once với lock/claim |
| Ordering | Theo thứ tự list | Theo stream ID/time | Theo publish trên connection | Theo score, phù hợp priority/delay |
| Consumer groups | Không | Có built-in | Không | Không built-in |
| Persistence unread | Có, nằm trong list | Có, log giữ message | Không | Có, member còn trong ZSet |
| Ack/retry | Tự chế bằng processing list + janitor | Built-in | Không | Tự chế bằng processing ZSet/list |
| Replay lịch sử | Không sau khi pop | Có `XRANGE`, `XREAD` theo ID | Không | Có nếu chưa remove |
| Fan-out | Không, pop destructive | Có: nhiều group đọc cùng stream | Có broadcast realtime | Cần nhân bản item hoặc nhiều ZSet |
| Backpressure (tín hiệu hệ thống đang nhận nhanh hơn xử lý) | `LLEN` backlog | Lag per group, pending count | Không tự lưu backlog | `ZCARD`, score lag |
| Delayed job | Cần thêm ZSet | Có thể nhưng không tối ưu bằng ZSet | Không | Rất hợp (`score = run_at`) |
| Complexity vận hành | Thấp | Trung bình | Thấp | Trung bình/cao |
| Điểm mạnh | Queue đơn giản, latency thấp | Reliable event log | Notification tức thời | Priority/schedule/rate limit |

> [!NOTE]
> List là “dao gấp”: nhẹ, nhanh, hữu dụng. Streams là “hộp đồ nghề”: nặng hơn nhưng có ack/replay/consumer group. Pub/Sub là “loa phát thanh”: nghe lúc đó thì có, vắng mặt là mất. Sorted Set là “lịch hẹn”: ai tới giờ/score trước xử lý trước.

### Khi nào KHÔNG nên dùng List

- Cần membership/dedup → dùng Set.
- Cần ranking/priority/delay → dùng Sorted Set.
- Cần ack/replay/consumer group → dùng Stream.
- Cần broadcast realtime → dùng Pub/Sub.
- Cần random access ở giữa list → List là O(N) ở giữa.

Nền tảng event loop: [Redis Architecture](./redis-architecture.md).

---

## 10. Case study thực tế

### 10.1. Hàng đợi gửi email/notification — SaaS điển hình

Bài toán: API phải trả response <100ms; SMTP mất 300ms–2s; gửi lỗi cần retry; backlog lúc cao điểm 500k job.

```bash
# API producer — payload nhỏ, có idempotency key
LPUSH q:email '{"id":"email:2026-07-07:1001","uid":42,"tpl":"welcome"}'

# Worker
job=$(BLMOVE q:email q:email:processing:$WORKER_ID RIGHT LEFT 5)
# send_email(job)
LREM q:email:processing:$WORKER_ID 1 "$job"
```

Thiết kế sâu hơn:

| Quyết định | Lý do |
|------------|------|
| Mỗi loại job một queue (`q:email`, `q:sms`, `q:webhook`) | Scale worker độc lập, backlog rõ |
| Payload chứa `id`, không chứa HTML email lớn | Queue nhỏ, replication nhẹ |
| `attempts` + dead-letter queue `q:email:dead` (hàng đợi chứa job lỗi để điều tra/xử lý sau) | Tránh retry vô hạn |
| Worker idempotent theo `email_id` | At-least-once có thể xử lý trùng |
| Metric `LLEN q:email` và age job | Backlog length thôi chưa đủ; cần biết job già nhất |

Janitor thực tế thường cần metadata:

```bash
# Khi enqueue
SET job:email:1001 '{"to":"a@b.c","tpl":"welcome","attempts":0}' EX 86400
LPUSH q:email email:1001

# Processing list chỉ giữ id
BLMOVE q:email q:email:processing:worker-7 RIGHT LEFT 5
```

> [!TIP]
> Nếu janitor/ack/retry bắt đầu phức tạp hơn business logic, đó là dấu hiệu chuyển sang [Streams](./streams.md) hoặc queue framework chuyên dụng.

### 10.2. Timeline “hoạt động gần đây” — trang profile

Bài toán: profile hiển thị 20 hành động gần nhất; toàn hệ thống ghi 5.000 event/s; query DB `ORDER BY created_at DESC LIMIT 20` chiếm 40% load.

```bash
# Pipeline 3 lệnh mỗi event
LPUSH act:user:42 '{"t":"comment","post":991,"at":1783400000}'
LTRIM act:user:42 0 19
EXPIRE act:user:42 2592000

# Render profile
LRANGE act:user:42 0 19
```

Memory budget:

| Thành phần | Ước lượng |
|------------|-----------|
| 20 entry × 120 bytes | ~2.4KB data |
| listpack + key overhead | vài trăm bytes đến ~1KB |
| 1 triệu user active | khoảng vài GB, đo bằng `MEMORY USAGE` |

> [!IMPORTANT]
> Timeline bằng List nên là **cache/materialized view**, không phải source of truth. Event gốc vẫn nên ở DB hoặc stream log. Redis mất thì rebuild được.

Feed phức tạp hơn (ranking, score, merge nhiều nguồn) thường hợp với [Sorted Set](./sorted-sets.md) hơn List.

### 10.3. Batch processor — gom log ghi DB theo lô

Bài toán: 20.000 event/s, ghi từng dòng vào DB quá chậm; cần gom lô 500–1.000 dòng/INSERT.

```bash
# Producer
LPUSH buf:events '{"ts":1783400000,"type":"click","uid":42}'

# Consumer mỗi vòng
LPOP buf:events 1000
# INSERT INTO events VALUES (...), (...), ...
```

| Batch size | Round-trip/s | Latency flush | Rủi ro |
|------------|--------------|---------------|--------|
| 1 | 20.000 | thấp từng event nhưng overhead lớn | CPU/network Redis cao |
| 100 | 200 | tốt | mất tối đa 100 nếu crash sau pop |
| 1.000 | 20 | rất tiết kiệm | command/reply lớn hơn, mất batch lớn hơn |

Nếu log không được mất, dùng `BLMOVE` sang processing hoặc [Streams](./streams.md). Nếu chỉ là analytics best-effort, List batch là đủ.

---

## 11. Anti-patterns cần tránh

### 11.1. ❌ `LRANGE 0 -1` trên list lớn

```bash
# ❌ Admin endpoint nguy hiểm
LRANGE q:email 0 -1
```

```bash
# ✅ Phân trang nông + giới hạn cứng
LRANGE q:email 0 99
LLEN q:email
```

Nếu cần browse sâu/audit/replay, dùng [Streams](./streams.md) hoặc lưu job metadata trong DB.

### 11.2. ❌ Dùng List như Set

```bash
# ❌ Không dedup, remove O(N)
LPUSH online:users 42
LPUSH online:users 42
LREM online:users 0 42
```

```bash
# ✅ Dùng Set cho membership/dedup
SADD online:users 42
SREM online:users 42
SISMEMBER online:users 42
```

### 11.3. ❌ Polling bằng LPOP loop

```python
# ❌ Đốt CPU/network khi queue rỗng, thêm delay nhân tạo
while True:
    job = redis.lpop("q:email")
    if job:
        handle(job)
    else:
        time.sleep(1)
```

```python
# ✅ Blocking pop
while True:
    item = redis.brpop("q:email", timeout=30)
    if item:
        _, job = item
        handle(job)
```

### 11.4. ❌ List tăng vô hạn

```bash
# ❌ Recent activity nhưng không cap
LPUSH act:user:42 "event"
```

```bash
# ✅ Recent-N bounded
LPUSH act:user:42 "event"
LTRIM act:user:42 0 99
```

### 11.5. ❌ Dùng List để fan-out pub/sub

```bash
# ❌ Muốn 10 service đều nhận cùng message nhưng dùng một list
LPUSH events '{"user_created":42}'
# service nào BRPOP trước thì lấy mất message
```

```bash
# ✅ Realtime broadcast
PUBLISH user-events '{"user_created":42}'

# ✅ Durable fan-out / consumer groups
XADD user-events * type user_created uid 42
```

Xem [Pub/Sub](./pub-sub.md) cho realtime và [Streams](./streams.md) cho durable fan-out.

### 11.6. ❌ Reliable queue không ack

```bash
# ❌ Pop xong là mất, worker crash làm mất job
BRPOP q:payment 0
```

```bash
# ✅ Move sang processing + ack
BLMOVE q:payment q:payment:processing:w1 RIGHT LEFT 0
# handle
LREM q:payment:processing:w1 1 "$job"
```

> [!CAUTION]
> “Reliable queue bằng List” không tự nhiên reliable; nó reliable vì bạn thêm processing list, timeout, retry, dead-letter và idempotency.

---

## 12. Best Practices

- **Nhất quán chiều FIFO**: `LPUSH` + `BRPOP` hoặc `RPUSH` + `BLPOP`; ghi rõ trong code comment.
- **Cap mọi recent list** bằng `LTRIM`; cap là data model, không phải cleanup job tùy chọn.
- **Không đọc toàn bộ list lớn**; đặt hard limit cho admin/debug endpoint.
- **Payload nhỏ**: queue chứa id/reference; body lớn ở DB/key riêng.
- **Worker idempotent** nếu dùng reliable queue at-least-once.
- **Dùng blocking command** thay polling; connection pool worker tách khỏi request pool.
- **Theo dõi cả length và age**: `LLEN` cho backlog, timestamp trong payload cho job già nhất.
- **Batch có giới hạn**: `LPOP count`/`BLMPOP COUNT` giảm round-trip nhưng đừng tạo reply khổng lồ.
- **Cluster-aware key design**: multi-key `BLMOVE`/`BLMPOP` trong [Cluster](./cluster.md) cần cùng hash slot, ví dụ `q:{email}` và `q:{email}:processing:w1`.
- **Đo memory thật** bằng `MEMORY USAGE`, `INFO memory`, và tham khảo [Memory Management](./memory-management.md).

---

## 13. Tóm tắt / Cheat sheet

### 13.1. Chọn pattern nào?

```diagram
                         ╭──────────────────────────╮
                         │ Bạn cần queue/message gì?│
                         ╰────────────┬─────────────╯
                                      │
                 ╭────────────────────┼────────────────────╮
                 │                    │                    │
        ╭────────▼────────╮  ╭────────▼────────╮  ╭────────▼────────╮
        │ 1 job → 1 worker│  │ nhiều consumer  │  │ realtime only   │
        │ đơn giản        │  │ ack/replay      │  │ mất cũng được   │
        ╰────────┬────────╯  ╰────────┬────────╯  ╰────────┬────────╯
                 │                    │                    │
          Redis List           Redis Streams           Pub/Sub
          LPUSH+BRPOP          XADD+XREADGROUP         PUBLISH/SUBSCRIBE
                 │
       ╭─────────▼─────────╮
       │ không được mất job│
       ╰─────────┬─────────╯
                 │
          BLMOVE + processing
          + janitor + idempotency
                 │
       ╭─────────▼─────────╮
       │ cần delay/priority│
       ╰─────────┬─────────╯
                 │
          Sorted Set queue
          score = run_at/priority
```

### 13.2. Command cheat sheet

| Mục tiêu | Dùng |
|----------|------|
| FIFO queue đơn giản | `LPUSH q job` + `BRPOP q 0` |
| LIFO stack | `LPUSH stack v` + `LPOP stack` |
| Reliable queue | `BLMOVE q q:processing:w RIGHT LEFT 0` + `LREM` ack |
| Batch pop | `LPOP q 100` hoặc `BLMPOP ... COUNT 100` |
| Recent 100 | `LPUSH key v` + `LTRIM key 0 99` |
| Đọc page đầu | `LRANGE key 0 49` |
| Đo backlog | `LLEN key` |
| Tránh | `LRANGE key 0 -1` trên list lớn, `LREM` như dedup |

### 13.3. Ba nguyên tắc nhớ lâu

1. **Hai đầu là đường cao tốc; giữa list là đường làng.** Push/pop head/tail O(1), random access O(N).
2. **Queue phải có biên.** Recent list cần `LTRIM`; work queue cần metric, worker scale, dead-letter.
3. **Reliability không miễn phí.** List mặc định pop là mất; muốn at-least-once phải có processing list, janitor và idempotency — hoặc dùng Streams.

Quay lại câu chuyện mở đầu: Redis không sập vì 80.000 email/phút; nó khựng vì ta bắt nó trả lời “cho tôi tất cả mọi thứ” trong một lệnh. Với List, câu hỏi đúng không phải “Redis có nhanh không?”, mà là: **bạn có đang chỉ chạm hai đầu và giữ list có giới hạn không?**

---

## Tài liệu tham khảo

- [Redis Lists](https://redis.io/docs/latest/develop/data-types/lists/)
- [Redis list commands](https://redis.io/commands/?group=list)
- [Redis configuration example — list-max-listpack-size/list-compress-depth](https://redis.io/docs/latest/operate/oss_and_stack/management/config/)
- [Redis Architecture](./redis-architecture.md) — event loop, single-thread command execution
- [Streams](./streams.md) — queue cần consumer groups, ack, replay
- [Pub/Sub](./pub-sub.md) — realtime fan-out không lưu message
- [Sorted Sets](./sorted-sets.md) — priority/delayed queue và ranking
- [Pipelining & Batching](./pipelining-batching.md) — giảm round-trip cho `LPUSH` + `LTRIM`
- [Memory Management](./memory-management.md) — đo memory, fragmentation, eviction
- [Cluster](./cluster.md) — hash slot và multi-key operations
