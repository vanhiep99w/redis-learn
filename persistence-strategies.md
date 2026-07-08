# Persistence Strategies

## Mục lục

- [1. Câu hỏi thật sự: bạn chấp nhận mất bao nhiêu?](#1-câu-hỏi-thật-sự-bạn-chấp-nhận-mất-bao-nhiêu)
- [2. Hai trục quyết định: Durability vs Performance](#2-hai-trục-quyết-định-durability-vs-performance)
- [3. RDB vs AOF: so sánh cạnh nhau](#3-rdb-vs-aof-so-sánh-cạnh-nhau)
- [4. Bốn chiến lược nền tảng](#4-bốn-chiến-lược-nền-tảng)
- [5. Hybrid: vì sao bật cả hai là mặc định tốt](#5-hybrid-vì-sao-bật-cả-hai-là-mặc-định-tốt)
- [6. Redis load cái nào khi khởi động](#6-redis-load-cái-nào-khi-khởi-động)
- [7. Persistence ở tầng nhiều máy: replication ≠ persistence](#7-persistence-ở-tầng-nhiều-máy-replication--persistence)
- [8. Cây quyết định chọn strategy](#8-cây-quyết-định-chọn-strategy)
- [9. Cấu hình mẫu theo use case](#9-cấu-hình-mẫu-theo-use-case)
- [10. Case study thực tế](#10-case-study-thực-tế)
- [11. Anti-patterns cần tránh](#11-anti-patterns-cần-tránh)
- [12. Checklist chọn & vận hành persistence](#12-checklist-chọn--vận-hành-persistence)
- [13. Best Practices](#13-best-practices)
- [14. Tóm tắt / Cheat sheet](#14-tóm-tắt--cheat-sheet)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## 1. Câu hỏi thật sự: bạn chấp nhận mất bao nhiêu?

Bạn đã hiểu [RDB](./rdb.md) (snapshot định kỳ) và [AOF](./aof.md) (log từng lệnh ghi). Câu hỏi bây giờ không phải "cái nào tốt hơn" — vì không có cái tốt hơn tuyệt đối. Câu hỏi thật sự là:

> **Nếu Redis crash ngay bây giờ, bạn chấp nhận mất tối đa bao nhiêu dữ liệu — và bạn sẵn sàng trả giá bao nhiêu bằng hiệu năng để giảm con số đó?**

Đây là một quyết định **kinh doanh**, không chỉ kỹ thuật. Mất 5 phút view count của một bài báo: chẳng sao. Mất 1 giao dịch trừ tiền ví: khiếu nại, hoàn tiền, mất uy tín. Cùng một Redis, hai câu trả lời khác nhau hoàn toàn.

```diagram
"Mất bao nhiêu dữ liệu là chấp nhận được?"  (RPO — Recovery Point Objective)
   │
   ├─ Vài phút OK        ──▶ RDB thuần
   ├─ Tối đa ~1 giây     ──▶ AOF everysec (thường + RDB)
   ├─ Gần như 0          ──▶ AOF always (đĩa nhanh)
   └─ 0 tuyệt đối        ──▶ AOF + replication + backup off-site (và vẫn có giới hạn)
```

Doc này giúp bạn biến "mất bao nhiêu là được" thành một cấu hình cụ thể, và tránh hai sai lầm kinh điển: **trả quá nhiều hiệu năng cho độ bền không cần** (bật AOF always cho cache), hoặc **tưởng mình an toàn trong khi không** (chỉ RDB cho dữ liệu tài chính, hoặc tưởng replication là backup).

---

## 2. Hai trục quyết định: Durability vs Performance

Mọi lựa chọn persistence nằm trên một đường căng giữa hai đầu:

```diagram
  Bền hơn ◀──────────────────────────────────────────▶ Nhanh hơn
                                                        Nhẹ hơn

  AOF always                                            no persistence
  AOF everysec + RDB                                    RDB thưa
       │                                                     │
       └──────────── điểm cân bằng đa số production ─────────┘
```

Ba đại lượng vận hành cần đặt lên bàn cân:

| Đại lượng | Câu hỏi | Ảnh hưởng bởi |
|-----------|---------|---------------|
| **RPO** (mất bao nhiêu) | Crash mất tối đa bao nhiêu dữ liệu? | RDB save point, `appendfsync` |
| **RTO** (Recovery Time Objective — bao lâu để trở lại) | Restart/khôi phục mất bao lâu? | Kích thước dataset, RDB vs AOF replay |
| **Overhead** | Persistence ngốn bao nhiêu I/O/RAM/latency? | fsync policy, `fork()`/Copy-on-Write (CoW), disk speed |

> [!IMPORTANT]
> Đừng tối ưu một trục mà quên hai trục kia. `appendfsync always` cho RPO ~0 nhưng bóp nghẹt throughput (overhead cao). RDB thưa nhẹ nhàng nhưng RPO tệ. Chọn strategy = tìm điểm cân đối RPO/RTO/overhead **khớp với yêu cầu nghiệp vụ**, không phải cực đại hoá độ bền.

---

## 3. RDB vs AOF: so sánh cạnh nhau

Tóm tắt lại hai cơ chế (chi tiết ở [RDB](./rdb.md) và [AOF](./aof.md)):

| Tiêu chí | RDB (snapshot) | AOF (log lệnh) |
|----------|----------------|----------------|
| Ghi cái gì | Toàn bộ dataset (kết quả) | Từng lệnh ghi (quá trình) |
| Mất dữ liệu tối đa (RPO) | Vài phút (giữa 2 snapshot) | ~1s (`everysec`), ~0 (`always`) |
| Tốc độ restart (RTO) | Rất nhanh (load binary) | Chậm hơn; nhanh với Redis 7 multi-part |
| Kích thước file | Nhỏ (nén LZF) | Lớn hơn (log, cần rewrite) |
| I/O runtime | Burst lúc `BGSAVE` | Liên tục + burst lúc rewrite |
| RAM (Copy-on-Write) | Lúc `BGSAVE` | Lúc rewrite |
| Backup / clone | Lý tưởng (1 file) | Cồng kềnh |
| Đọc được bằng mắt | Không (binary) | Có (RESP text) — audit thô |
| Nền của replication | Có (full sync — đồng bộ toàn bộ dataset cho replica) | Không trực tiếp |

```diagram
RDB tối ưu: RTO (restart nhanh) + backup gọn + overhead thấp
            đổi lại: RPO xấu (mất vài phút)

AOF tối ưu: RPO tốt (mất ~1s hoặc ~0)
            đổi lại: file lớn, I/O liên tục, RTO chậm hơn (bản cũ)
```

Điểm mấu chốt: **hai cơ chế mạnh ở hai chỗ khác nhau và bù trừ cho nhau** → đó là lý do hybrid tồn tại (mục 5).

---

## 4. Bốn chiến lược nền tảng

### 4.1 Không persistence

```conf
save ""
appendonly no
```

Redis hoàn toàn in-memory. Restart = mất sạch, dataset rỗng.

- **Dùng khi:** cache thuần warm lại được từ DB; dữ liệu ephemeral (rate-limit tạm, phiên tính toán).
- **Lợi:** nhanh nhất, không I/O persistence, không lo CoW/fsync.
- **Hại:** restart mất hết → cache stampede lên DB nếu không cẩn thận (xem [Caching Patterns](./caching-patterns.md)).

### 4.2 RDB thuần

```conf
save 900 1
save 300 100
save 60 10000
appendonly no
```

- **Dùng khi:** chịu được mất vài phút, cần restart nhanh + backup gọn (cache lớn, dữ liệu ít đổi, analytics).
- **Lợi:** overhead thấp, file nhỏ, restart lẹ, backup/clone dễ.
- **Hại:** RPO xấu — mất khoảng cách giữa hai snapshot.

### 4.3 AOF thuần

```conf
save ""
appendonly yes
appendfsync everysec
```

- **Dùng khi:** cần độ bền cao (mất tối đa ~1s), nhưng không cần snapshot backup nhanh.
- **Lợi:** RPO tốt.
- **Hại:** file lớn, restart chậm hơn (bản cũ), thiếu tiện ích backup/clone của RDB.

> [!NOTE]
> "AOF thuần" hiện nay hiếm ở dạng thuần tuý, vì Redis 7 multi-part AOF đã dùng **base RDB** bên trong — tức bạn gần như luôn có lợi ích RDB-preamble khi bật AOF. Xem [AOF](./aof.md) mục Multi-Part.

### 4.4 Hybrid — RDB + AOF (khuyến nghị cho production quan trọng)

```conf
save 900 1
save 300 100
appendonly yes
appendfsync everysec
```

- **Dùng khi:** production quan trọng, muốn **cả** độ bền (~1s) **lẫn** backup/clone/replication nhanh.
- **Lợi:** RPO tốt từ AOF + backup gọn/restart-nền từ RDB.
- **Hại:** overhead cao nhất (cả hai cùng chạy), cần chừa RAM cho CoW của cả `BGSAVE` lẫn AOF rewrite.

```diagram
Không persistence ─▶ RDB thuần ─▶ AOF thuần ─▶ Hybrid
   nhanh/rẻ           gọn/RTO tốt   RPO tốt      bền + tiện, đắt nhất
   RPO tệ nhất        RPO trung      RTO kém hơn  overhead cao nhất
```

---

## 5. Hybrid: vì sao bật cả hai là mặc định tốt

Nhiều người nghĩ phải **chọn** RDB **hoặc** AOF. Thực tế Redis được thiết kế để chạy **cả hai cùng lúc**, và với production quan trọng đây thường là lựa chọn tốt nhất. Mỗi cái bù đúng điểm yếu của cái kia:

```diagram
                 RDB                          AOF
        ┌──────────────────┐        ┌──────────────────┐
Mạnh:   │ restart nhanh    │        │ RPO ~1s          │
        │ backup 1 file    │        │ mất ít khi crash │
        │ full sync repl   │        │                  │
        └──────────────────┘        └──────────────────┘
Yếu:    │ RPO vài phút     │        │ file lớn         │
        │ mất nhiều        │        │ restart chậm hơn │
        └────────┬─────────┘        └────────┬─────────┘
                 │                            │
                 └───────── HYBRID ───────────┘
              lấy điểm mạnh của cả hai, bù điểm yếu
```

Cách hybrid hoạt động khi khởi động:

- Redis **load từ AOF** (mới hơn → RPO tốt).
- RDB đóng vai **backup nhanh** (copy 1 file đi off-site) và **phương tiện full sync** cho [Replication](./replication.md).

Cái giá phải trả không biến hybrid thành lựa chọn miễn phí: overhead của cả hai cộng lại. Bạn có `BGSAVE` fork (CoW) **và** AOF rewrite fork (CoW) **và** fsync liên tục. Vì vậy hybrid đòi hỏi chừa RAM và đĩa rộng rãi hơn.

> [!TIP]
> Nếu không chắc chọn gì cho một service quan trọng: bật **hybrid với `appendfsync everysec`**. Nó cho RPO ~1s, restart hợp lý, backup gọn — và bạn tinh chỉnh sau khi đo bằng [Benchmarking](./benchmarking.md).

---

## 6. Redis load cái nào khi khởi động

Thứ tự ưu tiên rất quan trọng để không hiểu lầm "vì sao restart ra dữ liệu cũ":

```diagram
Redis khởi động
   │
   ├─ appendonly yes?
   │      │
   │      ├─ Có → LOAD TỪ AOF  (bỏ qua RDB, vì AOF thường mới hơn)
   │      │        ├─ (Redis 7) load base RDB trong AOF → nhanh
   │      │        └─ replay phần incr → tới lệnh cuối
   │      │
   │      └─ Không → LOAD TỪ dump.rdb
   │
   └─ Xong
```

> [!WARNING]
> Bẫy vận hành: bạn có một `dump.rdb` mới toanh muốn restore, nhưng quên là `appendonly yes` đang bật. Redis khởi động sẽ **bỏ qua RDB và load AOF cũ** → tưởng restore thất bại. Muốn restore từ RDB khi đang bật AOF: hoặc tắt AOF tạm thời, hoặc chuyển RDB thành nguồn qua quy trình đúng. Xem [Backup & Restore](./backup-restore.md).

---

## 7. Persistence ở tầng nhiều máy: replication ≠ persistence

Đây là hiểu lầm nguy hiểm nhất về độ bền. "Tôi có 3 replica, dữ liệu chắc chắn an toàn" — **sai**.

[Replication](./replication.md) là **async replication** / **asynchronous** mặc định: master trả lời client **trước khi** replica xác nhận. Nếu master crash ngay sau khi ack client nhưng trước khi lệnh tới replica → lệnh đó **mất**, dù có bao nhiêu replica.

```diagram
Client ──SET──▶ Master ──(ack ngay)──▶ Client   ✅ "thành công"
                   │
                   └──(async, chưa kịp)──✗ CRASH
                                          │
                Replica lên làm master → KHÔNG có lệnh đó → MẤT
```

Vì vậy, replication bảo vệ khỏi **mất một máy** (availability), không đảm bảo **không mất dữ liệu** (durability) và không thay thế backup.

| Cơ chế | Bảo vệ khỏi | KHÔNG bảo vệ khỏi |
|--------|-------------|-------------------|
| RDB/AOF | Restart, crash process | Đĩa hỏng, xoá nhầm, ransomware |
| Replication | Chết một node (HA) | Mất dữ liệu async, lỗi lan sang mọi replica (vd `FLUSHALL`) |
| Backup off-site | Đĩa hỏng, xoá nhầm, thảm hoạ | (là lớp phòng thủ cuối) |

```diagram
Ba lớp phòng thủ độc lập — CẦN CẢ BA cho dữ liệu quan trọng:

  ┌─────────────┐   ┌──────────────┐   ┌────────────────────┐
  │ Persistence │   │ Replication  │   │ Backup off-site    │
  │ (RDB/AOF)   │   │ (HA/failover)│   │ (S3/NFS, nhiều gen)│
  └─────────────┘   └──────────────┘   └────────────────────┘
   sống qua restart  sống qua chết node  sống qua thảm hoạ đĩa
```

> [!IMPORTANT]
> `WAIT numreplicas timeout` cho phép chờ N replica xác nhận trước khi coi lệnh là bền hơn, giảm cửa sổ mất dữ liệu async — nhưng nó đánh đổi latency và **không** biến replication thành đồng bộ tuyệt đối. Chi tiết: [Replication](./replication.md). Backup off-site vẫn bắt buộc — [Backup & Restore](./backup-restore.md).

---

## 8. Cây quyết định chọn strategy

```diagram
Dữ liệu Redis có warm lại được từ nơi khác (DB) không?
│
├─ CÓ (cache thuần) ──────────────────────────────────────┐
│     │                                                     │
│     └─ Cần tránh cold-start/stampede sau restart?         │
│           ├─ Không quan trọng ─▶ Không persistence        │
│           └─ Muốn warm sẵn    ─▶ RDB thưa (save thưa)    │
│                                                           │
└─ KHÔNG (Redis là nguồn sự thật, hoặc mất là mất thật) ───┤
      │                                                     │
      └─ Chấp nhận mất bao nhiêu khi crash?                 │
            ├─ Vài phút OK        ─▶ RDB thuần              │
            ├─ Tối đa ~1 giây     ─▶ Hybrid (AOF everysec + RDB)  ◀── mặc định tốt
            └─ Gần như 0          ─▶ Hybrid (AOF always) + đĩa nhanh
                                     + replication + backup off-site
```

> [!TIP]
> Khi phân vân giữa hai nhánh, chọn nhánh bền hơn rồi **đo overhead thực tế** bằng [Benchmarking](./benchmarking.md). Hạ độ bền vì đo thấy nó thắt cổ chai thì dễ; phát hiện mất dữ liệu sau sự cố thì đã muộn.

---

## 9. Cấu hình mẫu theo use case

### 9.1 Cache thuần (warm lại từ DB)

```conf
save ""
appendonly no
maxmemory 8gb
maxmemory-policy allkeys-lru
```

Không persistence, để [Eviction Policies](./eviction-policies.md) lo bộ nhớ. Nếu muốn tránh cold-start, thêm `save 900 1` để có snapshot nền.

### 9.2 Session store cần độ bền vừa

```conf
save 300 100
appendonly yes
appendfsync everysec
```

Mất ~1s session là chấp nhận được; RDB làm backup nhanh. Xem [Session Store](./session-store.md).

### 9.3 Redis là primary datastore / tài chính

```conf
save 900 1
appendonly yes
appendfsync everysec        # hoặc always nếu quy định khắt khe + NVMe
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 128mb
# + replication (Sentinel/Cluster) + backup off-site
```

Hybrid + độ bền cao + phòng thủ nhiều lớp. `always` chỉ khi đã đo throughput chịu được.

### 9.4 Analytics / dữ liệu ít đổi

```conf
save 3600 1
appendonly no
```

Ghi ít → snapshot thưa là đủ, overhead tối thiểu.

### 9.5 Master latency cực ổn định (tách persistence)

```conf
# Master: tắt persistence để không fork/CoW → latency mượt
save ""
appendonly no
```

```conf
# Một replica chuyên trách persistence:
save 300 100
appendonly yes
appendfsync everysec
```

Master phục vụ traffic không bị latency spike do fork; replica lo lưu đĩa. Xem [Replication](./replication.md).

---

## 10. Case study thực tế

### 10.1 E-commerce: cache sản phẩm 30GB

Yêu cầu: đọc rất nhiều, mất vài phút không sao (warm lại từ DB). → **RDB thuần**.

```conf
save 300 10000
save 900 1
appendonly no
```

Restart nhanh (load binary), backup gọn, read-heavy nên CoW gần miễn phí. Bật AOF ở đây chỉ tổ tốn I/O cho dữ liệu vốn khôi phục được.

### 10.2 Fintech: ví & sổ giao dịch tạm

Yêu cầu: không được mất giao dịch. → **Hybrid AOF everysec + RDB**, cân nhắc `always`.

```conf
save 900 1
appendonly yes
appendfsync everysec
```

Kèm Sentinel để failover ([Sentinel](./sentinel.md)) và backup hàng giờ lên S3. Ba lớp: persistence + replication + backup.

### 10.3 Job queue: không được mất job

Yêu cầu: mất job = mất việc phải làm. → **AOF everysec** (hybrid).

Restart → replay AOF dựng lại queue với job chưa xử lý. Dùng [Streams](./streams.md) với consumer group để có thêm ack/redelivery.

### 10.4 Rate limiter tạm thời

Yêu cầu: state chỉ sống ngắn, mất khi restart cũng chấp nhận. → **Không persistence**.

```conf
save ""
appendonly no
```

Đơn giản, nhanh nhất. Xem [Rate Limiting](./rate-limiting.md).

### 10.5 Chuyển strategy khi tải tăng

Bắt đầu bằng RDB thuần cho một service. Khi nghiệp vụ nâng yêu cầu (dữ liệu trở nên quan trọng), bật AOF không downtime:

```bash
redis-cli CONFIG SET appendonly yes
redis-cli CONFIG REWRITE
redis-cli INFO persistence | grep aof_last_bgrewrite_status   # đợi ok
```

Persistence strategy nên tiến hoá theo giá trị dữ liệu, không đóng đinh từ ngày đầu.

---

## 11. Anti-patterns cần tránh

### 11.1 Bật AOF always cho cache

```diagram
❌ Cache warm-lại-được + appendfsync always
   → trả giá throughput/latency khổng lồ cho độ bền KHÔNG cần

✅ Cache → RDB thuần hoặc no persistence
```

### 11.2 Chỉ RDB cho dữ liệu tài chính

```diagram
❌ Ví tiền + chỉ RDB (save 300...)
   → crash mất tới 5 phút giao dịch → mất tiền thật

✅ Tài chính → AOF (everysec/always) + replication + backup
```

### 11.3 Tưởng replication là backup/persistence

Async replication mất dữ liệu chưa kịp truyền; `FLUSHALL` nhầm lan sang mọi replica. Replica **không** thay persistence, cũng **không** thay backup off-site. (Mục 7.)

### 11.4 Tưởng persistence là backup

RDB/AOF nằm cùng đĩa/máy. Đĩa hỏng, xoá nhầm, ransomware → mất cả. Luôn copy file ra ngoài (S3/NFS), giữ nhiều thế hệ, verify bằng `redis-check-rdb`/`redis-check-aof`. Xem [Backup & Restore](./backup-restore.md).

### 11.5 Quên đang bật AOF khi restore RDB

Đặt `dump.rdb` mới nhưng `appendonly yes` → Redis load AOF cũ, bỏ qua RDB. (Mục 6.)

### 11.6 Bật hybrid mà không chừa RAM/đĩa

Hybrid có `BGSAVE` fork + AOF rewrite fork (cả hai CoW) + fsync liên tục. Thiếu RAM → OOM lúc fork; thiếu đĩa → AOF ghi lỗi. Giữ Redis dùng dưới ~50–60% RAM, đĩa rộng.

### 11.7 Chọn always mà không benchmark trên đĩa thật

`always` gắn latency ghi vào latency đĩa. Trên HDD/EBS chậm, throughput sụp. Đo trước bằng [Benchmarking](./benchmarking.md).

---

## 12. Checklist chọn & vận hành persistence

```diagram
Trước khi chốt strategy:
□ Dữ liệu warm lại được không? (quyết định có cần persistence)
□ RPO: crash mất tối đa bao nhiêu là chấp nhận được?
□ RTO: restart/khôi phục trong bao lâu là chấp nhận được?
□ Workload read-heavy hay write-heavy? (ảnh hưởng CoW/overhead)
□ Đĩa loại gì? (always cần NVMe/SSD)
□ Có replication cho HA chưa? (không thay persistence)
□ Có backup off-site nhiều thế hệ chưa? (không thay được)

Sau khi bật:
□ Giám sát rdb_last_bgsave_status / aof_last_write_status
□ Giám sát rdb_changes_since_last_save (RPO thực)
□ Giám sát dung lượng đĩa (AOF + RDB tạm cùng lúc)
□ Chừa RAM cho Copy-on-Write; tắt Transparent Huge Pages (THP)
□ Benchmark overhead trước khi lên production
□ Diễn tập restore định kỳ (backup chưa test = chưa có backup)
```

---

## 13. Best Practices

- Bắt đầu từ **RPO nghiệp vụ** ("mất bao nhiêu là được"), rồi mới chọn cơ chế — đừng chọn theo cảm tính "bền hơn là tốt hơn".
- Cache thuần: **không persistence** hoặc **RDB thưa**. Đừng bật AOF cho dữ liệu warm-lại-được.
- Dữ liệu quan trọng: **hybrid (AOF everysec + RDB)** là mặc định tốt; nâng `always` chỉ khi cần và đã benchmark trên đĩa nhanh.
- Nhớ ba lớp phòng thủ **độc lập**: persistence (restart) + replication (HA) + backup off-site (thảm hoạ). Không cái nào thay cái nào.
- Chừa Redis dùng **dưới ~50–60% RAM máy** khi bật persistence write-heavy (Copy-on-Write); **tắt THP**.
- Đảm bảo đĩa đủ rộng: AOF + RDB + file tạm rewrite có thể tồn tại cùng lúc.
- Giám sát trạng thái persistence và **RPO thực** (`rdb_changes_since_last_save`, tỉ lệ `aof_current_size/base_size`) qua [Monitoring](./monitoring.md).
- **Diễn tập restore** định kỳ; verify file bằng `redis-check-rdb`/`redis-check-aof` — [Backup & Restore](./backup-restore.md).
- Cho instance cần latency cực ổn định: cân nhắc tách persistence sang replica.
- Để strategy **tiến hoá** theo giá trị dữ liệu; đo bằng [Benchmarking](./benchmarking.md) trước mỗi thay đổi lớn.

---

## 14. Tóm tắt / Cheat sheet

```diagram
┌──────────────── Redis Persistence Strategy cheat sheet ─────────────────┐
│ Bắt đầu từ RPO: "crash mất bao nhiêu là chấp nhận được?"               │
│                                                                         │
│ Cache warm-lại-được   → no persistence / RDB thưa                       │
│ Chịu mất vài phút     → RDB thuần (restart nhanh, backup gọn)          │
│ Mất tối đa ~1 giây    → HYBRID: AOF everysec + RDB   ◀── mặc định tốt  │
│ Gần như mất 0         → AOF always (NVMe) + repl + backup off-site     │
│                                                                         │
│ Khởi động: bật AOF → load AOF (bỏ RDB). Nhớ khi restore!              │
│ Replication ≠ persistence ≠ backup — CẦN CẢ BA lớp                     │
│ Hybrid: fork BGSAVE + fork rewrite + fsync → chừa RAM & đĩa            │
│ Tắt THP. Giám sát RPO thực. Diễn tập restore.                          │
└─────────────────────────────────────────────────────────────────────────┘
```

3 nguyên tắc nhớ lâu:

1. **Chọn persistence là chọn RPO, không phải chọn công nghệ**: quyết định "mất bao nhiêu là chấp nhận được" trước, rồi RDB/AOF/hybrid tự lộ ra. Tối đa hoá độ bền một cách mù quáng chỉ để lại hoá đơn hiệu năng.
2. **RDB và AOF bù trừ nhau — hybrid lấy cả hai điểm mạnh**: AOF cho RPO tốt, RDB cho restart/backup/replication nhanh. Với production quan trọng, bật cả hai thường đúng hơn là chọn một.
3. **Persistence, replication, backup là ba lớp khác nhau**: một cái sống qua restart, một cái sống qua chết node, một cái sống qua thảm hoạ đĩa. Nhầm lẫn ba thứ này là nguyên nhân phổ biến nhất của mất dữ liệu "không thể xảy ra".

Quay lại câu hỏi đầu doc — "bạn chấp nhận mất bao nhiêu?" — khi bạn trả lời được nó bằng một con số (0, 1 giây, hay 5 phút), phần còn lại chỉ là dịch con số đó thành `save`, `appendfsync`, replication và lịch backup. Đó chính là toàn bộ nghệ thuật của persistence strategy.

---

## Tài liệu tham khảo

- [Redis Persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [RDB](./rdb.md) — snapshot: nhanh, gọn, RPO vài phút
- [AOF](./aof.md) — log lệnh: độ bền cao, RPO ~1s hoặc ~0
- [Replication](./replication.md) — HA ở tầng nhiều máy (không thay persistence)
- [Sentinel](./sentinel.md) — automatic failover
- [Backup & Restore](./backup-restore.md) — lớp phòng thủ off-site bắt buộc
- [Benchmarking](./benchmarking.md) — đo overhead trước khi chọn
- [Memory Management](./memory-management.md) — RAM, Copy-on-Write, fork
- [Monitoring](./monitoring.md) — giám sát trạng thái & RPO thực
