# Geospatial

## Mục lục

- [1. Tìm điểm gần nhất, và một mẹo bất ngờ](#1-tìm-điểm-gần-nhất-và-một-mẹo-bất-ngờ)
- [2. Aha moment: Geo chỉ là Sorted Set](#2-aha-moment-geo-chỉ-là-sorted-set)
- [3. Geohash 52-bit: biến bản đồ 2D thành một trục số](#3-geohash-52-bit-biến-bản-đồ-2d-thành-một-trục-số)
- [4. Command catalog: dùng đúng lệnh, đúng option](#4-command-catalog-dùng-đúng-lệnh-đúng-option)
- [5. GEOSEARCH chạy bên trong như thế nào](#5-geosearch-chạy-bên-trong-như-thế-nào)
- [6. Performance model & benchmark tư duy](#6-performance-model--benchmark-tư-duy)
- [7. Patterns thực tế](#7-patterns-thực-tế)
- [8. Sharding trong Redis Cluster](#8-sharding-trong-redis-cluster)
- [9. Anti-patterns cần tránh](#9-anti-patterns-cần-tránh)
- [10. Giới hạn: Redis Geo không phải GIS](#10-giới-hạn-redis-geo-không-phải-gis)
- [11. Case study thực tế](#11-case-study-thực-tế)
- [12. Tóm tắt: cheat-sheet & 3 nguyên tắc](#12-tóm-tắt-cheat-sheet--3-nguyên-tắc)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## 1. Tìm điểm gần nhất, và một mẹo bất ngờ

"Tài xế nào đang trong bán kính 3km?", "cửa hàng nào gần tôi nhất?", "shipper nào ở gần quán ăn?" — vô số tính năng quy về cùng một bài toán: **cho một tập điểm có tọa độ và một vị trí trung tâm, tìm nhanh những điểm nằm trong vùng quanh nó**.

Cách ngây thơ là lưu `lon`, `lat` vào database rồi mỗi lần tìm lại quét toàn bộ điểm và tính khoảng cách từng cái. Với vài chục nghìn điểm và hàng nghìn truy vấn mỗi phút, đó là một cỗ máy đốt CPU.

Redis Geo cho câu trả lời gọn hơn nhiều:

```bash
GEOADD drivers 106.6297 10.8231 "driver:88"
GEOSEARCH drivers FROMLONLAT 106.63 10.82 BYRADIUS 3 km ASC COUNT 10 WITHDIST
# → 10 điểm gần nhất trong 3km, kèm khoảng cách
```

Điều thú vị là Redis không hề có một cấu trúc "bản đồ" riêng. Geo thực chất chỉ là **một lớp mỏng phủ lên [Sorted Set](./sorted-sets.md)**: tọa độ hai chiều được mã hóa thành một con số duy nhất làm score. Đó cũng là câu hỏi mở đầu thú vị nhất của doc này — làm sao nhét được **hai chiều** kinh độ/vĩ độ vào **một** score mà vẫn giữ được tính chất "gần nhau ngoài thực tế thì gần nhau trong dữ liệu"?

Từ mẹo mã hóa đó — **geohash** (mã hóa tọa độ thành chuỗi/số theo ô địa lý) và **bit-interleaving** (đan xen bit longitude/latitude) — doc sẽ đi tiếp tới cách `GEOSEARCH` quét vùng, những giới hạn của Redis Geo, cách shard theo thành phố, và khi nào nên chuyển sang PostGIS hay Elasticsearch.

---

## 2. Aha moment: Geo chỉ là Sorted Set

Chạy thử trong `redis-cli`:

```bash
127.0.0.1:6379> GEOADD drivers 106.6297 10.8231 "driver:1"
(integer) 1

127.0.0.1:6379> TYPE drivers
zset

127.0.0.1:6379> ZSCORE drivers "driver:1"
"3942139036372049"
```

Không có “geo tree” riêng. Không có R-tree. Không có per-member metadata. Key `drivers` là **zset**; member là `driver:1`; score là tọa độ đã mã hóa thành số nguyên geohash 52-bit.

| Bạn nghĩ là Geo | Thực tế trong Redis |
|-----------------|---------------------|
| `GEOADD key lon lat member` | `ZADD key encoded_52bit_score member` |
| `GEOPOS key member` | lấy `ZSCORE`, decode score ra lon/lat |
| `ZREM key member` | xóa điểm geo — không có `GEODEL` |
| `ZCARD key` | đếm số điểm trong geo index |
| `ZSCAN key` | duyệt member trong geo index |
| `ZRANGE key ... WITHSCORES` | thấy raw geohash score |

> [!TIP]
> Aha quan trọng nhất: **mọi thứ bạn biết về Sorted Set vẫn áp dụng** — memory, O(log N) (chi phí tăng theo logarit số phần tử), big key (một key quá lớn gây nặng memory/latency), single-threaded blocking (Redis xử lý command trên một luồng chính nên command nặng làm lệnh khác chờ), hash slot (ô phân vùng mà Redis Cluster dùng để gán key vào node), `ZREM`, `ZCARD`, `ZSCAN`, `ZRANGE`.

Hệ quả thiết kế:

- Một member chỉ có **một vị trí**. `GEOADD` lại cùng member = update tọa độ (score mới).
- Geo key không có per-member TTL. Muốn tài xế “hết hạn” sau 30s không ping → phải tự dùng heartbeat + janitor `ZREM`.
- Vì là zset, một geo key cực lớn vẫn là một **big key** cực lớn.

---

## 3. Geohash 52-bit: biến bản đồ 2D thành một trục số

### 3.1. Vì sao cần bit-interleaving?

Hãy tưởng tượng bạn cần xếp các địa điểm trên bản đồ vào một hàng duy nhất để Sorted Set có thể so sánh; bit-interleaving là cách “xen kẽ” hai tọa độ để hàng đó vẫn giữ được phần nào ý nghĩa gần-xa.

Sorted Set cần một score tuyến tính:

```text
score nhỏ  ───────────────────────────────→  score lớn
```

Bản đồ lại là 2 chiều:

```text
latitude ↑
         │       ● B
         │
         │  ● A
         └────────────────→ longitude
```

Redis giải bằng **Geohash + Z-order/Morton code** (đường đi kiểu chữ Z, còn gọi là Morton code, để biến không gian 2D thành thứ tự 1D): chia longitude và latitude thành bit, rồi đan xen chúng.

```diagram
Bước 1: Chuẩn hóa tọa độ
  longitude: [-180, 180]
  latitude : [-85.05112878, 85.05112878]

Bước 2: Binary split từng chiều
  lon bits:  1 0 1 1 0 0 ...  (26 bit)
  lat bits:  1 1 0 0 1 0 ...  (26 bit)

Bước 3: Interleave
  lon0 lat0 lon1 lat1 lon2 lat2 ...
  1    1    0    1    1    0    ...  → 52-bit integer

Bước 4: Lưu vào ZSet score
  ZADD drivers 3942139036372049 "driver:1"
```

52 bit được chọn vì Redis Sorted Set dùng `double` làm score; `double` biểu diễn chính xác integer tới 2^53. 52-bit geohash nằm an toàn trong vùng này.

| Thành phần | Con số / ý nghĩa |
|------------|------------------|
| Tổng bit | **52 bit** |
| Longitude | ~26 bit |
| Latitude | ~26 bit |
| Độ phân giải gần xích đạo | khoảng **0.6m** |
| `WITHHASH` | trả raw 52-bit geohash score |
| `GEOHASH` | trả chuỗi geohash chuẩn **11 ký tự** |

> [!NOTE]
> `GEOPOS` có thể trả tọa độ hơi khác tọa độ lúc `GEOADD`. Đó không phải lỗi: tọa độ được “snap” vào ô geohash rất nhỏ.

### 3.2. Tại sao điểm gần nhau có score gần nhau?

Trực giác là: nếu hai điểm rơi vào cùng một khu phố trên bản đồ, ta muốn score của chúng cũng nằm gần nhau để Redis scan được bằng range.

Z-order giữ được **locality tương đối**: các điểm chung prefix geohash dài thường nằm gần nhau trên bản đồ, nên chúng cũng nằm gần nhau trong zset score.

```text
Bản đồ 2D được “gấp” thành đường Z-order:

┌───────┬───────┐
│   2   │   3   │
├───────┼───────┤
│   0   │   1   │
└───────┴───────┘

Zoom sâu hơn:
0 → 00,01,02,03
1 → 10,11,12,13
...
```

Điểm mạnh: range scan trên score có thể gom một vùng địa lý.

Điểm yếu: **boundary problem** (vấn đề ở ranh giới ô). Hai điểm cách nhau 5m nhưng nằm hai bên ranh giới ô geohash có thể có prefix khác nhau rất sớm.

```text
┌─────────────┬─────────────┐
│             │             │
│      A ●    │    ● B      │
│             │             │
└─────────────┴─────────────┘
       cùng đường phố, khác ô geohash
```

Vì vậy Redis không thể chỉ scan “ô chứa tâm”. Nó phải scan ô đó **và các ô lân cận** rồi lọc lại bằng khoảng cách thật.

---

## 4. Command catalog: dùng đúng lệnh, đúng option

### 4.1. Bảng lệnh chính

| Command | Dùng khi | Complexity | Ghi chú |
|---------|----------|------------|---------|
| `GEOADD key [NX\|XX] [CH] lon lat member ...` | thêm/cập nhật điểm | O(log N) mỗi item | `lon lat`, không phải `lat lon` |
| `GEOPOS key member ...` | lấy tọa độ đã lưu | O(1) mỗi member | trả `nil` nếu không tồn tại |
| `GEODIST key m1 m2 [m\|km\|mi\|ft]` | tính khoảng cách 2 member | O(1) | dựa trên mô hình Trái Đất hình cầu |
| `GEOHASH key member ...` | lấy geohash string | O(1) mỗi member | chuỗi geohash chuẩn 11 ký tự |
| `GEOSEARCH key ...` | tìm trong radius/box | O(N + log M) | thay thế `GEORADIUS` |
| `GEOSEARCHSTORE dst src ...` | tìm và lưu kết quả | O(N + log M) | kết quả là zset |
| `ZREM key member ...` | xóa điểm | O(log N) mỗi member | vì geo không có lệnh xóa riêng |

`GEORADIUS` và `GEORADIUSBYMEMBER` là lệnh cũ, đã deprecated từ Redis 6.2. Code mới nên dùng `GEOSEARCH` / `GEOSEARCHSTORE`.

### 4.2. GEOADD: NX, XX, CH

```bash
# Chỉ thêm nếu chưa tồn tại; không update member cũ
GEOADD drivers NX 106.6297 10.8231 "driver:88"

# Chỉ update nếu đã tồn tại; không thêm member mới
GEOADD drivers XX 106.6300 10.8240 "driver:88"

# Return số member changed: thêm mới + tọa độ bị update
GEOADD drivers CH 106.6300 10.8240 "driver:88"
```

| Option | Ý nghĩa | Use case |
|--------|---------|----------|
| `NX` | chỉ add member mới | import dữ liệu tĩnh, tránh overwrite |
| `XX` | chỉ update member đã tồn tại | ping vị trí nhưng không muốn tạo ghost member mới |
| `CH` | đổi return value thành số member thay đổi | metrics: bao nhiêu vị trí thật sự đổi |

### 4.3. GEOSEARCH: cú pháp cần nhớ

```bash
GEOSEARCH drivers:{hcm}:online \
  FROMLONLAT 106.6300 10.8200 \
  BYRADIUS 3 km \
  ASC COUNT 10 \
  WITHDIST WITHCOORD WITHHASH
```

| Nhóm option | Lựa chọn | Ý nghĩa |
|-------------|----------|---------|
| Tâm tìm kiếm | `FROMLONLAT lon lat` | dùng tọa độ request |
| Tâm tìm kiếm | `FROMMEMBER member` | dùng tọa độ member đã có |
| Hình dạng | `BYRADIUS r m\|km\|mi\|ft` | hình tròn |
| Hình dạng | `BYBOX width height m\|km\|mi\|ft` | hình chữ nhật axis-aligned |
| Sort | `ASC` / `DESC` | gần nhất / xa nhất trước |
| Limit | `COUNT n` | trả tối đa n kết quả |
| Fast limit | `COUNT n ANY` | đủ n là dừng, không đảm bảo gần nhất |
| Payload | `WITHDIST` | trả khoảng cách tới tâm |
| Payload | `WITHCOORD` | trả tọa độ từng kết quả |
| Payload | `WITHHASH` | trả raw 52-bit score |

> [!IMPORTANT]
> `COUNT 10` không tự động nghĩa là “tìm rẻ”. Nếu không có `ANY`, Redis vẫn phải xét/sort các match trong vùng để chắc chắn 10 kết quả là đúng thứ tự gần nhất.

### 4.4. COUNT ANY: nhanh hơn nhưng không nearest-first

| Query | Redis phải làm gì | Kết quả phù hợp khi |
|-------|-------------------|---------------------|
| `ASC COUNT 10` | tìm toàn bộ match trong vùng, tính distance, sort, lấy 10 | cần **10 gần nhất thật sự** |
| `COUNT 10 ANY` | gặp đủ 10 candidate hợp lệ thì có thể dừng sớm | chỉ cần “một số điểm trong vùng” |
| không `COUNT` | trả toàn bộ match | vùng nhỏ hoặc admin/debug |

Ví dụ “tìm 10 tài xế gần nhất để gán đơn” → **không dùng `ANY`**. Ví dụ “kiểm tra quanh đây có ít nhất vài store không” → `COUNT 5 ANY` hợp lý.

---

## 5. GEOSEARCH chạy bên trong như thế nào

Redis docs mô tả complexity `O(N + log(M))`: `N` là số phần tử trong vùng **bounding box** (hình chữ nhật bao ngoài radius/box cần tìm) theo grid, `M` là số phần tử thật sự nằm trong shape.

Nói đời thường, `GEOSEARCH` không “nhìn quanh” từng điểm trên toàn bản đồ; nó khoanh một vùng ứng viên đủ rộng, lấy điểm trong vùng đó, rồi đo lại để loại điểm thừa.

Quy trình tư duy:

```diagram
Input:
  center = (106.63, 10.82)
  radius = 3 km

Step 1 — Chọn precision/geohash area
  Chọn mức geohash đủ lớn để phủ vùng cần tìm.

Step 2 — Lấy ô trung tâm + 8 ô lân cận
  ┌─────┬─────┬─────┐
  │ NW  │  N  │ NE  │
  ├─────┼─────┼─────┤
  │ W   │  ●  │ E   │   ● = center
  ├─────┼─────┼─────┤
  │ SW  │  S  │ SE  │
  └─────┴─────┴─────┘

Step 3 — Mỗi ô thành một score range
  [min_score_cell, max_score_cell]

Step 4 — Scan zset range
  Lấy candidate bằng skiplist/range scan.

Step 5 — Decode + tính distance thật
  Loại điểm nằm trong bounding box nhưng ngoài hình tròn.

Step 6 — Sort/COUNT
  ASC/DESC nếu cần, rồi cắt COUNT.
```

Tại sao phải 9 ô? Đây là cách Redis tránh bỏ sót hàng xóm đứng ngay bên kia vạch kẻ ô. Vì boundary problem, nếu user đứng sát ranh giới ô, điểm gần nhất có thể nằm ở ô bên cạnh.

```text
Không scan neighbor:
┌──────────────┬──────────────┐
│              │              │
│          ● U │ D ●          │  D rất gần U nhưng ở ô kế bên → miss
│              │              │
└──────────────┴──────────────┘

Scan 1 + 8 area:
┌─────┬─────┬─────┐
│     │     │     │
├─────┼─────┼─────┤
│     │ ● U │ D ● │  D được đưa vào candidate rồi lọc distance
├─────┼─────┼─────┤
│     │     │     │
└─────┴─────┴─────┘
```

> [!NOTE]
> Geo search không tỷ lệ trực tiếp với tổng số member trong key nếu radius nhỏ. Nó tỷ lệ với **mật độ điểm trong vùng bounding grid**. Nhưng radius lớn ở khu đông điểm sẽ làm query nặng và có thể block event loop Redis (vòng xử lý command chính của Redis).

---

## 6. Performance model & benchmark tư duy

### 6.1. Công thức mental model

```text
Cost GEOSEARCH ≈
  log(size_of_zset)                 # nhảy vào zset range
+ candidates_in_covering_cells      # decode + distance filter
+ matches_to_sort                   # nếu ASC/DESC hoặc COUNT không ANY
+ response_size                     # network + serialization
```

Vì Redis chạy command trong event loop, một query “trả về 80.000 điểm” không chỉ chậm cho client đó; nó còn làm các client khác chờ.

### 6.2. Benchmark tư duy theo radius

Bảng dưới đây không phải cam kết tuyệt đối; nó là cách ước lượng để thiết kế test load. Giả sử một key thành phố có 1.000.000 điểm phân bố không đều, query ở khu đô thị dày đặc, kết nối nội bộ.

| Radius | Candidate dự kiến | Kết quả trả về | Latency kỳ vọng | Nhận xét |
|--------|-------------------|----------------|-----------------|----------|
| 300m | vài chục–vài trăm | `COUNT 10` | rất thấp | pattern tốt cho matching realtime |
| 1–3km | vài trăm–vài nghìn | `COUNT 10–50` | thấp đến trung bình | phổ biến cho delivery/ride-hailing |
| 10km | vài nghìn–vài chục nghìn | `COUNT 100` | bắt đầu đáng chú ý | cần monitor p95/p99 |
| 50km | rất nhiều | không `COUNT` | nguy hiểm | dễ block, response lớn |
| 500km | gần như scan vùng khổng lồ | trả hàng loạt | anti-pattern | nên shard/aggregate trước |

### 6.3. Bảng so sánh option hiệu năng

| Mục tiêu | Query nên dùng | Vì sao |
|----------|----------------|-------|
| 10 điểm gần nhất thật | `ASC COUNT 10` | đúng nearest-first |
| Có bất kỳ 10 điểm nào trong vùng | `COUNT 10 ANY` | có thể dừng sớm |
| Hiển thị distance | `WITHDIST` | Redis đã tính distance, tránh app tính lại |
| Debug precision | `WITHHASH WITHCOORD` | thấy score + tọa độ decode |
| Lưu kết quả ngắn hạn | `GEOSEARCHSTORE` + `EXPIRE` | tránh query lặp lại |
| Đếm density hàng nghìn ô | zset score range theo geohash cell | rẻ hơn gọi GEOSEARCH từng ô |

> [!WARNING]
> `COUNT` giới hạn output, không luôn giới hạn work. Muốn giảm work: giảm radius, shard nhỏ hơn, dùng `ANY` khi chấp nhận kết quả không sắp gần nhất, hoặc aggregate theo cell.

---

## 7. Patterns thực tế

### 7.1. Ride-hailing: driver quanh khách

```bash
# Driver app ping vị trí mỗi 5s
GEOADD drivers:{hcm}:online XX 106.6297 10.8231 "driver:88"
SET hb:{hcm}:driver:88 1 EX 15

# Driver mới online
GEOADD drivers:{hcm}:online NX 106.6297 10.8231 "driver:88"
SET hb:{hcm}:driver:88 1 EX 15

# Driver offline
ZREM drivers:{hcm}:online "driver:88"
DEL hb:{hcm}:driver:88

# Tìm 5 driver gần khách nhất trong 3km
GEOSEARCH drivers:{hcm}:online FROMLONLAT 106.6300 10.8200 BYRADIUS 3 km ASC COUNT 5 WITHDIST
```

Geo chỉ trả lời “ai gần”. Sau đó service matching vẫn phải lọc: đang nhận cuốc khác không, loại xe, rating, hướng di chuyển, fraud score.

### 7.2. “Stores near you”: Geo + Hash + Set

```bash
GEOSEARCH stores FROMLONLAT 106.700 10.776 BYRADIUS 10 km ASC COUNT 10 WITHDIST
HGETALL store:st:hcm-01
SISMEMBER stock:sku:1001 st:hcm-01
```

| Dữ liệu | Redis structure | Lý do |
|---------|-----------------|-------|
| id + tọa độ | Geo/zset | search theo khoảng cách |
| tên, giờ mở cửa, phone | Hash | lookup theo id |
| store nào có SKU | Set | membership nhanh |
| ranking business | app/service | không nhồi vào geo score |

### 7.3. GEOSEARCHSTORE cho kết quả dùng lại

```bash
GEOSEARCHSTORE nearby:{req123} stores \
  FROMLONLAT 106.700 10.776 BYRADIUS 10 km ASC COUNT 100 STOREDIST
EXPIRE nearby:{req123} 30

ZRANGE nearby:{req123} 0 9 WITHSCORES
```

Khi cùng một kết quả cần paginate hoặc dùng qua nhiều bước pipeline, `GEOSEARCHSTORE` giúp lưu thành zset tạm. Score có thể là geohash mặc định hoặc distance nếu dùng `STOREDIST`.

---

## 8. Sharding trong Redis Cluster

Một geo key là một zset. Trong [Cluster](./cluster.md), một key thuộc **một hash slot**, tức là nằm trên **một node primary**. Nếu bạn tạo `drivers:world`, bạn vừa tạo một điểm nghẽn không shard được tự nhiên.

| Chiến lược key | Ví dụ | Ưu điểm | Nhược điểm |
|----------------|-------|---------|------------|
| Theo thành phố | `drivers:{hcm}:online` | đơn giản, phù hợp ride-hailing | query gần ranh giới thành phố cần hỏi 2 key |
| Theo region | `stores:{south}` | ít key, dễ vận hành | key có thể vẫn lớn |
| Theo grid/geohash prefix | `drivers:{hcm}:gh6:wsqqm1` | scale rất tốt, density map tốt | query radius phải fan-out nhiều cell |
| Một key toàn cầu | `drivers:world` | code đơn giản | big key, single slot, anti-pattern |

Hash tag `{hcm}` ép các key liên quan vào cùng slot khi cần transaction/pipeline script cùng vùng:

```bash
GEOADD drivers:{hcm}:online 106.6297 10.8231 "driver:88"
SET hb:{hcm}:driver:88 1 EX 15
```

> [!TIP]
> Shard theo cách người dùng thật sự tìm kiếm. Không ai cần tìm “driver gần tôi” xuyên toàn cầu. City/region shard vừa giảm N, vừa giảm blast radius khi một vùng nóng.

---

## 9. Anti-patterns cần tránh

| ❌ Anti-pattern | Vì sao nguy hiểm | ✅ Thay thế |
|----------------|------------------|------------|
| Một geo key cho cả hành tinh | single slot/node, big key, query radius lớn cực nặng | shard theo city/region/grid |
| `GEOSEARCH ... BYRADIUS 500 km` không `COUNT` | trả khối lượng lớn, block Redis, nghẽn network | radius nhỏ, mở rộng dần, luôn có limit |
| Dùng `COUNT` để “đếm mật độ” cho hàng nghìn ô | mỗi ô vẫn có overhead geo search + filter/sort | dùng zset score range theo geohash cell hoặc pre-aggregate |
| Quên `ZREM` driver offline | ghost drivers được match, trải nghiệm tệ | heartbeat key + janitor cleanup |
| Lưu vị trí high-churn không TTL/cleanup | zset phình vĩnh viễn | TTL heartbeat, batch cleanup, metrics stale ratio |
| Nhét JSON lớn làm member | zset memory tăng, network nặng | member là id ngắn; detail ở Hash/DB |
| Đổi `lon lat` thành `lat lon` | vị trí bay sang châu lục khác hoặc bị reject | wrapper function + validation range |
| Cần polygon/geofence phức tạp nhưng cố dùng BYBOX | false positive/false negative nghiệp vụ | PostGIS/Elasticsearch/RediSearch geo |

---

## 10. Giới hạn: Redis Geo không phải GIS

### Khi nào KHÔNG nên dùng Redis Geo

- Cần polygon/geofence phức tạp, spatial join, routing, projection → dùng PostGIS/Elasticsearch/RediSearch.
- Cần search kết hợp text + thuộc tính + geo → dùng RediSearch/Elasticsearch thay vì tự lọc quá nhiều ở app.
- Cần độ chính xác trắc địa hoặc billing theo khoảng cách → dùng GIS chuyên dụng.
- Dồn dữ liệu vào một key toàn cầu (big key, single slot) → shard theo city/region/grid trước khi dùng Geo.

| Giới hạn | Chi tiết | Khi nào đau? | Hướng đi |
|----------|----------|--------------|----------|
| Chỉ index **point** | không polygon, line, multipolygon | vùng giao hàng theo biên phường/quận | PostGIS hoặc app-side polygon check sau Geo |
| Không altitude | chỉ lon/lat 2D | drone, tòa nhà nhiều tầng | model riêng ngoài Redis |
| Trái Đất hình cầu | distance có sai số nhỏ so với geodesic chính xác | trắc địa, billing cực chính xác | GIS chuyên dụng |
| Latitude bị giới hạn khoảng ±85.05° | vùng cực không phù hợp | ứng dụng gần Bắc/Nam Cực | GIS khác |
| Mép ±180 meridian | vùng cắt qua antimeridian cần cẩn thận | Fiji, Alaska, Pacific | split query hai phía kinh tuyến |
| Không join/filter thuộc tính | “quán gần đây đang mở và còn hàng” không native | search nhiều điều kiện | [Redis Modules](./redis-modules.md) / RediSearch, Elasticsearch, PostGIS |
| Không per-member TTL | member stale vẫn nằm trong zset | vị trí động | heartbeat + janitor `ZREM` |

> [!IMPORTANT]
> Redis Geo là “nearby index”, không phải GIS engine. Nếu câu hỏi của bạn có polygon, spatial join, route, layer, projection phức tạp — hãy dùng PostGIS/Elasticsearch geo/RediSearch, rồi để Redis làm cache hoặc realtime index phụ.

---

## 11. Case study thực tế

### 11.1. Food delivery — match đơn với shipper

Bài toán: 30K shipper online toàn quốc, 500 đơn mới/phút giờ cao điểm; mỗi đơn cần danh sách shipper gần quán trong < 50ms để chạy thuật toán gán đơn.

```bash
# App shipper ping vị trí mỗi 10s — pipeline 2 lệnh
GEOADD ship:{hcm}:online 106.6297 10.8231 "s:88"
SET    ship:{hcm}:hb:s:88 1 EX 30

# Có đơn mới tại quán X
GEOSEARCH ship:{hcm}:online FROMLONLAT 106.652 10.795 BYRADIUS 2 km ASC COUNT 20 WITHDIST
```

Luồng match thực tế:

```diagram
Order created
  │
  ├─ GEOSEARCH radius 2km COUNT 20
  │    └─ đủ candidate? yes → scoring service
  │
  ├─ nếu thiếu → radius 5km COUNT 30
  │    └─ đủ candidate? yes → scoring service
  │
  └─ nếu vẫn thiếu → fallback region queue / manual dispatch
```

Bài học: Redis chỉ trả lời “ai ở gần” — nhanh và rẻ; business logic gán đơn nằm ngoài. Key shard theo thành phố, hash tag `{hcm}` để các key liên quan cùng slot trong [Cluster](./cluster.md). Không bao giờ query toàn quốc cho một đơn nội thành.

### 11.2. “Cửa hàng gần bạn” — chuỗi bán lẻ

Bài toán: 2.000 cửa hàng, web/app cần “10 cửa hàng gần nhất + giờ mở cửa + tồn kho sản phẩm đang xem”.

```bash
# Dữ liệu tĩnh, nạp lúc deploy
GEOADD stores 106.700 10.776 "st:hcm-01" 105.854 21.028 "st:hn-01"

# Request
GEOSEARCH stores FROMLONLAT $lon $lat BYRADIUS 10 km ASC COUNT 10 WITHDIST
HGETALL store:st:hcm-01
SISMEMBER stock:sku:1001 st:hcm-01
```

Với vài nghìn điểm tĩnh, Redis Geo thường là quá đủ. Đừng vội kéo PostGIS vào chỉ để hiển thị “cửa hàng gần bạn”. Nhưng nếu product yêu cầu “cửa hàng trong polygon giao hàng, đang mở, có SKU, ưu tiên store rank, exclude khu ngập nước” — đó không còn là bài toán Geo đơn giản.

### 11.3. Surge/density map — score-range trick

Bài toán: tính surge theo ô ~1km: `demand / supply` trong từng cell. Gọi `GEOSEARCH` cho 5.000 cell mỗi vài giây là đắt.

Aha: vì geo = zset score = geohash 52-bit, một cell geohash prefix tương ứng với **một hoặc vài khoảng score liên tục**. App có thể tính min/max score của cell rồi dùng range scan/count.

```bash
# Ý tưởng: cell geohash prefix -> score range
ZRANGEBYSCORE drivers:{hcm} $cell_min_score $cell_max_score
# hoặc dùng Lua/sidecar để chỉ count, không kéo toàn bộ payload nếu volume lớn
```

| Cách làm | Chi phí | Khi dùng |
|----------|---------|----------|
| `GEOSEARCH` quanh tâm từng cell | nhiều filter distance, overhead lớn | ít cell, ad-hoc |
| ZSet score range theo geohash cell | range scan trực tiếp | density grid/surge map |
| Pre-aggregate counter per cell | đọc cực nhanh | dashboard realtime, cell cố định |

Case này minh họa vì sao hiểu internals đáng tiền: biết Geo là zset mở ra kỹ thuật aggregation rẻ hơn lạm dụng radius search.

---

## 12. Tóm tắt: cheat-sheet & 3 nguyên tắc

### Redis Geo đủ dùng khi nào?

| Nhu cầu | Redis Geo | PostGIS | Elasticsearch/RediSearch geo |
|---------|-----------|---------|-------------------------------|
| Tìm điểm gần nhất theo radius/box | ✅ Rất hợp | ✅ | ✅ |
| Vị trí realtime high-churn | ✅ Rất hợp | ⚠️ cần tối ưu write | ⚠️ tùy workload |
| Polygon/geofence chính xác | ❌ | ✅ Rất hợp | ⚠️ tùy feature |
| Spatial join/layer/projection | ❌ | ✅ Rất hợp | ❌/⚠️ |
| Search text + geo + filters | ⚠️ app-side filter | ✅ | ✅ Rất hợp |
| Cache kết quả nearby | ✅ | bổ trợ | bổ trợ |

### Cheat-sheet lệnh

```bash
# Add/update điểm (LON trước, LAT sau)
GEOADD places 106.700 10.776 "st:hcm-01"

# Update only nếu member đã tồn tại
GEOADD places XX 106.701 10.777 "st:hcm-01"

# Lấy vị trí / khoảng cách / geohash string
GEOPOS places "st:hcm-01"
GEODIST places "st:hcm-01" "st:hcm-02" km
GEOHASH places "st:hcm-01"

# Tìm gần nhất đúng thứ tự
GEOSEARCH places FROMLONLAT 106.700 10.776 BYRADIUS 5 km ASC COUNT 10 WITHDIST

# Tìm nhanh “bất kỳ 10 điểm” trong vùng
GEOSEARCH places FROMLONLAT 106.700 10.776 BYRADIUS 5 km COUNT 10 ANY

# Xóa điểm
ZREM places "st:hcm-01"

# Đếm / scan vì geo là zset
ZCARD places
ZSCAN places 0 MATCH "st:hcm-*"
```

### 3 nguyên tắc nhớ lâu

1. **Geo là Sorted Set.** Hiểu zset là hiểu 70% Redis Geo: score, member, O(log N), big key, `ZREM`, hash slot.
2. **Radius nhỏ, key nhỏ, output nhỏ.** Hiệu năng đến từ việc giảm candidate và response, không phải từ niềm tin rằng “Redis luôn nhanh”.
3. **Dùng đúng công cụ.** Redis Geo cho điểm gần nhau; PostGIS/Elasticsearch/RediSearch cho GIS/search phức tạp.

> [!IMPORTANT]
> Câu chốt: Redis Geo giống một radar tốc độ cao — cực giỏi trong việc nói “có những điểm nào quanh đây?”. Nhưng nếu bạn bắt radar đó vẽ bản đồ địa chính, tính polygon, join dữ liệu và làm routing, nó sẽ phản kháng bằng latency p99.

---

## Tài liệu tham khảo

- [Redis Geospatial](https://redis.io/docs/latest/develop/data-types/geospatial/)
- [GEOADD command](https://redis.io/docs/latest/commands/geoadd/)
- [GEOSEARCH command](https://redis.io/docs/latest/commands/geosearch/)
- [Sorted Sets](./sorted-sets.md) — cấu trúc nền của geo index
- [Cluster](./cluster.md) — sharding, hash slot và hash tag
- [Redis Modules](./redis-modules.md) — RediSearch cho truy vấn geo + thuộc tính
