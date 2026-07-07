# Redis CLI

## Mục lục

- [Tổng quan](#tổng-quan)
- [1. Các mode hoạt động](#1-các-mode-hoạt-động)
- [2. Khảo sát keyspace — KEYS vs SCAN](#2-khảo-sát-keyspace--keys-vs-scan)
- [3. Khảo sát server — INFO, MONITOR, CLIENT](#3-khảo-sát-server--info-monitor-client)
- [4. Debug dữ liệu — OBJECT, MEMORY, DEBUG](#4-debug-dữ-liệu--object-memory-debug)
- [5. Các mode đặc biệt](#5-các-mode-đặc-biệt)
- [6. Cheatsheet lệnh hàng ngày](#6-cheatsheet-lệnh-hàng-ngày)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## Tổng quan

`redis-cli` là client chính thức nói chuyện với server qua RESP protocol (xem [Redis Overview](./redis-overview.md)). Nó không chỉ là REPL — còn là công cụ benchmark nhẹ, latency monitor, RDB backup tool, và mass-insert pipe.

```bash
redis-cli                          # interactive, mặc định 127.0.0.1:6379
redis-cli -h redis.internal -p 6380 -a "$REDIS_PASSWORD" --user app
redis-cli -u redis://app:pass@host:6379/0    # connection URI
redis-cli -n 3                     # chọn logical DB 3
redis-cli --tls --cacert ca.crt    # TLS
```

> [!TIP]
> Truyền password bằng `-a` sẽ lộ trong `ps aux` và shell history. Dùng biến môi trường `REDISCLI_AUTH` hoặc gõ `AUTH` trong interactive mode.

---

## 1. Các mode hoạt động

### 1.1 Interactive mode

```
127.0.0.1:6379> SET user:1 hiep
OK
127.0.0.1:6379> HELP SET          # inline help + version xuất hiện của command
127.0.0.1:6379> SELECT 2          # đổi DB — prompt thành [2]
```

Có tab-completion, history (`~/.rediscli_history`), và hints hiển thị signature khi gõ.

### 1.2 One-shot mode

```bash
redis-cli GET user:1               # chạy 1 lệnh rồi thoát — dùng trong script
redis-cli -r 5 -i 1 INFO clients   # lặp 5 lần, mỗi giây (theo dõi metric)
```

**Cách CLI quyết định output format:** khi stdout là terminal → format người đọc; khi pipe/redirect → raw output. Ép bằng `--no-raw` / `raw`:

```bash
redis-cli GET viet                 # "xin ch\xc3\xa0o" (escaped)
redis-cli --no-raw GET viet
redis-cli GET viet | cat           # xin chào (raw khi pipe)
```

### 1.3 Pipe mode — mass insertion

Nạp hàng triệu key nhanh nhất có thể: gửi RESP thẳng vào socket, không chờ reply từng lệnh:

```bash
# Sinh file lệnh
for i in $(seq 1 1000000); do echo "SET key:$i val:$i"; done > data.txt

redis-cli --pipe < data.txt
# All data transferred. Waiting for the last reply...
# errors: 0, replies: 1000000
```

Cơ chế: CLI ghi toàn bộ payload, chèn một lệnh `ECHO <random>` cuối cùng và chỉ chờ reply của ECHO đó để biết server xử lý xong — nhanh hơn pipelining thông thường vì không track từng reply. Chi tiết về round-trip: [Pipelining & Batching](./pipelining-batching.md).

---

## 2. Khảo sát keyspace — KEYS vs SCAN

### 2.1 Vì sao KEYS nguy hiểm

`KEYS pattern` duyệt **toàn bộ** dict trong một lần gọi — O(N) và **block event loop** (nhớ lại: Redis single-threaded, xem [Redis Overview](./redis-overview.md)). Với 10 triệu key, `KEYS *` có thể block hàng trăm ms → mọi client khác timeout.

### 2.2 SCAN hoạt động thế nào

`SCAN` là **cursor-based iteration**: mỗi lần gọi chỉ duyệt một ít bucket rồi trả về cursor cho lần sau:

```
127.0.0.1:6379> SCAN 0 MATCH user:* COUNT 100
1) "3932160"        ← cursor cho lần gọi tiếp theo
2) 1) "user:412"
   2) "user:9"
...
127.0.0.1:6379> SCAN 3932160 MATCH user:* COUNT 100
1) "0"              ← cursor 0 = đã duyệt xong
2) ...
```

Cơ chế bên trong — **reverse binary iteration**: cursor là chỉ số bucket được duyệt theo thứ tự đảo bit (thay vì tăng dần). Nhờ vậy SCAN đảm bảo:

- Mọi key tồn tại **suốt** quá trình scan sẽ được trả về ít nhất 1 lần — **kể cả khi dict đang rehash/resize giữa chừng**
- Không đảm bảo: key có thể trả về trùng lặp; key thêm/xóa giữa chừng có thể có hoặc không

`COUNT` là *hint* số bucket duyệt mỗi lần (mặc định 10), không phải số key trả về.

```bash
# CLI có sẵn wrapper tự lặp cursor:
redis-cli --scan --pattern 'user:*'
redis-cli --scan --pattern 'cache:*' | xargs -L 100 redis-cli UNLINK   # xóa hàng loạt an toàn
```

Họ hàng: `HSCAN` (hash), `SSCAN` (set), `ZSCAN` (sorted set) — cùng cơ chế cursor.

---

## 3. Khảo sát server — INFO, MONITOR, CLIENT

### 3.1 INFO

```bash
redis-cli INFO                # tất cả sections
redis-cli INFO memory         # từng section: server, clients, memory, persistence,
                              # stats, replication, cpu, commandstats, keyspace
```

Các metric đáng chú ý nhất:

| Metric | Section | Ý nghĩa |
|--------|---------|---------|
| `used_memory_human` / `maxmemory` | memory | Còn bao nhiêu headroom |
| `mem_fragmentation_ratio` | memory | >1.5 = fragmentation, <1 = đang swap (rất xấu) |
| `keyspace_hits` / `keyspace_misses` | stats | Hit rate của cache |
| `evicted_keys` | stats | Key bị đuổi vì maxmemory — cache đang quá nhỏ? |
| `connected_clients` | clients | Gần `maxclients` chưa |
| `rdb_last_bgsave_status`, `aof_last_write_status` | persistence | Persistence có đang fail |
| `master_link_status` | replication | Replica còn kết nối master |

Theo dõi liên tục: `redis-cli --stat` (in 1 dòng/giây: keys, mem, clients, ops/sec). Chi tiết giám sát: [Monitoring](./monitoring.md).

### 3.2 MONITOR

Stream **mọi command** server nhận được, real-time:

```bash
redis-cli MONITOR
1720312345.123456 [0 172.17.0.1:54321] "GET" "user:1"
1720312345.125001 [0 172.17.0.1:54321] "SET" "session:abc" "..." "EX" "1800"
```

> [!IMPORTANT]
> MONITOR làm giảm throughput đáng kể (server phải serialize mọi command cho monitor client) và **hiển thị cả password trong AUTH**. Chỉ bật vài giây khi debug, không bao giờ để chạy lâu trên production. Thay thế nhẹ hơn: [SLOWLOG](./slow-log-latency.md).

### 3.3 CLIENT

```bash
redis-cli CLIENT LIST         # mọi connection: addr, age, idle, cmd cuối, buffer size
redis-cli CLIENT KILL ADDR 10.0.0.5:49321
redis-cli CLIENT KILL LADDR 10.0.0.1:6379 TYPE normal   # kill hàng loạt theo filter
redis-cli CLIENT SETNAME worker-3   # đặt tên để dễ truy vết trong CLIENT LIST
```

Dùng khi: tìm client giữ connection idle, client có output buffer phình to (subscriber chậm), hoặc nghi ngờ connection leak từ app.

---

## 4. Debug dữ liệu — OBJECT, MEMORY, DEBUG

```bash
# Encoding thực tế bên trong (giải thích tại 1.2 của Redis Overview)
127.0.0.1:6379> OBJECT ENCODING mylist
"listpack"                    # sẽ thành "quicklist" khi list lớn lên

# Memory chính xác của 1 key (tính cả overhead struct)
127.0.0.1:6379> MEMORY USAGE user:1000 SAMPLES 0
(integer) 328

# Idle time / tần suất truy cập (phục vụ LRU/LFU debugging)
127.0.0.1:6379> OBJECT IDLETIME user:1000    # giây, khi policy là LRU
127.0.0.1:6379> OBJECT FREQ user:1000        # counter, khi policy là LFU

# Tìm key lớn — quét bằng SCAN nên an toàn với production
redis-cli --bigkeys              # key lớn nhất mỗi type
redis-cli --memkeys              # theo MEMORY USAGE
redis-cli --hotkeys              # cần maxmemory-policy *lfu
```

`--bigkeys` là công cụ đầu tay khi điều tra memory tăng bất thường hoặc latency spike do big key — xem [Slow Log & Latency](./slow-log-latency.md).

---

## 5. Các mode đặc biệt

### 5.1 Latency diagnostics

```bash
redis-cli --latency              # đo RTT liên tục: min/max/avg (ms)
redis-cli --latency-history      # in thống kê mỗi 15s
redis-cli --latency-dist         # heatmap màu theo thời gian
redis-cli --intrinsic-latency 30 # đo latency của chính OS/VM (không qua network)
```

`--intrinsic-latency` chạy loop trên chính máy server để đo scheduling latency của kernel — nếu con số này đã vài ms thì vấn đề nằm ở VM/hypervisor, không phải Redis.

### 5.2 RDB backup từ xa

```bash
redis-cli --rdb /backup/dump-$(date +%F).rdb
```

Cơ chế: CLI giả làm **replica** — gửi `SYNC`, master trả về snapshot RDB qua socket, CLI ghi ra file. Đây là cách backup không cần truy cập filesystem của server — xem [Backup & Restore](./backup-restore.md).

### 5.3 Pub/Sub

```bash
redis-cli SUBSCRIBE orders        # blocking, in message khi có
redis-cli PSUBSCRIBE 'events.*'   # pattern
redis-cli PUBLISH orders '{"id": 1}'
```

### 5.4 Lua

```bash
redis-cli EVAL "return redis.call('GET', KEYS[1])" 1 user:1
redis-cli --eval myscript.lua key1 key2 , arg1 arg2   # dấu phẩy ngăn KEYS và ARGV
```

---

## 6. Cheatsheet lệnh hàng ngày

```bash
# Sức khỏe nhanh
redis-cli PING
redis-cli --stat
redis-cli INFO replication

# Keyspace
redis-cli DBSIZE                          # số key trong DB hiện tại
redis-cli --scan --pattern 'sess:*' | wc -l
redis-cli TYPE somekey
redis-cli TTL somekey

# Dọn dẹp an toàn
redis-cli UNLINK bigkey                   # non-blocking (nền), thay vì DEL
redis-cli --scan --pattern 'tmp:*' | xargs -L 500 redis-cli UNLINK

# Config runtime
redis-cli CONFIG GET 'maxmemory*'
redis-cli CONFIG SET slowlog-log-slower-than 5000

# Persistence thủ công
redis-cli BGSAVE
redis-cli LASTSAVE                        # unix timestamp của lần save cuối
```

> [!NOTE]
> `FLUSHALL` / `FLUSHDB` xóa toàn bộ dữ liệu — trên production hãy dùng bản `ASYNC` và cân nhắc vô hiệu hóa bằng ACL (`-flushall`) — xem [Security](./security.md).

---

## Tài liệu tham khảo

- [redis-cli documentation](https://redis.io/docs/latest/develop/tools/cli/)
- [SCAN command — guarantees](https://redis.io/docs/latest/commands/scan/)
- [Strings](./strings.md) — bắt đầu học data structures
- [Slow Log & Latency](./slow-log-latency.md) — debug performance sâu hơn
