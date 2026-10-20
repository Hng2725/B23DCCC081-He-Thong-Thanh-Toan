# HỆ THỐNG THANH TOÁN HỌC PHÍ & KẾT NỐI SERVICE

## 1. Cấu trúc 2 Service

* **Fee Service (Cổng 4001):**
  * Quản lý công nợ sinh viên (SV 1: 50tr, SV 2: 0đ, SV 3: 3.2tr).
  * Gọi trừ tiền sang Ngân hàng bằng `http.Agent` (Keep-Alive, tái sử dụng $\le 20$ kết nối TCP).
  * Xử lý retry với `Idempotency-Key`, timeout $\le 4.5\text{s}$.
* **Ngân hàng giả lập (Cổng 4002):**
  * Xử lý `POST /charges`, kiểm tra hạn mức 20.000.000đ.
  * Chống trừ tiền trùng bằng Idempotency (`duplicates = 0`).
  * Giả lập lỗi qua biến môi trường: `DELAY_MS`, `FAIL_RATE`, `DROP_RATE`.
  * Đóng kết nối nhàn rỗi sau 5 giây.

---

## 2. Cài đặt & Khởi chạy

```bash
# Cài đặt thư viện
npm install

# Terminal 1: Chạy Ngân hàng (Cổng 4002)
npm run bank

# Terminal 2: Chạy Fee Service (Cổng 4001)
npm run fee
```

---

## 3. Danh sách API chính

| Service | Method | Endpoint | Mô tả |
| :--- | :---: | :--- | :--- |
| **Fee Service (4001)** | `GET` | `/students/:id/fees` | Xem công nợ sinh viên (nhanh $< 300\text{ms}$) |
| | `POST` | `/students/:id/payments` | Thanh toán học phí (Body: `{"amount": 100000}`) |
| | `POST` | `/reset` | Đưa công nợ về mặc định |
| **Bank (4002)** | `GET` | `/stats` | Xem thống kê `{ connections, requests, charges, duplicates }` |
| | `POST` | `/charges` | Trừ tiền trực tiếp (Header: `Idempotency-Key`) |
| | `POST` | `/reset` | Reset bộ nhớ và thống kê |

---

## 4. Chạy kiểm thử tự động

Hệ thống có sẵn script kiểm thử tự động bằng `tsx` cho toàn bộ 4 kịch bản sự cố:

```bash
npm test
```
*Hoặc chạy riêng từng kịch bản: `npm run test:1`, `test:2`, `test:3`, `test:4`.*

---

## 5. Kiểm thử bằng Postman

1. Mở Postman $\rightarrow$ Chọn **Import**.
2. Chọn file **`postman_collection.json`** trong thư mục dự án.
3. Collection đã tạo sẵn đầy đủ các request và script test tự động (`pm.test`):
   * **Tình huống 1:** Ngân hàng tắt $\rightarrow$ trả `503 FAILED` ($< 1.5\text{s}$); Bật lại $\rightarrow$ trả `201 PAID`.
   * **Tình huống 2:** Ngân hàng trễ 5s $\rightarrow$ trả `504 PENDING` ($\le 4.5\text{s}$); `GET /fees` đồng thời vẫn $< 300\text{ms}$.
   * **Tình huống 3:** Gửi 200 payments Keep-Alive $\rightarrow$ số kết nối TCP mở $\le 20$.
   * **Tình huống 4:** Đứt kết nối / lỗi 500 $\rightarrow$ `duplicates = 0`, retry thành công $\ge 54/60$; Thanh toán 25tr $\rightarrow$ trả `402 FAILED`.
