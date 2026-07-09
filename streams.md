# Streams

## Mục lục

- [1. Khoảng trống giữa Pub/Sub và Kafka](#1-khoảng-trống-giữa-pubsub-và-kafka)
- [2. Stream là gì — append-only log có ID, replay và group](#2-stream-là-gì--append-only-log-có-id-replay-và-group)
- [3. Internals: rax + listpack macro-node — vì sao vừa nhanh vừa tiết kiệm RAM](#3-internals-rax--listpack-macro-node--vì-sao-vừa-nhanh-vừa-tiết-kiệm-ram)
- [4. Entry ID: `<ms>-<seq>`, `*`, explicit ID và `NOMKSTREAM`](#4-entry-id-ms-seq--explicit-id-và-nomkstream)
- [5. Ghi và đọc cơ bản: XADD, XLEN, XRANGE, XREAD](#5-ghi-và-đọc-cơ-bản-xadd-xlen-xrange-xread)
- [6. Trimming và retention: MAXLEN, MINID, exact vs approximate](#6-trimming-và-retention-maxlen-minid-exact-vs-approximate)
- [7. Consumer Groups: chia tải, fan-out và trạng thái server-side](#7-consumer-groups-chia-tải-fan-out-và-trạng-thái-server-side)
- [8. PEL, XACK, XPENDING, XCLAIM, XAUTOCLAIM — recovery đúng cách](#8-pel-xack-xpending-xclaim-xautoclaim--recovery-đúng-cách)
- [9. Delivery semantics: at-least-once, poison message và dead-letter](#9-delivery-semantics-at-least-once-poison-message-và-dead-letter)
- [10. Observability và vận hành: XINFO, XGROUP DELCONSUMER, XSETID](#10-observability-và-vận-hành-xinfo-xgroup-delconsumer-xsetid)
- [11. So sánh sâu: Stream vs Pub/Sub vs List vs Kafka](#11-so-sánh-sâu-stream-vs-pubsub-vs-list-vs-kafka)
- [12. Benchmark & performance: con số để thiết kế capacity](#12-benchmark--performance-con-số-để-thiết-kế-capacity)
- [13. Case study thực tế](#13-case-study-thực-tế)
- [14. Anti-patterns cần tránh](#14-anti-patterns-cần-tránh)
- [15. Best Practices](#15-best-practices)
- [16. Tóm tắt — cheat-sheet, decision table và 3 nguyên tắc](#16-tóm-tắt--cheat-sheet-decision-table-và-3-nguyên-tắc)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## 1. Khoảng trống giữa Pub/Sub và Kafka

Giả sử order service của bạn phát ra một event mỗi khi có đơn mới, để payment, kho, email và analytics cùng xử lý. Cách nhanh nhất là Pub/Sub:

```bash
PUBLISH orders.created '{"order_id":8812,"amount":250000}'
```

Vấn đề: Pub/Sub là **fire-and-forget**. Message chỉ tới những subscriber đang online đúng thời điểm publish. Nếu payment service restart để deploy trong hai phút, mọi event phát ra trong hai phút đó biến mất vĩnh viễn — không có cách nào đọc lại.

Câu hỏi cốt lõi không phải "Redis có nhanh không" (nó rất nhanh), mà là: nếu một consumer chết trong 30 giây, bạn muốn message **biến mất**, **kẹt lại để retry**, hay **đọc lại được từ đầu**?

- Cần biến mất, không quan tâm ai nghe → [Pub/Sub](./pub-sub.md).
- Cần một hàng đợi đơn giản, mỗi job đúng một worker → [List](./lists.md).
- Cần log lưu lại, đọc lại được, nhiều nhóm consumer độc lập, có ack/retry → **Streams**.

Redis Streams là một **append-only log** (chỉ ghi thêm vào cuối, không sửa entry cũ; xem thêm [Redis Overview](./redis-overview.md)) nằm trong Redis: mỗi entry có ID tăng dần, đọc lại được theo khoảng thời gian, nhiều **consumer group** (nhóm worker cùng chia việc trên một stream) xử lý song song và độc lập, kèm cơ chế ack/claim để không mất message khi worker chết.

```bash
XADD orders '*' order_id 8812 amount 250000        # append, ID tự sinh
XREADGROUP GROUP payment w1 COUNT 10 STREAMS orders '>'
```

Doc này đi sâu vào cách Streams lưu trữ bằng **radix tree (`rax`)** (cây index nén prefix ID) + **listpack/macro-node** (block compact chứa nhiều entry), cơ chế consumer group và **PEL (Pending Entries List)**, cách recovery bằng `XCLAIM`/`XAUTOCLAIM`, và ranh giới rõ ràng giữa Streams với Pub/Sub, List và Kafka — để bạn biết khi nào Streams là đủ và khi nào cần một hệ thống chuyên dụng.

---

## 2. Stream là gì — append-only log có ID, replay và group

Stream là một chuỗi entry bất biến theo thứ tự append. Mỗi entry có:

- **ID** dạng `<millisecondsTime>-<sequence>`.
- **Body** dạng field-value, không phải một blob duy nhất.
- **Vị trí trong log** để range scan, replay, pending tracking.

```diagram
orders stream
┌──────────────────┬──────────────────┬──────────────────┬──────────────────┐
│ 1783400000000-0  │ 1783400000123-0  │ 1783400000123-1  │ 1783400000456-0  │
│ event=created    │ event=paid       │ event=reserved   │ event=emailed    │
│ order=8812       │ order=8812       │ order=8812       │ order=8812       │
└──────────────────┴──────────────────┴──────────────────┴──────────────────┘
   ▲ XRANGE từ đây                    ▲ XREAD từ last-id này
   └────────────── consumer groups giữ con trỏ riêng ──────────────┘
```

Ba đặc tính làm Streams khác các cấu trúc Redis quen thuộc:

| Đặc tính | Ý nghĩa thực tế |
|----------|-----------------|
| **Persistent until trim** | Đọc xong không mất; entry chỉ biến mất khi `XTRIM`, `MAXLEN`, `MINID`, hoặc `XDEL` |
| **Replayable by ID** | Consumer có thể đọc từ `0`, từ timestamp, từ ID cuối đã xử lý, hoặc range điều tra |
| **Consumer groups** | Server lưu `last_delivered_id`, PEL, ownership, delivery count — không phải tự chế ack/retry |

> [!NOTE]
> Độ bền dữ liệu của Stream vẫn phụ thuộc cấu hình Redis persistence/replication: RDB/AOF, fsync, replica, failover. Xem thêm [Persistence Strategies](./persistence-strategies.md). Stream giải quyết semantics đọc/ack, không tự thay thế chiến lược durability.

---

## 3. Internals: rax + listpack macro-node — vì sao vừa nhanh vừa tiết kiệm RAM

Redis Stream không lưu mỗi entry thành một object riêng. Nếu làm vậy, overhead pointer/object sẽ ăn RAM trước khi payload kịp lớn. Thay vào đó, Redis dùng hai lớp:

1. **Radix tree (`rax`)**: index theo ID của các block.
2. **Listpack-packed macro-nodes**: mỗi leaf/block chứa nhiều entry liên tiếp, nén delta và chia sẻ field names.

```diagram
stream key: orders

rax / radix tree (key = ID đầu hoặc ID đại diện của macro-node)
┌──────────────────────────────────────────────────────────────────────┐
│ 1783400000000-0 ─────▶ macro-node A (listpack, ~tens/100s entries)   │
│ 1783400001500-0 ─────▶ macro-node B (listpack, ~tens/100s entries)   │
│ 1783400003000-0 ─────▶ macro-node C (listpack, ~tens/100s entries)   │
└──────────────────────────────────────────────────────────────────────┘

macro-node B / listpack
┌──────────────────────────────────────────────────────────────────────┐
│ master entry: id=1783400001500-0 fields=[event,order_id,amount,uid]  │
│ entry +0ms +0seq values=[created,8812,250000,42]                     │
│ entry +8ms +0seq values=[paid,8812,250000,42]                        │
│ entry +8ms +1seq values=[reserved,8812,1,sku-7]                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.1. Vì sao radix tree hợp với Stream ID?

Radix tree là phần giúp Redis tìm đúng vùng dữ liệu nhanh, giống mục lục nén cho các ID đang tăng dần. Stream ID là chuỗi số tăng dần; radix tree nén prefix chung giữa các ID, nên các ID gần nhau chia sẻ nhiều byte đầu:

```diagram
1783400000...
├── 000-0
├── 123-0
├── 123-1
└── 456-0
```

Hệ quả:

| Operation | Vì sao nhanh |
|-----------|--------------|
| `XADD` cuối stream | Append vào macro-node cuối, O(1) amortized |
| Lookup/range theo ID | Nhảy qua `rax`, rồi scan một listpack nhỏ |
| `XRANGE start end` | Tìm macro-node đầu, sau đó đi tuần tự qua macro-node kế tiếp |
| `XINFO STREAM` | Có thể báo `radix-tree-keys`, `radix-tree-nodes`, `first-entry`, `last-entry` |

Redis docs mô tả lookup entry đơn là O(n) theo độ dài ID; vì ID ngắn và cố định, thực tế gần như constant. Range thì vẫn phụ thuộc số entry trả về.

### 3.2. Listpack macro-node tiết kiệm RAM bằng cách nào?

Listpack macro-node là cách Redis gom nhiều entry nhỏ vào một block liền mạch, để không phải trả chi phí object/pointer cho từng message. Điều này đặc biệt quan trọng vì event thực tế thường nhỏ nhưng rất nhiều.

Một order event thường lặp lại schema:

```text
event created order_id 8812 amount 250000 uid 42
event paid    order_id 8812 amount 250000 uid 42
event shipped order_id 8812 amount 250000 uid 42
```

Nếu lưu field name `event`, `order_id`, `amount`, `uid` cho từng entry thì overhead lớn. Listpack macro-node dùng **master entry** và delta:

| Thành phần | Cách nén |
|------------|----------|
| ID | Lưu delta so với master ID trong cùng macro-node |
| Field names | Schema giống nhau thì chia sẻ/tái sử dụng từ master entry |
| Values | Đóng gói compact trong listpack liên tục trên memory |
| Node overhead | Một macro-node chứa nhiều entry → ít pointer/object hơn |

> [!TIP]
> Muốn Stream gọn: entry nhỏ, field names ổn định, schema lặp lại. Nếu payload 50KB JSON, hãy lưu payload ở key/object store khác và đưa `payload_key` hoặc `blob_id` vào Stream.

### 3.3. Aha moment: tại sao `MAXLEN ~` rẻ hơn `MAXLEN =`?

Trim là thao tác dọn bớt entry cũ để Stream không phình RAM; khác biệt giữa `~` và `=` nằm ở mức Redis được phép “dọn theo block” hay phải “cắt đúng từng dòng”. Vì Stream được đóng gói theo macro-node, cắt chính xác từng entry ở giữa listpack có thể phải mở/sửa macro-node. Cắt approximate cho phép Redis đợi đến khi có thể **evict cả macro-node**.

```diagram
Exact trim (= 1000)
[macro A: 80 entries] [macro B: 80] ... cần xóa 13 entry đầu của macro K
                                      └─ phải sửa listpack

Approx trim (~ 1000)
[macro A: 80 entries] [macro B: 80] ... chỉ xóa khi bỏ trọn macro-node
└──── evict cả block ────┘              └─ nhanh hơn, sai số vài chục entry
```

Đây là chi tiết nhỏ nhưng thay đổi production: với high-throughput stream, `MAXLEN ~` thường là khác biệt giữa trim nhẹ nhàng và latency spike.

---

## 4. Entry ID: `<ms>-<seq>`, `*`, explicit ID và `NOMKSTREAM`

Entry ID có dạng:

```text
1783400000123-1
└────┬──────┘└┬┘
ms timestamp  sequence trong cùng millisecond
```

| Cách tạo ID | Ví dụ | Khi dùng |
|-------------|-------|----------|
| Auto | `XADD orders * event created` | 99% trường hợp production |
| Explicit | `XADD orders 1783400000123-0 event created` | Import/migrate log có timestamp sẵn |
| Chỉ ms, auto seq | `XADD orders 1783400000123-* event created` | Redis 7.0+, muốn timestamp cụ thể nhưng sequence tự chọn |
| Không tạo stream mới | `XADD orders NOMKSTREAM * ...` | Producer chỉ ghi nếu stream đã tồn tại |

Các luật quan trọng:

- ID mới phải **lớn hơn ID cuối** trong stream. Nếu explicit ID nhỏ hơn hoặc bằng last ID → lỗi.
- `*` dùng server time, nhưng Redis vẫn đảm bảo ID **monotonic**: nếu nhiều entry cùng millisecond, sequence tăng; nếu clock hệ thống lùi, Redis không tạo ID thấp hơn last ID.
- ID là cursor. `XREAD STREAMS orders 1783400000123-0` nghĩa là "trả entry có ID **lớn hơn** ID này".
- `XSETID` có thể set last-generated ID, thường chỉ dùng khi restore/migrate/advanced ops; set sai có thể làm `XADD *` lỗi hoặc phá kỳ vọng monotonic.

> [!IMPORTANT]
> Đừng tự tạo ID bằng timestamp client nếu nhiều producer phân tán và clock lệch. Dùng `*`, hoặc đảm bảo producer luôn gửi ID tăng nghiêm ngặt.

---

## 5. Ghi và đọc cơ bản: XADD, XLEN, XRANGE, XREAD

### 5.1. XADD và XLEN

```bash
XADD orders '*' event created order_id 8812 amount 250000 uid 42
# → "1783400000000-0"

XLEN orders
# → số entry còn lại trong stream sau trim/delete
```

`XADD` là O(1) khi append bình thường, nhưng nếu kèm trimming thì chi phí phụ thuộc số entry bị evict.

### 5.2. XRANGE / XREVRANGE — query theo thời gian

```bash
XRANGE orders - + COUNT 10
XREVRANGE orders + - COUNT 5
XRANGE orders 1783400000000 1783403600000 COUNT 100
```

`-` và `+` là ID nhỏ nhất/lớn nhất. Range mặc định inclusive. Muốn exclusive, prefix ID bằng `(`:

```bash
# Entry lớn hơn 1783400000000-0, không bao gồm chính nó
XRANGE orders (1783400000000-0 + COUNT 100

# Pagination an toàn: lấy batch sau last_id vừa thấy
XRANGE orders (1783400000456-0 + COUNT 100
```

> [!TIP]
> Vì phần đầu ID là millisecond timestamp, `XRANGE audit start_ms end_ms` biến Stream thành time-index rất tiện cho audit log. Nhưng Stream không có secondary index; query theo `user_id` hay `order_id` vẫn cần index riêng hoặc data model khác.

### 5.3. XREAD — non-group consumer tự giữ offset

```bash
# Đọc entry mới hơn ID đã xử lý
XREAD COUNT 100 STREAMS orders 1783400000000-0

# Chờ tối đa 5 giây cho entry mới
XREAD BLOCK 5000 COUNT 100 STREAMS orders 1783400000456-0

# $ = chỉ entry xuất hiện sau thời điểm gọi lệnh
XREAD BLOCK 5000 STREAMS orders $
```

Cẩn thận với `$`:

```diagram
T1: consumer gọi XREAD ... $
T2: nhận e101, xử lý xong
T3: consumer gọi lại XREAD ... $
T4: e102 đã được XADD giữa T2 và T3

Kết quả: e102 có thể bị bỏ qua vì $ nhảy tới "đuôi hiện tại".
```

Nếu cần không mất message, hãy lưu `last_id` sau mỗi batch hoặc dùng consumer group. `$` phù hợp cho "tail live từ bây giờ", không phù hợp cho reliable processing.

---

## 6. Trimming và retention: MAXLEN, MINID, exact vs approximate

Stream không tự nhỏ đi khi consumer ack. Nếu không đặt retention, bạn đang xây một memory leak có thứ tự thời gian.

### 6.1. MAXLEN — giữ N entry gần nhất

```bash
# Production thường dùng approximate
XADD orders MAXLEN '~' 1000000 '*' event created order_id 8812

# Exact trim: giữ đúng <= 1,000,000 entry, đắt hơn
XADD orders MAXLEN '=' 1000000 '*' event created order_id 8812
XTRIM orders MAXLEN '=' 1000000
```

### 6.2. MINID — giữ theo tuổi/thời gian

```bash
# Xóa entry có ID nhỏ hơn mốc này
XTRIM orders MINID '~' 1783300000000

# Ghi kèm retention theo timestamp
XADD orders MINID '~' 1783300000000 '*' event created order_id 8812
```

`MINID` rất hợp cho retention kiểu "giữ 24 giờ" vì ID chứa millisecond timestamp.

### 6.3. LIMIT — kiểm soát công việc trim mỗi lệnh

```bash
XTRIM orders MAXLEN '~' 1000000 LIMIT 1000
XADD orders MAXLEN '~' 1000000 LIMIT 1000 '*' event created order_id 8812
```

`LIMIT` giới hạn số entry/macro-node Redis cố gắng kiểm tra/evict trong một lần trim, giúp tránh một lệnh trim quá lớn gây latency spike. Đổi lại, stream có thể tạm thời vượt ngưỡng lâu hơn.

| Chiến lược | Độ chính xác | Chi phí | Khi dùng |
|------------|--------------|---------|----------|
| `MAXLEN = N` | Chính xác | Cao hơn nếu phải sửa macro-node | Test, stream nhỏ, hard cap rất chặt |
| `MAXLEN ~ N` | Xấp xỉ | Thấp, evict cả macro-node | Production high-throughput |
| `MINID = id` | Chính xác theo thời gian | Có thể cao | Compliance cần mốc rõ |
| `MINID ~ id` | Xấp xỉ theo thời gian | Thấp | Retention vận hành, metrics/log |

> [!IMPORTANT]
> `XDEL` không phải retention strategy. Nó logical delete entry theo ID; memory của macro-node thường chỉ được reclaim khi cả macro-node rỗng. Muốn kiểm soát RAM: `MAXLEN`/`MINID` + monitoring.

---

## 7. Consumer Groups: chia tải, fan-out và trạng thái server-side

Consumer group giải quyết bài toán: nhiều worker cùng xử lý một stream, mỗi entry mới giao cho **một consumer trong group**, nhưng nhiều group khác nhau vẫn nhận đủ event (fan-out theo group).

```bash
# 0 = group bắt đầu từ đầu stream; $ = chỉ entry mới sau thời điểm tạo group
XGROUP CREATE orders g:payment 0 MKSTREAM
XGROUP CREATE orders g:email   $ MKSTREAM

# Worker payment-1 lấy entry chưa từng giao cho group này
XREADGROUP GROUP g:payment payment-1 COUNT 50 BLOCK 5000 STREAMS orders '>'

# Xử lý xong thì ack
XACK orders g:payment 1783400000123-0 1783400000123-1
```

### Luật chia tải (pull, không phải push fair-queue)

Redis **không** push message đều cho worker như Kafka consumer rebalance. Assignment xảy ra **tại lúc** `XREADGROUP ... '>'`:

| Điểm | Hành vi thực tế |
|------|------------------|
| Ai nhận entry mới? | Consumer nào gọi `XREADGROUP >` **trước** / lấy được reply trước — pull race |
| Worker nhanh hơn? | Gọi `XREADGROUP` thường hơn → **lấy nhiều entry hơn** (không sticky partition) |
| Worker chậm / chết? | Entry đã giao nằm PEL của consumer đó cho tới `XACK` / `XCLAIM` |
| Scale out worker | Thêm process gọi cùng group name; không cần reassign partition |
| So với Kafka | Không có partition ownership cố định; không “đúng 1 consumer = 1 partition” |

```text
payment-1 ──XREADGROUP >──▶  lấy 50 entry mới (giao + vào PEL của payment-1)
payment-2 ──XREADGROUP >──▶  lấy 50 entry *tiếp theo* chưa giao
```

Vì vậy autoscaling worker **có ích** cho throughput, nhưng không đảm bảo fair share tuyệt đối; consumer chậm không “giữ slot” ngăn consumer khác lấy việc **mới** — chỉ giữ **pending đã giao**.

Group state trong Redis:

```diagram
group g:payment trên stream orders
├── last_delivered_id: 1783400000456-0
├── consumers
│   ├── payment-1: seen_time, active_time, PEL riêng
│   └── payment-2: seen_time, active_time, PEL riêng
└── PEL per-group
    ├── 1783400000123-0 → owner=payment-1, idle=5s, deliveries=1
    └── 1783400000300-0 → owner=payment-2, idle=90s, deliveries=3
```

### 7.1. `>` vs specific ID — khác nhau sống còn

| ID trong `XREADGROUP` | Ý nghĩa | Dùng khi |
|-----------------------|---------|----------|
| `>` | Lấy message mới chưa giao cho consumer nào trong group | Worker loop bình thường |
| `0` hoặc ID cụ thể | Đọc lại PEL của **consumer hiện tại** | Worker restart, xử lý nốt message đã nhận nhưng chưa ack |

```bash
# Bình thường: lấy việc mới
XREADGROUP GROUP g:payment payment-1 COUNT 50 STREAMS orders '>'

# Sau restart: đọc lại pending của chính payment-1
XREADGROUP GROUP g:payment payment-1 COUNT 50 STREAMS orders 0
```

> [!NOTE]
> Consumer được auto-create khi lần đầu xuất hiện trong `XREADGROUP`. `XGROUP CREATECONSUMER` chỉ cần khi bạn muốn tạo trước để quan sát/quản trị.

### 7.2. `XGROUP CREATE 0` hay `$`?

| Start ID | Hành vi | Ví dụ |
|----------|---------|-------|
| `0` | Group sẽ nhận toàn bộ entry đang còn trong stream | Service mới cần backfill lịch sử |
| `$` | Bỏ qua lịch sử, chỉ nhận entry mới sau khi tạo group | Notification service chỉ care future event |
| ID cụ thể | Bắt đầu sau ID đó | Replay từ checkpoint/migration |

---

## 8. PEL, XACK, XPENDING, XCLAIM, XAUTOCLAIM — recovery đúng cách

Khi worker nhận message rồi chết trước khi ack, Redis cần một “sổ nợ” để biết message nào đang lơ lửng và ai đang giữ nó. PEL = **Pending Entries List**: danh sách entry đã giao cho consumer nhưng chưa `XACK`.

Redis duy trì PEL ở hai mức:

- **Per-group PEL**: nhìn toàn bộ pending của group, phục vụ `XPENDING`, `XAUTOCLAIM`.
- **Per-consumer PEL**: biết consumer nào đang giữ entry nào, phục vụ đọc lại pending của chính consumer.

### 8.1. XPENDING — nhìn vấn đề trước khi sửa

`XPENDING` là lệnh để nhìn vào “sổ nợ” đó trước khi đụng vào recovery: có bao nhiêu message đang kẹt, kẹt ở consumer nào, và đã idle bao lâu.

```bash
# Summary: tổng pending, min/max ID, pending theo consumer
XPENDING orders g:payment

# Extended: ID, consumer, idle ms, delivery count
XPENDING orders g:payment - + 10
XPENDING orders g:payment - + 10 payment-2
```

Ví dụ extended output đáng chú ý:

```text
1) 1) "1783400000300-0"
   2) "payment-2"
   3) (integer) 91234     # idle ms
   4) (integer) 5         # delivery count
```

`delivery count = 5` là tín hiệu: message này retry nhiều lần, có thể là poison message.

### 8.2. XCLAIM — claim có chọn lọc

`XCLAIM` giống thao tác chuyển một việc đang kẹt từ worker cũ sang worker mới, nhưng chỉ khi bạn đã biết chính xác ID cần xử lý lại.

```bash
XCLAIM orders g:payment payment-1 60000 1783400000300-0
# key    group     new-owner min-idle-time id
```

Options hữu ích:

| Option | Ý nghĩa |
|--------|---------|
| `IDLE ms` | Set idle time mới |
| `TIME ms-unix` | Set idle time theo timestamp tuyệt đối |
| `RETRYCOUNT n` | Set delivery counter |
| `FORCE` | Tạo pending entry ngay cả khi ID chưa có trong PEL (advanced) |
| `JUSTID` | Chỉ trả ID, không trả body; không tăng delivery count như claim full |

`XCLAIM` tốt khi bạn đã biết chính xác ID cần claim. Nhưng để scan hàng nghìn pending entry, `XAUTOCLAIM` tiện hơn.

### 8.3. XAUTOCLAIM — janitor thực tế

`XAUTOCLAIM` là phiên bản phù hợp cho janitor chạy định kỳ: nó tự quét PEL theo cursor, nhặt các entry idle quá lâu và giao lại cho consumer recovery.

```bash
XAUTOCLAIM orders g:payment payment-janitor 60000 0 COUNT 100
# → trả cursor kế tiếp + các entry claimed
```

`XAUTOCLAIM` hoạt động kiểu cursor: scan PEL từ `start`, claim entry idle quá `min-idle-time`, trả cursor để lần sau tiếp tục. Khi cursor về `0-0`, quay lại từ đầu.

> [!TIP]
> Redis docs ghi `XAUTOCLAIM` có từ Redis **6.2**. Nếu team bạn chuẩn hóa "Redis 7.0+" thì càng an toàn, nhưng đừng ghi nhầm là chỉ 7.0 mới có.

### 8.4. XACK — xóa khỏi PEL, không xóa khỏi stream

`XACK` là bước worker báo “việc này xong rồi”, để Redis gỡ entry khỏi danh sách pending của group.

```bash
XACK orders g:payment 1783400000300-0 1783400000301-0
```

`XACK` chỉ nói với group: "message này xử lý xong". Entry vẫn nằm trong Stream cho group khác, replay, audit, hoặc đến khi trim.

---

## 9. Delivery semantics: at-least-once, poison message và dead-letter

Streams + consumer group mặc định cho semantics **at-least-once** (xử lý ít nhất một lần; có thể trùng nếu crash/retry):

```diagram
1. Worker nhận e1 → Redis đưa e1 vào PEL
2. Worker xử lý side effect: charge payment thành công
3. Worker chết trước XACK
4. Janitor XAUTOCLAIM e1 cho worker khác
5. e1 được xử lý lần nữa
```

Kết luận: consumer phải **idempotent** (xử lý lặp lại cùng một message không tạo side effect sai).

| Semantics | Cách đạt trong Redis Stream | Trade-off |
|-----------|-----------------------------|-----------|
| At-least-once | XREADGROUP → xử lý → XACK | Có thể xử lý trùng; dùng idempotency key = stream ID (`SETNX processed:<id> 1` / unique DB) |
| At-most-once (tối đa một lần; có thể mất) | XACK trước hoặc ngay khi nhận | Crash sau ack thì mất message |
| Exactly-once (đúng một lần end-to-end) | Không có native end-to-end | Cần idempotency key/transaction ở downstream |

### 9.1. Detect poison message bằng delivery count

```bash
XPENDING orders g:payment - + 100
# nếu delivery count > 5 → chuyển DLQ
```

Pattern dead-letter:

```bash
# Worker thấy message retry quá 5 lần
XADD orders.dlq '*' original_id 1783400000300-0 reason payment_timeout payload_key order:8812
XACK orders g:payment 1783400000300-0
```

> [!IMPORTANT]
> DLQ phải lưu đủ context để debug: original stream, original ID, consumer group, delivery count, error class, payload/reference, timestamp. Nếu chỉ lưu `reason=failed`, DLQ sẽ thành nghĩa địa không điều tra được.

---

## 10. Observability và vận hành: XINFO, XGROUP DELCONSUMER, XSETID

### 10.1. XINFO STREAM / GROUPS / CONSUMERS

```bash
XINFO STREAM orders
XINFO GROUPS orders
XINFO CONSUMERS orders g:payment
```

Các field nên đưa vào dashboard:

| Metric | Lấy từ | Ý nghĩa |
|--------|--------|---------|
| `length` | `XINFO STREAM` | Số entry còn trong stream |
| `radix-tree-keys/nodes` | `XINFO STREAM` | Dấu hiệu encoding/macro-node |
| `last-generated-id` | `XINFO STREAM` | Đuôi stream |
| `entries-read`, `lag` | `XINFO GROUPS` (Redis mới) | Group chậm bao xa |
| `pending` | `XINFO GROUPS`, `XPENDING` | Entry đã giao chưa ack |
| `idle` per consumer | `XINFO CONSUMERS` | Consumer im lặng bao lâu |

### 10.2. XGROUP DELCONSUMER — dọn consumer chết

```bash
XGROUP DELCONSUMER orders g:payment payment-old-7
```

Lệnh này xóa consumer khỏi group và loại bỏ PEL của consumer đó khỏi group state. Vì vậy, chỉ dùng sau khi đã claim/ack/xử lý pending hoặc chấp nhận bỏ trạng thái pending đó.

### 10.3. XSETID — chỉ dành cho migration/ops có kiểm soát

```bash
XSETID orders 1783400009999-0
```

`XSETID` set last-generated ID của stream. Dùng khi restore stream từ source khác hoặc cần đồng bộ ID generator. Trong app bình thường, gần như không cần.

---

## 11. So sánh sâu: Stream vs Pub/Sub vs List vs Kafka

| Tiêu chí | Redis Stream | [Pub/Sub](./pub-sub.md) | [List](./lists.md) | Kafka |
|----------|--------------|--------------------------|---------------------|-------|
| Persistence message | Có, đến khi trim/delete | Không | Có trong list đến khi pop | Có theo retention log |
| Consumer offline | Đọc tiếp từ ID/group | Mất message | Có thể pop sau, nhưng không có ack native | Đọc tiếp từ offset |
| Consumer groups | Native | Không | Không native, tự chia qua pop | Native |
| Replay lịch sử | `XRANGE`, `XREAD` từ ID | Không | Không sau khi pop | Có |
| Ack/retry | `XACK`, PEL, `XCLAIM` | Không | Tự chế bằng `LMOVE`/processing list | Offset commit/rebalance |
| Ordering | Toàn stream/key | Theo publish realtime | Toàn list | Trong partition |
| Fan-out nhiều service | Mỗi service một group | Subscriber online đều nhận | Phải copy sang nhiều list | Mỗi group nhận đủ |
| Backpressure (downstream chậm làm backlog dồn lại) | Stream dài ra, pending/lag tăng | Không lưu → drop với offline | List dài ra | Lag theo partition |
| Retention | `MAXLEN`, `MINID`, `XTRIM` | Không có | `LTRIM` thủ công | Time/size retention |
| Scale ngang ghi | Shard nhiều stream/key; trong [Cluster](./cluster.md) 1 key thuộc 1 hash slot (đơn vị phân vùng key trong Redis Cluster) | Tốt cho broadcast nhẹ | Shard nhiều list | Partition là core design |
| Durability mạnh | Phụ thuộc Redis AOF/RDB/replica | Không | Phụ thuộc Redis | Thiết kế cho durable distributed log |
| Độ phức tạp vận hành | Thấp nếu đã có Redis | Thấp nhất | Thấp | Cao hơn đáng kể |
| Khi chọn | Reliable queue/event log trong Redis | Realtime notify mất được | Queue đơn giản 1 nhóm worker | Event backbone TB/ngày, retention dài |

Decision nhanh:

```diagram
Cần message còn lại khi consumer offline?
├─ Không → Pub/Sub
└─ Có
   ├─ Cần replay/range/consumer group/ack? → Stream
   ├─ Chỉ một hàng đợi đơn giản, pop là xong? → List
   └─ Cần partition distributed, retention TB, ecosystem connector? → Kafka
```

### Khi nào KHÔNG nên dùng Streams

- Chỉ cần realtime notify mất-được → dùng [Pub/Sub](./pub-sub.md).
- Queue cực đơn giản, một nhóm worker, pop-là-xong → dùng [List](./lists.md).
- Cần log distributed nhiều TB, retention dài, connector ecosystem → dùng Kafka.
- Message rất lớn → lưu blob ngoài, Stream chỉ giữ reference.
- Không cần replay/ack/group → Stream là overkill, tốn thêm RAM và ops.

---

## 12. Benchmark & performance: con số để thiết kế capacity

Con số phụ thuộc CPU, network, payload, pipeline, persistence, replica. Bảng dưới là **rule-of-thumb** để capacity planning, không phải SLA universal.

| Workload | Kỳ vọng thường gặp | Ghi chú |
|----------|--------------------|---------|
| `XADD` entry nhỏ, pipeline/batching | Hàng chục nghìn đến vài trăm nghìn entry/s mỗi Redis node | Bật AOF `fsync=always` sẽ giảm mạnh; xem [Pipelining & Batching](./pipelining-batching.md) |
| `XREADGROUP COUNT 100-1000` | Throughput tốt hơn đọc từng entry | Batch giảm round-trip và số lần ack |
| `XACK` batch nhiều ID | Rẻ hơn ack từng ID | `XACK key group id1 id2 ...` |
| `MAXLEN ~` | Latency ổn định hơn exact trim | Evict cả macro-node |
| `MAXLEN =` trên stream lớn | Có thể gây spike khi phải sửa nhiều node | Dùng khi thật cần hard cap |
| `XRANGE - +` không `COUNT` | Nguy hiểm với stream lớn | Có thể trả hàng triệu entry, block client/network |

### 12.1. Memory per entry — tại sao schema quan trọng?

Ví dụ entry nhỏ:

```text
event created order_id 8812 amount 250000 uid 42
```

| Kiểu payload | Memory tương đối | Lý do |
|--------------|------------------|-------|
| Field-value nhỏ, schema lặp lại | Thấp | Listpack + master entry chia sẻ field names |
| Field names dài, mỗi entry khác schema | Trung bình/cao | Ít tận dụng delta/schema sharing |
| JSON blob lớn trong một field | Cao | Stream chỉ nén cấu trúc, không biến blob lớn thành rẻ |
| Payload external + reference | Thấp cho stream | Stream giữ metadata/cursor; blob ở nơi khác |

> [!NOTE]
> Nếu benchmark thấy memory/entry cao bất thường, kiểm tra: field name dài, payload quá lớn, stream không trim, PEL không ack, nhiều group giữ pending lâu, hoặc AOF/RDB overhead trong môi trường đo.

### 12.2. Big XRANGE — lỗi hay gặp trong incident

```bash
# ❌ Có thể kéo cả triệu entry qua network
XRANGE orders - +

# ✅ Phân trang bằng exclusive range + COUNT
XRANGE orders - + COUNT 1000
XRANGE orders (1783400000456-0 + COUNT 1000
```

---

## 13. Case study thực tế

### 13.1. Order pipeline — e-commerce microservices

Bài toán: sau khi đặt hàng, 4 service phải phản ứng: payment, stock, email, analytics. Mỗi service không được mất event khi deploy/restart; mỗi service có throughput riêng.

```bash
# Order service ghi 1 lần
XADD orders MAXLEN '~' 10000000 '*' event created order_id 8812 amount 250000 uid 42

# Mỗi service một consumer group
XGROUP CREATE orders g:payment   0 MKSTREAM
XGROUP CREATE orders g:stock     0 MKSTREAM
XGROUP CREATE orders g:email     0 MKSTREAM
XGROUP CREATE orders g:analytics 0 MKSTREAM

# Payment service có 3 instance chia tải trong cùng group
XREADGROUP GROUP g:payment pay-1 COUNT 50 BLOCK 5000 STREAMS orders '>'
XACK orders g:payment 1783400000123-0
```

Điểm đáng chú ý:

- **Fan-out + load balancing cùng lúc**: giữa các group là fan-out; trong một group là chia việc.
- Service mới sau 6 tháng? `XGROUP CREATE orders g:fraud 0` để backfill phần lịch sử còn giữ.
- Deploy/restart không làm mất entry đang xử lý: entry nằm trong PEL, janitor `XAUTOCLAIM` nhặt lại.
- Giới hạn rõ: `MAXLEN ~ 10000000` không phải archive vĩnh viễn; analytics dài hạn nên đẩy sang warehouse.

### 13.2. IoT telemetry ingest — buffer trước time-series DB

Bài toán: 50K thiết bị gửi metric mỗi 10s → **~5K msg/s** ổn định, burst **20K msg/s** khi reconnect sau mất mạng. Ghi từng dòng vào TimescaleDB làm DB nghẽn; cần buffer để batch.

```bash
# Gateway nhận MQTT → Redis Stream
XADD telemetry MAXLEN '~' 1000000 '*' dev d-4471 temp 27.4 hum 61 ts 1783400000123

# 4 writer cùng group, mỗi batch 500 metric
XREADGROUP GROUP g:tsdb writer-1 COUNT 500 BLOCK 2000 STREAMS telemetry '>'
# INSERT 500 rows vào TSDB → XACK 500 IDs
```

Vì sao không dùng List? Writer crash giữa batch 500 rows thì List đã pop mất nếu dùng `BRPOP`. Có thể tự chế reliable queue bằng `LMOVE`, nhưng Stream đã có PEL, claim, range theo thời gian, và group thứ hai cho realtime dashboard.

`MAXLEN ~` là van an toàn: nếu TSDB chết 1 giờ, mất metric cũ nhất thay vì OOM Redis. Đây là trade-off phải quyết định trước, không để incident quyết định hộ.

### 13.3. Audit log / activity feed nội bộ

Bài toán: ghi lại mọi thao tác admin, truy vấn theo khoảng thời gian khi điều tra.

```bash
XADD audit MINID '~' 1780800000000 '*' actor admin:7 action refund target order:8812 ip 10.0.3.4

# Điều tra: chuyện gì xảy ra 14:00–14:30?
XRANGE audit 1783605600000 1783607400000 COUNT 1000
```

Entry ID chính là timestamp → Stream tự nhiên là time-index. So với sorted set, Stream có consumer group và append log semantics. So với List, Stream không phá hủy khi đọc và query theo ID/time tốt hơn.

---

## 14. Anti-patterns cần tránh

| ❌ Anti-pattern | Hậu quả | ✅ Cách đúng |
|----------------|---------|-------------|
| Stream không `MAXLEN`/`MINID` | Memory phình vô hạn | Đặt retention ngay trong `XADD` hoặc `XTRIM` định kỳ |
| Không bao giờ `XACK` | PEL tăng mãi, recovery chậm, memory state phình | Ack sau khi side effect thành công; alert `pending` |
| Dùng `XREAD ... $` cho reliable consumer | Miss message giữa hai lần đọc | Lưu `last_id` hoặc dùng consumer group |
| Worker chết nhưng không claim PEL | Message kẹt vô hạn | Chạy janitor `XAUTOCLAIM` theo `min-idle-time` |
| Consumer name random mỗi restart | PEL cũ thành orphan | Dùng tên ổn định: hostname/pod name/instance id |
| Retry poison message mãi | Tốn CPU, block tiến độ, spam downstream | Delivery count threshold + DLQ |
| Dùng Stream cho notify mất được | Overkill, tốn RAM/ops | Dùng [Pub/Sub](./pub-sub.md) nếu fire-and-forget đủ |
| Dùng Pub/Sub cho đơn hàng/thanh toán | Deploy là mất event | Dùng Stream consumer group |
| `XDEL` và nghĩ memory giảm ngay | Macro-node còn entry khác nên RAM không reclaim | Dùng trim; `XDEL` cho GDPR/delete điểm lẻ |
| `XRANGE - +` trên production stream | Kéo cực nhiều data, nghẽn client/network | Luôn dùng `COUNT` + pagination |
| Payload rất lớn trong entry | Redis RAM đắt, replication/AOF nặng | Lưu blob ngoài, Stream lưu reference |

---

## 15. Best Practices

- **Luôn thiết kế retention trước khi go-live**: `MAXLEN ~` theo số entry hoặc `MINID ~` theo tuổi.
- **Batch mọi thứ có thể**: `XREADGROUP COUNT 100/500/1000`, `XACK` nhiều ID, pipeline producer; xem [Pipelining & Batching](./pipelining-batching.md).
- **Consumer idempotent**: dùng `order_id`, `event_id`, hoặc stream ID làm idempotency key ở downstream.
- **Janitor là thành phần bắt buộc**: định kỳ `XAUTOCLAIM`, xử lý delivery count, đẩy DLQ.
- **Dashboard PEL/lag**: alert khi pending tăng đều, idle consumer quá lâu, stream length gần memory budget.
- **Schema nhỏ và ổn định**: tận dụng listpack macro-node; tránh field name dài lặp lại vô ích.
- **Shard theo entity nếu cần scale ghi**: ví dụ `orders:{0}`, `orders:{1}`... Trong [Cluster](./cluster.md), một stream key thuộc một hash slot; muốn scale ngang phải nhiều key/slot.
- **Kết hợp persistence phù hợp**: reliable messaging mà tắt AOF/RDB có thể vẫn mất data khi Redis crash; xem [Redis Overview](./redis-overview.md) và [Persistence Strategies](./persistence-strategies.md).

---

## 16. Tóm tắt — cheat-sheet, decision table và 3 nguyên tắc

### 16.1. Command cheat-sheet

| Mục tiêu | Command |
|----------|---------|
| Ghi event | `XADD stream MAXLEN '~' N '*' field value ...` |
| Đọc range | `XRANGE stream start end COUNT n` |
| Đọc mới không group | `XREAD BLOCK ms COUNT n STREAMS stream last_id` |
| Tạo group từ đầu | `XGROUP CREATE stream group 0 MKSTREAM` |
| Tạo group chỉ future | `XGROUP CREATE stream group '$' MKSTREAM` |
| Worker lấy việc mới | `XREADGROUP GROUP group consumer COUNT n BLOCK ms STREAMS stream '>'` |
| Worker đọc lại pending của mình | `XREADGROUP GROUP group consumer STREAMS stream 0` |
| Ack | `XACK stream group id [id ...]` |
| Xem pending | `XPENDING stream group - + count [consumer]` |
| Claim tự động | `XAUTOCLAIM stream group consumer min-idle start COUNT n` |
| Trim | `XTRIM stream MAXLEN '~' N` hoặc `XTRIM stream MINID '~' id` |
| Inspect | `XINFO STREAM/GROUPS/CONSUMERS ...` |

### 16.2. Messaging pattern decision

| Nếu bạn cần... | Chọn |
|----------------|------|
| Realtime broadcast, subscriber offline mất cũng được | Pub/Sub |
| Queue cực đơn giản, một nhóm worker, pop là xong | List |
| Queue/event log có ack, retry, replay, nhiều group | Stream |
| Log distributed nhiều TB, retention dài, connector ecosystem | Kafka |

### 16.3. Ba nguyên tắc nhớ lâu

1. **Stream là log, không phải hàng đợi tự xóa** — ack không xóa data; retention mới xóa data.
2. **PEL là hợp đồng retry** — đã giao nhưng chưa ack thì phải có janitor, idempotency và DLQ.
3. **Macro-node quyết định performance** — `MAXLEN ~`, entry nhỏ, schema ổn định giúp Stream vừa nhanh vừa gọn.

Nếu Pub/Sub là tiếng loa trong phòng — ai có mặt thì nghe — thì Stream là cuốn sổ nhật ký có đánh số dòng. Worker có thể ngủ, deploy, crash, rồi quay lại hỏi: "Tôi đã đọc đến dòng nào?". Sự khác biệt giữa mất 18.000 đơn và xử lý lại an toàn đôi khi chỉ nằm ở câu hỏi đó.

---

## Tài liệu tham khảo

- [Redis Streams intro](https://redis.io/docs/latest/develop/data-types/streams/)
- [XADD command docs](https://redis.io/docs/latest/commands/xadd/)
- [XREADGROUP command docs](https://redis.io/docs/latest/commands/xreadgroup/)
- [XPENDING command docs](https://redis.io/docs/latest/commands/xpending/)
- [XCLAIM command docs](https://redis.io/docs/latest/commands/xclaim/)
- [XAUTOCLAIM command docs](https://redis.io/docs/latest/commands/xautoclaim/)
- [Pub/Sub](./pub-sub.md) — khi chỉ cần realtime broadcast
- [Lists](./lists.md) — queue đơn giản và blocking pop
- [Cluster](./cluster.md) — sharding nhiều stream key theo hash slot
- [Persistence Strategies](./persistence-strategies.md) — độ bền dữ liệu Redis
- [Pipelining & Batching](./pipelining-batching.md) — tăng throughput producer/consumer
- [Redis Overview](./redis-overview.md) — nền tảng Redis và trade-off vận hành
