# Eviction Policies

## Mục lục

- [Tổng quan](#tổng-quan)
- [Eviction xảy ra khi nào](#eviction-xảy-ra-khi-nào)
- [Các policy Redis hỗ trợ](#các-policy-redis-hỗ-trợ)
- [LRU hoạt động như thế nào](#lru-hoạt-động-như-thế-nào)
- [LFU hoạt động như thế nào](#lfu-hoạt-động-như-thế-nào)
- [TTL-based eviction](#ttl-based-eviction)
- [Noeviction và write safety](#noeviction-và-write-safety)
- [Chọn policy theo use case](#chọn-policy-theo-use-case)
- [Cấu hình và kiểm tra](#cấu-hình-và-kiểm-tra)
- [Quan sát eviction trong production](#quan-sát-eviction-trong-production)
- [Các lỗi thiết kế thường gặp](#các-lỗi-thiết-kế-thường-gặp)
- [Best Practices](#best-practices)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## Tổng quan

Eviction là cơ chế Redis **tự xóa key** khi memory chạm `maxmemory`. Nếu Redis được dùng làm cache, eviction là một phần bình thường của hệ thống. Nếu Redis được dùng như database/source-of-truth, eviction có thể là mất dữ liệu nghiêm trọng.

```text
Write command đến Redis
        │
        ▼
Redis kiểm tra used_memory >= maxmemory?
        │
        ├── No ──▶ thực thi command
        │
        └── Yes
             │
             ▼
       Áp dụng maxmemory-policy
             │
             ├── Evict được key ──▶ thực thi command
             └── Không evict được ─▶ trả OOM error cho write
```

Eviction policy trả lời câu hỏi: **khi thiếu RAM, Redis nên xóa key nào trước?**

> [!IMPORTANT]
> Eviction không thay thế capacity planning. Nếu eviction tăng liên tục, cache có thể đang quá nhỏ, TTL sai, hoặc workload thay đổi. Eviction ổn định ở mức thấp có thể chấp nhận với cache; eviction bất ngờ với dữ liệu quan trọng là incident.

---

## Eviction xảy ra khi nào

Redis chỉ kích hoạt eviction khi:

1. `maxmemory` được set lớn hơn 0.
2. Bộ nhớ Redis vượt ngưỡng.
3. Có command cần cấp phát thêm memory, thường là write.

Cấu hình cơ bản:

```conf
maxmemory 8gb
maxmemory-policy allkeys-lfu
```

Runtime:

```bash
redis-cli CONFIG SET maxmemory 8gb
redis-cli CONFIG SET maxmemory-policy allkeys-lfu
```

### Eviction không có nghĩa là OS hết RAM

Redis eviction dựa trên `maxmemory`, không phải RAM vật lý còn lại. Bạn có thể thấy eviction dù server còn RAM vì `maxmemory` đặt thấp. Ngược lại, nếu `maxmemory` quá cao, OS có thể OOM kill Redis trước khi eviction cứu được.

### Write command nào có thể bị ảnh hưởng?

Khi không evict được key, Redis trả lỗi dạng:

```text
(error) OOM command not allowed when used memory > 'maxmemory'.
```

Các command đọc thường vẫn chạy, nhưng command ghi hoặc command cần allocate memory sẽ fail.

---

## Các policy Redis hỗ trợ

| Policy | Pool key được xét | Cách chọn key xóa | Phù hợp |
|--------|-------------------|-------------------|---------|
| `noeviction` | Không xóa | Reject write khi hết memory | Redis lưu dữ liệu quan trọng |
| `allkeys-lru` | Tất cả key | Ít được dùng gần đây | Cache tổng quát |
| `volatile-lru` | Chỉ key có TTL | Ít được dùng gần đây | Cache chỉ trên key TTL |
| `allkeys-lfu` | Tất cả key | Ít được dùng thường xuyên | Cache có skew/hot keys |
| `volatile-lfu` | Chỉ key có TTL | Ít được dùng thường xuyên | Cache TTL + hot key rõ |
| `allkeys-random` | Tất cả key | Random | Workload đều, cần chi phí thấp |
| `volatile-random` | Chỉ key có TTL | Random trong key TTL | Ít dùng, đơn giản |
| `volatile-ttl` | Chỉ key có TTL | TTL còn lại ngắn nhất | Dữ liệu có deadline tự nhiên |

### `allkeys-*` vs `volatile-*`

```text
allkeys-lru
  Xem toàn bộ keyspace là cache, key nào cũng có thể bị xóa.

volatile-lru
  Chỉ xóa key có TTL. Key không TTL không bị eviction.
```

Nếu dùng `volatile-*` nhưng phần lớn key không có TTL, Redis có thể không tìm được key để xóa và trả OOM, dù trong database có rất nhiều key.

> [!WARNING]
> `volatile-*` không có nghĩa là Redis sẽ tự thêm TTL. App phải set TTL cho key. Quên TTL là nguyên nhân rất phổ biến gây OOM với `volatile-lru`/`volatile-lfu`.

---

## LRU hoạt động như thế nào

LRU = Least Recently Used. Ý tưởng: key lâu không được truy cập thì ít có khả năng cần trong tương lai.

```text
Truy cập gần đây hơn  ─────────────────────────▶
key A   key B   key C   key D
^                         ^
ít recent                recent

Khi cần evict: ưu tiên key A
```

### Redis dùng approximate LRU

Redis không duy trì danh sách LRU chính xác cho mọi key vì chi phí cao. Thay vào đó, Redis lưu metadata thời gian truy cập gần đây và lấy mẫu một số key để chọn ứng viên xấu nhất.

Cấu hình sample:

```conf
maxmemory-samples 5
```

Tăng sample giúp gần LRU thật hơn nhưng tốn CPU hơn:

```bash
redis-cli CONFIG SET maxmemory-samples 10
```

| `maxmemory-samples` | Độ chính xác | CPU cost |
|---------------------|--------------|----------|
| 3 | Thấp hơn | Thấp |
| 5 | Default phổ biến | Cân bằng |
| 10 | Tốt hơn | Cao hơn |

### Khi nào LRU tốt?

LRU tốt nếu workload có tính **temporal locality**: thứ vừa được dùng gần đây có khả năng được dùng lại.

Ví dụ:

- Cache API response trong web app.
- Cache profile user active gần đây.
- Cache product detail trong e-commerce.

### Khi nào LRU kém?

LRU có thể bị “pollution” bởi scan workload:

```text
Cache đang có hot keys: A, B, C
Một batch job đọc tuần tự 1 triệu key hiếm dùng
LRU metadata bị cập nhật bởi dữ liệu chỉ đọc một lần
Hot keys có thể bị đẩy ra nếu cache nhỏ
```

Nếu workload có nhiều key được đọc một lần, LFU thường phù hợp hơn.

---

## LFU hoạt động như thế nào

LFU = Least Frequently Used. Ý tưởng: key ít được truy cập thường xuyên thì bị xóa trước.

Redis LFU dùng counter xấp xỉ, không phải bộ đếm chính xác tuyệt đối. Counter tăng theo xác suất và giảm dần theo thời gian.

```text
key hot:    read nhiều lần  -> LFU counter cao
key cold:   read ít lần     -> LFU counter thấp
key old hot: từng hot nhưng lâu không dùng -> counter decay dần
```

### Tham số LFU

```conf
lfu-log-factor 10
lfu-decay-time 1
```

| Config | Ý nghĩa |
|--------|---------|
| `lfu-log-factor` | Điều chỉnh tốc độ counter tăng. Cao hơn → khó tăng hơn |
| `lfu-decay-time` | Số phút để counter decay theo thời gian |

Runtime:

```bash
redis-cli CONFIG SET lfu-log-factor 10
redis-cli CONFIG SET lfu-decay-time 1
```

### Vì sao counter không tăng tuyến tính?

Nếu counter tăng +1 mỗi lần truy cập, hot key cực nóng sẽ đạt max rất nhanh và gần như không bao giờ bị evict, kể cả sau khi hết hot. Redis dùng probabilistic counter để tránh vấn đề này.

### Khi nào LFU tốt?

LFU tốt nếu có **popular items ổn định**:

- Top product.
- Top articles.
- User/session active thường xuyên.
- Config/feature flag được đọc liên tục.
- Cache search result có query phổ biến.

### Khi nào LFU cần cẩn thận?

Nếu traffic thay đổi theo trend rất nhanh, LFU decay quá chậm có thể giữ key từng hot nhưng nay đã lạnh. Khi đó cần giảm `lfu-decay-time` hoặc dùng LRU.

---

## TTL-based eviction

`volatile-ttl` chỉ xét key có TTL và xóa key có TTL còn lại ngắn nhất.

```text
key A TTL 5s
key B TTL 60s
key C no TTL

volatile-ttl sẽ ưu tiên A; C không bị xét.
```

Policy này hợp khi TTL mang ý nghĩa business rõ: key sắp hết hạn thì ít giá trị hơn key còn sống lâu.

Ví dụ:

- Temporary token.
- Short-lived verification code.
- Cache theo deadline dữ liệu.

Không nên dùng `volatile-ttl` nếu TTL chỉ được set ngẫu nhiên để chống stampede. TTL ngắn không nhất thiết nghĩa là key ít quan trọng.

---

## Noeviction và write safety

`noeviction` không xóa key. Khi vượt memory, write fail. Đây là lựa chọn an toàn hơn cho dữ liệu không được mất.

```conf
maxmemory 8gb
maxmemory-policy noeviction
```

Phù hợp khi Redis giữ:

- Queue quan trọng.
- Session không thể mất tùy tiện.
- Distributed lock state.
- Rate limit state cần chính xác hơn.
- Dữ liệu gần source-of-truth.

Nhưng `noeviction` yêu cầu app xử lý OOM error:

```text
Redis OOM -> write fail -> app retry vô hạn -> traffic tăng -> incident nặng hơn
```

Best practice:

- Alert trước khi đầy memory.
- App phải có timeout/backoff.
- Có runbook scale up/scale out/cleanup key.
- Có TTL/retention cho dữ liệu tạm.

---

## Chọn policy theo use case

| Use case | Policy gợi ý | Lý do |
|----------|--------------|-------|
| Cache-aside API response | `allkeys-lfu` hoặc `allkeys-lru` | Mọi key là cache, có thể xóa |
| Cache product hot | `allkeys-lfu` | Giữ item được đọc nhiều |
| Cache user gần đây | `allkeys-lru` | Recent activity quan trọng |
| Session store | Thường `volatile-lru` hoặc `noeviction` | Tùy session có thể mất hay không |
| Rate limiting | `noeviction` hoặc `volatile-ttl` | Sai lệch rate limit có thể nguy hiểm |
| Distributed lock | `noeviction` | Không được evict lock tùy tiện |
| Queue/List/Stream | `noeviction` | Evict là mất message |
| Temporary token | `volatile-ttl` | Token gần hết hạn ít giá trị hơn |
| Mixed cache + durable data cùng Redis | Không khuyến nghị | Tách instance tốt hơn |

> [!IMPORTANT]
> Tránh trộn cache có thể mất và dữ liệu không được mất trong cùng Redis instance. Nếu bắt buộc trộn, eviction policy sẽ luôn là compromise nguy hiểm.

---

## Cấu hình và kiểm tra

### Xem config hiện tại

```bash
redis-cli CONFIG GET maxmemory
redis-cli CONFIG GET maxmemory-policy
redis-cli CONFIG GET maxmemory-samples
```

### Set runtime

```bash
redis-cli CONFIG SET maxmemory 4gb
redis-cli CONFIG SET maxmemory-policy allkeys-lfu
redis-cli CONFIG SET maxmemory-samples 10
```

### Ghi vào `redis.conf`

```conf
maxmemory 4gb
maxmemory-policy allkeys-lfu
maxmemory-samples 10

# LFU tuning nếu dùng LFU
lfu-log-factor 10
lfu-decay-time 1
```

### Test eviction nhanh trên local

```bash
redis-server --save "" --appendonly no --maxmemory 20mb --maxmemory-policy allkeys-lru
```

Load dữ liệu:

```bash
for i in $(seq 1 100000); do
  redis-cli SET "k:$i" "$(openssl rand -hex 200)" > /dev/null
done
```

Xem eviction:

```bash
redis-cli INFO stats | grep evicted_keys
redis-cli DBSIZE
```

---

## Quan sát eviction trong production

Các metric quan trọng:

```bash
redis-cli INFO stats | egrep 'evicted_keys|keyspace_hits|keyspace_misses|expired_keys'
redis-cli INFO memory | egrep 'used_memory|maxmemory|mem_not_counted_for_evict'
```

| Metric | Ý nghĩa | Alert gợi ý |
|--------|---------|-------------|
| `evicted_keys` | Tổng key bị eviction | Tăng đột ngột cần điều tra |
| `keyspace_hits` | Cache hit | Dùng tính hit ratio |
| `keyspace_misses` | Cache miss | Miss tăng sau eviction spike là dấu hiệu cache churn |
| `expired_keys` | Key hết hạn tự nhiên | Bình thường nếu dùng TTL |
| `used_memory / maxmemory` | Mức đầy cache | Alert 75-85%, critical 90%+ tùy hệ thống |

Hit ratio:

```text
hit_ratio = keyspace_hits / (keyspace_hits + keyspace_misses)
```

> [!NOTE]
> Eviction spike thường kéo theo cache miss spike, database phía sau tăng tải, rồi response chậm. Vì vậy alert eviction nên liên kết với DB QPS/latency, không nhìn Redis riêng lẻ.

---

## Các lỗi thiết kế thường gặp

### 1. Dùng `volatile-lru` nhưng quên TTL

```bash
SET cache:user:1 '{...}'
# quên EX/PX
```

Key không có TTL sẽ không bị eviction trong `volatile-lru`. Khi phần key TTL không đủ để xóa, write fail.

Đúng hơn:

```bash
SET cache:user:1 '{...}' EX 3600
```

### 2. Dùng `allkeys-lru` cho queue

Nếu queue nằm cùng Redis với cache, eviction có thể xóa message.

```text
cache:*  -> có thể evict
queue:*  -> không được evict
```

Tách instance hoặc dùng `noeviction` cho Redis queue.

### 3. TTL đồng loạt gây stampede

Nếu hàng triệu key cùng TTL 3600s và được tạo cùng lúc, chúng có thể expire/evict cùng lúc.

Giải pháp:

```text
TTL = base_ttl + random_jitter
```

Ví dụ:

```bash
# app-side pseudo
ttl = 3600 + random(0, 300)
SET cache:key value EX ttl
```

### 4. Cache quá nhỏ so với working set

Nếu working set 100GB nhưng cache 5GB, eviction liên tục. Hit ratio thấp, Redis chỉ đang churn.

Giải pháp:

- Tăng memory.
- Shard cache.
- Cache selective hơn.
- Tối ưu value size.
- Dùng LFU nếu access skew rõ.

---

## Best Practices

- Với pure cache, bắt đầu bằng `allkeys-lfu` nếu có hot keys; dùng `allkeys-lru` nếu recency quan trọng.
- Với dữ liệu quan trọng, dùng `noeviction` và alert sớm.
- Không trộn cache và durable workload trong cùng instance.
- Nếu dùng `volatile-*`, đảm bảo mọi cache key có TTL.
- Thêm jitter vào TTL để tránh expire storm.
- Theo dõi `evicted_keys` theo rate, không chỉ total.
- Đo hit ratio trước/sau khi đổi policy.
- Chừa memory headroom cho replication/AOF/fork; eviction không xử lý mọi loại memory.
- Test policy bằng workload gần production, không chỉ bằng `redis-benchmark` mặc định.

---

## Tài liệu tham khảo

- [Redis Documentation - Key eviction](https://redis.io/docs/latest/develop/reference/eviction/)
- [Redis Documentation - LFU eviction](https://redis.io/docs/latest/develop/reference/eviction/#lfu-eviction)
- [Memory Management](./memory-management.md)
- [Caching Patterns](./caching-patterns.md)
