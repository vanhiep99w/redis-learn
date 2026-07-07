# Geospatial

## Mục lục

- [Tổng quan](#tổng-quan)
- [Use Cases phổ biến](#use-cases-phổ-biến)
- [1. Bên trong: geohash trên Sorted Set](#1-bên-trong-geohash-trên-sorted-set)
- [2. Command chính & độ phức tạp](#2-command-chính--độ-phức-tạp)
- [3. GEOSEARCH hoạt động thế nào](#3-geosearch-hoạt-động-thế-nào)
- [4. Patterns thực tế](#4-patterns-thực-tế)
- [5. Giới hạn & khi nào cần công cụ khác](#5-giới-hạn--khi-nào-cần-công-cụ-khác)
- [6. Case study thực tế](#6-case-study-thực-tế)
- [7. Best Practices](#7-best-practices)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## Tổng quan

Geospatial index của Redis lưu các điểm (kinh độ, vĩ độ) và trả lời câu hỏi "**có gì quanh đây?**" trong vài mili giây:

```bash
GEOADD drivers 106.6297 10.8231 "driver:1"     # lon lat member (LON trước!)
GEOSEARCH drivers FROMLONLAT 106.63 10.82 BYRADIUS 3 km ASC
# → các driver trong bán kính 3km, gần nhất trước
```

Điều thú vị nhất: **không có cấu trúc dữ liệu mới nào cả** — geo index chính là một [Sorted Set](./sorted-sets.md), với score là tọa độ được mã hóa geohash 52-bit.

---

## Use Cases phổ biến

| Use Case | Command chính |
|----------|--------------|
| **Tìm tài xế/shipper gần nhất** (ride-hailing, delivery) | `GEOADD` cập nhật vị trí + `GEOSEARCH BYRADIUS` |
| **Cửa hàng/ATM quanh vị trí user** | `GEOSEARCH` + `WITHDIST` |
| **Bạn bè/người chơi lân cận** | `GEOSEARCH FROMMEMBER` |
| **Geofencing thô** ("có trong khu vực X?") | `GEOSEARCH BYBOX` + kiểm tra kết quả |
| **Tính khoảng cách hiển thị** ("cách bạn 1.2km") | `GEODIST` |

---

## 1. Bên trong: geohash trên Sorted Set

### 1.1 Interleave — biến 2 chiều thành 1 chiều

Vấn đề: ZSet sắp theo **một** số double, còn vị trí có **hai** chiều (lon, lat). Giải pháp — geohash interleaving:

1. Chia đôi liên tiếp dải kinh độ [-180, 180] và vĩ độ [-85, 85]: mỗi lần chia, điểm nằm nửa trên = bit 1, nửa dưới = bit 0 → 26 bit cho mỗi chiều
2. **Đan xen** (interleave) bit của 2 chiều: `lon₀ lat₀ lon₁ lat₁ ...` → số 52 bit
3. Số 52 bit này nằm gọn trong phần nguyên chính xác của double (< 2⁵³) → làm **score** của ZSet

```
lon bits:  1 0 1 1 ...
lat bits:   1 1 0 0 ...
interleave: 11 01 10 10 ...  →  score 52-bit
```

Tính chất vàng của geohash: **chung prefix càng dài = càng gần nhau về địa lý**. Hai điểm cách nhau vài trăm mét sẽ có score gần nhau trên trục 1 chiều → range query của ZSet dùng được cho tìm kiếm không gian.

Độ phân giải: 52 bit ≈ ô lưới **0.6m × 0.6m** — quá đủ cho mọi ứng dụng "tìm quanh đây" (và là lý do `GEOPOS` trả về tọa độ hơi lệch so với lúc GEOADD — tọa độ bị snap vào tâm ô).

### 1.2 Hệ quả của việc "chỉ là ZSet"

```
127.0.0.1:6379> GEOADD drivers 106.6297 10.8231 "driver:1"
127.0.0.1:6379> TYPE drivers          → zset
127.0.0.1:6379> ZSCORE drivers driver:1   → "3942139036372049"  (geohash 52-bit)
```

- Mọi lệnh ZSet dùng được: `ZREM key member` để **xóa điểm** (không có GEODEL!), `ZCARD` đếm điểm, `ZSCAN` duyệt, TTL của key
- Một member một vị trí — GEOADD lại cùng member = **cập nhật vị trí** (như ZADD ghi đè score)
- Memory và complexity kế thừa ZSet: thêm/xóa O(log N)

---

## 2. Command chính & độ phức tạp

| Command | Complexity | Ghi chú |
|---------|-----------|---------|
| `GEOADD key lon lat member ...` | O(log N) | option `NX/XX/CH` như ZADD |
| `GEOPOS key member` | O(1) | giải mã score → (lon, lat) — hơi lệch do snap ô |
| `GEODIST key m1 m2 [m\|km\|mi\|ft]` | O(1) | khoảng cách Haversine (coi Trái Đất là cầu, sai số ~0.5%) |
| `GEOSEARCH key FROMLONLAT\|FROMMEMBER BYRADIUS\|BYBOX ...` | O(N+log M) | N = điểm trong vùng bao |
| `GEOSEARCHSTORE dst src ...` | như trên | lưu kết quả thành ZSet mới |
| `GEOHASH key member` | O(1) | chuỗi geohash 11 ký tự chuẩn (tương thích geohash.org) |
| `ZREM key member` | O(log N) | xóa điểm — geo không có lệnh xóa riêng |

`GEORADIUS`/`GEORADIUSBYMEMBER` là bản cũ (deprecated từ 6.2) — dùng `GEOSEARCH` thay thế.

Option của GEOSEARCH:

```bash
GEOSEARCH drivers FROMLONLAT 106.63 10.82 BYRADIUS 3 km \
  ASC COUNT 10 WITHCOORD WITHDIST WITHHASH
#  │       │        │         │        └ score thô
#  │       │        │         └ khoảng cách tới tâm
#  │       │        └ tọa độ từng kết quả
#  │       └ tối đa 10 (thêm ANY = lấy 10 cái đầu gặp, nhanh hơn nhưng không chắc gần nhất)
#  └ gần nhất trước
```

---

## 3. GEOSEARCH hoạt động thế nào

Geohash có một khuyết tật: hai điểm **sát nhau nhưng nằm hai bên ranh giới ô** có thể có prefix rất khác nhau (edge effect). Vì vậy GEOSEARCH không chỉ quét một khoảng score:

1. Từ bán kính r, chọn **mức zoom** geohash sao cho một ô ≥ vùng tìm kiếm
2. Xác định ô chứa tâm + **8 ô lân cận** (3×3) — bịt hết edge effect
3. Mỗi ô ↔ một **khoảng score liên tục** trong ZSet → chạy 9 range query `ZRANGEBYSCORE` (trên cùng skiplist, rất rẻ)
4. Với từng candidate, giải mã ra (lon, lat), tính khoảng cách Haversine thật tới tâm, **lọc bỏ** điểm ngoài bán kính
5. Sort theo khoảng cách nếu ASC/DESC, cắt COUNT

```
┌─────┬─────┬─────┐
│  NW │  N  │ NE  │   9 ô 3×3 phủ trọn hình tròn tìm kiếm
├─────┼─────┼─────┤   → 9 range scan trên ZSet
│  W  │ ●r  │  E  │   → lọc chính xác bằng khoảng cách thật
├─────┼─────┼─────┤
│  SW │  S  │ SE  │
└─────┴─────┴─────┘
```

Hệ quả hiệu năng: chi phí tỷ lệ với **số điểm nằm trong vùng bao 9 ô**, không phải tổng số điểm trong key. Bán kính càng lớn → ô càng to → càng nhiều candidate phải lọc → chậm dần. Tìm "bán kính 500km giữa thành phố dày đặc điểm" là truy vấn nặng.

---

## 4. Patterns thực tế

### 4.1 Ride-hailing: driver quanh khách

```bash
# Driver app ping vị trí mỗi 5s (GEOADD = update):
GEOADD drivers:online 106.6297 10.8231 "driver:88"

# Driver offline → xóa bằng lệnh ZSet:
ZREM drivers:online "driver:88"

# Tìm 5 driver gần khách nhất trong 3km:
GEOSEARCH drivers:online FROMLONLAT 106.6300 10.8200 BYRADIUS 3 km ASC COUNT 5 WITHDIST
```

Vị trí "sống" (phải ping mới còn) → kết hợp TTL: mỗi ping cũng `SET hb:driver:88 1 EX 15`; janitor quét member không còn heartbeat và ZREM. (Geo/ZSet không có per-member TTL.)

### 4.2 Shard theo thành phố

```bash
GEOADD drivers:{hcm} ...      # mỗi thành phố một key
GEOADD drivers:{hanoi} ...
```

Một key = một node trong [Cluster](./cluster.md) — chia theo thành phố vừa scale ghi vừa thu nhỏ N của mỗi truy vấn. Không ai cần tìm driver "gần đây" xuyên 1700km.

### 4.3 Kết quả tìm kiếm + dữ liệu chi tiết

```bash
GEOSEARCH stores FROMLONLAT ... BYRADIUS 5 km ASC COUNT 20   # → danh sách id
HGETALL store:412                                            # chi tiết từng store (Hash)
```

Geo set chỉ giữ **id + vị trí**; thuộc tính (tên, giờ mở cửa) nằm trong [Hash](./hashes.md) — cùng nguyên tắc "member nhỏ" của ZSet.

---

## 5. Giới hạn & khi nào cần công cụ khác

| Giới hạn | Chi tiết / thay thế |
|----------|--------------------|
| Chỉ lưu **điểm** | Không polygon, không line — geofencing đa giác phải tự kiểm tra phía app hoặc dùng PostGIS |
| Vĩ độ ±85.05° | Do phép chiếu Web Mercator — hai vùng cực không index được |
| Khoảng cách Haversine | Sai số ~0.5% (Trái Đất không phải hình cầu hoàn hảo) — đủ cho hiển thị, không đủ cho trắc địa |
| Không per-member TTL | Tự chế heartbeat như 4.1 |
| Không join thuộc tính | "Tìm quán cafe gần đây *đang mở cửa*" = GEOSEARCH rồi lọc app-side, hoặc RediSearch với field GEO — xem [Redis Modules](./redis-modules.md) |

**Chọn nhanh:** cần "điểm gần đây" tốc độ cao, dữ liệu sống (vị trí xe, người chơi) → Redis geo. Cần truy vấn không gian thực thụ (polygon, chồng lớp, join) → PostGIS; Redis khi đó làm cache kết quả.

---

## 6. Case study thực tế

### 6.1 Food delivery — match đơn với shipper

Bài toán: 30K shipper online toàn quốc, 500 đơn mới/phút giờ cao điểm; mỗi đơn cần danh sách shipper gần quán trong < 50ms để chạy thuật toán gán đơn.

```bash
# App shipper ping vị trí mỗi 10s — pipeline 2 lệnh:
GEOADD ship:{hcm}:online 106.6297 10.8231 "s:88"
SET    ship:{hcm}:hb:s:88 1 EX 30            # heartbeat — geo không có per-member TTL

# Có đơn mới tại quán X:
GEOSEARCH ship:{hcm}:online FROMLONLAT 106.652 10.795 BYRADIUS 2 km ASC COUNT 20 WITHDIST
# → 20 candidate gần nhất + khoảng cách → service gán đơn lọc tiếp
#   (đang giao đơn khác? rating? hướng di chuyển?) phía app

# Janitor 30s/lần: ZSCAN geo set, member nào mất heartbeat → ZREM
```

Bài học từ thiết kế này: Redis chỉ trả lời "**ai ở gần**" — nhanh và rẻ; toàn bộ business logic gán đơn nằm ngoài. Key shard theo thành phố (hash tag `{hcm}` để cùng slot với key heartbeat trong [Cluster](./cluster.md)), bán kính mở rộng dần 2→5→10km nếu chưa đủ candidate — không bao giờ quét toàn quốc.

### 6.2 "Cửa hàng gần bạn" — chuỗi bán lẻ

Bài toán: 2000 cửa hàng, trang web/app cần "10 cửa hàng gần nhất + giờ mở cửa + tồn kho sản phẩm đang xem".

```bash
# Dữ liệu tĩnh, nạp lúc deploy:
GEOADD stores 106.700 10.776 "st:hcm-01" 105.854 21.028 "st:hn-01" ...

# Request:
GEOSEARCH stores FROMLONLAT $lon $lat BYRADIUS 10 km ASC COUNT 10 WITHDIST
# → [st:hcm-01 (0.8km), st:hcm-05 (2.3km), ...]
HGETALL store:st:hcm-01                       # tên, giờ mở, phone — từ Hash
SISMEMBER stock:sku:1001 st:hcm-01            # có hàng không — từ Set
```

Mẫu kết hợp 3 structure rất điển hình: **geo trả id theo khoảng cách, [Hash](./hashes.md) giữ thuộc tính, [Set](./sets.md) giữ quan hệ tồn kho** — mỗi cái làm đúng việc của nó. Với 2000 điểm tĩnh, mọi truy vấn < 1ms; còn "lọc theo tồn kho ngay trong truy vấn geo" → lúc đó mới cần đến RediSearch hoặc DB.

### 6.3 Ride-sharing surge map — đếm mật độ theo ô

Bài toán: tính hệ số surge theo khu vực = tỉ lệ (khách đang chờ / tài xế rảnh) trong từng ô lưới ~1km.

```bash
# Cách 1 — thuần geo: đếm quanh tâm ô bằng GEOSEARCH... COUNT chỉ để đếm → đắt khi gọi cho hàng nghìn ô
# Cách 2 — tận dụng bản chất ZSet của geo: mỗi ô geohash-6 là MỘT KHOẢNG SCORE LIÊN TỤC
ZRANGEBYSCORE drivers:{hcm} $min_score_ô $max_score_ô        # đếm tài xế trong ô — 1 range scan
# (tính min/max score của ô geohash phía app — công thức interleave mục 1.1)
```

Case này minh họa vì sao hiểu internals đáng tiền: biết geo = ZSet + geohash prefix → mở ra cách đếm theo ô bằng range query rẻ thay vì lạm dụng GEOSEARCH. Thực tế nhiều hệ thống surge (như mô tả công khai của Uber/Grab) dùng chính lưới hexagon/geohash để aggregate mật độ như vậy.

---

## 7. Best Practices

- **Thứ tự tham số là (longitude, latitude)** — ngược với thói quen "lat, lon" của Google Maps; lỗi số 1 của người mới, và GEOADD chỉ báo lỗi khi giá trị vượt dải hợp lệ
- **Bán kính tìm kiếm nhỏ nhất có thể** — mở rộng dần (1km → 3km → 10km) thay vì quét 50km ngay từ đầu
- **`COUNT n` luôn luôn** — không giới hạn kết quả trong khu dày đặc điểm là tự bắn vào chân
- **Shard theo vùng địa lý** khi một key vượt vài triệu điểm hoặc cần scale ghi
- **Xóa điểm bằng `ZREM`**, và nhớ dọn member "chết" (không có TTL per-member)
- **GEOSEARCHSTORE + TTL** cho kết quả dùng lại nhiều lần (trang danh sách phân trang)

---

## Tài liệu tham khảo

- [Redis Geospatial](https://redis.io/docs/latest/develop/data-types/geospatial/)
- [GEOSEARCH command](https://redis.io/docs/latest/commands/geosearch/)
- [Sorted Sets](./sorted-sets.md) — cấu trúc nền của geo index
- [Redis Modules](./redis-modules.md) — RediSearch cho truy vấn geo + thuộc tính
