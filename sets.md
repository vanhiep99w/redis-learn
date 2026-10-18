# Sets

## Mục lục

- [1. Set: khi thứ ta cần là tính duy nhất](#1-set-khi-thứ-ta-cần-là-tính-duy-nhất)
- [2. Set là gì — mô hình tư duy đúng](#2-set-là-gì--mô-hình-tư-duy-đúng)
- [3. Chọn đúng cấu trúc: Set vs Sorted Set vs HyperLogLog vs Bitmap](#3-chọn-đúng-cấu-trúc-set-vs-sorted-set-vs-hyperloglog-vs-bitmap)
- [4. Bên trong Redis Set: intset, listpack, hashtable](#4-bên-trong-redis-set-intset-listpack-hashtable)
- [5. Command chính: return value, atomicity và độ phức tạp](#5-command-chính-return-value-atomicity-và-độ-phức-tạp)
- [6. Set algebra deep dive — SINTER / SUNION / SDIFF](#6-set-algebra-deep-dive--sinter--sunion--sdiff)
- [7. Random members — SRANDMEMBER vs SPOP](#7-random-members--srandmember-vs-spop)
- [8. Duyệt Set lớn: SSCAN và cursor semantics](#8-duyệt-set-lớn-sscan-và-cursor-semantics)
- [9. Performance notes & benchmark thực tế](#9-performance-notes--benchmark-thực-tế)
- [10. Patterns thực tế](#10-patterns-thực-tế)
- [11. Case study thực tế](#11-case-study-thực-tế)
- [12. Anti-patterns cần tránh](#12-anti-patterns-cần-tránh)
- [13. Best Practices](#13-best-practices)
- [14. Tóm tắt — cheat-sheet & 3 nguyên tắc](#14-tóm-tắt--cheat-sheet--3-nguyên-tắc)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## 1. Set: khi thứ ta cần là tính duy nhất

Rất nhiều bài toán thực tế quy về cùng một câu hỏi: **"phần tử này đã có chưa?"** — user đã xem bài viết chưa, event này đã xử lý chưa, tài khoản có nằm trong whitelist không. Khi đó thứ ta cần không phải một danh sách có thứ tự, mà là một **tập hợp các phần tử duy nhất** với khả năng kiểm tra membership tức thì.

Đó là Redis Set: tập hợp không thứ tự các string, tự động khử trùng, cho phép hỏi "có/không" trong O(1) và — điểm mạnh riêng của Redis — thực hiện **phép toán tập hợp (giao, hợp, hiệu) ngay trên server**. Lệnh chạy **tuần tự trên event loop** — một lệnh đúng chỗ vừa nhanh vừa tránh race ở app ([Redis Architecture](./redis-architecture.md)).

```bash
SADD seen:2026-07-07 evt_8Kj2m       # trả 1 nếu mới, 0 nếu đã có
SISMEMBER whitelist user:42          # O(1): user có trong whitelist?
SINTER follow:alice follow:bob       # bạn chung của alice và bob
```

Một giá trị hay bị bỏ qua nằm ở return value của `SADD`. Vì nó cho biết phần tử là mới hay đã tồn tại, ta có thể gộp "kiểm tra rồi thêm" thành **một lệnh atomic** — thay cho cặp đọc-rồi-ghi vốn tốn 2 round-trip và dễ dính race condition. Đây là nền tảng cho idempotency / dedup (xử lý lặp lại vẫn cho cùng kết quả, bỏ qua bản trùng) trong pipeline event.

Doc này mổ xẻ Redis Set từ trong ra ngoài: ba encoding nội bộ — `intset` (mảng số nguyên nhỏ), `listpack` (khối memory liên tục cho set nhỏ), `hashtable` (bảng băm cho set lớn) — complexity thật của `SINTER`/`SUNION`/`SDIFF`, cách random sampling hoạt động, ràng buộc khi chạy trên Cluster, và những anti-pattern có thể làm production treo chỉ vì một lệnh `SMEMBERS` vô tình.

---

## 2. Set là gì — mô hình tư duy đúng

Set là **tập hợp không thứ tự các string duy nhất**. Không có index theo vị trí, không có score, không có thứ tự ổn định. Thứ Set làm cực tốt:

- **Uniqueness**: thêm trùng không đổi dữ liệu (`SADD` idempotent)
- **Membership**: `SISMEMBER` trung bình O(1)
- **Cardinality**: số lượng member trong Set; `SCARD` O(1)
- **Set algebra**: giao/hợp/hiệu trên server (`SINTER`, `SUNION`, `SDIFF`)

```d2 title="SADD vừa kiểm tra membership vừa thêm atomically"
direction: down
client: "Client\nSADD seen:2026-07-07 evt_abc"
set: "Redis Set\nevt_001 / evt_abc / evt_xyz"
new: "Member chưa tồn tại?" {shape: diamond}
add: "Thêm và trả 1\nApp xử lý"
skip: "Không thêm, trả 0\nApp skip"
client -> set
set -> new
new -> add: "Có"
new -> skip: "Không"
```

Ví dụ trực quan:

```bash
SADD tags:post:1 redis cache db        # → 3
SADD tags:post:1 redis                 # → 0 (đã tồn tại)
SISMEMBER tags:post:1 cache            # → 1
SCARD tags:post:1                      # → 3
```

> [!NOTE]
> “Không thứ tự” nghĩa là output của `SMEMBERS`/`SSCAN` không phải contract. Nếu UI cần ranking, thời gian, pagination ổn định theo score → dùng [Sorted Set](./sorted-sets.md).

---

## 3. Chọn đúng cấu trúc: Set vs Sorted Set vs HyperLogLog vs Bitmap

Redis có nhiều cấu trúc nhìn qua đều giải quyết “unique/counted membership”. Khác biệt nằm ở câu hỏi bạn cần trả lời.

| Nhu cầu | Set | Sorted Set | HyperLogLog | Bitmap |
|---------|-----|------------|-------------|--------|
| “User X có trong nhóm không?” | ✅ O(1), chính xác | ✅ O(log N), có score | ❌ không membership | ✅ nếu ID là integer dense |
| “Có bao nhiêu unique user?” | ✅ `SCARD` chính xác, tốn memory theo N | ✅ `ZCARD` chính xác | ✅ xấp xỉ ~0.81%, ~12KB/key | ✅ `BITCOUNT`, rất rẻ nếu ID dense |
| “Top/range theo thời gian/điểm” | ❌ | ✅ mạnh nhất | ❌ | ❌ |
| “TTL riêng từng member” | ❌ | ✅ score=expire_at + `ZREMRANGEBYSCORE` | ❌ | ❌ |
| “100M visitor/day chỉ cần đếm” | ⚠️ memory lớn | ⚠️ memory lớn | ✅ xem [Bitmaps & HyperLogLog](./bitmaps-hyperloglog.md) | ✅ nếu user id dense |
| “Tập tag, friend, permission” | ✅ tự nhiên | ⚠️ chỉ khi cần score | ❌ | ❌ |

> [!TIP]
> Quy tắc chọn nhanh: **cần biết member cụ thể có tồn tại không → Set**. Chỉ cần đếm unique khổng lồ → HyperLogLog. Cần thứ tự/range/TTL per-member → Sorted Set. ID số dày đặc và cần bit-level memory → Bitmap.

---

## 4. Bên trong Redis Set: intset, listpack, hashtable

Redis Set có 3 encoding nội bộ. API bên ngoài giống nhau, nhưng cách Redis cất dữ liệu trong memory quyết định Set đó rẻ như một mảng nhỏ hay đắt như một dictionary đầy pointer.

| Encoding | Khi nào dùng | Cấu trúc | Điểm mạnh | Điểm yếu |
|----------|--------------|----------|-----------|----------|
| `intset` | Tất cả member là integer và số lượng ≤ `set-max-intset-entries` (mặc định 512) | Mảng integer **sorted** liên tục | Memory cực thấp, binary search | Insert O(N) vì phải dịch mảng |
| `listpack` | Redis 7.2+, set nhỏ có non-integer, member ngắn | Khối memory liên tục encode từng entry | Ít overhead pointer | Lookup/insert scan tuyến tính |
| `hashtable` | Vượt ngưỡng hoặc member dài | `dict` với `value = NULL` | Membership trung bình O(1) | Overhead memory lớn hơn |

Config mặc định liên quan:

```bash
set-max-intset-entries 512
set-max-listpack-entries 128      # Redis 7.2+
set-max-listpack-value 64         # bytes, Redis 7.2+
```

### 4.1. intset — mảng sorted nhỏ nhưng rất tiết kiệm

`intset` đáng quan tâm khi Set của bạn chỉ chứa ID số: Redis có thể nén chúng thành một mảng gọn, giống cất số ghế trong danh sách đã sắp xếp thay vì mỗi số một object riêng.

```d2 title="intset dùng mảng integer sorted và binary search"
direction: right
n0: "SADD nums 10 3 7"
n1: "Tất cả member là integer"
n2: "intset<int16>\nlen=3\ncontents=[3, 7, 10]"
n3: "SISMEMBER nums 7\nBinary search trong mảng sorted"
n0 -> n1
n1 -> n2
n2 -> n3
```

Cơ chế bên trong có một chi tiết rất đáng nhớ: nó bắt đầu bằng integer width nhỏ nhất (`int16`), rồi upgrade khi gặp số lớn hơn.

```d2 mode=steps title="intset nâng độ rộng khi thêm integer lớn"
set: "intset<int16>\ncontents=[1, 2, 30000]"
steps: {
  upgrade: { set: "SADD nums 100000\nCần int32: allocate mảng mới\nCopy và convert toàn bộ phần tử" }
  upgraded: { set: "intset<int32>\n[1, 2, 30000, 100000]" }
  removed: { set: "SREM nums 100000\n[1, 2, 30000]\nKhông downgrade về int16" }
}
```

> [!IMPORTANT]
> `intset` upgrade `int16 → int32 → int64` nhưng **không downgrade**. Tương tự, một Set đã chuyển sang `hashtable` thì không tự quay lại `intset/listpack` sau khi bạn `SREM` bớt member.

Vì sao insert O(N) vẫn ổn? Vì N mặc định tối đa 512. Dịch 512 integer trong memory liên tục rẻ hơn giữ cả đống pointer của hashtable.

### 4.2. listpack — Redis 7.2+ cho Set nhỏ không thuần integer

`listpack` là đường giữa cho Set nhỏ có string: thay vì bật ngay sang hashtable nhiều overhead, Redis nhét các entry ngắn vào một khối memory liên tục để tiết kiệm RAM.

Trước Redis 7.2, set có string non-integer thường chuyển thẳng hashtable. Redis 7.2 thêm listpack cho set nhỏ để giảm overhead.

```bash
SADD colors red blue green
OBJECT ENCODING colors
# Redis 7.2+ có thể trả "listpack" nếu không vượt ngưỡng
```

Điều kiện giữ listpack:

- Số entry ≤ `set-max-listpack-entries` (128)
- Mỗi member dài ≤ `set-max-listpack-value` (64 bytes)
- Không bị convert sang hashtable trước đó

> [!CAUTION]
> Tăng threshold listpack quá cao có thể tiết kiệm memory nhưng làm CPU tăng vì lookup phải scan tuyến tính. Threshold mặc định là trade-off đã được Redis chọn cho workload phổ thông.

### 4.3. hashtable — dict chỉ cần key, value = NULL

`hashtable` là chế độ “lớn rồi thì ưu tiên lookup nhanh”: tốn thêm memory, nhưng đổi lại membership trung bình O(1) ngay cả khi Set có rất nhiều member.

Khi Set lớn, Redis dùng dictionary. Với Set, member chính là key trong dict; value không cần nên để `NULL`.

```d2 title="Set hashtable lưu member ở key, value là NULL"
direction: right
set: "followers:alice — hashtable" {
  b18: "Bucket 18: bob → NULL"
  b44: "Bucket 44: carol → NULL"
  b91: "Bucket 91: dave → NULL"
}
query: "SISMEMBER followers:alice carol"
hash: "hash(carol) → bucket 44"
compare: "Compare key → found"
query -> hash -> set.b44 -> compare
```

Trung bình membership O(1), nhưng memory gồm hash table array, dict entry, SDS string, allocator overhead. Đó là lý do 512 `int64` trong `intset` chỉ khoảng **4KB payload**, còn hashtable có thể lớn hơn nhiều lần.

---

## 5. Command chính: return value, atomicity và độ phức tạp

| Command | Complexity | Return value / ghi chú |
|---------|------------|------------------------|
| `SADD key m1 m2 ...` | O(1)/member trung bình | Trả **số member mới được thêm** |
| `SREM key m1 m2 ...` | O(1)/member trung bình | Trả **số member thực sự bị xóa** |
| `SISMEMBER key m` | O(1) trung bình | 1/0 |
| `SMISMEMBER key m1 m2 ...` | O(N) theo số member hỏi | Batch membership trong 1 round-trip (Redis 6.2+) |
| `SCARD key` | O(1) | Cardinality lưu sẵn |
| `SMEMBERS key` | O(N) | Trả toàn bộ set — nguy hiểm với set lớn |
| `SSCAN key cursor [MATCH p] [COUNT n]` | O(1) mỗi call, O(N) toàn vòng | Duyệt incremental, không block dài |
| `SPOP key [count]` | O(1) không count; O(N) theo count | Random và **xóa** |
| `SRANDMEMBER key [count]` | O(1) không count; O(N) theo `abs(count)` | Random, **không xóa** |
| `SMOVE src dst member` | O(1) | Atomic move giữa 2 set |
| `SINTERCARD numkeys ... [LIMIT n]` | như `SINTER`, có thể dừng sớm | Chỉ đếm giao, Redis 7.0+ |

Aha moment phổ biến nhất:

```bash
# ❌ Thừa round-trip, còn có race nếu tách logic phức tạp phía app
SISMEMBER processed evt_1
SADD processed evt_1

# ✅ Một lệnh atomic, return value là câu trả lời
SADD processed evt_1
# 1 = tôi là người đầu tiên thêm
# 0 = event đã được worker khác thấy trước
```

> [!IMPORTANT]
> `SADD` và `SREM` trả về **count changed**, không phải “OK”. Đây là tín hiệu dedup/idempotency miễn phí. Đừng bỏ phí nó.

---

## 6. Set algebra deep dive — SINTER / SUNION / SDIFF

Set algebra là lý do Redis Set vượt xa “hash set trong app”. Thay vì kéo dữ liệu về client rồi intersect, bạn gửi tên key và để Redis làm trong memory; lợi ích lớn nhất là giảm network round-trip và tránh materialize dữ liệu trung gian ở app.

```bash
SADD skill:redis alice bob carol
SADD skill:java  bob carol dave

SINTER skill:redis skill:java    # bob, carol
SUNION skill:redis skill:java    # alice, bob, carol, dave
SDIFF  skill:redis skill:java    # alice
```

### 6.1. SINTER: vì sao small ∩ huge vẫn nhanh?

`SINTER` dễ bị hiểu nhầm là “cứ có set triệu phần tử là chậm”. Thực tế, nếu một input rất nhỏ, Redis tận dụng nó làm điểm xuất phát.

Redis documentation mô tả complexity `SINTER` là **O(N*M)**, trong đó N là cardinality của set nhỏ nhất, M là số set. Điều này không phải ngẫu nhiên: Redis drive thuật toán bằng set nhỏ nhất.

```d2 title="SINTER bắt đầu từ input có ít member nhất"
direction: right
n0: "Input sizes\ntag:redis=1.000.000\ntag:backend=800.000\ntag:hot=120"
n1: "Chọn tag:hot — nhỏ nhất"
n2: "Duyệt 120 members"
n3: "Mỗi member: kiểm membership\ntrong backend và redis"
n4: "Có ở cả hai → thêm kết quả\nKhoảng 120 × 2 checks"
n0 -> n1
n1 -> n2
n2 -> n3
n3 -> n4
```

| Phép | Complexity | Server làm gì | Khi nào nguy hiểm |
|------|------------|---------------|-------------------|
| `SINTER` | O(N*M), N=set nhỏ nhất, M=số set | Duyệt set nhỏ nhất, check membership trong set còn lại | Kết quả lớn hoặc mọi set đều lớn |
| `SUNION` | O(total members) | Duyệt tất cả, add vào result set để khử trùng | Union nhiều big set trả về client |
| `SDIFF` | O(total members) | Lấy set đầu làm base, loại member xuất hiện ở set sau | Set đầu cực lớn |
| `SINTERSTORE`/`SUNIONSTORE`/`SDIFFSTORE` | tương tự | Lưu result vào key đích | Quên TTL cho key tạm |
| `SINTERCARD ... LIMIT n` | như `SINTER`, dừng khi đủ limit | Chỉ đếm, không materialize result | Không dùng được nếu cần danh sách member |

> [!TIP]
> Cần hỏi “hai user có ít nhất 3 bạn chung không?” dùng `SINTERCARD 2 following:a following:b LIMIT 3`. Redis có thể dừng khi thấy đủ 3, không cần trả danh sách bạn chung về client.

### 6.2. STORE variants — cứu output buffer

Các biến thể `*STORE` hữu ích khi vấn đề không nằm ở phép tính, mà nằm ở việc trả một kết quả quá lớn về client trong một lần.

```bash
SINTERSTORE tmp:search:{u42}:1 tag:{u42}:redis tag:{u42}:backend
EXPIRE tmp:search:{u42}:1 30
SSCAN tmp:search:{u42}:1 0 COUNT 100
```

`*STORE` hữu ích khi kết quả lớn hoặc cần reuse nhiều lần. Nhưng nhớ TTL: key tạm không TTL là memory leak trá hình.

### 6.3. Cluster: tất cả key trong set-op phải cùng hash slot

Trong Redis Cluster, một lệnh nhiều key chỉ chạy nếu các key nằm cùng hash slot (ô phân vùng key trong cluster). Set algebra không ngoại lệ; nếu cần ép nhiều key vào cùng slot, dùng hash tag (phần trong `{...}` được dùng để tính slot).

```bash
# ❌ Có thể CROSSSLOT
SINTER following:alice followers:bob

# ✅ Hash tag ép cùng slot phần nằm trong {...}
SINTER following:{alice} muted:{alice}
SUNION tag:{tenant42}:redis tag:{tenant42}:cache
```

Xem thêm [Redis Cluster](./cluster.md) để hiểu hash slot và hash tag.

> [!WARNING]
> Đừng thiết kế key set-op theo kiểu `tag:redis`, `tenant:42` rồi hy vọng cluster tự “join distributed”. Redis Cluster không scatter-gather set algebra cho bạn.

---

## 7. Random members — SRANDMEMBER vs SPOP

Hai lệnh cùng “random”, nhưng semantics khác hẳn.

| Lệnh | Có xóa không? | `count > 0` | `count < 0` | Use case |
|------|---------------|-------------|-------------|----------|
| `SRANDMEMBER key` | Không | — | — | Peek random 1 member |
| `SRANDMEMBER key 3` | Không | Tối đa 3 member **khác nhau** | — | Sampling không phá dữ liệu |
| `SRANDMEMBER key -5` | Không | — | Chính xác 5 kết quả, **có thể lặp** | Random draw có hoàn lại |
| `SPOP key 3` | Có | 3 member bị xóa | Không áp dụng | Lottery/job queue đơn giản |

```bash
SRANDMEMBER wheel 3      # rút 3 phần tử khác nhau, không xóa
SRANDMEMBER wheel -5     # rút 5 lần, có thể trùng
SPOP lottery 2           # rút 2 vé và xóa khỏi pool
```

Random lấy ở đâu ra? Với hashtable, Redis có thể chọn bucket/entry ngẫu nhiên gần O(1), không cần shuffle cả set.

> [!NOTE]
> Random của Redis đủ tốt cho sampling, lottery nội bộ, phân phối job đơn giản. Không dùng nó làm nguồn random mật mã. Redis 6 cải thiện độ công bằng so với các phiên bản cũ, nhưng output có `count > 0` vẫn không cam kết thứ tự ngẫu nhiên hoàn hảo; client shuffle nếu UI cần.

---

## 8. Duyệt Set lớn: SSCAN và cursor semantics

`SMEMBERS` nhìn tiện, nhưng là cái bẫy lớn nhất của Set: một big key (key chứa quá nhiều dữ liệu so với request path bình thường) có thể tạo reply khổng lồ và kéo chậm cả Redis.

```bash
SMEMBERS followers:famous
# 10,000,000 members → Redis phải gom reply lớn, block event loop, client nhận hàng trăm MB
```

Dùng `SSCAN`:

```bash
SSCAN followers:famous 0 COUNT 1000
# → cursor mới + batch member
# lặp đến khi cursor trả về 0
```

**Cursor ≠ offset pagination.** Redis encode vị trí trong **hash table** (bucket index + trạng thái rehash), không phải “bỏ qua N phần tử”:

```d2 title="SSCAN lặp theo opaque cursor, không phải offset ổn định"
direction: down
start: "SSCAN cursor=0 COUNT 1000"
walk: "Duyệt một phần hash table\nTrả members và cursor mới"
done: "Cursor trả về =0?" {shape: diamond}
next: "Gọi SSCAN với cursor mới\nKhông giải mã như offset"
end: "Kết thúc full iteration"
start -> walk
walk -> done
done -> end: "Có"
done -> next: "Không"
next -> walk
```

| Tính chất | Ý nghĩa thực tế |
|----------|------------------|
| Cursor `0` bắt đầu và kết thúc vòng scan | Không dùng để “page 5”; không so sánh cursor giữa client |
| `COUNT` là hint, không phải limit cứng | Batch có thể nhiều/ít hơn; bucket rỗng/ dày khác nhau |
| Có thể trả duplicate khi key thay đổi trong lúc scan | Client nên idempotent |
| Không snapshot | Member thêm/xóa giữa vòng scan có thể thấy hoặc không |
| `MATCH` filter **sau** khi lấy bucket | Pattern không biến scan thành index; set lệch pattern vẫn tốn CPU |

> [!IMPORTANT]
> Với set production không bounded rõ ràng, mặc định coi nó là big set: **không dùng `SMEMBERS` trong request path**. `SSCAN` + batch processing, hoặc thiết kế thêm index/pagination ở cấu trúc khác.

---

## 9. Performance notes & benchmark thực tế

Các số dưới đây là benchmark minh họa trên máy dev phổ thông (Redis local, loopback, member ngắn). Đừng copy làm SLA, hãy dùng để cảm nhận bậc độ lớn.

| Kịch bản | Dữ liệu | Lệnh | Kết quả điển hình | Ý nghĩa |
|----------|---------|------|-------------------|---------|
| Dedup event | set hashtable 1M member | `SADD seen evt_new` | ~0.05–0.2ms | Một round-trip quyết định mới/trùng |
| Membership | set hashtable 1M member | `SISMEMBER users u42` | ~0.05–0.2ms | O(1) trung bình |
| intset nhỏ | 512 int64 | memory payload ~4KB | — | Rẻ hơn hashtable nhiều lần |
| Intersect nhỏ ∩ lớn | 120 ∩ 1,000,000 | `SINTER` | thường <1ms nếu result nhỏ | Drive bằng set nhỏ nhất |
| Dump set lớn | 1M member × 16 bytes | `SMEMBERS` | có thể block hàng chục ms+ và reply hàng chục MB | Không dùng trong request path |
| Batch scan | 1M member | `SSCAN COUNT 1000` | nhiều call nhỏ | Trải chi phí ra nhiều tick |

Memory trực giác:

| 512 phần tử | Ước lượng chi phí |
| --- | --- |
| intset với số int64 | Header + 512 × 8 byte, hơn 4 KB payload |
| hashtable với String member | dict entries, bucket array, SDS và allocator overhead; thường lớn hơn nhiều, đổi lại lookup kỳ vọng O(1) |

> [!CAUTION]
> Lệnh O(N) + reply khổng lồ **block event loop** — request khác xếp hàng phía sau ([Redis Architecture](./redis-architecture.md)).

---

## 10. Patterns thực tế

### 10.1. Dedup job / event

```bash
SADD processed:2026-07-07 evt:8812     # → 1 = mới, 0 = đã xử lý
EXPIRE processed:2026-07-07 172800 NX  # giữ 2 ngày
```

Atomic nhờ Redis command execution: hai worker cùng `SADD` một event thì chỉ một worker nhận `1`.

### 10.2. Bạn chung / gợi ý kết bạn

```bash
SINTER following:alice following:bob      # follow chung
SDIFF  following:bob   following:alice    # bob follow mà alice chưa → gợi ý
```

Nếu chỉ cần “có bạn chung không?”:

```bash
SINTERCARD 2 following:alice following:bob LIMIT 1
```

### 10.3. Filter đa điều kiện (faceted search thô)

```bash
SADD color:red   p1 p2 p5
SADD size:M      p2 p5 p9
SADD brand:nike  p5 p9

SINTER color:red size:M brand:nike        # → p5
```

Cần range query, full-text, relevance score → dùng [RediSearch / Redis modules](./redis-modules.md), không cố nhồi mọi thứ vào Set.

### 10.4. Online users

```bash
SADD online:now user:42
SREM online:now user:42
SCARD online:now
SISMEMBER online:now user:7
```

> [!WARNING]
> Set không có TTL per-member. Nếu heartbeat user cần tự hết hạn từng người, dùng key TTL riêng (`online:user:42`) hoặc [Sorted Set](./sorted-sets.md) với score là timestamp heartbeat.

---

## 11. Case study thực tế

### 11.1. Hệ thống follow — mạng xã hội quy mô vừa

Bài toán: **5 triệu user**, trung bình **200 following/user** → khoảng 1 tỷ edge logic. Cần render nút Follow trong request path, đếm follower, tìm bạn chung.

```bash
MULTI
SADD following:alice bob
SADD followers:bob alice
EXEC

SISMEMBER following:alice bob          # nút Follow/Following — O(1)
SCARD followers:bob                    # đếm follower
SINTER following:alice following:carol # follow chung
SDIFF  following:carol following:alice # gợi ý
```

Celebrity problem:

| Trường hợp | Lựa chọn |
| --- | --- |
| User thường ~200 followers | Set nhỏ, đo encoding và memory |
| Celebrity ~10 triệu followers: chỉ đếm | `SCARD` — O(1) |
| Celebrity: duyệt theo batch | `SSCAN`, không giả định snapshot hay số phần tử cố định |
| Celebrity: `SMEMBERS` toàn bộ | Tránh response khổng lồ, block và ảnh hưởng migrate slot |

Hướng xử lý thực tế:

- Không bao giờ liệt kê toàn bộ follower celebrity trong request path
- Dùng `SSCAN` cho batch job/offline export
- Cân nhắc chỉ giữ chiều `following:{user}` trong Redis; follower list dài để DB/search system xử lý pagination
- Với cluster, key cần set-op theo user nên dùng hash tag nhất quán, xem [cluster](./cluster.md)

### 11.2. Dedup consumer — pipeline xử lý webhook

Bài toán: partner gửi webhook **at-least-once**. Cùng event đến 2–3 lần; duplicate có thể gây ghi sổ kép.

```bash
SADD seen:webhook:2026-07-07 evt_8Kj2m
# 1: lần đầu → xử lý
# 0: đã thấy → trả 200 OK ngay
EXPIRE seen:webhook:2026-07-07 259200 NX     # 3 ngày > retry window
```

Vì sao vẫn giữ DB unique constraint? Vì Redis là lớp chặn nhanh, DB là lưới an toàn cuối cùng. Nếu Redis restart mất vài giây dữ liệu chưa persist, duplicate hiếm có thể lọt xuống; constraint bắt nốt.

> [!TIP]
> Key theo ngày + TTL làm memory bounded. Một set `seen:webhook:forever` nghe đơn giản nhưng là memory leak chậm rãi.

### 11.3. Feature flag rollout theo tập user

Bài toán: bật tính năng mới cho beta tester + override, tắt/bật tức thì không deploy.

```bash
SADD ff:new-checkout:users 42 88 1024
SISMEMBER ff:new-checkout:users $uid

# 5% rollout bền vững thường làm phía app:
# hash(uid) % 100 < 5
# Set dành cho include/exclude đích danh
SADD ff:new-checkout:excluded 555
```

Dùng kèm local cache 5–30s phía app để giảm Redis QPS; invalidation và cache coherence xem [Client-side Caching](./client-side-caching.md).

---

## 12. Anti-patterns cần tránh

| ❌ Anti-pattern | Vì sao hỏng | ✅ Cách đúng |
|----------------|-------------|-------------|
| `SMEMBERS` trên set unbounded | Block Redis + reply khổng lồ | `SSCAN`, `*STORE` + scan, hoặc thiết kế pagination khác |
| `SISMEMBER` trước `SADD` để dedup | 2 round-trip, race logic | Dùng return value của `SADD` |
| `SUNION` nhiều giant set trả về client | Output buffer phình, network nghẽn | `SUNIONSTORE` key tạm + `EXPIRE` + `SSCAN` |
| Một set `seen` vĩnh viễn | Memory leak theo thời gian | Key theo ngày/tenant + TTL |
| Dùng Set khi cần TTL từng member | Set chỉ TTL cả key | [Sorted Set](./sorted-sets.md) score=expire_at |
| Dùng Set để đếm 100M unique/day | Chính xác nhưng memory lớn | [HyperLogLog](./bitmaps-hyperloglog.md) nếu chấp nhận sai số |
| Set-op cross-slot trong cluster | `CROSSSLOT` | Hash tag `{tenant}`/`{user}` |
| Lưu member string rất dài khi chỉ cần ID | Tốn memory, listpack dễ convert | Lưu numeric/string ID ngắn, metadata ở DB/hash khác |

> [!WARNING]
> Anti-pattern nguy hiểm nhất thường không xuất hiện ở staging: staging có 1.000 member nên `SMEMBERS` “nhanh”. Production có 10 triệu member và cùng dòng code đó trở thành incident.

---

## 13. Best Practices

- **Dùng return value của `SADD`/`SREM`** làm tín hiệu changed; giảm round-trip và tránh race.
- **Bound key theo thời gian** cho dedup: `seen:webhook:YYYY-MM-DD` + `EXPIRE`.
- **Không `SMEMBERS` set không rõ size**; dùng `SSCAN` hoặc `SCARD` trước khi quyết định.
- **Thiết kế member ngắn**: numeric ID giúp `intset` tiết kiệm memory khi set nhỏ và giảm SDS overhead khi hashtable.
- **Dùng `SINTERCARD LIMIT`** cho câu hỏi threshold (“có ít nhất K phần tử chung?”).
- **Dùng `*STORE` cho kết quả lớn**, nhớ `EXPIRE` key tạm.
- **Trong Cluster, thiết kế hash tag từ đầu** nếu các key sẽ tham gia set-op.
- **Đừng ép Set làm search engine**; filter phức tạp/range/full-text nên chuyển sang [Redis modules](./redis-modules.md) hoặc search system chuyên dụng.

---

## 14. Tóm tắt — cheat-sheet & 3 nguyên tắc

Cheat-sheet chọn cấu trúc cho uniqueness/membership:

| Nếu câu hỏi là... | Chọn | Lệnh chính |
|-------------------|------|------------|
| “Đã xử lý event này chưa?” | Set | `SADD` đọc return value |
| “User có trong allowlist không?” | Set | `SISMEMBER` / `SMISMEMBER` |
| “Hai nhóm có giao nhau ít nhất K không?” | Set | `SINTERCARD ... LIMIT K` |
| “Lấy danh sách member lớn theo batch?” | Set | `SSCAN` |
| “Member cần tự hết hạn theo thời gian?” | Sorted Set | `ZADD score=expire_at`, `ZREMRANGEBYSCORE` |
| “Chỉ cần đếm unique cực lớn?” | HyperLogLog | `PFADD`, `PFCOUNT` |
| “User ID dense, cần membership siêu rẻ?” | Bitmap | `SETBIT`, `GETBIT`, `BITCOUNT` |

### Khi nào KHÔNG nên dùng Set

- Cần thứ tự, score hoặc rank → dùng Sorted Set.
- Cần TTL per-member → dùng Sorted Set với `score=expire_at`.
- Chỉ cần đếm unique cực lớn và chấp nhận sai số → dùng HyperLogLog.
- Membership trên ID dense cần memory siêu rẻ → dùng Bitmap.
- Cần search, range query hoặc full-text → dùng RediSearch.

3 nguyên tắc nhớ lâu:

1. **Hỏi membership thì để Redis trả lời bằng một lệnh** — `SADD`/`SISMEMBER`, đừng kéo dữ liệu về app.
2. **Set-op nhanh khi input nhỏ, nguy hiểm khi output lớn** — đặc biệt `SUNION`/`SMEMBERS`.
3. **Set không có thời gian và thứ tự** — cần score, range, TTL per-member thì chuyển sang Sorted Set.

Khi incident 03:17 sáng quay lại, một dòng `SADD` đúng chỗ có thể là khác biệt giữa retry storm 2 triệu event và một hệ thống bình thản trả `0` cho duplicate.

---

## Tài liệu tham khảo

- [Redis Sets](https://redis.io/docs/latest/develop/data-types/sets/)
- [SADD](https://redis.io/docs/latest/commands/sadd/)
- [SINTER](https://redis.io/docs/latest/commands/sinter/)
- [SINTERCARD](https://redis.io/docs/latest/commands/sintercard/)
- [SRANDMEMBER](https://redis.io/docs/latest/commands/srandmember/)
- [Redis memory optimization](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/)
- [Sorted Sets](./sorted-sets.md) — khi cần thứ tự, score, TTL per-member
- [Bitmaps & HyperLogLog](./bitmaps-hyperloglog.md) — đếm unique tiết kiệm memory
- [Redis Cluster](./cluster.md) — hash slot và hash tag cho multi-key command
