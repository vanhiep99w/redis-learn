# Slow Log & Latency

## Mục lục

- [Tổng quan](#tổng-quan)
- [Latency trong Redis đến từ đâu](#latency-trong-redis-đến-từ-đâu)
- [Slow Log là gì](#slow-log-là-gì)
- [Cấu hình Slow Log](#cấu-hình-slow-log)
- [Đọc và phân tích SLOWLOG](#đọc-và-phân-tích-slowlog)
- [Latency Monitor](#latency-monitor)
- [Command gây latency phổ biến](#command-gây-latency-phổ-biến)
- [Big keys và hot keys](#big-keys-và-hot-keys)
- [Fork, persistence và latency spike](#fork-persistence-và-latency-spike)
- [Client, network và output buffer](#client-network-và-output-buffer)
- [Runbook debug latency](#runbook-debug-latency)
- [Best Practices](#best-practices)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## Tổng quan

Redis nổi tiếng latency thấp, nhưng không có nghĩa là mọi command luôn nhanh. Redis command execution path chủ yếu chạy tuần tự trên event loop. Một command chậm, một key quá lớn, một fork tốn thời gian, hoặc một client nhận response quá chậm đều có thể kéo P99/P999 latency lên.

Có hai nhóm công cụ quan trọng:

| Công cụ | Dùng để | Giới hạn |
|---------|---------|----------|
| `SLOWLOG` | Ghi lại command mất nhiều thời gian thực thi trong Redis | Không tính thời gian network/client queue |
| Latency Monitor | Ghi nhận latency spike từ nhiều event nội bộ | Cần bật threshold, phân tích theo event |

> [!IMPORTANT]
> `SLOWLOG` đo thời gian Redis thực thi command, không đo tổng thời gian app chờ. Nếu app thấy Redis call 200ms nhưng SLOWLOG sạch, vấn đề có thể nằm ở network, connection pool, client queue, TLS, CPU scheduling hoặc response lớn.

---

## Latency trong Redis đến từ đâu

Một request Redis đi qua nhiều chặng:

```text
App code
  │ serialize command
  ▼
Client library queue / connection pool
  │ write socket
  ▼
Network / TLS / kernel
  │
  ▼
Redis input buffer
  │ parse command
  ▼
Redis execute command
  │ access data structure / allocate / free
  ▼
Redis output buffer
  │ write socket
  ▼
Network back to client
  │ parse response
  ▼
App receives result
```

`SLOWLOG` chỉ nhìn phần:

```text
Redis execute command
```

Vì vậy cần phân biệt:

| Loại latency | Ví dụ nguyên nhân | Công cụ |
|--------------|-------------------|---------|
| Server execution | `HGETALL` huge hash, Lua lâu | `SLOWLOG`, `INFO commandstats` |
| Server event spike | fork, eviction, expire cycle | `LATENCY DOCTOR`, `LATENCY LATEST` |
| Network/client | connection pool queue, packet loss | app metrics, tcpdump, client tracing |
| Response transfer | `SMEMBERS` trả 100MB | app latency, output buffer, network metrics |
| OS/runtime | swap, CPU steal, THP, noisy neighbor | `vmstat`, `top`, cloud metrics |

---

## Slow Log là gì

Slow Log là log vòng trong memory của Redis. Khi command chạy lâu hơn threshold, Redis ghi lại entry gồm:

- ID entry.
- Timestamp.
- Duration tính bằng microseconds.
- Command và arguments.
- Client address/name nếu có.

Xem log:

```bash
redis-cli SLOWLOG GET 10
```

Xem số lượng entry:

```bash
redis-cli SLOWLOG LEN
```

Reset log:

```bash
redis-cli SLOWLOG RESET
```

### Slow Log không phải file log

Slow Log nằm trong memory và có giới hạn độ dài. Khi đầy, entry cũ bị loại bỏ. Nó không thay thế centralized logging/metrics.

---

## Cấu hình Slow Log

Hai config quan trọng:

```conf
slowlog-log-slower-than 10000
slowlog-max-len 128
```

| Config | Ý nghĩa |
|--------|---------|
| `slowlog-log-slower-than` | Threshold microseconds. `10000` = 10ms |
| `slowlog-max-len` | Số entry tối đa giữ trong memory |

Runtime:

```bash
redis-cli CONFIG GET slowlog-log-slower-than
redis-cli CONFIG GET slowlog-max-len

redis-cli CONFIG SET slowlog-log-slower-than 10000
redis-cli CONFIG SET slowlog-max-len 1024
```

### Chọn threshold bao nhiêu?

| Môi trường | Threshold gợi ý |
|------------|-----------------|
| Local debug | `0` để log mọi command, chỉ dùng rất ngắn |
| Low-latency service | 1ms - 5ms |
| Cache thông thường | 5ms - 10ms |
| Batch/offline | 10ms - 50ms |

> [!WARNING]
> Set threshold `0` trong production sẽ log mọi command, gây overhead và làm log nhiễu. Chỉ bật tạm thời trong cửa sổ debug ngắn nếu thật cần.

### Duration trong SLOWLOG tính gì?

Duration không tính:

- Thời gian command chờ trong socket/input buffer trước khi execute.
- Thời gian gửi response về client.
- Thời gian client parse response.

Duration có tính:

- Thời gian Redis xử lý command.
- Thời gian chạy Lua script.
- Thời gian truy cập/duyệt data structure.
- Một phần chi phí allocate/free trong command.

---

## Đọc và phân tích SLOWLOG

Ví dụ output dạng RESP được `redis-cli` render:

```text
1) 1) (integer) 42
   2) (integer) 1720000000
   3) (integer) 15321
   4) 1) "HGETALL"
      2) "user:sessions:active"
   5) "10.0.1.15:52144"
   6) "api-worker-7"
```

Diễn giải:

| Field | Ý nghĩa |
|-------|---------|
| `42` | Slowlog entry ID |
| timestamp | Unix time |
| `15321` | 15.321 microseconds = 15.3ms |
| command | `HGETALL user:sessions:active` |
| client | Client address |
| client name | Nếu app set `CLIENT SETNAME` |

### Tạo client name để debug dễ hơn

Trong app, set client name theo service/worker:

```bash
CLIENT SETNAME api-user-service
```

Hoặc trong client library nếu hỗ trợ. Khi SLOWLOG có client name, việc truy ngược source dễ hơn rất nhiều.

### Nhóm theo command

Nếu thấy nhiều entry:

```bash
redis-cli SLOWLOG GET 128
```

Phân loại:

- Command nào xuất hiện nhiều nhất?
- Key pattern nào liên quan?
- Có client/service cụ thể gây ra không?
- Duration cao nhất là command gì?
- Có trùng thời điểm deploy/batch job không?

### SLOWLOG sạch nhưng app vẫn chậm

Điều này thường chỉ ra:

- Connection pool cạn, request chờ connection.
- Network/TLS/load balancer chậm.
- Response lớn mất thời gian truyền.
- Client event loop/GC pause.
- Redis CPU bị nghẽn nhưng từng command dưới threshold.
- Pipeline quá lớn làm command chờ phía client.

---

## Latency Monitor

Redis Latency Monitor ghi lại spike cho các event nội bộ. Bật bằng threshold microseconds:

```bash
redis-cli CONFIG SET latency-monitor-threshold 100
```

Xem event mới nhất:

```bash
redis-cli LATENCY LATEST
```

Chẩn đoán tự động:

```bash
redis-cli LATENCY DOCTOR
```

Lịch sử event:

```bash
redis-cli LATENCY HISTORY command
```

Reset:

```bash
redis-cli LATENCY RESET
```

### Event thường gặp

| Event | Ý nghĩa |
|-------|---------|
| `command` | Command execution chậm |
| `fork` | `fork()` mất thời gian |
| `aof-write` | Ghi AOF chậm |
| `aof-fsync-always` | fsync AOF chậm nếu dùng always |
| `expire-cycle` | Chu kỳ expire tốn thời gian |
| `eviction-cycle` | Eviction tốn thời gian |
| `active-defrag-cycle` | Defrag tốn CPU/time |
| `rdb-unlink-temp-file` | Xóa file RDB temp |

> [!TIP]
> `LATENCY DOCTOR` rất hữu ích để bắt đầu, nhưng vẫn cần correlate với metrics OS, app và thời điểm traffic/deploy.

---

## Command gây latency phổ biến

Redis có nhiều command O(1) rất nhanh, nhưng cũng có command O(N). Vấn đề không phải command “xấu” tuyệt đối, mà là dùng trên dữ liệu lớn hoặc trong hot path.

| Command | Risk | Thay thế/cách dùng an toàn |
|---------|------|----------------------------|
| `KEYS *` | Quét toàn bộ keyspace, block | `SCAN` |
| `HGETALL huge` | Trả toàn bộ hash lớn | `HSCAN`, `HMGET` field cần thiết |
| `SMEMBERS huge` | Trả toàn bộ set lớn | `SSCAN`, `SRANDMEMBER count` |
| `LRANGE list 0 -1` | Trả list lớn | Range nhỏ, pagination |
| `ZRANGE zset 0 -1` | Trả zset lớn | Range theo page/score |
| `DEL huge` | Free memory đồng bộ | `UNLINK` |
| `SORT` | CPU/memory nặng | Precompute index, ZSet |
| Lua script dài | Block event loop | Tối ưu script, chia nhỏ |
| `SUNION/SINTER/SDIFF` set lớn | O(N) theo input | Precompute, shard, batch |

### `SCAN` không miễn phí

`SCAN` an toàn hơn `KEYS` vì incremental, nhưng `COUNT` quá lớn hoặc chạy nhiều scanner song song vẫn gây tải.

```bash
redis-cli --scan --pattern 'user:*'
```

Dùng trong production:

- Giới hạn tốc độ phía client.
- Chạy ngoài giờ cao điểm.
- Tránh `COUNT` quá lớn.
- Theo dõi latency khi scan.

---

## Big keys và hot keys

### Tìm big keys

```bash
redis-cli --bigkeys
redis-cli --memkeys
```

`--bigkeys` tìm key lớn theo cardinality/type. `--memkeys` tập trung vào memory usage.

### Tìm hot keys

```bash
redis-cli --hotkeys
```

Cần LFU metadata để hữu ích.

### Vì sao big key làm chậm?

```text
HGETALL hash 1 triệu field
  -> Redis duyệt nhiều phần tử
  -> tạo response rất lớn
  -> giữ event loop lâu
  -> client khác phải chờ
  -> network truyền lâu
```

### Cách xử lý

| Vấn đề | Giải pháp |
|--------|-----------|
| Một hash quá lớn | Shard hash theo bucket |
| Một set quá lớn | Shard set hoặc dùng index phụ |
| Leaderboard quá lớn | Chia theo region/time window |
| Key cần xóa lớn | `UNLINK`, lazy free |
| Hot key read nhiều | Client-side caching, local cache, replica read |
| Hot counter write nhiều | Sharded counter + aggregate |

---

## Fork, persistence và latency spike

`BGSAVE` và `BGREWRITEAOF` gọi `fork()`. Dataset càng lớn, page table càng lớn, fork có thể mất thời gian và gây latency spike.

Kiểm tra:

```bash
redis-cli INFO persistence | egrep 'latest_fork_usec|rdb_last_cow_size|aof_last_cow_size|in_progress'
redis-cli LATENCY LATEST
```

| Metric | Ý nghĩa |
|--------|---------|
| `latest_fork_usec` | Thời gian fork gần nhất |
| `rdb_bgsave_in_progress` | Đang snapshot |
| `aof_rewrite_in_progress` | Đang rewrite AOF |
| `rdb_last_cow_size` | Copy-on-write memory RDB |
| `aof_last_cow_size` | Copy-on-write memory AOF rewrite |

### AOF fsync

Nếu `appendfsync always`, mỗi write có thể chờ fsync disk, latency tăng mạnh. `everysec` thường cân bằng hơn:

```conf
appendonly yes
appendfsync everysec
```

### Transparent Huge Pages

THP có thể làm latency/fork tệ hơn trong một số môi trường Redis. Nhiều hướng dẫn vận hành khuyến nghị disable THP cho Redis server.

Kiểm tra:

```bash
cat /sys/kernel/mm/transparent_hugepage/enabled
```

---

## Client, network và output buffer

### Connection pool cạn

App có thể log Redis latency cao vì request chờ connection pool, không phải Redis chậm.

Dấu hiệu:

- SLOWLOG không có command chậm.
- Redis CPU thấp.
- App pool wait time cao.
- Tăng pool size hoặc giảm concurrency cải thiện.

### Output buffer lớn

Command trả response lớn hoặc client đọc chậm làm output buffer tăng.

```bash
redis-cli CLIENT LIST
```

Tìm field:

- `omem`: output buffer memory.
- `obl`: output buffer length.
- `cmd`: command gần nhất.
- `name`: client name.

Client Pub/Sub chậm cũng có thể bị disconnect nếu vượt output buffer limit.

### Network bandwidth

`GET` value 1KB ở 100k QPS là khoảng 100MB/s chỉ riêng payload, chưa tính protocol overhead. Response lớn có thể nghẽn NIC hoặc load balancer trước khi Redis CPU đầy.

---

## Runbook debug latency

Khi app báo Redis chậm:

### 1. Xác nhận latency ở đâu

```bash
redis-cli --latency-history
redis-cli PING
```

So sánh:

- App Redis span latency.
- `redis-cli --latency` từ cùng host app.
- SLOWLOG duration.

### 2. Xem slowlog

```bash
redis-cli SLOWLOG LEN
redis-cli SLOWLOG GET 20
```

Nếu có command chậm, phân tích key/type:

```bash
redis-cli TYPE <key>
redis-cli MEMORY USAGE <key>
redis-cli OBJECT ENCODING <key>
```

### 3. Xem latency monitor

```bash
redis-cli LATENCY LATEST
redis-cli LATENCY DOCTOR
```

Tìm event `fork`, `command`, `eviction-cycle`, `expire-cycle`, `aof-write`.

### 4. Xem Redis metrics

```bash
redis-cli INFO stats
redis-cli INFO commandstats
redis-cli INFO memory
redis-cli INFO clients
redis-cli INFO persistence
redis-cli INFO replication
```

**Rank hot path bằng `commandstats`** (usec trung bình × số lần gọi):

```bash
redis-cli INFO commandstats | grep -E 'cmdstat_(get|set|hgetall|lrange|smembers|zrange|eval)'
# Ví dụ:
# cmdstat_hgetall:calls=1200,usec=4800000,usec_per_call=4000
# → HGETALL trung bình 4ms — nghi big hash / full dump
```

Sắp xếp mentally theo `usec` tổng (`calls * usec_per_call`) để biết command nào đang “đốt” main thread, kể cả khi từng call dưới ngưỡng SLOWLOG.

> [!NOTE]
> **I/O threads (Redis 6+) ≠ song song hóa command.** Thread phụ chỉ giúp đọc/ghi socket; logic command vẫn tuần tự trên main thread. `INFO` CPU multi-core cao không có nghĩa command chạy song song — xem [Redis Architecture](./redis-architecture.md).

### 5. Xem OS/container

```bash
top -p $(pgrep redis-server)
vmstat 1
iostat -xz 1
free -m
```

Tìm:

- CPU 100% một core.
- Swap in/out.
- Disk I/O await cao.
- Network saturation.
- Container CPU throttling.

### 6. Mitigate nhanh

Tùy nguyên nhân:

| Nguyên nhân | Mitigation nhanh |
|-------------|------------------|
| Big key command | Chặn endpoint/job, đổi sang scan/page |
| `DEL` key lớn | Dùng `UNLINK` |
| Eviction spike | Tăng memory, giảm write, scale out, chỉnh TTL |
| AOF/disk chậm | Kiểm tra disk, cân nhắc `everysec`, giảm rewrite peak |
| Fork spike | Dời backup/rewrite, tăng headroom |
| Hot key | Local cache/client-side caching, shard key |
| Pool cạn | Tăng pool hợp lý, giảm timeout/retry storm |

---

## Best Practices

- Bật Slow Log với threshold phù hợp production, ví dụ 5-10ms.
- Set `slowlog-max-len` đủ lớn để không mất entry trong incident.
- Set `CLIENT SETNAME` cho mọi service.
- Bật Latency Monitor với threshold hợp lý nếu cần điều tra spike.
- Tránh command trả toàn bộ collection trong hot path.
- Dùng `SCAN` thay `KEYS`, nhưng vẫn rate limit.
- Dùng `UNLINK` thay `DEL` cho key lớn.
- Theo dõi `latest_fork_usec`, COW size, AOF rewrite và BGSAVE.
- Alert theo P95/P99 app-side Redis latency, không chỉ server-side slowlog.
- Kết hợp metrics Redis + app tracing + OS metrics để tìm đúng nguyên nhân.

---

## Tài liệu tham khảo

- [Redis Documentation - SLOWLOG](https://redis.io/docs/latest/commands/slowlog-get/)
- [Redis Documentation - Latency monitoring](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency-monitor/)
- [Redis Documentation - Latency problems troubleshooting](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/)
- [Memory Management](./memory-management.md)
- [Benchmarking](./benchmarking.md)
- [Pipelining & Batching](./pipelining-batching.md)
