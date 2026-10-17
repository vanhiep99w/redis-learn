# D2 icons

- `redis.svg`: https://icons.d2lang.com/dev/redis.svg — logo Redis từ catalog D2.
- Lưu bản local để build và đọc tài liệu không phụ thuộc icon host. Giữ nguyên logo; không dùng như dấu xác nhận/bảo trợ.
- `scripts/prepare-content.mjs` chỉ rewrite URL catalog này trong fence D2. `remarkD2` nhúng SVG thành data URL trong output light/dark và SVG tải xuống.
