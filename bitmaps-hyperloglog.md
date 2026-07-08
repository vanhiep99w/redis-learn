# Bitmaps & HyperLogLog

## Mục lục

- [1. Bài toán đếm lớn: biết ai, hay chỉ cần biết bao nhiêu?](#1-bài-toán-đếm-lớn-biết-ai-hay-chỉ-cần-biết-bao-nhiêu)
- [2. Tổng quan: hai vũ khí cho bài toán đếm lớn](#2-tổng-quan-hai-vũ-khí-cho-bài-toán-đếm-lớn)
- [3. Bitmap internals — String biến thành mảng bit](#3-bitmap-internals--string-biến-thành-mảng-bit)
- [4. Bitmap commands & complexity](#4-bitmap-commands--complexity)
- [5. Patterns với Bitmap: DAU, MAU, retention](#5-patterns-với-bitmap-dau-mau-retention)
- [6. BITFIELD — packed counters trong một String](#6-bitfield--packed-counters-trong-một-string)
- [7. HyperLogLog internals — đếm bằng độ hiếm](#7-hyperloglog-internals--đếm-bằng-độ-hiếm)
- [8. HLL commands, sparse/dense encoding & merge](#8-hll-commands-sparsedense-encoding--merge)
- [9. Benchmark memory: Set vs Bitmap vs HLL](#9-benchmark-memory-set-vs-bitmap-vs-hll)
- [10. Chọn công cụ đếm: Set vs Bitmap vs HLL](#10-chọn-công-cụ-đếm-set-vs-bitmap-vs-hll)
- [11. Case study thực tế](#11-case-study-thực-tế)
- [12. Anti-patterns cần tránh](#12-anti-patterns-cần-tránh)
- [13. Best Practices](#13-best-practices)
- [14. Tóm tắt — cheat sheet & 3 nguyên tắc](#14-tóm-tắt--cheat-sheet--3-nguyên-tắc)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## 1. Bài toán đếm lớn: biết ai, hay chỉ cần biết bao nhiêu?

Đếm là một trong những việc phổ biến nhất của mọi hệ thống: bao nhiêu user active hôm nay, bao nhiêu unique visitor tuần này, cohort tuần trước còn bao nhiêu người quay lại. Nghe đơn giản, nhưng khi số lượng lên tới hàng chục, hàng trăm triệu, cách đếm quyết định hóa đơn RAM.

Phản xạ đầu tiên là dùng [Set](./sets.md): mỗi user là một member, `SCARD` để đếm, `SISMEMBER` để hỏi membership (kiểm tra “X có thuộc tập không?”) của từng người.

```bash
SADD active:2026-07-07 42 10001 918273
SCARD active:2026-07-07              # đếm chính xác
SISMEMBER active:2026-07-07 42       # user 42 có active không?
```

Chính xác tuyệt đối, nhưng đắt: với hàng trăm triệu member, Set ngốn nhiều GB vì mỗi phần tử kéo theo object overhead, bucket hashtable và fragmentation. Nhân lên vài chục ngày lưu trữ là hóa đơn RAM khổng lồ.

Trước khi chọn công cụ, hãy hỏi một câu quyết định: bạn cần **biết chính xác từng ai**, hay chỉ cần **con số xấp xỉ**? Redis cho hai lời giải rất khác nhau cho hai nhu cầu đó:

- **Bitmap** — chính xác, hỏi được từng cá nhân, memory = `max_id / 8` bytes (hợp khi id là số nguyên liên tục).
- **HyperLogLog** — chỉ ước lượng số lượng (probabilistic: dùng xác suất, có sai số ~0.81%), không hỏi được cá nhân, nhưng mỗi key tối đa chỉ ~12KB dù đếm tới hàng tỉ phần tử.

Doc này giải thích cơ chế bên trong của cả hai (bit array, và thuật toán "đếm bằng độ hiếm" của HLL), khi nào chọn cái nào, và cách phối hợp chúng cho các dashboard DAU/MAU, retention và unique visitor.

---

## 2. Tổng quan: hai vũ khí cho bài toán đếm lớn

| Tiêu chí | Bitmap | HyperLogLog |
|---|---|---|
| Bản chất | [String](./strings.md) dùng như mảng bit | Probabilistic cardinality structure (cấu trúc ước lượng số phần tử distinct) lưu trong String |
| Kết quả | Chính xác 100% | Ước lượng, standard error (độ lệch chuẩn kỳ vọng) ~**0.81%** |
| Memory | `offset_lớn_nhất / 8` bytes, tối đa 512MB | Sparse (nén khi còn ít register khác 0) vài byte/KB, dense (mảng register đầy đủ) tối đa ~12KB |
| Dữ liệu đầu vào | ID số nguyên compact: `0..N` | Bất kỳ string/bytes: UUID, IP, email hash |
| Membership | ✅ `GETBIT` | ❌ Không thể hỏi “X có trong tập không?” |
| Union | ✅ `BITOP OR` | ✅ `PFCOUNT k1 k2`, `PFMERGE` |
| Intersection | ✅ `BITOP AND` | ❌ Không hỗ trợ trực tiếp |
| Use case vàng | DAU/retention/cohort exact | Unique visitors/search/IP analytics |

Một điểm dễ nhầm: Bitmap và HLL đều “nằm trên String” trong Redis. Nhưng ý nghĩa hoàn toàn khác:

```diagram
Redis String bytes
├─ Bitmap: byte nào, bit nào tương ứng với user_id nào → còn truy vết được membership
└─ HLL: bytes là registers (ô nhớ nhỏ giữ thống kê) sau khi hash → mất danh tính phần tử, chỉ còn ước lượng cardinality
```

---

## 3. Bitmap internals — String biến thành mảng bit

Bitmap **không phải data type riêng**. Cách dễ hình dung nhất: Redis lấy một String binary-safe và coi nó như cuộn giấy ô vuông rất dài, mỗi ô là một bit có số thứ tự. Bạn đọc/ghi từng bit bằng offset.

```bash
SETBIT active:2026-07-07 10 1
GETBIT active:2026-07-07 10
```

```diagram
Key: active:2026-07-07

byte index:      0          1          2
             ┌────────┬────────┬────────┐
bits:        │00000000│00100000│00000000│ ...
             └────────┴────────┴────────┘
bit offset:   01234567 89abcdef 01234567
                         ▲
                         offset 10 = byte 1, bit trong byte

Công thức:
  byte_index = floor(offset / 8)
  bit_index  = offset % 8
  memory     ≈ (max_offset + 1) / 8 bytes
```

### 3.1. Giới hạn 512MB và cái bẫy offset cao

Giới hạn này quan trọng vì Bitmap phình theo **offset lớn nhất**, không theo số bit đang bật.

Vì Bitmap là String, nó chịu giới hạn String tối đa **512MB**. 512MB = `2^29` bytes = **2^32 bits** ≈ **4.29 tỷ offset**.

| Offset cao nhất đã set | Memory tối thiểu của key | Ghi chú |
|---:|---:|---|
| 999 | 125 bytes | Nhỏ không đáng kể |
| 9,999,999 | ~1.25MB | 10 triệu user compact |
| 99,999,999 | ~12.5MB | 100 triệu user compact |
| 999,999,999 | ~125MB | Vẫn hợp lý nếu thật sự cần exact membership |
| 4,000,000,000 | ~500MB | Một lệnh `SETBIT` có thể cấp phát khổng lồ |

> [!WARNING]
> `SETBIT key 4000000000 1` trên key rỗng pad ~**500MB** và có thể **block event loop** lúc cấp phát ([Redis Overview](./redis-overview.md)). ID UUID/snowflake thưa → HLL hoặc mapping int, đừng dùng làm offset.

### 3.2. Vì sao BITCOUNT nhanh nhưng vẫn là O(N)?

Điểm cần nhớ: `BITCOUNT` nhanh vì CPU rất giỏi đếm bit, nhưng Redis vẫn phải quét qua vùng bytes cần đếm.

`BITCOUNT` không đi từng bit một kiểu ngây thơ. Redis đếm theo byte/word và tận dụng kỹ thuật **population count** (popcount): CPU có instruction hoặc thuật toán word-at-a-time để đếm số bit `1` cực nhanh.

```diagram
Bitmap 12.5MB cho 100M user

[64-bit word][64-bit word][64-bit word] ...
     │            │            │
  popcount     popcount     popcount
     └────────────┴────────────┴──▶ cộng tổng

O(N bytes), nhưng hằng số nhỏ: đọc tuần tự memory, cache-friendly.
```

> [!NOTE]
> “Nhanh” không có nghĩa “miễn phí”. `BITCOUNT` trên bitmap 512MB vẫn phải đọc 512MB. Dùng tốt cho job/dashboard; tránh đặt trong request path nóng nếu key có thể phình lớn.

Redis 7.0 hỗ trợ range theo `BYTE` hoặc `BIT`:

```bash
BITCOUNT active:2026-07-07 0 999999 BIT     # đếm 1 triệu bit đầu
BITCOUNT active:2026-07-07 0 124999 BYTE    # tương đương 125KB đầu
```

---

## 4. Bitmap commands & complexity

| Command | Complexity | Dùng để | Gotcha |
|---|---:|---|---|
| `SETBIT key offset 0|1` | O(1) | Bật/tắt bit, trả bit cũ | Offset cao cấp phát toàn bộ range |
| `GETBIT key offset` | O(1) | Membership exact | Offset ngoài String trả `0` |
| `BITCOUNT key [start end [BYTE|BIT]]` | O(N) | Đếm số bit `1` | N = số byte/bit trong range |
| `BITPOS key 0|1 [start end [BYTE|BIT]]` | O(N) | Tìm bit đầu tiên | `BITPOS 0` có semantics đặc biệt khi ngoài string là zero |
| `BITOP AND|OR|XOR|NOT dst src...` | O(N) | Union/intersection/diff-like | N = key dài nhất, key ngắn được pad `0` |
| `BITFIELD key ...` | O(1)/subcommand | Packed counters/flags | Phải chọn width & overflow cẩn thận |

Ví dụ thao tác cơ bản:

```bash
# Ghi nhận user active
SETBIT active:2026-07-07 42 1

# Check membership — exact, O(1)
GETBIT active:2026-07-07 42

# Đếm DAU
BITCOUNT active:2026-07-07

# Tìm user_id đầu tiên active
BITPOS active:2026-07-07 1
```

> [!TIP]
> Với dữ liệu derived như kết quả `BITOP`, đặt TTL. Bitmap nguồn theo ngày có thể giữ 90 ngày, còn bitmap `tmp:retention:*` chỉ cần sống vài phút/giờ.

---

## 5. Patterns với Bitmap: DAU, MAU, retention

Bitmap tỏa sáng khi cùng một universe ID compact được hỏi theo nhiều lát cắt thời gian.

### 5.1. DAU/WAU/MAU bằng OR

```bash
# Mỗi lần user hoạt động:
SETBIT active:2026-07-07 <user_id> 1

# DAU hôm nay:
BITCOUNT active:2026-07-07

# WAU — user active ít nhất một ngày trong 7 ngày:
BITOP OR active:week:27 active:2026-07-01 active:2026-07-02 active:2026-07-03 active:2026-07-04 active:2026-07-05 active:2026-07-06 active:2026-07-07
BITCOUNT active:week:27
EXPIRE active:week:27 3600
```

```diagram
active Mon:  10010010
active Tue:  01010000
active Wed:  00000110
             -------- OR
WAU:         11010110  → count = 5 unique users trong tuần
```

### 5.2. Retention/cohort bằng AND

```bash
# Cohort install ngày 1 và active ngày 7
SETBIT signup:2026-07-01 <user_id> 1
SETBIT active:2026-07-07 <user_id> 1

BITOP AND retained:d1:d7 signup:2026-07-01 active:2026-07-07
BITCOUNT retained:d1:d7
EXPIRE retained:d1:d7 3600
```

```diagram
signup D1:    11110000
active D7:    10101010
              -------- AND
retained:     10100000  → users vừa signup D1 vừa active D7
```

HLL có thể cho bạn `|signup ∪ active|`, nhưng không thể cho bitmap giao chính xác. Đây là lý do dashboard retention realtime thường chọn Bitmap nếu user_id compact.

---

## 6. BITFIELD — packed counters trong một String

`BITFIELD` nâng Bitmap từ “mảng bit” thành “mảng số nguyên bit-width tùy ý”. Bạn có thể đặt nhiều counter nhỏ trong một key: `u4`, `u8`, `i16`, `u32`, thậm chí width tới 64 bit tùy signed/unsigned theo command.

```bash
# Mảng u16 counter: user_id làm index, mỗi counter 16 bit
BITFIELD counters:level SET u16 '#42' 100
BITFIELD counters:level INCRBY u16 '#42' 5
BITFIELD counters:level GET u16 '#42'

# Nhiều op trong một lệnh — atomic
BITFIELD counters:level INCRBY u16 '#42' 1 GET u16 '#42'
```

`#42` nghĩa là offset theo **đơn vị type**: phần tử thứ 42 của mảng `u16` = bit offset `42 * 16`. Không có `#` thì offset là bit tuyệt đối.

```diagram
BITFIELD counters:level u16

index:      #0        #1        #2              #42
        ┌────────┬────────┬────────┬── ... ──┬────────┐
        │ 16 bit │ 16 bit │ 16 bit │         │ 16 bit │
        └────────┴────────┴────────┴── ... ──┴────────┘

1,000,000 counters u16 = 2,000,000 bytes ≈ 2MB
```

### 6.1. Overflow: WRAP, SAT, FAIL

```bash
BITFIELD hp SET u8 '#0' 250
BITFIELD hp OVERFLOW SAT  INCRBY u8 '#0' 10   # → 255 (kẹt trần)
BITFIELD hp OVERFLOW WRAP INCRBY u8 '#0' 10   # → 4   (quay vòng)
BITFIELD hp OVERFLOW FAIL INCRBY u8 '#0' 10   # → nil (từ chối)
```

| Mode | Khi vượt range | Dùng cho |
|---|---|---|
| `WRAP` | Quay vòng modulo | Counter kiểu vòng, mặc định Redis |
| `SAT` | Kẹt ở min/max | HP, quota, level cap |
| `FAIL` | Trả `nil`, không ghi | Logic cần phát hiện overflow |

Use case: game stats (HP/mana/level), quota nhỏ theo user, packed time-series counters, per-user attribute flags. Nếu cần đếm leaderboard/ranking, xem thêm [leaderboard-counting.md](./leaderboard-counting.md) vì Sorted Set thường phù hợp hơn.

---

## 7. HyperLogLog internals — đếm bằng độ hiếm

HyperLogLog trả lời một câu duy nhất: **tập này có khoảng bao nhiêu phần tử distinct?** Nó không lưu phần tử. Nó lưu “dấu vết thống kê” sau khi hash, nên đổi khả năng truy vết từng phần tử lấy memory cực nhỏ.

### 7.1. Trực giác: chuỗi zero càng dài càng hiếm

Đây là ý tưởng đời thường của HLL: nếu bạn quan sát được một sự kiện rất hiếm, bạn có lý do để đoán rằng đã có rất nhiều lần thử phía sau.

Tưởng tượng tung đồng xu công bằng. Nếu bạn thấy chuỗi **20 lần mặt ngửa liên tiếp**, khả năng cao bạn đã tung rất nhiều lần — vì sự kiện đó có xác suất khoảng `1 / 2^20`.

HLL thay đồng xu bằng hash bit:

```diagram
Element: "user:42"
       │
       ▼
Hash 64-bit:  010011010101000000000000101101...
              └────14 bit────┘└── phần còn lại ──┘
                    │                 │
                    │                 └─ đếm leading zeros/rank
                    └─ chọn 1 trong 2^14 = 16,384 registers

Register được cập nhật:
  registers[index] = max(registers[index], rank)
```

Một hash có 18 zero liên tiếp ở phần rank là sự kiện hiếm; nếu đã thấy nó, cardinality chắc không nhỏ. Nhưng một register quá nhiễu, nên HLL dùng **16,384 registers** rồi lấy trung bình điều hòa (harmonic mean — cách trung bình giảm ảnh hưởng của vài giá trị cực lớn) kèm bias correction.

### 7.2. Vì sao sai số là 0.81%?

Câu trả lời ngắn: HLL càng có nhiều register độc lập thì nhiễu càng được triệt tiêu; Redis cố định số register ở mức cho sai số khoảng 0.81%.

Công thức sai số chuẩn của HyperLogLog xấp xỉ:

```text
standard_error = 1.04 / sqrt(m)
Redis dùng m = 2^14 = 16,384 registers
=> 1.04 / sqrt(16384) = 1.04 / 128 ≈ 0.008125 = 0.8125%
```

| Unique thật | Sai số chuẩn 0.81% ≈ | Kỳ vọng đọc PFCOUNT |
|---:|---:|---|
| 10,000 | ±81 | Khoảng 9,919–10,081 thường gặp |
| 1,000,000 | ±8,100 | Khoảng 991,900–1,008,100 thường gặp |
| 100,000,000 | ±810,000 | Đủ tốt cho analytics, không đủ cho billing |

> [!IMPORTANT]
> 0.81% là **standard error**, không phải “Redis cam kết luôn nằm trong ±0.81%”. Với analytics, trend, dashboard, A/B monitoring thường ổn. Với billing, quota pháp lý, payout — dùng cấu trúc exact.

### 7.3. 12KB đến từ đâu?

Con số 12KB không phải “ước lượng marketing”; nó đến trực tiếp từ số register và số bit cần để lưu mỗi rank.

Mỗi register cần lưu rank tối đa khoảng 50–64, nên 6 bit là đủ. Redis dùng 16,384 registers:

```text
16,384 registers × 6 bits = 98,304 bits = 12,288 bytes = 12KB
```

Đổi lại, HLL không thể:

- Liệt kê phần tử.
- Xóa một phần tử riêng lẻ.
- Hỏi `user X có trong tập không?`.
- Tính intersection chính xác.

---

## 8. HLL commands, sparse/dense encoding & merge

Sparse/dense encoding là cách Redis chọn “đóng gói tiết kiệm cho tập nhỏ” hay “mảng cố định cho tập lớn” mà không đổi API bên ngoài. Về phía người dùng, chỉ có ba lệnh chính:

| Command | Complexity | Ý nghĩa | Ghi chú |
|---|---:|---|---|
| `PFADD key element [element ...]` | O(1) mỗi element | Thêm phần tử vào HLL | Trả `1` nếu internal estimate/register thay đổi, `0` nếu không |
| `PFCOUNT key [key ...]` | O(1) với 1 key; nhiều key phải union tạm | Đếm cardinality ước lượng | Nhiều key = cardinality của **union** |
| `PFMERGE dest source [source ...]` | O(N) theo số HLL source/register | Gộp union vào dest | Register dest = max từng register |

```bash
# Unique visitors mỗi trang mỗi ngày
PFADD uv:home:2026-07-07 ip1 ip2 ip3
PFCOUNT uv:home:2026-07-07

# Unique cả tuần — có thể đếm union trực tiếp
PFCOUNT uv:home:2026-07-01 uv:home:2026-07-02 uv:home:2026-07-03

# Hoặc materialize để dashboard gọi nhiều lần
PFMERGE uv:home:week:27 uv:home:2026-07-01 uv:home:2026-07-02 uv:home:2026-07-03
PFCOUNT uv:home:week:27
EXPIRE uv:home:week:27 86400
```

> [!NOTE]
> `PFCOUNT k1 k2 k3` trả cardinality của `k1 ∪ k2 ∪ k3`, không phải tổng từng ngày. User vào cả 3 ngày vẫn được ước lượng là 1 unique trong union.

### 8.1. Sparse vs dense encoding

Với HLL ít phần tử, phần lớn register vẫn bằng 0; sparse encoding tận dụng điều đó để chưa phải trả ngay 12KB.

Redis HLL cũng được tối ưu cho tập nhỏ:

| Encoding | Khi nào | Memory | Ý tưởng |
|---|---|---:|---|
| Sparse | Ít register khác 0 | Vài chục byte đến vài KB | Nén run-length các register 0 |
| Dense | Khi sparse vượt ngưỡng | ~12KB | Mảng 16,384 register 6-bit |

Ngưỡng cấu hình là `hll-sparse-max-bytes` (mặc định thường là **3000 bytes**). Khi sparse representation vượt ngưỡng, Redis tự promote sang dense.

```bash
TYPE uv:home:2026-07-07          # string
DEBUG OBJECT uv:home:2026-07-07  # có thể xem serializedlength/encoding khi môi trường cho phép
```

> [!TIP]
> Vì HLL lưu trong String, bạn có thể `DEL`, `EXPIRE`, `RENAME`, replicate/persist như key Redis bình thường. Nhưng đừng dùng `GET` rồi tự sửa bytes nếu không hiểu encoding nội bộ.

### 8.2. Merge: siêu năng lực và giới hạn

Merge quan trọng vì analytics thường cần đếm unique theo tuần/tháng từ nhiều key ngày mà vẫn không double-count user lặp lại.

Merge HLL rất đẹp vì mỗi register giữ max rank từng thấy:

```diagram
HLL A registers: [3, 0, 5, 1, ...]
HLL B registers: [2, 4, 1, 7, ...]
                 -------------------- max từng vị trí
A ∪ B:           [3, 4, 5, 7, ...]
```

Đó là union lossless đối với trạng thái HLL. Nhưng intersection thì không có trạng thái đủ để làm chính xác. Inclusion-exclusion `|A∩B| = |A| + |B| - |A∪B|` có thể dùng để ước lượng thô, nhưng sai số cộng dồn và dễ tệ khi intersection nhỏ.

---

## 9. Benchmark memory: Set vs Bitmap vs HLL

Giả định cần đếm unique user theo ngày. Set lưu user_id dạng string/integer trong Redis, overhead thực tế phụ thuộc encoding, allocator, độ dài member; bảng dưới dùng con số bảo thủ để nhìn bậc độ lớn, không phải benchmark tuyệt đối.

| Cardinality/ngày | Exact Set ước tính | Bitmap nếu ID compact `0..max_id` | HLL | Ai thắng? |
|---:|---:|---:|---:|---|
| 1,000 | ~50–100KB | 125 bytes nếu max_id < 1K; có thể lớn nếu max_id cao | sparse ~hundreds bytes–KB | Bitmap nếu ID dense; HLL nếu ID arbitrary |
| 1,000,000 | ~50–100MB | ~125KB | ≤12KB | HLL cho count-only; Bitmap cho membership |
| 100,000,000 | ~5–10GB | ~12.5MB | ≤12KB | HLL cực rẻ; Bitmap vẫn rất tốt nếu cần exact |

Một bảng khác nhìn theo `max_id`, vì Bitmap phụ thuộc **offset lớn nhất**, không phụ thuộc số bit bật:

| Số user active thật | Max user_id | Bitmap memory | Nhận xét |
|---:|---:|---:|---|
| 1,000 | 1,000 | 125 bytes | Tuyệt vời |
| 1,000 | 100,000,000 | 12.5MB | Có thể vẫn chấp nhận, nhưng không còn “rẻ” |
| 1,000 | 4,000,000,000 | ~500MB | Anti-pattern nghiêm trọng |

> [!WARNING]
> “Cardinality nhỏ” không làm Bitmap nhỏ nếu offset lớn. Với HLL thì ngược lại: memory gần như độc lập cardinality, nhưng bạn mất membership và exactness.

---

## 10. Chọn công cụ đếm: Set vs Bitmap vs HLL

| Câu hỏi / Nhu cầu | Set | Bitmap | HLL |
|---|---|---|---|
| Đếm unique chính xác | ✅ | ✅ | ❌ Ước lượng |
| Membership `X có trong tập không?` | ✅ | ✅ | ❌ |
| Liệt kê phần tử | ✅ `SSCAN` | ⚠️ Có thể scan bit nhưng không tiện | ❌ |
| ID không phải số compact | ✅ | ❌ | ✅ |
| Union | ✅ `SUNION` | ✅ `BITOP OR` | ✅ `PFCOUNT`/`PFMERGE` |
| Intersection | ✅ `SINTER` | ✅ `BITOP AND` | ❌ |
| Memory cho 100M | Rất cao | Thấp nếu dense ID | Cực thấp |
| Attribute flags/counters | ⚠️ Không tự nhiên | ✅ `SETBIT`/`BITFIELD` | ❌ |

Cây quyết định thực dụng:

```diagram
Bạn cần liệt kê phần tử hoặc lưu dữ liệu kèm theo?
├─ Có  → Set / DB / Sorted Set
└─ Không
   Bạn cần hỏi membership exact từng user?
   ├─ Có
   │  ID có compact và max_id kiểm soát được?
   │  ├─ Có  → Bitmap
   │  └─ Không → Set hoặc tạo mapping ID → integer
   └─ Không
      Chỉ cần unique count analytics và chấp nhận ~1% sai?
      ├─ Có  → HyperLogLog
      └─ Không → Set/Bitmap exact tùy ID
```

### Khi nào KHÔNG nên dùng Bitmap

- ID thưa hoặc không phải số compact như UUID/snowflake: dùng HLL nếu chỉ cần đếm, hoặc tạo mapping ID → integer compact nếu vẫn cần membership.
- Cần đếm count-only cực lớn và chấp nhận sai số analytics: HLL tiết kiệm memory hơn nhiều.
- Cần liệt kê phần tử: dùng Set, vì scan bit để dựng lại danh sách user không tiện và dễ tốn chi phí vận hành.

### Khi nào KHÔNG nên dùng HyperLogLog

- Cần membership “X có trong tập không?”: dùng Bitmap nếu ID compact, hoặc Set nếu ID arbitrary.
- Cần chính xác tuyệt đối cho billing/quota/payout: dùng Set/Bitmap exact hoặc DB transaction.
- Cần intersection chính xác: dùng Bitmap (`BITOP AND`) hoặc Set (`SINTER`).
- Cần liệt kê hoặc xóa từng phần tử riêng lẻ: dùng Set; HLL đã quên danh tính phần tử sau khi hash.

Liên hệ nhanh với các topic khác:

- Cần lưu raw string, TTL, binary payload → [strings.md](./strings.md)
- Cần membership + liệt kê phần tử arbitrary → [sets.md](./sets.md)
- Cần tối ưu RAM/eviction/fragmentation → [memory-management.md](./memory-management.md)
- Cần ranking/top N → [leaderboard-counting.md](./leaderboard-counting.md)

---

## 11. Case study thực tế

### 11.1. Bảng điểm danh & streak — app học tập kiểu Duolingo

Bài toán: hiển thị lịch hoạt động 365 ngày + chuỗi ngày liên tiếp cho từng user; 20 triệu user.

```bash
# Mỗi user một bitmap theo năm, bit = day-of-year (0..364)
SETBIT streak:42:2026 187 1

BITCOUNT streak:42:2026     # số ngày học trong năm
GETBIT streak:42:2026 186   # hôm qua có học không?
GET streak:42:2026          # lấy 46 bytes về app vẽ calendar/streak
```

```diagram
User 42 - year 2026

Day:   0 1 2 3 4 5 6 ... 186 187 188 ... 364
Bit:   1 1 0 1 0 0 1 ...  1   1   0  ...  0
                              ▲   ▲
                           hôm qua hôm nay
```

365 bit = **46 bytes/user/năm**. 20 triệu user ≈ 920MB raw bitmap data cho cả năm — nghe lớn nhưng vẫn nhỏ hơn rất nhiều so với 20M × 365 rows trong database. Và render calendar chỉ cần một lệnh `GET`, không phải 365 lệnh.

> [!TIP]
> Có hai chiều thiết kế key: `active:<date>` để hỏi DAU/cohort theo ngày, hoặc `streak:<user>:<year>` để hỏi lịch của một user. Chọn chiều theo query nóng nhất.

### 11.2. Funnel & retention dashboard — growth team

Bài toán: “trong những người cài app tuần 27, bao nhiêu % còn active tuần 28/29/30?” Warehouse query chạy vài phút; dashboard muốn gần realtime.

```bash
SETBIT cohort:install:w27 91234 1
SETBIT active:w28 91234 1

BITOP AND tmp:ret:w27:w28 cohort:install:w27 active:w28
BITCOUNT tmp:ret:w27:w28
BITCOUNT cohort:install:w27
EXPIRE tmp:ret:w27:w28 3600
```

```diagram
cohort install W27:  111111000000
active W28:          101100110000
                     ------------ AND
retained W28:        101100000000

retention = BITCOUNT(retained) / BITCOUNT(cohort)
```

Toàn bộ ma trận retention 8 tuần chỉ là nhiều phép `BITOP AND` trên bitmap vài MB. Set làm được nhưng tốn RAM lớn hơn nhiều; HLL rẻ hơn nhưng không có intersection exact.

### 11.3. Realtime unique visitors — analytics widget

Bài toán: cung cấp widget “unique visitors hôm nay/7 ngày/30 ngày” cho 50K website khách hàng. Visitor định danh bằng cookie UUID, không phải số compact.

```bash
# Mỗi pageview
PFADD uv:site881:2026-07-07 "c-550e8400-e29b-41d4-a716-446655440000"

# Widget — mỗi số là một lệnh
PFCOUNT uv:site881:2026-07-07
PFCOUNT uv:site881:2026-07-01 uv:site881:2026-07-02 uv:site881:2026-07-03 uv:site881:2026-07-04 uv:site881:2026-07-05 uv:site881:2026-07-06 uv:site881:2026-07-07
PFMERGE uv:site881:m:2026-07 uv:site881:2026-07-01 uv:site881:2026-07-02 uv:site881:2026-07-03
```

50K site × 30 ngày × 12KB = ~18GB worst-case dense. Nhưng thực tế phần lớn site nhỏ nằm ở sparse encoding, nên footprint có thể thấp hơn đáng kể. Nếu dùng Set với UUID 36 byte, một site lớn 1M visitor/day có thể ăn hàng chục MB/ngày; HLL giữ ở 12KB và sai số 0.81% hoàn toàn chấp nhận cho analytics.

---

## 12. Anti-patterns cần tránh

| ❌ Anti-pattern | Vì sao sai | ✅ Làm đúng |
|---|---|---|
| `SETBIT active <snowflake_id> 1` với ID cực lớn/thưa | Offset cao cấp phát String khổng lồ | Dùng HLL nếu chỉ đếm; hoặc mapping ID → integer compact nếu cần membership |
| Dùng HLL để check “user X đã active chưa?” | HLL không lưu membership | Bitmap/Set |
| Dùng HLL cho billing/payout/quota pháp lý | Sai số xác suất có thể gây tranh chấp | Set/Bitmap exact, hoặc DB transaction |
| Dùng Set cho 100M cardinality chỉ để `SCARD` | RAM blowup nhiều GB | HLL nếu count-only; Bitmap nếu ID dense và cần exact |
| `BITOP` trên bitmap độ dài khác nhau mà không để ý | Key ngắn được xem như pad `0`, kết quả có thể “thiếu” universe mong muốn | Chuẩn hóa key theo cùng universe/time window, document max_id |
| `BITCOUNT` bitmap hàng trăm MB trong request path | O(N) đọc nhiều memory, block Redis single thread | Precompute bằng job, cache kết quả, range count nếu có thể |
| Quên TTL cho key ngày/tháng | Time-series keys tăng mãi | Đặt retention policy, xem thêm [memory-management.md](./memory-management.md) |
| Cộng `PFCOUNT` từng ngày để ra unique tuần | Double-count user xuất hiện nhiều ngày | Dùng `PFCOUNT day1 day2 ...` hoặc `PFMERGE` rồi `PFCOUNT` |

---

## 13. Best Practices

- **Kiểm tra distribution của ID trước khi chọn Bitmap**: hỏi `max_id` hiện tại, tốc độ tăng, có lỗ hổng lớn không.
- **Namespace key theo thời gian rõ ràng**: `active:2026-07-07`, `uv:site881:2026-07-07`, `cohort:install:w27`.
- **Đặt TTL theo retention policy**: daily bitmap/HLL có thể giữ 90 ngày; aggregate tuần/tháng giữ lâu hơn.
- **Materialize aggregate nóng**: dashboard gọi liên tục thì `BITOP`/`PFMERGE` trước, lưu key tạm, không merge lại mỗi request.
- **Pipeline write-heavy events**: `SETBIT`/`PFADD` rất rẻ nhưng round-trip network vẫn đắt.
- **BITFIELD chọn width dư một chút**: counter `u8` chỉ tới 255; nếu product tăng limit lên 500, bạn sẽ phải migrate.
- **Theo dõi memory thật**: dùng `MEMORY USAGE key`, `INFO memory`, fragmentation; đọc thêm [memory-management.md](./memory-management.md).

---

## 14. Tóm tắt — cheat sheet & 3 nguyên tắc

### Cheat sheet chọn công cụ

| Cardinality | Membership cần không? | ID có dense không? | Exact cần không? | Chọn |
|---:|---|---|---|---|
| ≤ 100K | Có + cần liệt kê | Bất kỳ | Có | Set |
| 1M–1B | Có | Có, max_id hợp lý | Có | Bitmap |
| 1M–1B | Không | Bất kỳ | Không, analytics | HLL |
| Nhỏ nhưng ID là UUID | Có | Không | Có | Set hoặc mapping UUID → int + Bitmap |
| Attribute flags/counters | Có theo user_id | Có | Có | Bitmap/BITFIELD |
| Unique visitor/search query/IP | Không | Không liên quan | Không | HLL |

### 3 nguyên tắc nhớ lâu

1. **Bitmap rẻ theo max ID, không theo số phần tử bật** — offset 4 tỷ là 500MB dù chỉ có 1 user.
2. **HLL rẻ vì nó quên danh tính phần tử** — 12KB đổi lấy việc không membership, không delete element, không exact.
3. **Set là dao đa năng nhưng đắt** — dùng khi cần liệt kê/membership arbitrary; đừng dùng chỉ để đếm 100M unique nếu HLL đủ.

Nếu phải nhớ một câu: **“Cần biết ai thì Bitmap/Set; chỉ cần biết khoảng bao nhiêu thì HLL.”** Đó là khác biệt giữa dashboard chạy trong 5ms với cụm Redis cháy RAM chỉ vì một câu `SCARD` tưởng vô hại.

---

## Tài liệu tham khảo

- [Redis Bitmaps](https://redis.io/docs/latest/develop/data-types/bitmaps/)
- [Redis HyperLogLog](https://redis.io/docs/latest/develop/data-types/probabilistic/hyperloglogs/)
- [Redis SETBIT command](https://redis.io/docs/latest/commands/setbit/)
- [Redis BITCOUNT command](https://redis.io/docs/latest/commands/bitcount/)
- [Redis BITFIELD command](https://redis.io/docs/latest/commands/bitfield/)
- [Redis PFADD command](https://redis.io/docs/latest/commands/pfadd/)
- [Redis configuration — hll-sparse-max-bytes](https://redis.io/docs/latest/operate/oss_and_stack/management/config/)
- [Antirez — Redis new data structure: the HyperLogLog](http://antirez.com/news/75)
- [Geospatial](./geospatial.md) — data structure tiếp theo
