# Bitmaps & HyperLogLog

## Mục lục

- [Tổng quan](#tổng-quan)
- [Use Cases phổ biến](#use-cases-phổ-biến)
- [1. Bitmap hoạt động thế nào](#1-bitmap-hoạt-động-thế-nào)
- [2. Bitmap commands & patterns](#2-bitmap-commands--patterns)
- [3. BITFIELD — nhiều counter trong 1 key](#3-bitfield--nhiều-counter-trong-1-key)
- [4. HyperLogLog hoạt động thế nào](#4-hyperloglog-hoạt-động-thế-nào)
- [5. HLL commands & patterns](#5-hll-commands--patterns)
- [6. Chọn công cụ đếm: Set vs Bitmap vs HLL](#6-chọn-công-cụ-đếm-set-vs-bitmap-vs-hll)
- [7. Best Practices](#7-best-practices)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## Tổng quan

Hai công cụ giải cùng một họ bài toán — **đếm/đánh dấu số lượng lớn với memory tối thiểu** — bằng hai cách đối lập:

| | Bitmap | HyperLogLog |
|---|--------|-------------|
| Bản chất | String dùng làm mảng bit — **chính xác** | Cấu trúc xác suất — **ước lượng** (sai số ~0.81%) |
| Memory | n/8 bytes theo id lớn nhất | **Cố định 12KB** bất kể cardinality |
| Trả lời được | "User #42 CÓ hoạt động không?" + đếm | CHỈ đếm "khoảng bao nhiêu phần tử unique?" |
| Yêu cầu | Phần tử là số nguyên compact (id) | Phần tử là bất kỳ string nào |

---

## Use Cases phổ biến

| Use Case | Công cụ |
|----------|---------|
| **DAU/MAU + biết đích danh ai active** | Bitmap (id → bit) |
| **Unique visitors theo trang/ngày, hàng trăm triệu** | HLL |
| **User đã nhận thông báo X chưa?** | Bitmap `GETBIT` |
| **Chuỗi ngày hoạt động liên tiếp (streak)** | Bitmap theo ngày + `BITCOUNT`/`BITPOS` |
| **Đếm unique search queries / IP** | HLL (phần tử không phải số) |
| **A/B testing bucket membership** | Bitmap |
| **Retention: active hôm nay ∩ đăng ký tuần trước** | Bitmap `BITOP AND` |

---

## 1. Bitmap hoạt động thế nào

Bitmap **không phải type riêng** — chính là [String](./strings.md) được thao tác theo từng bit:

```
SETBIT active 10 1

byte:      0        1
        ┌────────┬────────┐
bit:    │00000000│00100000│ ...
        └────────┴────────┘
offset:  01234567 89......
                    ▲ bit 10 (byte 1, bit thứ 2 trong byte)
```

- `SETBIT key offset 1` → tìm byte `offset/8`, bật bit `offset%8`. String tự **giãn ra và pad 0** nếu offset vượt độ dài hiện tại
- Vì là String: max 512MB = **2³² bit** ≈ 4.29 tỷ id; dùng được mọi lệnh String (GET để lấy raw bytes, TTL, v.v.)
- Memory chỉ phụ thuộc **id lớn nhất từng set**, không phụ thuộc số bit bật: 10 triệu user id liên tục ≈ 1.25MB/ngày

> [!WARNING]
> `SETBIT key 4000000000 1` trên key rỗng buộc Redis cấp phát ngay ~500MB **trong một lệnh** — vừa tốn memory vừa block event loop lúc cấp phát. Bitmap chỉ hợp lý khi id là dãy số **compact** (auto-increment). Id thưa (UUID, snowflake) → dùng HLL hoặc [Set](./sets.md).

### BITCOUNT nhanh cỡ nào?

`BITCOUNT` đếm bit bật bằng popcount trên từng word — O(N) theo số byte nhưng cực nhanh (hàng GB/s). Vẫn là O(N): bitmap 512MB thì đừng BITCOUNT trong request path; giới hạn phạm vi bằng `BITCOUNT key start end [BYTE|BIT]`.

---

## 2. Bitmap commands & patterns

| Command | Complexity | Ghi chú |
|---------|-----------|---------|
| `SETBIT key offset 0\|1` | O(1) | trả về giá trị bit **cũ** |
| `GETBIT key offset` | O(1) | |
| `BITCOUNT key [start end [BIT]]` | O(N) | đếm bit 1 |
| `BITPOS key 0\|1 [start end]` | O(N) | vị trí bit đầu tiên có giá trị đó |
| `BITOP AND\|OR\|XOR\|NOT dst k1 k2...` | O(N) | kết quả lưu vào `dst` |
| `BITFIELD` | O(1)/op | mục 3 |

### Pattern: DAU / MAU / retention

```bash
# Mỗi lần user hoạt động:
SETBIT active:2026-07-07 <user_id> 1

# DAU hôm nay:
BITCOUNT active:2026-07-07

# WAU — OR 7 bitmap ngày:
BITOP OR active:week:27 active:2026-07-01 ... active:2026-07-07
BITCOUNT active:week:27

# Retention: đăng ký ngày 1 VÀ còn hoạt động ngày 7:
BITOP AND retained signup:2026-07-01 active:2026-07-07
BITCOUNT retained

# User 42 có active hôm nay không? — điều HLL không bao giờ trả lời được:
GETBIT active:2026-07-07 42
```

`BITOP` chạy trên server, O(N) theo size bitmap — với bitmap vài MB là mili giây; kết quả nên đặt TTL vì là dữ liệu dẫn xuất.

---

## 3. BITFIELD — nhiều counter trong 1 key

`BITFIELD` coi string như **mảng số nguyên bit-width tùy ý** (u8, i16, u32... đến 64 bit) — đóng gói hàng nghìn counter nhỏ vào một key:

```bash
# Mảng u16 counter: user_id làm index, mỗi counter 16 bit
BITFIELD counters:level SET u16 '#42' 100        # counters[42] = 100
BITFIELD counters:level INCRBY u16 '#42' 5       # +5 → 105
BITFIELD counters:level GET u16 '#42'            # đọc

# Nhiều op trong 1 lệnh — atomic:
BITFIELD counters:level INCRBY u16 '#42' 1 GET u16 '#42'
```

`#42` = offset theo **đơn vị type** (42 × 16 bit); không có `#` là offset bit tuyệt đối.

Điểm đáng giá nhất — **kiểm soát overflow**, thứ INCR thường không có:

```bash
BITFIELD hp SET u8 '#0' 250
BITFIELD hp OVERFLOW SAT INCRBY u8 '#0' 10    # → 255 (kẹt trần, không wrap)
BITFIELD hp OVERFLOW WRAP INCRBY u8 '#0' 10   # → 4   (mặc định — quay vòng)
BITFIELD hp OVERFLOW FAIL INCRBY u8 '#0' 10   # → nil (từ chối)
```

Use case: game stats (HP, mana, level — mỗi thứ vài bit), quota nhỏ theo user, packed time-series counter. 1 triệu counter u16 = 2MB trong một key.

---

## 4. HyperLogLog hoạt động thế nào

### 4.1 Trực giác: đếm bằng "độ hiếm"

Tung đồng xu: gặp chuỗi "10 mặt ngửa liên tiếp" nghĩa là bạn đã tung cỡ 2¹⁰ lần. HLL áp dụng ý tưởng đó cho hash:

1. Hash mỗi phần tử thành 64 bit — phần tử trùng nhau hash giống nhau → **tự khử trùng lặp**
2. Đếm số **bit 0 dẫn đầu** trong hash. Gặp hash có 20 bit 0 dẫn đầu → xác suất 1/2²⁰ → chắc đã "thấy" cỡ 2²⁰ phần tử unique
3. Một quan sát thì quá nhiễu → chia thành **16384 register**: 14 bit đầu của hash chọn register, phần còn lại đếm leading zeros, register giữ **max** từng thấy
4. Cardinality = trung bình điều hòa của 16384 ước lượng + hiệu chỉnh → sai số chuẩn `1.04/√16384` ≈ **0.81%**

```
element ──hash──▶ 64 bit: [14 bit chọn register][50 bit đếm leading zeros]
                              │                      │
                              ▼                      ▼
registers[16384]:  ...  [reg 8123] = max(cũ, zeros+1)  ...
```

### 4.2 Vì sao đúng 12KB, và sparse encoding

Mỗi register cần đếm tối đa ~50 → 6 bit đủ. 16384 × 6 bit = **12KB** — bất kể bạn add 1 nghìn hay 10 tỷ phần tử. Không lưu phần tử nào cả → **không thể** liệt kê phần tử hay hỏi membership.

Redis còn tối ưu thêm: HLL ít phần tử dùng **sparse encoding** (run-length các register 0) chỉ vài chục byte, tự chuyển sang **dense** 12KB khi vượt `hll-sparse-max-bytes` (3000). Xem được bằng `DEBUG OBJECT` — và vì HLL thực chất lưu trong String, `TYPE key` trả về `string`.

---

## 5. HLL commands & patterns

Chỉ có 3 lệnh:

| Command | Complexity | Ghi chú |
|---------|-----------|---------|
| `PFADD key el [el ...]` | O(1) | trả 1 nếu ước lượng thay đổi |
| `PFCOUNT key [key ...]` | O(1) | nhiều key = cardinality của **hợp** (không cần merge trước) |
| `PFMERGE dst src [src ...]` | O(1) | hợp các HLL vào dst — register lấy max theo vị trí |

```bash
# Unique visitors mỗi trang mỗi ngày:
PFADD uv:home:2026-07-07 ip1 ip2 ip3 ...
PFCOUNT uv:home:2026-07-07                     # ~unique hôm nay

# Unique cả tuần — merge không mất tính unique (user vào 5 ngày vẫn đếm 1):
PFMERGE uv:home:week:27 uv:home:2026-07-01 ... uv:home:2026-07-07
PFCOUNT uv:home:week:27

# Hoặc đếm hợp trực tiếp không cần key trung gian:
PFCOUNT uv:home:2026-07-01 uv:home:2026-07-02 ...
```

Phép **merge là lossless** đối với thuật toán (max từng register) — đây là siêu năng lực của HLL: đếm unique theo giờ, rồi gộp thành ngày/tuần/tháng tùy ý mà không lưu lại dữ liệu gốc.

> [!NOTE]
> HLL chỉ có **union**. Muốn intersection ("bao nhiêu user dùng cả trang A và B") thì HLL không làm trực tiếp được — dùng inclusion-exclusion (|A∩B| = |A|+|B|−|A∪B|, sai số cộng dồn) hoặc chuyển sang Bitmap/Set.

---

## 6. Chọn công cụ đếm: Set vs Bitmap vs HLL

Bài toán: đếm 10 triệu unique user/ngày.

| | [Set](./sets.md) | Bitmap | HLL |
|---|------|--------|-----|
| Memory/ngày | ~400-600MB (member string) | ~1.25MB (id compact) | **12KB** |
| Chính xác | 100% | 100% | ±0.81% |
| Membership ("user X có không?") | Có | Có | **Không** |
| Liệt kê phần tử | Có (SSCAN) | Có (BITPOS scan) | **Không** |
| Phần tử không phải số | Có | Không | Có |
| Union / Intersection | Cả hai | Cả hai (BITOP) | Chỉ union |

Cây quyết định:

```
Cần liệt kê phần tử hoặc dữ liệu kèm theo?  ── Có ─▶ Set (hoặc DB)
        │ Không
Cần membership chính xác từng phần tử?      ── Có ─▶ id compact? Bitmap : Set
        │ Không
Chỉ cần con số unique, chấp nhận ~1% sai?   ── Có ─▶ HLL (12KB, xong)
```

---

## 7. Best Practices

- **Bitmap: kiểm soát id trước khi dùng** — id phải compact; nếu id nội bộ là UUID, tạo mapping UUID → số tự tăng, hoặc bỏ Bitmap
- **Key theo chu kỳ + TTL**: `active:2026-07-07` với `EXPIRE 90 ngày` — cả Bitmap lẫn HLL đều nên có vòng đời rõ
- **Không dùng HLL khi con số phải chính xác tuyệt đối** (billing, hạn mức pháp lý) — 0.81% là sai số *chuẩn*, đuôi phân phối có thể lệch hơn
- **PFCOUNT nhiều key hơi đắt hơn 1 key** (phải merge tạm trong memory) — dashboard gọi liên tục thì PFMERGE ra key tuần/tháng rồi PFCOUNT key đó
- **BITOP/BITCOUNT trên bitmap trăm MB** → chạy ngoài request path (job nền), kết quả cache lại
- **BITFIELD nhiều op 1 lệnh** thay vì nhiều round-trip — vốn đã atomic sẵn

---

## Tài liệu tham khảo

- [Redis Bitmaps](https://redis.io/docs/latest/develop/data-types/bitmaps/)
- [Redis HyperLogLog](https://redis.io/docs/latest/develop/data-types/probabilistic/hyperloglogs/)
- [Antirez — Redis new data structure: the HyperLogLog](http://antirez.com/news/75)
- [Geospatial](./geospatial.md) — data structure tiếp theo
