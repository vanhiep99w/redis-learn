# AOF

## Mục lục

- [1. Bài toán: RDB mất vài phút, có khi không chấp nhận được](#1-bài-toán-rdb-mất-vài-phút-có-khi-không-chấp-nhận-được)
- [2. AOF là gì: nhật ký mọi lệnh ghi](#2-aof-là-gì-nhật-ký-mọi-lệnh-ghi)
- [3. Use Cases phổ biến](#3-use-cases-phổ-biến)
- [4. Vòng đời một lệnh ghi trong AOF](#4-vòng-đời-một-lệnh-ghi-trong-aof)
- [5. fsync policy: appendfsync always / everysec / no](#5-fsync-policy-appendfsync-always--everysec--no)
- [6. AOF file trông thế nào bên trong](#6-aof-file-trông-thế-nào-bên-trong)
- [7. AOF rewrite: chống file phình vô hạn](#7-aof-rewrite-chống-file-phình-vô-hạn)
- [8. Multi-Part AOF (Redis 7+)](#8-multi-part-aof-redis-7)
- [9. Cấu hình & Setup](#9-cấu-hình--setup)
- [10. Recovery: khởi động lại từ AOF](#10-recovery-khởi-động-lại-từ-aof)
- [11. Chi phí thật của AOF: I/O, latency, disk](#11-chi-phí-thật-của-aof-io-latency-disk)
- [12. Case study thực tế](#12-case-study-thực-tế)
- [13. Anti-patterns cần tránh](#13-anti-patterns-cần-tránh)
- [14. AOF vs RDB & hybrid](#14-aof-vs-rdb--hybrid)
- [15. Best Practices](#15-best-practices)
- [16. Tóm tắt / Cheat sheet](#16-tóm-tắt--cheat-sheet)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## 1. Bài toán: RDB mất vài phút, có khi không chấp nhận được

[RDB](./rdb.md) chụp ảnh dataset định kỳ — nhanh, gọn, restart lẹ. Nhưng nó có một tử huyệt: **cửa sổ mất dữ liệu**. Snapshot lúc 12:05, crash lúc 12:09 → bay 4 phút gần nhất.

Với cache, mất 4 phút chẳng sao. Nhưng có những dữ liệu mà **mất một giây cũng là thảm hoạ**: một giao dịch trừ tiền ví, một order vừa được xác nhận, một job vừa nhận. Với chúng, câu hỏi đổi thành:

> Làm sao để nếu Redis crash, ta chỉ mất **tối đa một giây** — hoặc lý tưởng là **không mất gì**?

RDB không trả lời được vì nó chụp ảnh cách quãng. Cần một cơ chế **ghi lại từng thay đổi ngay khi nó xảy ra**. Đó chính là AOF — **Append Only File**: mỗi lệnh ghi được nối thêm vào một file log, để khi crash ta chỉ cần "diễn lại" (replay) log là dựng lại được trạng thái.

```bash
CONFIG SET appendonly yes    # bật AOF
SET balance:42 1000          # lệnh này được append vào AOF ngay
```

AOF đổi lấy độ bền bằng chi phí I/O đều đặn và file lớn hơn. Doc này mổ xẻ chính xác cái đánh đổi đó — đặc biệt là ba mức `appendfsync` quyết định bạn mất bao nhiêu khi crash. So sánh tổng thể RDB/AOF: [Persistence Strategies](./persistence-strategies.md).

---

## 2. AOF là gì: nhật ký mọi lệnh ghi

AOF (Append Only File) ghi lại **mọi lệnh làm thay đổi dataset** (write command) vào một file log, theo đúng thứ tự thực thi. Khi Redis khởi động lại, nó **replay** toàn bộ log này từ đầu → tái tạo chính xác trạng thái cuối cùng.

```diagram
Client gửi lệnh ghi        AOF file (append liên tục)
─────────────────          ─────────────────────────
SET user:1 "An"     ──▶    SET user:1 "An"
INCR views          ──▶    INCR views
INCR views          ──▶    INCR views
LPUSH q "job1"      ──▶    LPUSH q "job1"
DEL user:1          ──▶    DEL user:1

Restart → replay từ trên xuống → dataset y hệt lúc crash
```

Khác biệt cốt lõi so với [RDB](./rdb.md):

| | RDB | AOF |
|--|-----|-----|
| Ghi cái gì | **Kết quả** (snapshot trạng thái) | **Quá trình** (từng lệnh ghi) |
| `INCR` 1000 lần | Lưu 1 con số cuối | Lưu 1000 dòng `INCR` (trước rewrite) |
| Khi nào ghi | Định kỳ (save point) | Liên tục (mỗi lệnh ghi) |
| Restart | Load binary (nhanh) | Replay lệnh (chậm hơn) |

> [!NOTE]
> AOF **chỉ ghi lệnh ghi** (`SET`, `INCR`, `LPUSH`, `DEL`, `EXPIRE`...). Lệnh đọc (`GET`, `LRANGE`) không vào AOF vì chúng không đổi dữ liệu. Nhờ vậy replay tái tạo đúng trạng thái mà không cần log đọc.

> [!IMPORTANT]
> Một số lệnh có yếu tố **không xác định** (non-deterministic) được Redis **viết lại thành dạng xác định** trước khi ghi AOF. Ví dụ `SPOP` (lấy phần tử ngẫu nhiên) được chuyển thành `SREM` với đúng phần tử đã bị xoá; `EXPIRE` (tương đối) chuyển thành `PEXPIREAT` (timestamp tuyệt đối). Nhờ vậy replay trên máy khác, thời điểm khác vẫn ra kết quả giống hệt.

---

## 3. Use Cases phổ biến

| Use Case | Vì sao cần AOF | Ghi chú |
|----------|----------------|---------|
| **Dữ liệu tài chính / ví / order** | Không được mất giao dịch | `everysec` hoặc `always` |
| **Job/task queue** | Mất job = mất công việc | Replay lấy lại job chưa xử lý |
| **Session store nghiêm ngặt** | Không muốn logout hàng loạt | Xem [Session Store](./session-store.md) |
| **Redis làm primary datastore** | Redis là nguồn sự thật, không có DB sau lưng | Độ bền cao là bắt buộc |
| **Idempotency / dedup state** | Mất state → xử lý trùng | Kết hợp TTL dài |
| **Audit-friendly** | AOF là log thao tác dễ đọc/kiểm | Human-readable format |

> [!TIP]
> Nếu Redis chỉ là cache đứng trước một DB (dữ liệu warm lại được), AOF thường là **thừa** — RDB đủ và nhẹ hơn. AOF phát huy khi mất dữ liệu là mất thật, không lấy lại được từ nơi khác.

---

## 4. Vòng đời một lệnh ghi trong AOF

Đây là phần cần hiểu thật kỹ, vì nó giải thích vì sao `appendfsync` lại quyết định độ bền. Một lệnh ghi đi qua **ba tầng**, không phải một:

```diagram
Client: SET balance 1000
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ (1) Thực thi trong memory  → dataset đổi ngay                │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ (2) Append vào AOF buffer (trong RAM của Redis)             │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ (3a) write()  → đẩy buffer xuống OS page cache (vẫn ở RAM!) │
│ (3b) fsync()  → OS flush page cache xuống ĐĨA vật lý        │
└─────────────────────────────────────────────────────────────┘
```

Điểm "aha" gây hiểu lầm nhiều nhất: **`write()` KHÔNG có nghĩa là đã ở đĩa.**

```diagram
Redis buffer ──write()──▶ OS page cache ──fsync()──▶ ĐĨA vật lý
              (nhanh)      (vẫn trong RAM)  (chậm)    (mới thật sự bền)
```

Khi bạn `write()`, dữ liệu chỉ mới sang **page cache của kernel** — vẫn nằm trong RAM. Nếu **mất điện đột ngột** lúc này, dữ liệu trong page cache **bay mất**. Chỉ sau `fsync()` — lệnh ép OS ghi page cache xuống đĩa vật lý — dữ liệu mới thực sự bền.

> [!IMPORTANT]
> Chính vì `write()` rẻ còn `fsync()` đắt (phải chờ đĩa vật lý), Redis cho bạn chọn **fsync bao lâu một lần** qua `appendfsync`. Đây là cái núm chỉnh trực tiếp giữa **độ bền** và **tốc độ**.

---

## 5. fsync policy: appendfsync always / everysec / no

`appendfsync` quyết định Redis gọi `fsync()` thường xuyên tới đâu — tức bạn mất tối đa bao nhiêu khi mất điện.

```diagram
        Độ bền cao ◀───────────────────────────────▶ Tốc độ cao
        always            everysec                 no
        (mất ~0)          (mất ~1s)                (mất tuỳ OS)
        chậm nhất         cân bằng (mặc định)      nhanh nhất
```

### 5.1 `appendfsync always`

fsync **sau mỗi lệnh ghi** (chính xác hơn: sau mỗi event loop có ghi). Mỗi write chỉ trả về client sau khi đã chắc chắn nằm trên đĩa.

- **Mất khi crash:** gần như 0.
- **Giá:** mỗi lệnh ghi chờ một lần fsync → throughput ghi giảm mạnh, latency ghi tăng. Phụ thuộc nặng vào tốc độ đĩa (SSD/NVMe bắt buộc).

### 5.2 `appendfsync everysec` (mặc định, khuyến nghị)

fsync **mỗi giây một lần** bởi một luồng nền (background thread). Lệnh ghi không phải chờ fsync — nó append vào buffer/page cache rồi trả về ngay.

- **Mất khi crash:** tối đa ~1 giây thay đổi gần nhất.
- **Giá:** rất nhẹ. Đây là điểm cân bằng vàng mà đa số production dùng.

```diagram
giây thứ N:  write write write write ... (nhanh, không chờ đĩa)
             ────────────────────────────┐
                                          ▼
                            background fsync 1 lần/giây
```

### 5.3 `appendfsync no`

Redis **không bao giờ chủ động fsync** — để OS tự quyết định khi nào flush page cache (thường ~30s trên Linux).

- **Mất khi crash:** không xác định, có thể tới hàng chục giây.
- **Giá:** nhanh nhất, nhưng độ bền yếu — gần như đánh mất lý do dùng AOF.

### 5.4 Bảng so sánh

| Policy | fsync khi nào | Mất tối đa khi crash | Tốc độ ghi | Dùng khi |
|--------|---------------|----------------------|------------|----------|
| `always` | Mỗi lệnh ghi | ~0 | Chậm nhất | Tài chính, không được mất gì; cần SSD/NVMe |
| `everysec` | Mỗi giây (nền) | ~1 giây | Nhanh | **Mặc định** — hầu hết production |
| `no` | OS tự quyết (~30s) | Nhiều, không đoán trước | Nhanh nhất | Hiếm; gần như nên dùng RDB thay thế |

> [!WARNING]
> `always` không "bền gấp đôi" `everysec` một cách miễn phí. Nó có thể cắt throughput ghi xuống nhiều lần và khiến p99 latency phụ thuộc hoàn toàn vào đĩa. Chỉ chọn `always` khi thật sự không được mất một giây dữ liệu, và luôn chạy trên đĩa nhanh. Đo trước bằng [Benchmarking](./benchmarking.md).

> [!NOTE]
> Ngay cả `everysec`, trong tình huống đĩa chậm/nghẽn, luồng fsync nền có thể bị dồn ứ, khiến main thread phải chờ để tránh mất quá nhiều dữ liệu → xuất hiện latency spike. Theo dõi qua [Slow Log & Latency](./slow-log-latency.md).

---

## 6. AOF file trông thế nào bên trong

Khác với binary của [RDB](./rdb.md), AOF là **text theo giao thức RESP** — con người đọc được. Mỗi lệnh được mã hoá dạng RESP array.

```diagram
# Redis nhận: SET user:1 "An"
# AOF ghi (RESP):
*3            ← array 3 phần tử
$3            ← chuỗi dài 3 byte
SET
$6
user:1
$2
An
```

Một ví dụ dễ nhìn hơn (bỏ chi tiết RESP):

```
SELECT 0
SET balance:42 1000
INCRBY balance:42 500
PEXPIREAT session:abc 1783420800000   ← EXPIRE đã bị chuyển thành dạng tuyệt đối
SREM myset "x"                          ← SPOP "x" đã bị chuyển thành SREM
```

> [!TIP]
> Vì AOF là text RESP, khi cần điều tra sự cố bạn có thể mở file xem chuỗi lệnh gần nhất trước crash — cực hữu ích để hiểu "chuyện gì đã xảy ra". RDB không cho bạn khả năng này.

Kiểm tra và sửa AOF hỏng (ví dụ crash làm dòng cuối bị cắt dở):

```bash
redis-check-aof --fix appendonlydir/appendonly.aof.1.incr.aof
```

---

## 7. AOF rewrite: chống file phình vô hạn

### 7.1 Vấn đề: log chỉ có nối thêm

AOF ghi **mọi** lệnh ghi. Xét một counter:

```
INCR views      # 1
INCR views      # 2
...
INCR views      # 1,000,000
```

Một triệu lần `INCR` = một triệu dòng trong AOF, chỉ để biểu diễn một con số `1000000`. File phình vô tận dù dataset thực tế bé xíu. Tệ hơn: replay lúc restart phải chạy lại đủ một triệu lệnh.

### 7.2 Giải pháp: rewrite — viết lại log ngắn nhất

**AOF rewrite** tạo ra một AOF **mới, tối giản**: thay vì lịch sử thao tác, nó ghi **tập lệnh ngắn nhất đủ tái tạo trạng thái hiện tại**.

```diagram
AOF cũ (dài dòng)                 AOF sau rewrite (tối giản)
─────────────────                 ──────────────────────────
INCR views     × 1,000,000   ──▶  SET views 1000000
LPUSH q a
LPUSH q b
RPOP q                        ──▶  RPUSH q b
SET x 1
SET x 2
SET x 3                       ──▶  SET x 3
```

Cơ chế giống [RDB](./rdb.md): Redis `fork()` một tiến trình con, con duyệt dataset hiện tại và ghi ra AOF mới. Mọi lệnh ghi **xảy ra trong lúc rewrite** được giữ trong buffer và nối vào cuối để không mất thay đổi.

```diagram
fork() ──▶ Child: duyệt dataset → ghi AOF mới (tối giản)
   │
Parent: tiếp tục phục vụ + gom lệnh mới vào buffer
   │
Child xong → nối buffer lệnh mới vào → thay AOF cũ
```

### 7.3 Khi nào rewrite tự chạy

Hai directive điều khiển auto-rewrite:

```conf
auto-aof-rewrite-percentage 100   # file to gấp đôi (100%) so với lần rewrite trước → rewrite
auto-aof-rewrite-min-size 64mb    # nhưng chỉ khi file ≥ 64MB (tránh rewrite khi còn bé)
```

```diagram
Kích thước AOF vượt max(base × (1 + 100%), 64MB)?
        │
        ├─ Có → BGREWRITEAOF tự động
        └─ Chưa → tiếp tục append
```

Rewrite thủ công:

```bash
BGREWRITEAOF     # rewrite nền, không chặn
```

> [!NOTE]
> Rewrite cũng dùng `fork` + Copy-on-Write như `BGSAVE` → cùng chi phí RAM (CoW phình khi write nhiều) và latency spike lúc fork. Đừng để RDB `BGSAVE` và AOF rewrite chạy đè lên nhau; Redis thường tự tránh, nhưng vẫn nên giám sát. Xem [RDB](./rdb.md) mục Copy-on-Write.

---

## 8. Multi-Part AOF (Redis 7+)

Từ Redis 7.0, AOF không còn là một file duy nhất mà là **multi-part**: một base + các file incremental, quản lý bởi một manifest.

```diagram
appenddir/                           (thư mục appenddirname)
├── appendonly.aof.manifest          ← danh mục: file nào là base, file nào incr
├── appendonly.aof.1.base.rdb        ← BASE: snapshot trạng thái (định dạng RDB!)
└── appendonly.aof.1.incr.aof        ← INCR: các lệnh ghi sau base (RESP)
```

Ý tưởng thông minh: **base file dùng định dạng RDB** (nhị phân, compact), incr file dùng RESP (log lệnh). Đây gọi là **AOF-use-RDB-preamble** — kết hợp cái tốt nhất của hai thế giới:

```diagram
Rewrite (Redis 7+):
  base = snapshot RDB gọn của dataset hiện tại   ← load nhanh
  + incr = lệnh ghi mới tích luỹ sau đó          ← độ bền ~1s
```

- **Restart nhanh hơn** vì phần lớn dữ liệu ở base RDB binary (load thẳng), chỉ replay phần incr nhỏ.
- **File nhỏ hơn** vì base nén như RDB.
- Directive liên quan: `appenddirname` (tên thư mục), `aof-use-rdb-preamble yes` (mặc định bật ở nhiều bản).

> [!TIP]
> Nếu bạn quen phiên bản Redis cũ (một file `appendonly.aof` nằm cùng `dir`), thấy Redis 7 tạo cả thư mục `appendonlydir/` với nhiều file là bình thường — đó là Multi-Part AOF, không phải lỗi.

---

## 9. Cấu hình & Setup

### 9.1 Bật AOF

```conf
appendonly yes                       # bật AOF (mặc định no)
appendfilename "appendonly.aof"      # tên file cơ sở
appenddirname "appendonlydir"        # thư mục chứa (Redis 7+)
appendfsync everysec                 # always | everysec | no
```

Bật lúc runtime không cần restart:

```bash
CONFIG SET appendonly yes    # Redis lập tức khởi tạo AOF từ dataset hiện tại
CONFIG REWRITE               # lưu cấu hình vào file
```

### 9.2 Các directive quan trọng

| Directive | Mặc định | Ý nghĩa |
|-----------|----------|---------|
| `appendonly` | `no` | Bật/tắt AOF |
| `appendfsync` | `everysec` | Chính sách fsync (mục 5) |
| `auto-aof-rewrite-percentage` | `100` | % tăng so với lần rewrite trước để tự rewrite |
| `auto-aof-rewrite-min-size` | `64mb` | Ngưỡng tối thiểu mới rewrite |
| `no-appendfsync-on-rewrite` | `no` | Nếu `yes`: tạm không fsync trong lúc rewrite (giảm I/O đua nhau, nhưng tăng rủi ro mất tới vài giây) |
| `aof-use-rdb-preamble` | `yes` | Dùng RDB làm base của AOF (Redis 7 multi-part) |
| `aof-load-truncated` | `yes` | Nếu AOF bị cắt dở (crash), vẫn load phần hợp lệ thay vì từ chối start |
| `aof-timestamp-enabled` | `no` | Ghi timestamp vào AOF (hỗ trợ point-in-time recovery) |

> [!WARNING]
> `no-appendfsync-on-rewrite yes` tạm dừng fsync trong lúc rewrite để tránh hai luồng I/O đè nhau gây latency. Đổi lại, nếu crash đúng lúc rewrite, bạn có thể mất nhiều hơn ~1 giây. Chỉ bật khi latency lúc rewrite là vấn đề thực sự và bạn chấp nhận đánh đổi này.

> [!IMPORTANT]
> `aof-load-truncated yes` (mặc định) rất quan trọng: khi mất điện, dòng lệnh cuối trong AOF thường bị ghi dở. Nếu `no`, Redis từ chối khởi động → downtime. Nếu `yes`, Redis bỏ phần dở và load phần hợp lệ → mất tối đa lệnh cuối, nhưng start được.

---

## 10. Recovery: khởi động lại từ AOF

Khi Redis start với `appendonly yes`, nó **ưu tiên AOF** hơn RDB (vì AOF thường mới hơn):

```diagram
Redis khởi động
   │
   ├─ appendonly yes?
   │     │
   │     ├─ Có → load từ AOF
   │     │        ├─ (Redis 7) load base RDB → nhanh
   │     │        └─ replay incr AOF → dựng lại tới lệnh cuối
   │     │
   │     └─ Không → load từ dump.rdb (xem [RDB])
   │
   └─ Xong → sẵn sàng phục vụ
```

So sánh tốc độ restart:

```diagram
RDB thuần:            load binary snapshot            ── nhanh nhất
AOF (Redis 6, cũ):    replay TẤT CẢ lệnh              ── chậm nhất
AOF (Redis 7, multi): load base RDB + replay incr nhỏ ── nhanh, gần RDB
```

> [!NOTE]
> Nếu bật **cả RDB và AOF**, Redis khởi động từ **AOF** (mới hơn), RDB chỉ đóng vai backup/replication. Đây là setup hybrid được khuyến nghị — xem [Persistence Strategies](./persistence-strategies.md).

Kiểm tra trạng thái AOF:

```bash
INFO persistence
```

```diagram
aof_enabled:1
aof_rewrite_in_progress:0
aof_last_rewrite_time_sec:2
aof_last_bgrewrite_status:ok
aof_last_write_status:ok             # ghi AOF gần nhất OK?
aof_current_size:104857600           # kích thước hiện tại
aof_base_size:52428800               # kích thước base sau rewrite cuối
aof_pending_rewrite:0
```

> [!TIP]
> `aof_current_size / aof_base_size` cho biết AOF đã phình bao nhiêu lần kể từ rewrite cuối. Gần chạm `auto-aof-rewrite-percentage` là sắp có rewrite. `aof_last_write_status != ok` (đĩa đầy!) là báo động đỏ.

---

## 11. Chi phí thật của AOF: I/O, latency, disk

AOF bền hơn [RDB](./rdb.md), nhưng "bền" luôn có giá.

### 11.1 Disk I/O liên tục

RDB chỉ I/O bùng lên lúc snapshot. AOF **ghi đĩa gần như liên tục** (mỗi lệnh ghi → buffer → write → fsync định kỳ). Trên workload write-heavy, đây là tải I/O đều đặn, đáng kể — cần đĩa tốt.

### 11.2 Latency phụ thuộc fsync

- `everysec`: nhẹ, nhưng khi đĩa nghẽn, fsync nền dồn ứ → main thread có thể phải chờ → spike.
- `always`: mỗi write chờ đĩa → latency ghi gắn chặt với latency đĩa.

### 11.3 File lớn & rewrite tốn tài nguyên

AOF luôn lớn hơn RDB tương đương. Rewrite (dọn file) lại `fork` + CoW → cùng chi phí RAM/latency như `BGSAVE`.

| Chi phí | RDB | AOF |
|---------|-----|-----|
| Kiểu I/O | Burst lúc snapshot | **Liên tục** + burst lúc rewrite |
| Latency runtime | Chủ yếu lúc fork | fsync + fork lúc rewrite |
| Disk usage | Nhỏ | **Lớn hơn** (log + rewrite tạm) |
| RAM (CoW) | Lúc `BGSAVE` | Lúc rewrite |

> [!IMPORTANT]
> Đừng để đĩa AOF đầy. Khi hết chỗ, `aof_last_write_status` chuyển lỗi và (tuỳ cấu hình) Redis có thể chặn ghi. Giám sát dung lượng đĩa như một metric bậc nhất — xem [Monitoring](./monitoring.md).

---

## 12. Case study thực tế

### 12.1 Ví điện tử — không được mất giao dịch

Bối cảnh: Redis giữ số dư ví tạm thời trước khi flush về DB. Mất một lần trừ tiền = khách mất tiền/khiếu nại.

```conf
appendonly yes
appendfsync everysec        # cân bằng: mất tối đa ~1s
# nếu quy định khắt khe hơn nữa và đĩa NVMe:
# appendfsync always        # mất ~0, đổi lấy throughput
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 128mb
```

- `everysec` là mặc định hợp lý; nâng lên `always` chỉ khi "mất 1 giây cũng không được" và đã đo throughput chịu được.
- Kết hợp RDB để có backup nhanh + full sync replication.

### 12.2 Job queue — replay lấy lại job

```conf
appendonly yes
appendfsync everysec
```

Redis crash → restart → AOF replay dựng lại queue với các job chưa xử lý. Nếu chỉ dùng RDB, các job đẩy vào sau snapshot cuối sẽ biến mất. Xem [Lists](./lists.md), [Streams](./streams.md).

### 12.3 Chuyển từ RDB sang AOF không downtime

```bash
# Đang chạy RDB, muốn thêm AOF mà không tắt server
redis-cli CONFIG SET appendonly yes    # Redis khởi tạo AOF từ dataset hiện tại (rewrite ngầm)
redis-cli CONFIG REWRITE               # lưu vào redis.conf
redis-cli INFO persistence | grep aof_last_bgrewrite_status   # đợi ok
```

### 12.4 Điều tra sự cố bằng cách đọc AOF

Sau một incident nghi ngờ có lệnh `FLUSHALL` nhầm:

```bash
grep -n "FLUSHALL\|FLUSHDB" appendonlydir/appendonly.aof.*.incr.aof
```

Vì AOF là text RESP, nó trở thành một "audit log" thô cho các thao tác ghi — điều RDB không làm được.

---

## 13. Anti-patterns cần tránh

### 13.1 Bật AOF cho cache thuần

```diagram
❌ Redis chỉ là cache trước DB + bật AOF everysec/always
   → tốn I/O, đĩa, latency cho dữ liệu vốn warm lại được

✅ Cache thuần → RDB (hoặc thậm chí không persistence)
```

### 13.2 Chọn `always` mà không đo, trên đĩa chậm

```diagram
❌ appendfsync always trên HDD/EBS chậm
   → mỗi write chờ đĩa → throughput sụp, p99 nổ

✅ always chỉ trên NVMe/SSD nhanh, sau khi benchmark
```

Đo trước: [Benchmarking](./benchmarking.md).

### 13.3 Không giám sát dung lượng đĩa & rewrite status

Đĩa đầy → AOF ghi lỗi → có thể chặn ghi/mất dữ liệu âm thầm. Luôn alert `aof_last_write_status`, `aof_last_bgrewrite_status`, disk free.

### 13.4 Tắt `aof-load-truncated`

```diagram
❌ aof-load-truncated no + crash làm dòng cuối dở
   → Redis TỪ CHỐI khởi động → downtime kéo dài

✅ giữ mặc định yes → bỏ phần dở, start được
```

### 13.5 Tưởng AOF thay thế được backup

AOF/RDB là persistence **cùng máy/đĩa**. Đĩa hỏng, xoá nhầm, ransomware → mất cả AOF lẫn RDB. Vẫn phải backup off-site (S3/NFS). Xem [Backup & Restore](./backup-restore.md).

### 13.6 Để RDB BGSAVE và AOF rewrite fork đè nhau liên tục

Hai tiến trình `fork` + CoW cùng lúc nhân đôi áp lực RAM/I/O. Giám sát và giãn lịch; Redis có cơ chế tránh nhưng đừng cấu hình ngưỡng khiến chúng thường xuyên trùng.

---

## 14. AOF vs RDB & hybrid

| Tiêu chí | RDB | AOF | Hybrid (cả hai) |
|----------|-----|-----|-----------------|
| Mất dữ liệu tối đa | Vài phút | ~1s (`everysec`) / ~0 (`always`) | ~1s, có backup nhanh |
| Restart | Nhanh nhất | Chậm hơn (nhanh với Redis 7 multi-part) | AOF chính, RDB nền |
| Kích thước file | Nhỏ | Lớn hơn | — |
| I/O runtime | Burst | Liên tục | Cả hai |
| Backup/clone | Lý tưởng | Cồng kềnh | Dùng RDB để backup |
| Độ bền | Thấp | Cao | Cao |

```diagram
Chịu mất vài phút, cần gọn nhẹ + backup?        ─▶ RDB
Không được mất quá ~1 giây?                       ─▶ AOF (everysec)
Không được mất gì + đĩa nhanh?                    ─▶ AOF (always)
Production quan trọng, muốn cả bền lẫn backup?   ─▶ RDB + AOF (hybrid)
```

> [!TIP]
> RDB và AOF **không loại trừ nhau** và setup mạnh nhất cho production quan trọng là bật cả hai: AOF cho độ bền hằng ngày, RDB cho backup/clone/replication nhanh. Phân tích chọn strategy đầy đủ: [Persistence Strategies](./persistence-strategies.md).

---

## 15. Best Practices

- Mặc định dùng `appendfsync everysec` — điểm cân bằng vàng giữa bền và nhanh.
- Chỉ dùng `always` khi thật sự không được mất một giây, và **chỉ trên đĩa nhanh (SSD/NVMe)** sau khi benchmark.
- Giữ mặc định `aof-load-truncated yes` để crash không biến thành từ chối khởi động.
- Đặt `auto-aof-rewrite-min-size` đủ lớn để không rewrite khi file còn bé; theo dõi tỉ lệ `aof_current_size / aof_base_size`.
- Chừa RAM cho Copy-on-Write lúc rewrite (như [RDB](./rdb.md)); tắt Transparent Huge Pages.
- Giám sát `aof_last_write_status`, `aof_last_bgrewrite_status`, và **dung lượng đĩa** như metric bậc nhất — [Monitoring](./monitoring.md).
- Với production quan trọng, bật kèm RDB (hybrid) để có backup/clone/replication nhanh.
- Persistence không thay thế backup off-site: vẫn copy file ra ngoài máy — [Backup & Restore](./backup-restore.md).
- Cache thuần thì cân nhắc **không** bật AOF — RDB nhẹ hơn và đủ.

---

## 16. Tóm tắt / Cheat sheet

```diagram
┌─────────────────────── Redis AOF cheat sheet ───────────────────────┐
│ AOF = log mọi lệnh GHI, replay khi restart → độ bền cao            │
│ write() ≠ bền!  Chỉ fsync() mới đẩy xuống ĐĨA vật lý               │
│ appendfsync always   → mất ~0,   chậm, cần đĩa nhanh              │
│ appendfsync everysec → mất ~1s,  cân bằng (MẶC ĐỊNH)             │
│ appendfsync no       → mất nhiều, nhanh (hiếm dùng)               │
│ Rewrite = viết lại log tối giản (fork + CoW như BGSAVE)          │
│ Redis 7 Multi-Part AOF: base RDB + incr RESP → restart nhanh     │
│ Khởi động ưu tiên AOF hơn RDB (AOF mới hơn)                       │
│ Giữ aof-load-truncated yes. Giám sát disk + aof_last_write_status│
│ AOF ≠ backup off-site. Cache thuần thường không cần AOF.         │
└─────────────────────────────────────────────────────────────────────┘
```

3 nguyên tắc nhớ lâu:

1. **Độ bền nằm ở `fsync`, không phải `write`**: dữ liệu ở page cache vẫn có thể bay khi mất điện. `appendfsync` là cái núm bạn chỉnh để quyết định mất bao nhiêu — và trả giá bằng bao nhiêu tốc độ.
2. **AOF chỉ ghi lệnh ghi, và rewrite giữ nó gọn**: không có rewrite, một triệu `INCR` phình file vô hạn và replay chậm. Rewrite dùng cùng `fork`/CoW của RDB nên cùng cần chừa RAM.
3. **Bền không miễn phí**: AOF đánh đổi bằng I/O liên tục, file lớn, và latency phụ thuộc đĩa. Chọn AOF khi mất dữ liệu là mất thật; nếu chỉ là cache, RDB nhẹ hơn.

Quay lại câu hỏi đầu doc — "làm sao chỉ mất tối đa một giây, hoặc không mất gì?" — AOF trả lời bằng cách ghi từng lệnh ngay khi xảy ra và cho bạn chọn nhịp `fsync`. Nếu bạn cần vừa độ bền của AOF vừa tốc độ restart/backup của RDB, câu trả lời không phải chọn một, mà là bật cả hai: đọc tiếp [Persistence Strategies](./persistence-strategies.md).

---

## Tài liệu tham khảo

- [Redis Persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [BGREWRITEAOF command](https://redis.io/docs/latest/commands/bgrewriteaof/)
- [CONFIG SET appendonly](https://redis.io/docs/latest/commands/config-set/)
- [RDB](./rdb.md) — snapshot, nhanh & gọn, độ bền thấp hơn
- [Persistence Strategies](./persistence-strategies.md) — chọn RDB / AOF / hybrid
- [Replication](./replication.md) — độ bền ở tầng nhiều máy
- [Backup & Restore](./backup-restore.md) — persistence không thay backup off-site
- [Slow Log & Latency](./slow-log-latency.md) — debug latency spike do fsync/fork
