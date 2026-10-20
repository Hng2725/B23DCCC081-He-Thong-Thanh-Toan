# BÀI TẬP: KẾT NỐI VÀ DUY TRÌ KẾT NỐI GIỮA CÁC SERVICE
---

## 1. Cấu trúc hệ thống

Hệ thống gồm 2 microservice viết bằng **TypeScript / TSX** (chạy trực tiếp bằng `tsx`, dữ liệu lưu trong bộ nhớ):

1. **Fee Service (Hệ thống trường học - Cổng 4001):**
   - Quản lý công nợ sinh viên (Sinh viên 1: 50.000.000đ, SV 2: 0đ, SV 3: 3.200.000đ).
   - `GET /students/:id/fees`: Xem công nợ nhanh, không bị ảnh hưởng khi ngân hàng gặp sự cố.
   - `POST /students/:id/payments`: Tạo lệnh thanh toán `P1, P2...`, gọi sang ngân hàng qua HTTP Keep-Alive Agent, xử lý retry idempotent và trừ công nợ khi thành công.

2. **Ngân hàng giả lập (Bank Service - Cổng 4002):**
   - `POST /charges`: Trừ tiền với `Idempotency-Key` (chống trừ tiền trùng `duplicates = 0`), kiểm tra hạn mức 20.000.000đ.
   - `GET /stats`: Thống kê `{ connections, requests, charges, duplicates }`.
   - Giả lập lỗi qua biến môi trường: `DELAY_MS`, `FAIL_RATE`, `DROP_RATE`.
   - Đóng kết nối nhàn rỗi sau 5 giây (`keepAliveTimeout = 5000`).

---

## 2. Hướng dẫn cài đặt và chạy ứng dụng

### Bước 1: Khởi động 2 Service độc lập

Mở 2 cửa sổ terminal (PowerShell hoặc Command Prompt) trong thư mục dự án:

- **Terminal 1 - Khởi động Ngân hàng (Cổng 4002):**
  ```bash
  npm run start:bank
  ```

- **Terminal 2 - Khởi động Fee Service (Cổng 4001):**
  ```bash
  npm run start:fee
  ```

---

## 3. Chạy kiểm thử tự động (Automated Test Suite)

Toàn bộ 4 tình huống sự cố đã được lập trình kiểm thử tự động bằng `tsx`:

```bash
# Chạy toàn bộ 4 kịch bản kiểm thử:
npm test
```

Hoặc chạy kiểm thử riêng từng kịch bản:
- Kịch bản 1 (Ngân hàng tắt, bật lại): `npm run test:1`
- Kịch bản 2 (Ngân hàng trễ 5s, timeout ≤ 4.5s): `npm run test:2`
- Kịch bản 3 (Duy trì kết nối Keep-Alive ≤ 20 TCP): `npm run test:3`
- Kịch bản 4 (Idempotency retry, drop rate, fail rate, 402): `npm run test:4`

---

## 4. Hướng dẫn kiểm thử bằng POSTMAN

Đã chuẩn bị sẵn file Collection chuẩn Postman v2.1: **`postman_collection.json`**.

### Cách Import vào Postman:
1. Mở ứng dụng **Postman**.
2. Bấm vào nút **Import** (ở góc trên bên trái).
3. Kéo thả hoặc chọn file `c:\Users\WebProject\Bai_tap_API\postman_collection.json`.
4. Bấm **Import**. Bạn sẽ thấy Collection mang tên **`LAB 3 - Kết Nối Service và Thanh Toán Học Phí (PTIT)`**.

### Danh sách các thư mục kiểm thử trong Postman:

#### 📂 Thư mục 1: `Fee Service (Cổng 4001)`
- `GET Xem công nợ Sinh viên 1 (50.000.000đ)`: Trả 200 kèm nợ 50.000.000đ.
- `GET Xem công nợ Sinh viên 2 (0đ)`: Trả 200 kèm nợ 0đ.
- `GET Xem công nợ Sinh viên 3 (3.200.000đ)`: Trả 200 kèm nợ 3.200.000đ.
- `POST Thanh toán học phí (100.000đ)`: Trả `201 Created`, trạng thái `PAID`, công nợ giảm còn 49.900.000đ.
- `POST Thanh toán vượt quá công nợ`: Gửi 999.000.000đ -> Trả `400 Bad Request`.

#### 📂 Thư mục 2: `Ngân hàng giả lập (Cổng 4002)`
- `GET Xem thống kê Ngân hàng (GET /stats)`: Xem `connections`, `requests`, `charges`, `duplicates`.
- `POST Trừ tiền trực tiếp kèm Idempotency-Key`: Thử gửi 2 lần cùng một key, ngân hàng trả lại giao dịch cũ, không trừ tiền trùng (`duplicates = 0`).
- `POST Trừ tiền vượt hạn mức 20tr`: Gửi 25.000.000đ -> Trả `402 Payment Required`.

#### 📂 Thư mục 3: `Kiểm thử 4 Tình huống Sự cố (Scenarios 1-4)`
- **Tình huống 1**: Tắt terminal Ngân hàng, gửi request `Tình huống 1: Ngân hàng tắt -> Gọi thanh toán`.
  - Kết quả: Nhận `503 Service Unavailable`, `status: "FAILED"` trong thời gian `< 1.5s`.
  - Bật lại ngân hàng (`npm run start:bank`), gửi lại -> Nhận `201 Created`, `status: "PAID"`.
- **Tình huống 2**: Chạy ngân hàng với `$env:DELAY_MS="5000"; npm run start:bank`.
  - Gửi request `Tình huống 2: Ngân hàng trễ 5s -> Gọi thanh toán`.
  - Kết quả: Hết timeout trả về `504 Gateway Timeout`, `status: "PENDING"`, tổng thời gian `≤ 4.5s`.
  - Trong lúc đang chờ, gửi request `Xem công nợ` -> Trả lời ngay tức thì (`< 300ms`).
- **Tình huống 4 (c)**: Gửi request `Tình huống 4(c): Thanh toán 25tr`.
  - Kết quả: Trả `402 Payment Required`, `status: "FAILED"`, không retry.

---

## 5. Bảng tổng hợp kết quả 4 tình huống sự cố

| Tình huống | Bối cảnh | Kết quả đạt được | Trạng thái |
| :--- | :--- | :--- | :---: |
| **1. Ngân hàng tắt rồi bật lại** | Fee Service khởi động trước, ngân hàng khởi động sau | Trả về `503 FAILED` trong < 1.5s khi bank tắt. Fee Service không sập, xem nợ 200 bình thường. Khi bank bật, thanh toán trả `201 PAID` ngay không cần restart. | **ĐẠT 100%** |
| **2. Ngân hàng phản hồi chậm 5s** | Bank quá tải `DELAY_MS=5000` | Trả về `504 PENDING` trong ≤ 4.5s. Đồng thời bắn 20 payment thì `GET /fees` vẫn phản hồi cực nhanh < 10ms (< 300ms). | **ĐẠT 100%** |
| **3. Duy trì kết nối Keep-Alive** | Gửi 200 payments, concurrency 10 | 200/200 thành công. Số TCP connections mở ≤ 20. Sau nhàn rỗi 6s, kết nối tự khôi phục thành công 5/5. | **ĐẠT 100%** |
| **4. Đứt cáp, lỗi tạm thời, từ chối** | `DROP_RATE=0.3`, `FAIL_RATE=0.3`, thanh toán 25tr | (a) duplicates = 0, ≥ 54/60 thành công (đạt 60/60); công nợ chỉ giảm đúng lệnh PAID.<br>(b) ≥ 54/60 thành công (đạt 60/60); duplicates = 0.<br>(c) Trả 402 FAILED, ngân hàng chỉ nhận đúng 1 request duy nhất. | **ĐẠT 100%** |
