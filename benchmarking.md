# Benchmarking

## Mục lục

- [Tổng quan](#tổng-quan)
- [Benchmark đúng câu hỏi](#benchmark-đúng-câu-hỏi)
- [Các metric cần đo](#các-metric-cần-đo)
- [redis-benchmark căn bản](#redis-benchmark-căn-bản)
- [Benchmark theo workload thực tế](#benchmark-theo-workload-thực-tế)
- [Đọc kết quả latency percentile](#đọc-kết-quả-latency-percentile)
- [Benchmark pipeline, connection và payload](#benchmark-pipeline-connection-và-payload)
- [Benchmark memory và eviction](#benchmark-memory-và-eviction)
- [Benchmark persistence và replication](#benchmark-persistence-và-replication)
- [Quan sát Redis trong lúc benchmark](#quan-sát-redis-trong-lúc-benchmark)
- [Sai lầm phổ biến](#sai-lầm-phổ-biến)
- [Checklist benchmark production-like](#checklist-benchmark-production-like)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## Tổng quan

Benchmark Redis không chỉ là chạy `redis-benchmark` rồi lấy số requests/sec lớn nhất. Một benchmark hữu ích phải trả lời câu hỏi vận hành cụ thể:

- Redis chịu được bao nhiêu QPS với workload của mình?
- P95/P99 latency có đạt SLO không?
- Pipeline size nào tối ưu?
- Value size tăng ảnh hưởng thế nào?
- Bật AOF/RDB/replication có làm tail latency tăng không?
- Khi gần `maxmemory`, eviction ảnh hưởng hit ratio ra sao?

> [!IMPORTANT]
> Benchmark sai workload thường tạo cảm giác an toàn giả. `SET key value` 3 bytes trên localhost không đại diện cho cache JSON 2KB qua network, có TLS, replication và AOF.

---

## Benchmark đúng câu hỏi

Trước khi chạy tool, viết rõ giả định:

```text
Mục tiêu:
  Kiểm tra Redis cache user profile có đáp ứng 50k QPS read, P99 < 5ms không.

Workload:
  90% GET, 10% SET
  value size trung bình 1KB, p99 5KB
  keyspace 10 triệu key
  TTL 1 giờ + jitter
  200 concurrent clients
  app và Redis khác host cùng AZ
  maxmemory 20GB, allkeys-lfu
  replica 1 node, AOF everysec
```

Nếu không có mô tả workload, kết quả benchmark khó có giá trị.

### Benchmark micro vs macro

| Loại | Mục tiêu | Ví dụ |
|------|----------|-------|
| Microbenchmark | Đo Redis command riêng lẻ | GET/SET throughput, pipeline size |
| Component benchmark | Đo Redis + client + network | App worker gọi Redis thật |
| System benchmark | Đo toàn hệ thống | API latency, DB fallback, cache hit ratio |

Redis nhanh không đảm bảo hệ thống nhanh nếu app serialization, network, database fallback hoặc lock contention mới là bottleneck.

---

## Các metric cần đo

| Metric | Ý nghĩa | Vì sao quan trọng |
|--------|---------|-------------------|
| Throughput | ops/sec | Capacity tổng |
| Average latency | Độ trễ trung bình | Dễ hiểu nhưng che tail latency |
| P50/P95/P99/P999 | Percentile latency | SLO thường nằm ở tail |
| Error/timeout rate | Tỷ lệ lỗi | Throughput cao nhưng lỗi nhiều là vô nghĩa |
| CPU Redis | Server saturation | Redis single-thread command path dễ chạm 1 core |
| Network bandwidth | Bytes in/out | Response lớn có thể nghẽn network |
| Memory | `used_memory`, RSS | Đánh giá capacity và fragmentation |
| Eviction | `evicted_keys` rate | Cache churn |
| Hit ratio | hits/(hits+misses) | Chất lượng cache |
| Replication lag | Replica theo kịp không | Ảnh hưởng HA/read scaling |
| Fork/COW | RDB/AOF rewrite overhead | Tail latency/OOM risk |

> [!TIP]
> Luôn ghi lại config Redis, version, instance type, kernel/container limit, network topology và client library version cùng kết quả benchmark.

---

## redis-benchmark căn bản

`redis-benchmark` đi kèm Redis, dùng tốt để đo baseline.

```bash
redis-benchmark -h 127.0.0.1 -p 6379 -n 100000 -c 50
```

Ý nghĩa:

| Option | Ý nghĩa |
|--------|---------|
| `-n` | Tổng số requests |
| `-c` | Số connection song song |
| `-t` | Chọn command test |
| `-d` | Payload size bytes |
| `-P` | Pipeline requests |
| `-q` | Output ngắn |
| `--csv` | Output CSV |
| `--threads` | Dùng nhiều thread client benchmark |
| `-r` | Random key range |

### Test GET/SET cơ bản

```bash
redis-benchmark -t set,get -n 1000000 -c 100 -d 1024
```

### Test với pipeline

```bash
redis-benchmark -t set,get -n 1000000 -c 100 -P 16 -d 1024
```

### Random key

```bash
redis-benchmark -t get,set -n 1000000 -c 100 -r 1000000 -d 512
```

`-r 1000000` tạo key ngẫu nhiên trong range để tránh chỉ hit một key.

### Output percentile

Một số phiên bản hỗ trợ output latency distribution. Nếu có, bật để xem percentile thay vì chỉ average.

```bash
redis-benchmark -t get,set -n 1000000 -c 100 -d 1024 --csv
```

---

## Benchmark theo workload thực tế

`redis-benchmark` mặc định không mô phỏng mọi pattern. Bạn cần tự tạo workload bằng script/app nếu:

- Mix command phức tạp: `HGET`, `ZADD`, `XADD`, Lua.
- Key distribution Zipfian/hot key.
- Value size biến thiên.
- TTL + eviction.
- Cluster nhiều node.
- Retry/timeout từ client thật.

### Ví dụ workload cache profile bằng Python

```python
import os
import random
import time
import json
import redis

r = redis.Redis(host=os.getenv('REDIS_HOST', 'localhost'), port=6379)

KEYSPACE = 1_000_000
OPS = 200_000
SET_RATIO = 0.1

latencies_ms = []
errors = 0

for i in range(OPS):
    user_id = random.randint(1, KEYSPACE)
    key = f'user:profile:{user_id}'
    start = time.perf_counter()
    try:
        if random.random() < SET_RATIO:
            value = json.dumps({
                'id': user_id,
                'name': 'Nguyen Van A',
                'roles': ['user'],
                'version': i,
            })
            ttl = 3600 + random.randint(0, 300)
            r.set(key, value, ex=ttl)
        else:
            r.get(key)
    except Exception:
        errors += 1
    finally:
        latencies_ms.append((time.perf_counter() - start) * 1000)

latencies_ms.sort()

def pct(p):
    return latencies_ms[int(len(latencies_ms) * p / 100)]

print('errors', errors)
print('p50', pct(50))
print('p95', pct(95))
print('p99', pct(99))
```

Script đơn giản này chưa hoàn hảo nhưng tốt hơn benchmark command đơn nếu workload thật là cache profile.

### Key distribution

Không phải key nào cũng được truy cập đều. Nhiều hệ thống có phân phối lệch:

```text
20% key nhận 80% traffic
1% key nhận 50% traffic
```

Nếu benchmark random uniform, bạn có thể đánh giá sai hiệu quả LFU/LRU và hot key.

---

## Đọc kết quả latency percentile

Average latency dễ đánh lừa.

```text
99 request: 1ms
1 request : 1000ms
Average  : ~11ms
P99      : có thể rất cao tùy số mẫu
```

Người dùng thường cảm nhận tail latency. SLO production nên nhìn P95/P99.

| Percentile | Ý nghĩa |
|------------|---------|
| P50 | Một nửa request nhanh hơn mức này |
| P95 | 95% request nhanh hơn mức này |
| P99 | 99% request nhanh hơn mức này |
| P999 | Bắt spike hiếm, cần sample lớn |

### Cần đủ số mẫu

Đo P99 với 1.000 requests chỉ có 10 request nằm ở 1% cuối. Kết quả rất nhiễu. Benchmark tail latency cần số mẫu lớn và chạy đủ lâu.

### Latency spike thường đến từ đâu?

- Command O(N) trên big key.
- Fork `BGSAVE`/AOF rewrite.
- Eviction/free memory.
- Client GC pause.
- Network jitter.
- CPU steal/noisy neighbor.
- TLS overhead.
- Swap/container throttling.

---

## Benchmark pipeline, connection và payload

### Thử nhiều pipeline size

```bash
for p in 1 4 8 16 32 64; do
  echo "Pipeline $p"
  redis-benchmark -t get,set -n 1000000 -c 100 -P $p -d 1024 -q
done
```

Kỳ vọng thường thấy:

```text
P=1   throughput thấp hơn, latency từng op rõ
P=8   tăng mạnh
P=16  tăng tiếp
P=64  throughput có thể tăng nhưng tail latency/buffer xấu hơn
```

### Thử connection concurrency

```bash
for c in 1 10 50 100 500; do
  echo "Connections $c"
  redis-benchmark -t get,set -n 500000 -c $c -d 1024 -q
done
```

Quá nhiều connection không luôn tốt. Redis phải quản lý client buffers, kernel socket, context overhead phía client.

### Thử payload size

```bash
for d in 16 128 1024 4096 16384; do
  echo "Payload $d bytes"
  redis-benchmark -t set,get -n 300000 -c 100 -d $d -q
done
```

Payload lớn thường làm bottleneck chuyển từ CPU command sang network/memory bandwidth.

---

## Benchmark memory và eviction

Nếu Redis là cache, cần benchmark khi cache gần đầy.

### Setup local giới hạn memory

```bash
redis-server --save "" --appendonly no \
  --maxmemory 256mb \
  --maxmemory-policy allkeys-lfu
```

### Load vượt memory

```bash
redis-benchmark -t set -n 2000000 -c 100 -d 1024 -r 5000000
```

Quan sát:

```bash
watch -n 1 "redis-cli INFO memory | egrep 'used_memory_human|maxmemory_human|mem_fragmentation_ratio'; redis-cli INFO stats | egrep 'evicted_keys|keyspace_hits|keyspace_misses'"
```

Câu hỏi cần trả lời:

- Eviction rate ổn định hay spike?
- Hit ratio sau warmup bao nhiêu?
- Latency có tăng khi eviction bắt đầu không?
- Policy LRU/LFU khác nhau thế nào với key distribution thật?

---

## Benchmark persistence và replication

### AOF

So sánh khi tắt/bật AOF:

```conf
appendonly yes
appendfsync everysec
```

`appendfsync always` an toàn hơn nhưng latency write cao hơn nhiều; thường không dùng cho workload throughput cao nếu không có yêu cầu durability cực mạnh.

### RDB/AOF rewrite

Trong lúc benchmark write, chạy:

```bash
redis-cli BGSAVE
# hoặc nếu AOF bật
redis-cli BGREWRITEAOF
```

Quan sát:

```bash
redis-cli INFO persistence | egrep 'in_progress|last_cow|latest_fork_usec'
redis-cli LATENCY LATEST
```

### Replication

Khi có replica:

```bash
redis-cli INFO replication
```

Theo dõi:

- `master_repl_offset` và `slave_repl_offset`/replica offset.
- Replica lag.
- Network bandwidth.
- Output buffer của replica.

Write benchmark trên master có thể bị ảnh hưởng bởi replication backlog và network tới replica.

---

## Quan sát Redis trong lúc benchmark

Mở các terminal riêng.

### Latency monitor

```bash
redis-cli --latency
redis-cli --latency-history
redis-cli --latency-dist
```

### INFO tổng quan

```bash
watch -n 1 'redis-cli INFO stats | egrep "instantaneous_ops_per_sec|total_commands_processed|rejected_connections|evicted_keys|expired_keys"'
```

### CPU và commandstats

```bash
redis-cli INFO commandstats
redis-cli INFO cpu
```

### Slow log

```bash
redis-cli SLOWLOG GET 20
```

### OS-level

```bash
top -p $(pgrep redis-server)
vmstat 1
iostat -xz 1
sar -n DEV 1
```

Nếu Redis chạy container:

```bash
docker stats
kubectl top pod <redis-pod>
```

---

## Sai lầm phổ biến

### Benchmark trên localhost rồi áp dụng cho production network

Localhost RTT rất thấp, không có packet loss, không có TLS/load balancer. Production khác host có thể latency cao hơn nhiều.

### Chỉ nhìn requests/sec

Throughput cao nhưng P99 200ms có thể không đạt SLO.

### Dùng keyspace quá nhỏ

Nếu benchmark chỉ dùng vài key, toàn bộ nằm hot trong CPU cache, không đại diện memory/key distribution thật.

### Không warm up

Cache lạnh và cache đã warm có hành vi khác nhau. Cần đo cả warmup và steady state.

### Không reset giữa các test

Test sau bị ảnh hưởng bởi data/keyspace của test trước.

```bash
redis-cli FLUSHALL
```

Chỉ dùng trên môi trường benchmark, không production.

### Benchmark client bị bottleneck

Nếu máy chạy benchmark CPU/network yếu, bạn đang đo client chứ không đo Redis. Dùng nhiều benchmark clients hoặc đặt client trên máy đủ mạnh.

---

## Checklist benchmark production-like

- [ ] Redis config giống production: persistence, maxmemory, eviction, TLS, cluster/replica.
- [ ] Client library giống production.
- [ ] Network path giống production càng nhiều càng tốt.
- [ ] Payload size phân phối giống thật.
- [ ] Command mix giống thật.
- [ ] Key distribution giống thật: uniform/Zipf/hot keys.
- [ ] Có warmup và steady-state phase.
- [ ] Đo P50/P95/P99/P999, không chỉ average.
- [ ] Đo error/timeout/retry rate.
- [ ] Quan sát CPU, memory, network, disk.
- [ ] Test fork/AOF rewrite nếu production bật persistence.
- [ ] Test khi gần maxmemory nếu dùng cache eviction.
- [ ] Lưu lại config, command, code, version và raw result.

---

## Tài liệu tham khảo

- [Redis Documentation - redis-benchmark](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/benchmarks/)
- [Redis Documentation - Latency monitoring](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency-monitor/)
- [Pipelining & Batching](./pipelining-batching.md)
- [Slow Log & Latency](./slow-log-latency.md)
- [Memory Management](./memory-management.md)
