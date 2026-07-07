# RDB Snapshots

## Mục lục

- [1. Bài toán: RAM bay hơi, dữ liệu thì không được phép](#1-bài-toán-ram-bay-hơi-dữ-liệu-thì-không-được-phép)
- [2. RDB là gì: một tấm ảnh chụp toàn bộ dataset](#2-rdb-là-gì-một-tấm-ảnh-chụp-toàn-bộ-dataset)
- [3. Use Cases phổ biến](#3-use-cases-phổ-biến)
- [4. SAVE vs BGSAVE: chặn cả server hay không](#4-save-vs-bgsave-chặn-cả-server-hay-không)
- [5. fork() và Copy-on-Write: phép màu của BGSAVE](#5-fork-và-copy-on-write-phép-màu-của-bgsave)
- [6. File dump.rdb bên trong trông thế nào](#6-file-dumprdb-bên-trong-trông-thế-nào)
- [7. Cấu hình save point & tuỳ chọn quan trọng](#7-cấu-hình-save-point--tuỳ-chọn-quan-trọng)
- [8. Khi nào BGSAVE tự động chạy](#8-khi-nào-bgsave-tự-động-chạy)
- [9. Recovery: Redis khởi động lại từ RDB thế nào](#9-recovery-redis-khởi-động-lại-từ-rdb-thế-nào)
- [10. Chi phí thật của RDB: memory, CPU, latency](#10-chi-phí-thật-của-rdb-memory-cpu-latency)
- [11. Case study thực tế](#11-case-study-thực-tế)
- [12. Anti-patterns cần tránh](#12-anti-patterns-cần-tránh)
- [13. RDB vs AOF: chọn cái nào](#13-rdb-vs-aof-chọn-cái-nào)
- [14. Best Practices](#14-best-practices)
- [15. Tóm tắt / Cheat sheet](#15-tóm-tắt--cheat-sheet)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## 1. Bài toán: RAM bay hơi, dữ liệu thì không được phép

Redis là in-memory data store — toàn bộ dataset nằm trong RAM để đọc/ghi ở tốc độ micro giây (xem [Redis Overview](./redis-overview.md)). Nhưng RAM là bộ nhớ **volatile**: mất điện, kill process, `docker restart`, OOM killer nhảy vào — tất cả dữ liệu bốc hơi trong tích tắc.

Nếu Redis chỉ dùng làm cache thuần, mất là chuyện nhỏ: warm lại từ DB. Nhưng thực tế Redis còn giữ session, counter, leaderboard, job queue, rate-limit state... Mất sạch sau một lần restart nghĩa là hàng triệu user bị logout, số liệu về 0, job biến mất.

Câu hỏi cốt lõi: **làm sao lưu dữ liệu RAM xuống đĩa để sống sót qua restart, mà không làm chậm cả server đang phục vụ hàng trăm nghìn request/giây?**

Redis có hai câu trả lời: **RDB** (snapshot — ảnh chụp) và **AOF** (append-only log — nhật ký lệnh). Doc này nói về RDB — cách tiếp cận "chụp ảnh": định kỳ dump toàn bộ dataset thành **một file binary nén gọn**. Nó nhanh, file nhỏ, restart cực nhanh — đổi lại là **có thể mất vài phút dữ liệu gần nhất** nếu crash. Hiểu chính xác cái đánh đổi đó là mục tiêu của doc này.

```bash
BGSAVE            # chụp ảnh nền, không chặn server
# → tạo /var/lib/redis/dump.rdb
```

AOF được phân tích riêng trong [AOF](./aof.md); cách phối hợp cả hai nằm ở [Persistence Strategies](./persistence-strategies.md).

---

## 2. RDB là gì: một tấm ảnh chụp toàn bộ dataset

RDB (Redis Database) là cơ chế **point-in-time snapshot**: tại một thời điểm, Redis ghi lại **toàn bộ** key-value hiện có trong bộ nhớ ra một file binary duy nhất, mặc định là `dump.rdb`.

Hãy hình dung nó như chụp một tấm ảnh: mọi thứ trong khung hình tại giây bấm máy được lưu lại. Những gì thay đổi **sau** khoảnh khắc đó không có trong ảnh — cho tới lần chụp kế tiếp.

```diagram
Thời gian ──────────────────────────────────────────────▶
   │            │                    │
 12:00        12:05                12:10
 BGSAVE       BGSAVE               BGSAVE
   │            │                    │
   ▼            ▼                    ▼
dump.rdb    dump.rdb             dump.rdb
(ảnh #1)    (ảnh #2)             (ảnh #3)

        ⚡ CRASH lúc 12:09
        → phục hồi về ảnh #2 (12:05)
        → MẤT 4 phút dữ liệu (12:05 → 12:09)
```

Đặc tính then chốt:

| Đặc tính | RDB |
|----------|-----|
| Đơn vị lưu | Toàn bộ dataset (không phải từng lệnh) |
| Định dạng | Binary, có nén (LZF), compact |
| Tần suất | Định kỳ theo save point, hoặc thủ công |
| Mất dữ liệu tối đa | Từ snapshot gần nhất tới lúc crash (phút/giây) |
| Tốc độ restart | Rất nhanh — load thẳng binary vào RAM |
| Kích thước file | Nhỏ (nhỏ hơn AOF nhiều) |

> [!NOTE]
> RDB không ghi "lệnh". Nó ghi **kết quả cuối cùng** của dataset. Bạn `INCR` một key 1000 lần thì RDB chỉ lưu con số cuối cùng, không lưu 1000 phép cộng. Đây là khác biệt gốc rễ so với [AOF](./aof.md) — cái ghi lại từng lệnh ghi.

---

## 3. Use Cases phổ biến

| Use Case | Vì sao RDB hợp | Ghi chú |
|----------|----------------|---------|
| **Backup định kỳ** | File đơn, nén gọn, dễ copy sang S3/NFS | Cron `BGSAVE` + upload |
| **Disaster recovery** | Restore nhanh, chỉ cần copy 1 file | Xem [Backup & Restore](./backup-restore.md) |
| **Cache có thể chịu mất vài phút** | Restart nhanh, warm sẵn dữ liệu | Không cần độ bền tuyệt đối |
| **Replica bootstrap** | Master gửi RDB cho replica khi full sync | Xem [Replication](./replication.md) |
| **Di chuyển dữ liệu giữa các instance** | Copy `dump.rdb`, khởi động instance mới | Migration, clone môi trường |
| **Analytics / dữ liệu ít đổi** | Snapshot vài lần/ngày là đủ | Ghi ít, đọc nhiều |

> [!TIP]
> RDB chính là "xương sống" của [Replication](./replication.md): khi một replica lần đầu kết nối master, master `BGSAVE` một RDB rồi stream sang. Hiểu RDB giúp hiểu vì sao full sync tốn tài nguyên.

---

## 4. SAVE vs BGSAVE: chặn cả server hay không

Redis có hai lệnh tạo snapshot, khác nhau ở **một điểm sống còn**: có chặn event loop hay không.

### 4.1 SAVE — chặn toàn bộ server

```bash
SAVE
```

`SAVE` ghi RDB **ngay trong tiến trình chính (main thread)**. Vì Redis xử lý lệnh single-threaded (xem [Redis Overview](./redis-overview.md)), trong suốt thời gian ghi file, **không request nào khác được xử lý** — toàn bộ client bị treo.

```diagram
Main thread (single-threaded event loop):

SAVE bắt đầu ──[ ghi toàn bộ dataset ra đĩa: 3 giây ]── SAVE xong
                        │
     Trong 3 giây này ──┴──▶ MỌI client GET/SET đều bị BLOCK
                              p99 latency nhảy vọt, timeout hàng loạt
```

Với dataset 10GB, `SAVE` có thể treo server nhiều giây tới cả phút → **gần như không bao giờ dùng trong production**.

### 4.2 BGSAVE — chụp ảnh nền

```bash
BGSAVE
```

`BGSAVE` (Background Save) `fork()` ra một **tiến trình con**, con lo việc ghi file, còn tiến trình cha (main) tiếp tục phục vụ request bình thường.

```diagram
Main process ──fork()──┬──▶ Child process ──[ ghi dump.rdb ]──▶ exit
       │               │
       │               └─ chia sẻ memory qua Copy-on-Write
       ▼
tiếp tục phục vụ GET/SET, gần như không gián đoạn
```

| | `SAVE` | `BGSAVE` |
|--|--------|----------|
| Chạy ở | Main thread | Child process (`fork`) |
| Chặn client? | **Có** — treo toàn bộ | Không (trừ lúc `fork`) |
| Dùng khi | Gần như không bao giờ | Mặc định, luôn dùng |
| Rủi ro | Treo server | Tốn RAM lúc write nhiều (CoW) |

> [!WARNING]
> Đừng bao giờ gọi `SAVE` trên production instance đang phục vụ traffic. Save point tự động và lệnh thủ công đều nên dùng `BGSAVE`. `SAVE` chỉ hợp trong script maintenance khi server đã ngừng nhận traffic.

> [!NOTE]
> Lúc `fork()`, main thread có bị chặn một khoảnh khắc rất ngắn để OS copy page table. Với dataset lớn (hàng chục GB) trên máy nhiều RAM, riêng `fork` có thể tốn hàng chục–hàng trăm ms. Đây là nguồn latency spike hay bị bỏ sót — xem [Slow Log & Latency](./slow-log-latency.md).

---

## 5. fork() và Copy-on-Write: phép màu của BGSAVE

Đây là phần "aha" quan trọng nhất của RDB. Làm sao tiến trình con ghi được một snapshot **nhất quán** của 10GB dữ liệu, trong khi tiến trình cha vẫn đang liên tục sửa dữ liệu đó?

### 5.1 fork() không copy 10GB RAM

Trực giác sai lầm: "fork tạo process con → phải copy toàn bộ 10GB RAM → tốn 10GB nữa". Nếu vậy `BGSAVE` sẽ vừa chậm vừa ngốn RAM khủng khiếp.

Thực tế, `fork()` trên Linux **không copy dữ liệu**. Nó chỉ copy **page table** (bảng ánh xạ trang nhớ). Cả cha và con **cùng trỏ vào những trang RAM vật lý giống hệt nhau**, được đánh dấu **read-only**.

```diagram
Ngay sau fork():

Parent page table ─┐
                   ├──▶ [ Trang RAM vật lý ]  (read-only, dùng chung)
Child page table ──┘

→ KHÔNG tốn thêm 10GB. Chỉ tốn RAM cho page table (nhỏ).
```

### 5.2 Copy-on-Write: chỉ copy khi bị ghi

"Copy-on-Write" (CoW) nghĩa là: trang nhớ chỉ được sao chép **tại thời điểm có ai đó ghi vào nó**.

Kịch bản: con đang đọc dataset để ghi ra file. Cha nhận lệnh `SET key1 newval` — cần sửa một trang.

```diagram
Cha muốn ghi vào trang P:

1. CPU phát hiện P là read-only → page fault
2. Kernel copy P thành P' (bản riêng cho cha)
3. Cha ghi vào P' (bản mới)
4. Con vẫn thấy P (bản cũ) → snapshot NHẤT QUÁN tại thời điểm fork

┌──────────┐         ┌──────────┐
│  Parent  │────────▶│    P'    │  (bản copy, có newval)
└──────────┘         └──────────┘
┌──────────┐         ┌──────────┐
│  Child   │────────▶│    P     │  (bản gốc, val cũ — vào file)
└──────────┘         └──────────┘
```

Kết quả tuyệt vời: con luôn nhìn thấy **ảnh chụp đóng băng tại giây fork**, dù cha có sửa dữ liệu bao nhiêu đi nữa. Snapshot nhất quán mà không cần lock, không cần dừng ghi.

### 5.3 Cái giá: RAM có thể phình lên

CoW không miễn phí. Cha càng ghi nhiều trong lúc `BGSAVE` chạy, càng nhiều trang bị copy, RAM thực dùng càng tăng.

```diagram
Write nhẹ trong lúc BGSAVE:
  copy vài trang  →  RAM tăng ít  →  an toàn

Write cực nặng (traffic ghi lớn) trong lúc BGSAVE:
  copy rất nhiều trang → gần như nhân đôi dataset trong RAM → nguy cơ OOM
```

| Tình huống | RAM thêm do CoW | Rủi ro |
|------------|-----------------|--------|
| Read-heavy workload | Gần 0 | Rất an toàn |
| Write vừa phải | Nhỏ (vài %) | An toàn |
| Write-heavy khi BGSAVE | Có thể tới ~1× dataset | OOM nếu RAM sát trần |

> [!IMPORTANT]
> Vì CoW có thể làm RAM phình gần gấp đôi trong worst case, quy tắc kinh nghiệm: giữ Redis dùng **dưới ~50–60% RAM máy** nếu bật RDB trên workload write-heavy. Thiếu RAM lúc `BGSAVE` → OOM killer giết Redis đúng lúc đang cố... bảo vệ dữ liệu. Xem [Memory Management](./memory-management.md).

> [!TIP]
> Bật Transparent Huge Pages (THP) làm CoW copy theo trang 2MB thay vì 4KB → khuếch đại RAM và latency. Redis khuyến cáo **tắt THP** (`madvise`/`never`). Log khởi động Redis sẽ cảnh báo nếu THP đang bật.

---

## 6. File dump.rdb bên trong trông thế nào

RDB là binary format được thiết kế để **compact và load nhanh**, không phải để người đọc. Nhưng hiểu cấu trúc giúp bạn debug corruption và hiểu vì sao load nhanh.

```diagram
┌──────────────────────── dump.rdb ────────────────────────┐
│ "REDIS"          magic string (5 byte)                    │
│ "0011"           version number RDB (4 byte)              │
│ ── AUX fields ── metadata: redis-ver, redis-bits, ctime  │
│ ── SELECTDB 0 ── đánh dấu database index                  │
│ ── RESIZEDB ──── hint số key + số key có TTL (pre-alloc) │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ [expire?] [type] [key] [value]                       │ │
│ │ [expire?] [type] [key] [value]                       │ │  ← từng cặp
│ │ ...                                                   │ │
│ └─────────────────────────────────────────────────────┘ │
│ ── SELECTDB 1 ── (nếu dùng nhiều DB)                     │
│ ── EOF ──────── opcode kết thúc                          │
│ CRC64            checksum 8 byte toàn file                │
└───────────────────────────────────────────────────────────┘
```

Vài điểm đáng nhớ:

- **Type byte** cho biết value là string/list/set/hash/zset/stream và **encoding** cụ thể (ví dụ listpack, intset, skiplist). RDB lưu đúng encoding gọn nhất → file nhỏ.
- **Value được nén LZF** (nếu `rdbcompression yes`) — thuật toán nén nhanh, nhẹ CPU.
- **CRC64 checksum** ở cuối file: khi load, Redis kiểm tra để phát hiện file hỏng. Nếu `rdbchecksum no` thì checksum = 0 và bỏ qua kiểm tra (nhanh hơn tí, rủi ro hơn nhiều).
- Redis lưu cả **TTL tuyệt đối** (Unix timestamp ms) cho key có expire, nên restart xong key vẫn nhớ hạn của mình.

> [!TIP]
> Kiểm tra file RDB có hỏng không mà không cần khởi động Redis:
> ```bash
> redis-check-rdb /var/lib/redis/dump.rdb
> ```
> Công cụ này parse file và báo lỗi nếu cấu trúc/CRC sai — nên chạy trước khi restore một backup quan trọng.

---

## 7. Cấu hình save point & tuỳ chọn quan trọng

### 7.1 save point — "chụp ảnh khi đủ điều kiện"

Trong `redis.conf`, directive `save` định nghĩa **khi nào Redis tự động `BGSAVE`** theo dạng `save <giây> <số thay đổi>`:

```conf
save 900 1        # sau 900s (15 phút) nếu có ÍT NHẤT 1 key đổi
save 300 100      # sau 300s (5 phút)  nếu có ÍT NHẤT 100 key đổi
save 60 10000     # sau 60s  (1 phút)  nếu có ÍT NHẤT 10000 key đổi
```

Logic là **OR**: chỉ cần một dòng thoả điều kiện là `BGSAVE` chạy. Ý tưởng: dataset đổi càng nhiều thì chụp càng thường xuyên.

```diagram
Đổi nhiều (10k+ key/phút) ──▶ snapshot mỗi 60s  (mất tối đa ~1 phút)
Đổi vừa   (100+ key/5phút) ──▶ snapshot mỗi 300s (mất tối đa ~5 phút)
Đổi ít    (1+ key/15phút)  ──▶ snapshot mỗi 900s (mất tối đa ~15 phút)
```

Tắt hoàn toàn RDB tự động:

```conf
save ""
```

### 7.2 Các directive quan trọng khác

| Directive | Mặc định | Ý nghĩa |
|-----------|----------|---------|
| `dbfilename` | `dump.rdb` | Tên file RDB |
| `dir` | `./` | Thư mục chứa file (và AOF) |
| `rdbcompression` | `yes` | Nén value bằng LZF; `no` nhanh hơn chút, file to hơn |
| `rdbchecksum` | `yes` | CRC64 cuối file; `no` bỏ qua kiểm tra |
| `stop-writes-on-bgsave-error` | `yes` | Nếu `BGSAVE` lỗi → **chặn mọi lệnh ghi** để cảnh báo |
| `rdb-del-sync-files` | `no` | Xoá file RDB tạm dùng cho replication khi không cần persistence |

> [!WARNING]
> `stop-writes-on-bgsave-error yes` (mặc định) là con dao hai lưỡi. Khi đĩa đầy / lỗi ghi RDB, Redis **từ chối mọi lệnh ghi** với lỗi `MISCONF`. Mục đích tốt (báo bạn dữ liệu không được lưu), nhưng nếu bạn dùng Redis thuần làm cache và không quan tâm persistence, nó biến sự cố đĩa thành sự cố toàn bộ ứng dụng. Cache-only setup nên cân nhắc đặt `no`.

### 7.3 Chỉnh save point lúc runtime

```bash
CONFIG GET save
CONFIG SET save "60 10000 300 100"   # đổi không cần restart
CONFIG REWRITE                       # ghi lại vào redis.conf cho bền
```

---

## 8. Khi nào BGSAVE tự động chạy

`BGSAVE` không chỉ chạy theo save point. Có nhiều trigger:

```diagram
BGSAVE được kích hoạt khi:
├─ save point thoả điều kiện (giây + số thay đổi)
├─ chạy tay: BGSAVE
├─ SHUTDOWN (mặc định lưu RDB trước khi tắt, nếu có save point)
├─ replica kết nối lần đầu → master fork RDB để full sync
├─ DEBUG RELOAD (test)
└─ FLUSHALL với option (một số bản)
```

Vài lưu ý vận hành:

- `SHUTDOWN` mặc định gọi `SAVE` (blocking) trước khi thoát, để không mất dữ liệu — dùng `SHUTDOWN NOSAVE` nếu muốn tắt nhanh không lưu.
- Full sync trong [Replication](./replication.md) dựa trực tiếp vào cơ chế RDB. Nếu master không thể `fork`/ghi RDB, replica không sync được.
- Xem trạng thái snapshot gần nhất:

```bash
INFO persistence
```

```diagram
# INFO persistence — các field RDB quan trọng
rdb_bgsave_in_progress:0            # đang BGSAVE không
rdb_last_bgsave_status:ok           # lần cuối thành công?
rdb_last_save_time:1783420800       # timestamp lần lưu cuối
rdb_changes_since_last_save:1523    # bao nhiêu thay đổi chưa được lưu
rdb_last_cow_size:52428800          # RAM copy-on-write lần cuối
```

> [!TIP]
> `rdb_changes_since_last_save` là số vàng: nó cho biết **nếu crash bây giờ, bạn mất bao nhiêu thay đổi**. Cao bất thường → save point quá thưa hoặc `BGSAVE` đang thất bại.

---

## 9. Recovery: Redis khởi động lại từ RDB thế nào

Khi Redis start, quy trình load rất đơn giản — và đây là lý do RDB restart nhanh:

```diagram
Redis khởi động
   │
   ├─ AOF bật? ──── Có ──▶ load từ AOF (ưu tiên, xem [AOF])
   │                        (vì AOF thường mới hơn)
   └─ AOF tắt? ──── ▶ tìm dump.rdb trong `dir`
                         │
                         ├─ có file → kiểm CRC → load thẳng binary vào RAM
                         │             (nhanh: không replay lệnh, dựng cấu trúc trực tiếp)
                         └─ không có → khởi động với dataset rỗng
```

Điểm mấu chốt: RDB load nhanh vì nó **dựng thẳng cấu trúc dữ liệu từ binary** theo đúng encoding đã lưu, không phải "diễn lại" hàng triệu lệnh như [AOF](./aof.md).

```diagram
RDB load 10GB:  đọc binary → build cấu trúc → xong    (nhanh)
AOF load tương đương: replay hàng triệu lệnh SET/INCR (chậm hơn nhiều)
```

> [!IMPORTANT]
> Nếu bật cả RDB và AOF, khi khởi động Redis **ưu tiên load AOF** vì AOF thường phản ánh trạng thái mới nhất. RDB lúc này đóng vai backup/nền cho replication. Chi tiết phối hợp: [Persistence Strategies](./persistence-strategies.md).

Restore thủ công từ một backup:

```bash
# 1. Dừng Redis
sudo systemctl stop redis

# 2. Đặt file backup vào đúng `dir` với đúng `dbfilename`
cp /backups/dump-2026-07-07.rdb /var/lib/redis/dump.rdb
chown redis:redis /var/lib/redis/dump.rdb

# 3. Khởi động lại → Redis tự load
sudo systemctl start redis
```

Quy trình restore đầy đủ, kể cả disaster recovery: [Backup & Restore](./backup-restore.md).

---

## 10. Chi phí thật của RDB: memory, CPU, latency

RDB "nhẹ" hơn AOF, nhưng không miễn phí. Ba loại chi phí cần biết:

### 10.1 Memory (CoW)

Như mục 5: write-heavy trong lúc `BGSAVE` có thể đẩy RAM lên gần gấp đôi. Đây là chi phí nguy hiểm nhất vì nó gây OOM.

### 10.2 CPU & I/O

Tiến trình con serialize + nén (LZF) + ghi đĩa. Với dataset lớn, đây là burst CPU và I/O đáng kể. Trên máy chia sẻ (nhiều container), burst này có thể ảnh hưởng hàng xóm.

### 10.3 Latency spike lúc fork

`fork()` phải copy page table tỉ lệ với **số trang**, tức tỉ lệ với dataset size. Dataset càng lớn, `fork` càng lâu, main thread bị "đóng băng" càng lâu tại đúng thời điểm đó.

```diagram
Dataset size ──▶ page table size ──▶ thời gian fork ──▶ latency spike
   1GB               nhỏ                  ~vài ms            khó thấy
   50GB              lớn                   ~vài trăm ms       p99 nhảy vọt
```

| Chi phí | Nguồn gốc | Cách giảm |
|---------|-----------|-----------|
| RAM phình | Copy-on-Write khi write nhiều | Giữ RAM dùng <50–60%, giảm write burst, tắt THP |
| CPU/I/O burst | Serialize + nén + ghi đĩa | Đĩa nhanh (SSD), lịch snapshot lúc thấp điểm |
| Latency spike | `fork` copy page table | Dataset nhỏ hơn, tắt THP, tránh instance quá lớn |

> [!NOTE]
> Đây là lý do một số hệ thống chọn **tách persistence sang replica**: master tắt RDB (không fork, không spike), một replica chuyên trách `BGSAVE`. Master phục vụ traffic mượt, replica lo lưu đĩa. Xem [Replication](./replication.md).

---

## 11. Case study thực tế

### 11.1 Cache lớn — chấp nhận mất 5 phút

Bối cảnh: Redis 30GB làm cache sản phẩm cho e-commerce, đọc rất nhiều, ghi vừa. Mất vài phút dữ liệu = warm lại vài key, không đau.

```conf
save 300 10000      # snapshot mỗi 5 phút nếu đủ thay đổi
save 900 1          # phòng khi ít thay đổi
appendonly no       # tắt AOF cho gọn nhẹ
```

- RDB đủ dùng: restart nhanh (30GB load nhanh hơn replay AOF), file backup nhỏ.
- Read-heavy → CoW gần như miễn phí → `BGSAVE` êm.
- Giữ Redis dưới ~50% RAM máy để an toàn CoW.

### 11.2 Backup định kỳ lên S3

```bash
# cron mỗi giờ
redis-cli BGSAVE
# chờ BGSAVE xong (poll rdb_bgsave_in_progress)
sleep 5
cp /var/lib/redis/dump.rdb /tmp/dump-$(date +%F-%H).rdb
redis-check-rdb /tmp/dump-$(date +%F-%H).rdb   # verify trước khi upload
aws s3 cp /tmp/dump-$(date +%F-%H).rdb s3://my-redis-backups/
```

RDB là định dạng backup lý tưởng: **một file, self-contained, nén sẵn, verify được**. Xem [Backup & Restore](./backup-restore.md).

### 11.3 Clone production sang staging

```bash
# Trên production
redis-cli BGSAVE
scp /var/lib/redis/dump.rdb staging:/var/lib/redis/dump.rdb
# Trên staging: restart Redis → có ngay dataset production
```

Nhanh hơn nhiều so với replay từng lệnh — chỉ copy một file binary.

### 11.4 Replica bootstrap (full sync)

Khi thêm replica mới vào [Replication](./replication.md):

```diagram
Replica mới kết nối
   │
   ▼
Master BGSAVE ──▶ RDB ──stream──▶ Replica load RDB ──▶ nhận buffer lệnh mới ──▶ đồng bộ
```

Chính RDB là phương tiện chuyển "trạng thái đầy đủ" từ master sang replica. Nếu master không `fork`/ghi RDB được (thiếu RAM, đĩa đầy), replica không lên được.

---

## 12. Anti-patterns cần tránh

### 12.1 Dùng SAVE trên production

```bash
# ❌ Sai: treo toàn bộ server nhiều giây
SAVE

# ✅ Đúng: fork nền
BGSAVE
```

### 12.2 Redis dùng >70% RAM máy khi bật RDB write-heavy

```diagram
❌ Redis 14GB / máy 16GB + write-heavy
   → BGSAVE fork + CoW copy nhiều trang
   → RAM vượt 16GB → OOM killer giết Redis

✅ Redis 8GB / máy 16GB
   → còn dư cho CoW → an toàn
```

### 12.3 Coi RDB là "không bao giờ mất dữ liệu"

RDB **luôn có cửa sổ mất dữ liệu** bằng khoảng cách giữa hai snapshot. Nếu yêu cầu là "không mất một giao dịch nào" (ví tiền, order tài chính) → RDB đơn thuần không đủ. Dùng [AOF](./aof.md) với `fsync everysec`/`always`, hoặc kết hợp — xem [Persistence Strategies](./persistence-strategies.md).

### 12.4 Không giám sát rdb_last_bgsave_status

```bash
# ❌ Sai: BGSAVE thất bại âm thầm hàng ngày, không ai biết
# (đĩa đầy, thiếu RAM fork...) → tưởng có backup mà không có

# ✅ Đúng: alert khi status != ok
INFO persistence | grep rdb_last_bgsave_status
```

Xem [Monitoring](./monitoring.md).

### 12.5 Bật THP (Transparent Huge Pages)

```bash
# ❌ THP bật → CoW copy theo trang 2MB → RAM & latency tăng vọt
# ✅ Tắt:
echo never > /sys/kernel/mm/transparent_hugepage/enabled
```

### 12.6 Chỉ giữ đúng một file backup mới nhất

Nếu snapshot gần nhất bị hỏng/rỗng (do một sự cố ghi) và bạn đã ghi đè bản cũ → mất sạch. Luôn giữ **nhiều thế hệ** backup (hourly/daily/weekly) và verify bằng `redis-check-rdb`.

---

## 13. RDB vs AOF: chọn cái nào

Đây là bảng so sánh nhanh; phân tích đầy đủ nằm ở [Persistence Strategies](./persistence-strategies.md).

| Tiêu chí | RDB | AOF |
|----------|-----|-----|
| Đơn vị lưu | Snapshot toàn bộ | Từng lệnh ghi |
| Mất dữ liệu tối đa | Vài phút (giữa 2 snapshot) | ~1 giây (`everysec`) hoặc gần 0 (`always`) |
| Kích thước file | Nhỏ (nén) | Lớn hơn (log lệnh, cần rewrite) |
| Tốc độ restart | Rất nhanh | Chậm hơn (replay lệnh) |
| Ảnh hưởng runtime | Burst lúc `BGSAVE` (fork/CoW) | fsync liên tục, disk I/O đều đặn |
| Độ bền | Thấp hơn | Cao hơn |
| Backup/clone | Lý tưởng (1 file) | Cồng kềnh hơn |

```diagram
Cần restart nhanh + backup gọn, chịu được mất vài phút? ─▶ RDB
Cần độ bền cao, mất tối đa ~1s?                          ─▶ AOF
Muốn cả hai (khuyến nghị nhiều production)?              ─▶ RDB + AOF
```

> [!TIP]
> Chúng **không loại trừ nhau**. Cấu hình phổ biến nhất cho production quan trọng: bật cả RDB (backup nhanh, replication) lẫn AOF (độ bền). Redis ưu tiên AOF khi khởi động, RDB làm nền. Xem [Persistence Strategies](./persistence-strategies.md).

---

## 14. Best Practices

- Luôn dùng `BGSAVE`, không dùng `SAVE` trên instance đang phục vụ traffic.
- Giữ Redis dùng **dưới ~50–60% RAM máy** nếu bật RDB trên workload write-heavy (chừa chỗ cho Copy-on-Write).
- **Tắt Transparent Huge Pages** để giảm khuếch đại CoW và latency `fork`.
- Đặt save point khớp với "cửa sổ mất dữ liệu" bạn chấp nhận được: đổi nhiều → snapshot dày hơn.
- Giám sát `rdb_last_bgsave_status`, `rdb_changes_since_last_save`, `rdb_last_cow_size` qua [Monitoring](./monitoring.md).
- Verify backup bằng `redis-check-rdb` trước khi tin tưởng, và giữ nhiều thế hệ backup (không ghi đè bản duy nhất).
- Cache-only setup: cân nhắc `stop-writes-on-bgsave-error no` để sự cố đĩa không làm sập ứng dụng.
- Cân nhắc tách persistence sang replica nếu master cần latency cực ổn định.
- Đưa `dir`/`dump.rdb` lên đĩa nhanh (SSD) và đủ dung lượng (RDB tạm + file mới cùng lúc).

---

## 15. Tóm tắt / Cheat sheet

```diagram
┌─────────────────────── Redis RDB cheat sheet ───────────────────────┐
│ RDB = snapshot toàn bộ dataset ra 1 file binary nén                 │
│ BGSAVE = fork nền (LUÔN dùng)   SAVE = blocking (TRÁNH)             │
│ fork() không copy RAM — Copy-on-Write copy trang khi bị ghi        │
│ Write-heavy khi BGSAVE → RAM phình → giữ dùng <50-60% RAM máy      │
│ Mất dữ liệu = khoảng cách giữa 2 snapshot (phút)                    │
│ Restart NHANH vì load thẳng binary, không replay lệnh              │
│ save 900 1 / 300 100 / 60 10000 → đổi càng nhiều, chụp càng dày    │
│ Verify: redis-check-rdb   Trạng thái: INFO persistence            │
│ Tắt THP. Giám sát rdb_last_bgsave_status.                          │
└─────────────────────────────────────────────────────────────────────┘
```

3 nguyên tắc nhớ lâu:

1. **RDB đổi độ bền lấy tốc độ**: file nhỏ, restart nhanh, backup gọn — đổi lại là chấp nhận mất cửa sổ dữ liệu giữa hai snapshot. Biết rõ cửa sổ đó rộng bao nhiêu là trách nhiệm của bạn.
2. **BGSAVE không copy RAM, nhưng CoW có thể**: fork rẻ, nhưng ghi nhiều lúc snapshot khiến RAM phình gần gấp đôi. Chừa RAM là bắt buộc, không phải tuỳ chọn.
3. **RDB là nền của replication & backup**: hiểu RDB là hiểu vì sao full sync tốn tài nguyên và vì sao một file `dump.rdb` là cách clone/khôi phục nhanh nhất.

Nếu quay lại bài toán đầu doc — "lưu RAM xuống đĩa mà không làm chậm server" — RDB trả lời bằng `fork` + Copy-on-Write: chụp một ảnh đóng băng nhất quán ở tiến trình con, để tiến trình cha tiếp tục bay. Cái giá là một cửa sổ mất mát và một cú phình RAM tiềm tàng. Nếu cửa sổ đó quá rộng với bài toán của bạn, đã đến lúc đọc [AOF](./aof.md).

---

## Tài liệu tham khảo

- [Redis Persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [BGSAVE command](https://redis.io/docs/latest/commands/bgsave/)
- [SAVE command](https://redis.io/docs/latest/commands/save/)
- [AOF](./aof.md) — persistence dựa trên log lệnh, độ bền cao hơn
- [Persistence Strategies](./persistence-strategies.md) — chọn RDB / AOF / hybrid
- [Replication](./replication.md) — RDB là phương tiện full sync
- [Backup & Restore](./backup-restore.md) — quy trình backup/restore/disaster recovery
- [Memory Management](./memory-management.md) — RAM, Copy-on-Write, fragmentation
