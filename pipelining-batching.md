# Pipelining & Batching

## Mục lục

- [Tổng quan](#tổng-quan)
- [Vấn đề cốt lõi: Round-trip time](#vấn-đề-cốt-lõi-round-trip-time)
- [Redis pipelining hoạt động như thế nào](#redis-pipelining-hoạt-động-như-thế-nào)
- [Pipeline khác gì transaction và Lua](#pipeline-khác-gì-transaction-và-lua)
- [Batch size: chọn bao nhiêu là hợp lý](#batch-size-chọn-bao-nhiêu-là-hợp-lý)
- [Ordering, error handling và retry](#ordering-error-handling-và-retry)
- [Pipelining với Cluster](#pipelining-với-cluster)
- [Client examples](#client-examples)
- [Anti-patterns](#anti-patterns)
- [Best Practices](#best-practices)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## Tổng quan

Redis xử lý command rất nhanh, thường tính bằng microseconds cho command đơn giản. Nhưng app nói chuyện với Redis qua network. Nếu mỗi command phải chờ một request-response riêng, latency tổng bị chi phối bởi **round-trip time (RTT)**.

Pipelining cho phép client gửi nhiều command liên tiếp mà không cần chờ response từng command. Redis vẫn xử lý command theo thứ tự, nhưng client chỉ phải chịu ít round trip hơn.

```text
Không pipeline:
Client ── SET a ─────────▶ Redis
Client ◀────────── OK ─── Redis
Client ── SET b ─────────▶ Redis
Client ◀────────── OK ─── Redis
Client ── SET c ─────────▶ Redis
Client ◀────────── OK ─── Redis

Pipeline:
Client ── SET a; SET b; SET c ─▶ Redis
Client ◀── OK; OK; OK ───────── Redis
```

> [!IMPORTANT]
> Pipeline tăng throughput bằng cách giảm network waiting, nhưng không làm một command riêng lẻ chạy nhanh hơn trong Redis. Nếu command chậm vì big key hoặc thuật toán O(N), pipeline không chữa nguyên nhân gốc.

---

## Vấn đề cốt lõi: Round-trip time

Giả sử RTT app → Redis là 1ms. Một command `GET` trong Redis mất 10µs. Nếu gửi tuần tự 1.000 command:

```text
Tổng thời gian ≈ 1.000 * (1ms RTT + 10µs xử lý)
              ≈ 1.010ms
```

Nếu pipeline 1.000 command trong 10 batch, mỗi batch 100 command:

```text
Tổng thời gian ≈ 10 * 1ms RTT + 1.000 * 10µs xử lý
              ≈ 20ms
```

Con số thực tế phụ thuộc network, serialization, client library, response size, server CPU. Nhưng mental model rất quan trọng: **RTT nhân với số lần chờ response**.

### Khi RTT nhỏ có cần pipeline không?

Ngay cả khi app và Redis cùng datacenter, RTT 0.1-0.5ms vẫn đáng kể nếu QPS cao. Pipeline giúp:

- Giảm syscall/network overhead.
- Tăng số command xử lý mỗi vòng event loop.
- Tận dụng TCP tốt hơn.
- Giảm thời gian app chờ I/O.

---

## Redis pipelining hoạt động như thế nào

Redis dùng protocol request/response. Client có thể gửi nhiều request vào socket liên tục. Redis đọc input buffer, parse command, thực thi theo thứ tự, ghi response vào output buffer.

```text
Client output buffer:
  *3\r\n$3\r\nSET\r\n$1\r\na\r\n$1\r\n1\r\n
  *3\r\n$3\r\nSET\r\n$1\r\nb\r\n$1\r\n2\r\n
  *2\r\n$3\r\nGET\r\n$1\r\na\r\n
Redis response:
  +OK\r\n
  +OK\r\n
  $1\r\n1\r\n
```

### Tính chất quan trọng

| Tính chất | Giải thích |
|----------|------------|
| Ordered | Response trả theo đúng thứ tự command gửi vào |
| Không atomic | Command khác từ client khác có thể xen giữa các command pipeline |
| Có thể chứa lỗi từng command | Một command fail không nhất thiết làm các command sau không chạy |
| Tăng memory buffer | Pipeline quá lớn làm client/server buffer phình |
| Không giảm độ phức tạp command | `SMEMBERS huge:set` vẫn nặng |

### Buffer limits — failure mode production

Pipeline gom nhiều reply vào **output buffer** phía server (và buffer phía client). Reply lớn × N command có thể:

- Phình `client-output-buffer-limit` → Redis **kill** connection.
- Client OOM hoặc timeout khi đọc chậm.

```conf
# redis.conf — ví dụ (điều chỉnh theo workload; hard/soft)
client-output-buffer-limit normal 0 0 0
client-output-buffer-limit replica 256mb 64mb 60
client-output-buffer-limit pubsub 32mb 8mb 60
```

Thực hành:

- Batch **vừa** (thường 100–1000 command đơn giản; đo p99).
- Tránh pipeline `HGETALL`/`LRANGE`/`SMEMBERS` trên key lớn.
- Theo dõi `rejected_connections`, client killed, `INFO clients`.
- Auto-pipeline của client library: tin khi command độc lập & response nhỏ; **explicit chunk** khi payload lớn hoặc cần backpressure.

### Redis vẫn single-threaded execution path

Pipeline không làm Redis xử lý song song command trên nhiều core. Nó chỉ giúp Redis ít idle chờ network hơn.

```text
Client gửi nhiều command sẵn trong socket
Redis event loop đọc một lần nhiều command
Redis execute command 1 → command 2 → command 3
Redis ghi nhiều response ra socket
```

---

## Pipeline khác gì transaction và Lua

Ba cơ chế này hay bị nhầm.

| Cơ chế | Mục tiêu chính | Atomic? | Giảm RTT? | Có logic server-side? |
|--------|----------------|---------|-----------|-----------------------|
| Pipeline | Throughput/network efficiency | Không | Có | Không |
| `MULTI/EXEC` | Gom command thành transaction Redis | Có ở mức EXEC sequence | Có thể nếu pipeline MULTI commands | Không nhiều |
| Lua script | Atomic logic server-side | Có | Có, vì 1 command `EVALSHA` | Có |

### Pipeline không atomic

```text
Client A pipeline:
  GET balance
  SET balance 90

Client B có thể chạy command giữa GET và SET nếu không dùng transaction/Lua.
```

Nếu cần check-and-set, dùng `WATCH`/`MULTI` hoặc Lua.

### Transaction vẫn có thể pipeline

Bạn có thể gửi `MULTI`, nhiều command, `EXEC` trong một pipeline để giảm RTT:

```bash
MULTI
INCR counter
EXPIRE counter 60
EXEC
```

Nhưng transaction Redis không rollback theo kiểu SQL. Nếu command trong `EXEC` lỗi runtime, các command khác vẫn có thể đã chạy.

### Lua cho logic phụ thuộc kết quả trung gian

Nếu command sau phụ thuộc kết quả command trước, pipeline không đủ vì client chưa có response.

Ví dụ rate limit atomic:

```lua
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
```

App gọi một `EVALSHA` thay vì nhiều round trip và vẫn atomic.

---

## Batch size: chọn bao nhiêu là hợp lý

Batch quá nhỏ không tận dụng pipeline. Batch quá lớn tăng latency tail, memory buffer và blast radius khi retry.

```text
Batch size nhỏ:
  + latency từng item thấp
  - throughput chưa tối ưu

Batch size lớn:
  + throughput cao
  - response chờ lâu hơn
  - buffer lớn
  - retry khó hơn
```

### Gợi ý ban đầu

| Workload | Batch size khởi điểm |
|----------|----------------------|
| GET/SET value nhỏ | 50-500 |
| INCR counter | 100-1000 |
| HGET/HSET nhỏ | 50-300 |
| ZADD/ZINCRBY leaderboard | 50-200 |
| Response lớn | 10-100 |
| Cross-region RTT cao | Có thể lớn hơn, nhưng phải đo |

> [!NOTE]
> Không có batch size “đúng” cho mọi hệ thống. Chọn bằng benchmark với payload thật, client thật, network thật.

### Dấu hiệu batch quá lớn

- P99 latency tăng mạnh.
- Redis `client_recent_max_output_buffer` lớn.
- App memory tăng vì giữ nhiều pending responses.
- Timeout theo batch làm retry hàng loạt.
- Replica lag tăng do write burst.

### Dấu hiệu batch quá nhỏ

- Redis CPU thấp nhưng app latency cao.
- Network packet nhiều, throughput thấp.
- `redis-benchmark -P` tăng throughput rõ rệt so với không pipeline.

---

## Ordering, error handling và retry

### Response mapping theo index

Vì response theo đúng thứ tự command, client cần map response về request bằng index.

```text
commands[0] = SET a 1  -> replies[0] = OK
commands[1] = INCR b   -> replies[1] = integer
commands[2] = HGET x y -> replies[2] = bulk/null
```

### Lỗi từng command

Một pipeline có thể có response lỗi xen giữa response thành công:

```text
SET a 1      -> OK
INCR a       -> ERR value is not an integer or out of range
GET a        -> "1"
```

App không nên xem “pipeline fail” là tất cả fail nếu library trả array kết quả.

### Retry phải idempotent

Nếu connection bị đứt sau khi client gửi pipeline nhưng trước khi đọc response, client không biết Redis đã thực thi bao nhiêu command.

```text
Client sends 100 commands
Redis executes 60 commands
Connection drops before replies
Client sees timeout
```

Retry toàn bộ có thể duplicate side effects.

| Command | Retry an toàn? | Ghi chú |
|---------|----------------|---------|
| `SET key value` | Thường có | Nếu cùng value/idempotent |
| `HSET field value` | Thường có | Idempotent nếu value giống |
| `INCR` | Không | Retry có thể tăng 2 lần |
| `LPUSH` | Không | Retry có thể duplicate item |
| `ZADD member score` | Có nếu member/score cố định | Không nếu score là timestamp mới |
| `XADD *` | Không | `*` tạo ID mới mỗi lần |

> [!IMPORTANT]
> Với operation không idempotent, cần request id/dedup, Lua script, transaction logic, hoặc chấp nhận at-least-once semantics.

---

## Pipelining với Cluster

Redis Cluster phân key vào 16.384 hash slots. Multi-key command và pipeline cần chú ý slot.

### Client cluster-aware

Client tốt sẽ group command theo node:

```text
Pipeline logical:
  GET user:1      slot A -> node 1
  GET product:9   slot B -> node 2
  GET order:7     slot C -> node 1

Client tách thành:
  node 1 pipeline: GET user:1, GET order:7
  node 2 pipeline: GET product:9
```

### Hash tags để cùng slot

Nếu cần thao tác nhiều key liên quan trên cùng slot, dùng hash tag:

```text
cart:{user:123}
cart_meta:{user:123}
cart_lock:{user:123}
```

Phần trong `{}` được dùng để tính slot, nên các key trên cùng slot.

### MOVED/ASK trong pipeline

Khi cluster reshard/failover, một số command có thể trả `MOVED` hoặc `ASK`. Client library cluster-aware thường xử lý redirect, nhưng retry pipeline phức tạp hơn command đơn.

Best practice:

- Dùng client Redis Cluster mature.
- Tránh tự implement pipeline cluster nếu không cần.
- Giữ batch vừa phải để giảm retry blast radius.
- Test reshard/failover với pipeline trong staging.

---

## Client examples

### Node.js với ioredis

```js
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

const pipeline = redis.pipeline();
for (const id of [1, 2, 3]) {
  pipeline.hgetall(`user:${id}`);
}

const results = await pipeline.exec();

for (const [err, value] of results) {
  if (err) {
    console.error('Redis command failed', err);
    continue;
  }
  console.log(value);
}
```

### Node.js với node-redis

```js
import { createClient } from 'redis';

const client = createClient();
await client.connect();

const commands = [];
for (let i = 0; i < 100; i++) {
  commands.push(client.set(`k:${i}`, `v:${i}`));
}

// node-redis auto-pipelining trong cùng tick có thể gom các command này
await Promise.all(commands);
```

### Python redis-py

```python
import redis

r = redis.Redis(host='localhost', port=6379, decode_responses=True)

pipe = r.pipeline(transaction=False)
for i in range(100):
    pipe.set(f'k:{i}', f'v:{i}')

results = pipe.execute()
print(results[:5])
```

`transaction=False` nghĩa là pipeline thường, không bọc `MULTI/EXEC`.

### Java Jedis

```java
try (Jedis jedis = new Jedis("localhost", 6379)) {
    Pipeline p = jedis.pipelined();
    List<Response<String>> responses = new ArrayList<>();

    for (int i = 0; i < 100; i++) {
        responses.add(p.get("k:" + i));
    }

    p.sync();

    for (Response<String> response : responses) {
        System.out.println(response.get());
    }
}
```

---

## Anti-patterns

### Pipeline command nặng

```bash
SMEMBERS huge:set
HGETALL huge:hash
LRANGE huge:list 0 -1
```

Pipeline nhiều command nặng có thể làm Redis block lâu hơn và output buffer rất lớn.

Thay bằng pagination/range:

```bash
HSCAN huge:hash 0 COUNT 1000
SSCAN huge:set 0 COUNT 1000
LRANGE huge:list 0 999
```

### Pipeline không giới hạn

```js
// Anti-pattern: tạo pipeline hàng triệu command trong memory
const p = redis.pipeline();
for (const item of hugeArray) {
  p.set(item.key, item.value);
}
await p.exec();
```

Tốt hơn: chunking.

```js
const batchSize = 500;
for (let i = 0; i < hugeArray.length; i += batchSize) {
  const p = redis.pipeline();
  for (const item of hugeArray.slice(i, i + batchSize)) {
    p.set(item.key, item.value);
  }
  await p.exec();
}
```

### Dùng pipeline để thay atomic logic

Nếu cần “check then write” chính xác, pipeline không đủ. Dùng Lua hoặc transaction.

---

## Best Practices

- Dùng pipeline cho nhiều command độc lập, value nhỏ/vừa.
- Chọn batch size bằng benchmark, bắt đầu 100-500 cho command nhẹ.
- Giới hạn số pending commands và timeout.
- Tránh pipeline response lớn hoặc command O(N) trên big key.
- Với operation không idempotent, thiết kế retry cẩn thận.
- Với Cluster, dùng client cluster-aware và test redirect/failover.
- Theo dõi P95/P99 latency, output buffer, timeout, retry rate.
- Nếu logic phụ thuộc kết quả trung gian, cân nhắc Lua script.
- Nếu cần atomic nhóm command, dùng `MULTI/EXEC` hoặc Lua, không chỉ pipeline.

---

## Tài liệu tham khảo

- [Redis Documentation - Pipelining](https://redis.io/docs/latest/develop/using-commands/pipelining/)
- [Transactions](./transactions.md)
- [Lua Scripting](./lua-scripting.md)
- [Benchmarking](./benchmarking.md)
- [Slow Log & Latency](./slow-log-latency.md)
