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

```d2 title="AOF append và replay khi restart"
shape: sequence_diagram
c: "Client"
r: "Redis"
a: "AOF file"
restart: "Redis sau restart"
c -> r: "SET user:1 \"An\""
r -> a: "Append SET user:1 \"An\""
c -> r: "INCR views — lần 1"
r -> a: "Append INCR views"
c -> r: "INCR views — lần 2"
r -> a: "Append INCR views"
c -> r: "LPUSH q \"job1\""
r -> a: "Append LPUSH q \"job1\""
c -> r: "DEL user:1"
r -> a: "Append DEL user:1"
restart -> a: "Đọc phần AOF còn hợp lệ theo thứ tự"
restart."Replay để dựng lại dataset"
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
> AOF phát huy khi mất dữ liệu là mất thật, không lấy lại được từ nơi khác. Nếu Redis chỉ là cache đứng trước DB, xem thêm phần "Khi nào KHÔNG nên dùng AOF" ở mục 14.

---

## 4. Vòng đời một lệnh ghi trong AOF

Đây là phần cần hiểu thật kỹ, vì nó giải thích vì sao `appendfsync` lại quyết định độ bền. Một lệnh ghi đi qua **ba tầng**, không phải một:

```d2 title="Các lớp bộ nhớ trên đường ghi AOF"
direction: right
n0: "Client: SET balance 1000"
n1: "1. Execute trong Redis memory\nDataset đổi ngay"
n2: "2. Append vào AOF buffer\nRAM của Redis"
n3: "3a. write()\nOS page cache — RAM kernel"
n4: "3b. fsync()\nFlush xuống đĩa vật lý"
n0 -> n1
n1 -> n2
n2 -> n3
n3 -> n4
```

Điểm "aha" gây hiểu lầm nhiều nhất: **`write()` KHÔNG có nghĩa là đã ở đĩa.**

```d2 title="write không đồng nghĩa dữ liệu đã bền trên đĩa"
direction: right
buffer: "Redis buffer"
cache: "OS page cache\nVẫn trong RAM"
disk: "Đĩa vật lý\nSau fsync thành công"
buffer -> cache: "write() — nhanh"
cache -> disk: "fsync() — chậm hơn"
```

Khi bạn `write()`, dữ liệu chỉ mới sang **page cache của kernel** — vùng RAM mà OS dùng làm bộ đệm đĩa. Nếu **mất điện đột ngột** lúc này, dữ liệu trong page cache **bay mất**. Chỉ sau `fsync()` — lệnh ép OS ghi page cache xuống đĩa vật lý — dữ liệu mới thực sự bền.

> [!IMPORTANT]
> Chính vì `write()` rẻ còn `fsync()` đắt (phải chờ đĩa vật lý), Redis cho bạn chọn **fsync bao lâu một lần** qua `appendfsync`. Đây là cái núm chỉnh trực tiếp giữa **độ bền** và **tốc độ**.

---

## 5. fsync policy: appendfsync always / everysec / no

`appendfsync` quyết định Redis gọi `fsync()` thường xuyên tới đâu — tức bạn mất tối đa bao nhiêu khi mất điện.

| Policy | Độ bền khi crash | Đánh đổi |
| --- | --- | --- |
| `always` | Mục tiêu mất gần 0 sau fsync thành công | Chờ đĩa, chậm nhất |
| `everysec` | Có thể mất khoảng 1 giây trong điều kiện thông thường | Cân bằng, mặc định |
| `no` | Phụ thuộc lịch flush của OS | Nhanh, cửa sổ mất dữ liệu khó kiểm soát |

### 5.1 `appendfsync always`

fsync **sau mỗi lệnh ghi** (chính xác hơn: sau mỗi event loop — vòng xử lý lệnh single-threaded của Redis — có ghi). Mỗi write chỉ trả về client sau khi đã chắc chắn nằm trên đĩa.

- **Mất khi crash:** gần như 0.
- **Giá:** mỗi lệnh ghi chờ một lần fsync → throughput ghi giảm mạnh, latency ghi tăng. Phụ thuộc nặng vào tốc độ đĩa (SSD/NVMe bắt buộc).

### 5.2 `appendfsync everysec` (mặc định, khuyến nghị)

fsync **mỗi giây một lần** bởi một luồng nền (background thread). Lệnh ghi không phải chờ fsync — nó append vào buffer/page cache rồi trả về ngay.

- **Mất khi crash:** tối đa ~1 giây thay đổi gần nhất.
- **Giá:** rất nhẹ. Đây là điểm cân bằng vàng mà đa số production dùng.

```d2 title="everysec tách write khỏi background fsync"
shape: sequence_diagram
main: "Main thread"
os: "OS page cache"
bg: "Background fsync"
disk: "Đĩa"
main -> os: "write — nhiều lần trong giây N"
main."Tiếp tục xử lý command, không đợi từng fsync"
bg -> os: "fsync xấp xỉ mỗi giây"
os -> disk: "Flush các write đang chờ"
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

### 5.5 Timeline: dataset / reply client / bền trên đĩa

Hiểu nhầm phổ biến: nghĩ `everysec` = “mỗi giây mới `SET` xong”. Thực tế dataset trong RAM đổi **ngay**; khác nhau chỉ ở **khi nào client nhận OK** và **khi nào đĩa an toàn**.

| Policy | Dataset (RAM) đổi khi nào? | Client nhận reply khi nào? | Bền trên đĩa khi nào? |
|--------|----------------------------|----------------------------|------------------------|
| `always` | Ngay khi command execute | **Sau** `write` + `fsync` | Trước khi reply (gần như) |
| `everysec` | Ngay khi command execute | Sau `write` vào page cache (không chờ fsync) | Background fsync ≤ ~1s sau |
| `no` | Ngay khi command execute | Sau `write` vào page cache | Khi OS flush (có thể hàng chục giây) |

```d2 title="everysec: reply có thể đi trước fsync"
shape: sequence_diagram
c: "Client"
r: "Redis"
cache: "OS page cache"
disk: "Đĩa"
c -> r: "t=0.0: SET a 1"
r -> cache: "write()"
r -> c: "OK, chưa nhất thiết bền trên đĩa"
c -> r: "t=0.3: SET b 2"
r -> cache: "write()"
r -> c: "OK"
r."Nếu crash t=0.8: a,b có thể mất"
cache -> disk: "Nếu tiếp tục tới t≈1.0: background fsync"
```

> [!WARNING]
> `always` không "bền gấp đôi" `everysec` một cách miễn phí. Nó có thể cắt throughput ghi xuống nhiều lần và khiến p99 latency phụ thuộc hoàn toàn vào đĩa. Chỉ chọn `always` khi thật sự không được mất một giây dữ liệu, và luôn chạy trên đĩa nhanh. Đo trước bằng [Benchmarking](./benchmarking.md).

> [!NOTE]
> Ngay cả `everysec`, trong tình huống đĩa chậm/nghẽn, luồng fsync nền có thể bị dồn ứ, khiến main thread phải chờ để tránh mất quá nhiều dữ liệu → xuất hiện latency spike. Theo dõi qua [Slow Log & Latency](./slow-log-latency.md).

---

## 6. AOF file trông thế nào bên trong

Phần này giúp bạn hình dung file AOF thật sự chứa gì, để khi cần debug hoặc cứu file hỏng không bị "mù" trước một blob lạ.

Khác với binary của [RDB](./rdb.md), AOF là **text theo giao thức RESP** (Redis Serialization Protocol — format Redis dùng để mã hoá command/reply, xem [Redis Overview](./redis-overview.md)) — con người đọc được. Mỗi lệnh được mã hoá dạng RESP array.

<!-- diagram-text: RESP payload cần giữ nguyên thứ tự dòng và byte length. -->

```text
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

Đây là lý do AOF không thể cứ append mãi mà không dọn: log càng dài thì vừa tốn đĩa, vừa kéo dài thời gian replay khi restart.

AOF ghi **mọi** lệnh ghi. Xét một counter:

```
INCR views      # 1
INCR views      # 2
...
INCR views      # 1,000,000
```

Một triệu lần `INCR` = một triệu dòng trong AOF, chỉ để biểu diễn một con số `1000000`. File phình vô tận dù dataset thực tế bé xíu. Tệ hơn: replay lúc restart phải chạy lại đủ một triệu lệnh.

### 7.2 Giải pháp: rewrite — viết lại log ngắn nhất

Rewrite không phải "nén text" đơn thuần; nó tạo lại lịch sử tối thiểu từ trạng thái hiện tại, giống viết một bản tóm tắt đủ để dựng lại dataset.

**AOF rewrite** tạo ra một AOF **mới, tối giản**: thay vì lịch sử thao tác, nó ghi **tập lệnh ngắn nhất đủ tái tạo trạng thái hiện tại**.

| Lịch sử AOF cũ | Trạng thái tương đương sau rewrite |
| --- | --- |
| `INCR views` × 1.000.000 | `SET views 1000000` |
| `LPUSH q a`, `LPUSH q b`, `RPOP q` | `RPUSH q b` |
| `SET x 1`, `SET x 2`, `SET x 3` | `SET x 3` |

Cơ chế giống [RDB](./rdb.md): Redis `fork()` (tạo tiến trình con) và dựa vào Copy-on-Write (CoW — chỉ copy page bộ nhớ khi parent/child ghi khác nhau) để con duyệt dataset hiện tại và ghi ra AOF mới. Mọi lệnh ghi **xảy ra trong lúc rewrite** được giữ trong buffer và nối vào cuối để không mất thay đổi.

```d2 title="Rewrite: child ghi base, parent vẫn nhận write"
shape: sequence_diagram
p: "Parent"
c: "Child"
base: "AOF mới"
tail: "Write mới"
p -> c: "fork() — snapshot qua CoW"
c -> base: "Duyệt dataset và ghi dạng tối giản"
p -> tail: "Tiếp tục phục vụ, giữ các write phát sinh"
c -> p: "Hoàn thành base"
p."Chuyển sang AOF mới cùng phần write phát sinh"
```

### 7.3 Khi nào rewrite tự chạy

Bạn không cần tự tay chạy rewrite mỗi ngày; Redis có ngưỡng để tự dọn khi AOF đã phình đủ lớn.

Hai directive điều khiển auto-rewrite:

```conf
auto-aof-rewrite-percentage 100   # file to gấp đôi (100%) so với lần rewrite trước → rewrite
auto-aof-rewrite-min-size 64mb    # nhưng chỉ khi file ≥ 64MB (tránh rewrite khi còn bé)
```

```d2 title="Điều kiện auto rewrite với cấu hình minh họa"
direction: down
check: "AOF vượt ngưỡng tăng 100%\nvà đạt tối thiểu 64 MB?" {shape: diamond}
yes: "BGREWRITEAOF tự động"
no: "Tiếp tục append"
check -> yes: "Có"
check -> no: "Chưa"
```

Rewrite thủ công:

```bash
BGREWRITEAOF     # rewrite nền, không chặn
```

> [!NOTE]
> Rewrite cũng dùng `fork` + Copy-on-Write như `BGSAVE` → cùng chi phí RAM (CoW phình khi write nhiều) và latency spike lúc fork. Đừng để RDB `BGSAVE` và AOF rewrite chạy đè lên nhau; Redis thường tự tránh, nhưng vẫn nên giám sát. Xem [RDB](./rdb.md) mục Copy-on-Write.

---

## 8. Multi-Part AOF (Redis 7+)

Multi-Part AOF là cách Redis 7 làm AOF dễ quản lý và restart nhanh hơn: thay vì một file log khổng lồ, dữ liệu được tách thành phần nền và phần lệnh mới.

Từ Redis 7.0, AOF không còn là một file duy nhất mà là **multi-part AOF** (AOF nhiều phần): một base + các file incremental, quản lý bởi một manifest.

<Files>
  <Folder name="appenddir/ — appenddirname" defaultOpen>
    <File name="appendonly.aof.manifest — danh mục base/incr" />
    <File name="appendonly.aof.1.base.rdb — BASE: snapshot RDB" />
    <File name="appendonly.aof.1.incr.aof — INCR: lệnh ghi RESP" />
  </Folder>
</Files>

Ý tưởng thông minh: **base file dùng định dạng RDB** (nhị phân, compact), incr file dùng RESP (log lệnh). Đây gọi là **RDB preamble** / **AOF-use-RDB-preamble** (phần mở đầu của AOF là một snapshot RDB) — kết hợp cái tốt nhất của hai thế giới:

```d2 title="Multi-Part AOF kết hợp base và incremental log"
direction: right
base: "BASE\nSnapshot RDB của dataset\nLoad nhanh"
incr: "INCR\nCác lệnh ghi sau base\nDurability theo fsync policy"
restore: "Dataset sau recovery"
base -> restore: "Load trước"
incr -> restore: "Replay sau"
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

Recovery là nơi AOF chứng minh giá trị: Redis đọc lại những gì đã ghi để dựng dataset gần sát thời điểm crash nhất có thể.

Khi Redis start với `appendonly yes`, nó **ưu tiên AOF** hơn RDB (vì AOF thường mới hơn):

```d2 title="Chọn nguồn phục hồi khi khởi động"
direction: down
start: "Redis khởi động"
aof: "appendonly yes?" {shape: diamond}
base: "Load BASE\nRDB hoặc AOF theo manifest"
incr: "Replay INCR AOF theo thứ tự"
rdb: "Load dump.rdb nếu có"
ready: "Sẵn sàng phục vụ"
start -> aof
aof -> base: "Có — ưu tiên AOF"
base -> incr
incr -> ready
aof -> rdb: "Không"
rdb -> ready
```

So sánh tốc độ restart:

| Nguồn recovery | Cách load | Đặc điểm |
| --- | --- | --- |
| RDB thuần | Load binary snapshot | Thường nhanh, phụ thuộc dataset và đĩa |
| AOF cũ, toàn RESP | Replay mọi lệnh | Có thể chậm khi log lớn |
| Multi-Part AOF, base RDB | Load base rồi replay incr | Giảm phần cần replay, thường gần RDB hơn |

> [!NOTE]
> Nếu bật **cả RDB và AOF**, Redis khởi động từ **AOF** (mới hơn), RDB chỉ đóng vai backup/replication. Đây là setup hybrid được khuyến nghị — xem [Persistence Strategies](./persistence-strategies.md).

Kiểm tra trạng thái AOF:

```bash
INFO persistence
```

<!-- diagram-text: Output INFO persistence minh họa, không phải sơ đồ. -->

```text
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

- **Tránh:** cache thuần warm lại được từ DB nhưng bật AOF `everysec`/`always` mà không có yêu cầu durability; phải trả thêm I/O, đĩa và latency.
- **Cân nhắc:** RDB thưa hoặc không persistence, tùy chi phí cold-start.

### 13.2 Chọn `always` mà không đo, trên đĩa chậm

- **Tránh:** `appendfsync always` trên HDD/EBS chậm mà chưa đo; mỗi write phải chờ fsync, throughput và P99 có thể xấu đi.
- **Nên làm:** benchmark trên loại đĩa thực tế; SSD/NVMe nhanh cũng không thay thế việc đo.

Đo trước: [Benchmarking](./benchmarking.md).

### 13.3 Không giám sát dung lượng đĩa & rewrite status

Đĩa đầy → AOF ghi lỗi → có thể chặn ghi/mất dữ liệu âm thầm. Luôn alert `aof_last_write_status`, `aof_last_bgrewrite_status`, disk free.

### 13.4 Tắt `aof-load-truncated`

- Với `aof-load-truncated no`, phần AOF cuối bị cắt dở có thể khiến Redis từ chối khởi động.
- Giữ mặc định `yes` nếu policy cho phép bỏ phần cuối chưa hoàn chỉnh để start; lỗi corruption khác vẫn cần xử lý riêng.

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

| Yêu cầu | Hướng chọn |
| --- | --- |
| Chấp nhận mất vài phút, backup gọn | RDB |
| Cửa sổ mất dữ liệu khoảng 1 giây | AOF `everysec` |
| Giảm cửa sổ mất sau ACK, chấp nhận chờ đĩa | AOF `always` và kiểm chứng storage |
| Vừa durability vừa snapshot backup | RDB + AOF; vẫn cần backup off-site |

### Khi nào KHÔNG nên dùng AOF

- **Cache thuần, warm lại được từ DB** → dùng [RDB](./rdb.md) hoặc no persistence để nhẹ I/O hơn.
- **Workload write-heavy trên đĩa chậm + `appendfsync always`** → throughput có thể sụp, p99 latency tăng mạnh; đo trước khi chọn.
- **Dữ liệu ephemeral/rate-limit tạm thời** → mất vài giây/phút không ảnh hưởng nghiệp vụ thì thường không cần AOF; xem cách chọn trong [Persistence Strategies](./persistence-strategies.md).

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

- AOF ghi lại effects của write và replay khi restart.
- `write()` mới vào OS page cache; `fsync()` mới yêu cầu flush xuống storage.
- `always`: chờ fsync; `everysec`: cân bằng mặc định, có cửa sổ mất dữ liệu; `no`: phụ thuộc OS.
- Rewrite tạo log tối giản từ dataset, có chi phí fork/CoW.
- Multi-Part AOF Redis 7+ dùng manifest, BASE và INCR; base RDB giúp load nhanh.
- Nếu bật AOF, Redis ưu tiên nguồn AOF hơn `dump.rdb` khi start.
- Giám sát disk, `aof_last_write_status`, rewrite và fsync; hiểu tác động `aof-load-truncated`.
- AOF không thay backup off-site; cache thuần có thể không cần AOF.

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
