import express, { Request, Response } from 'express';
import http from 'node:http';

const app = express();
app.use(express.json());

// Biến môi trường cấu hình sự cố
const PORT = Number(process.env.PORT) || 4002;
const DELAY_MS = Number(process.env.DELAY_MS) || 0;
const FAIL_RATE = Number(process.env.FAIL_RATE) || 0; // 0 - 1
const DROP_RATE = Number(process.env.DROP_RATE) || 0; // 0 - 1

// Thống kê hoạt động của ngân hàng
export const stats = {
  connections: 0,
  requests: 0,
  charges: 0,
  duplicates: 0,
};

// Bộ nhớ lưu các giao dịch đã xử lý theo Idempotency-Key
interface ChargeRecord {
  chargeId: string;
  reference: string;
  amount: number;
  status: string;
}

export const processedKeys = new Map<string, ChargeRecord>();
// Lưu các reference đã từng trừ tiền thành công để phát hiện duplicates (trừ tiền trùng)
export const chargedReferences = new Set<string>();
// Quản lý các giao dịch đang xử lý dở dang (in-flight) để chống race-condition
export const inFlightRequests = new Map<string, Promise<ChargeRecord | null>>();

// Endpoint xem thống kê
app.get('/stats', (req: Request, res: Response) => {
  res.json({
    connections: stats.connections,
    requests: stats.requests,
    charges: stats.charges,
    duplicates: stats.duplicates,
  });
});

// Endpoint reset bộ nhớ (hỗ trợ kiểm thử tự động giữa các bài test)
app.post('/reset', (req: Request, res: Response) => {
  stats.connections = 0;
  stats.requests = 0;
  stats.charges = 0;
  stats.duplicates = 0;
  processedKeys.clear();
  chargedReferences.clear();
  inFlightRequests.clear();
  res.json({ message: 'Reset stats and memory successfully' });
});

// Endpoint trừ tiền
app.post('/charges', async (req: Request, res: Response) => {
  stats.requests++;

  const idempotencyKey = (req.headers['idempotency-key'] as string) || '';
  const { reference, amount } = req.body;

  // 1. Kiểm tra tính hợp lệ của số tiền
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'Số tiền không hợp lệ' });
  }

  // 2. Kiểm tra hạn mức giao dịch (tối đa 20.000.000đ)
  if (amount > 20_000_000) {
    return res.status(402).json({ error: 'Vượt hạn mức 20.000.000đ' });
  }

  // 3. Xử lý Idempotency-Key: nếu đã xử lý giao dịch này rồi, trả lại kết quả cũ, KHÔNG trừ thêm
  if (idempotencyKey && processedKeys.has(idempotencyKey)) {
    console.log(`[Bank] Idempotency hit: Khóa ${idempotencyKey} đã xử lý, trả lại kết quả cũ`);
    return res.status(201).json(processedKeys.get(idempotencyKey));
  }

  // Nếu có một request cùng Idempotency-Key đang được xử lý, đợi kết quả đó
  if (idempotencyKey && inFlightRequests.has(idempotencyKey)) {
    console.log(`[Bank] Idempotency: Khóa ${idempotencyKey} đang xử lý, đợi kết quả...`);
    try {
      const existing = await inFlightRequests.get(idempotencyKey);
      if (existing) {
        return res.status(201).json(existing);
      }
    } catch {
      // Nếu in-flight trước đó bị lỗi, request này tiếp tục xử lý
    }
  }

  const processChargePromise = (async (): Promise<ChargeRecord | null> => {
    // 4. Giả lập trễ mạng (DELAY_MS)
    const currentDelay = Number(process.env.DELAY_MS) || DELAY_MS;
    if (currentDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, currentDelay));
    }

    // Kiểm tra lại Idempotency sau trễ mạng
    if (idempotencyKey && processedKeys.has(idempotencyKey)) {
      return processedKeys.get(idempotencyKey)!;
    }

    // 5. Giả lập lỗi tạm thời FAIL_RATE (trả 500 TRƯỚC khi trừ tiền)
    const currentFailRate = Number(process.env.FAIL_RATE) || FAIL_RATE;
    if (currentFailRate > 0 && Math.random() < currentFailRate) {
      console.log(`[Bank] Giả lập lỗi 500 (FAIL_RATE = ${currentFailRate})`);
      throw { statusCode: 500, message: 'Lỗi máy chủ ngân hàng tạm thời (500)' };
    }

    // 6. Thực hiện trừ tiền
    if (reference) {
      if (chargedReferences.has(reference)) {
        stats.duplicates++;
        console.warn(`[Bank] CẢNH BÁO: Phát hiện trừ tiền trùng cho reference ${reference}!`);
      } else {
        chargedReferences.add(reference);
      }
    }

    stats.charges++;
    const chargeId = `CHG_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const record: ChargeRecord = {
      chargeId,
      reference,
      amount,
      status: 'SUCCESS',
    };

    if (idempotencyKey) {
      processedKeys.set(idempotencyKey, record);
    }

    return record;
  })();

  if (idempotencyKey) {
    inFlightRequests.set(idempotencyKey, processChargePromise);
  }

  let record: ChargeRecord | null = null;
  try {
    record = await processChargePromise;
  } catch (err: any) {
    if (idempotencyKey) {
      inFlightRequests.delete(idempotencyKey);
    }
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    return res.status(500).json({ error: 'Lỗi không xác định' });
  } finally {
    if (idempotencyKey) {
      inFlightRequests.delete(idempotencyKey);
    }
  }

  // 7. Giả lập DROP_RATE: Trừ tiền XONG rồi cắt kết nối trước khi trả lời
  const currentDropRate = Number(process.env.DROP_RATE) || DROP_RATE;
  if (currentDropRate > 0 && Math.random() < currentDropRate) {
    console.log(`[Bank] Giả lập đứt kết nối (DROP_RATE = ${currentDropRate}) sau khi trừ tiền chargeId=${record?.chargeId}`);
    req.socket.destroy();
    return;
  }

  // 8. Trả kết quả thành công 201
  return res.status(201).json(record);
});

const server = http.createServer(app);

server.keepAliveTimeout = 5000;
server.headersTimeout = 6000;

server.on('connection', (socket) => {
  stats.connections++;
  console.log(`[Bank] Kết nối TCP mới nhận (#${stats.connections}) từ ${socket.remoteAddress}:${socket.remotePort}`);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`=== NGÂN HÀNG GIẢ LẬP ĐANG CHẠY TRÊN CỔNG ${PORT} ===`);
    console.log(`Cấu hình sự cố: DELAY_MS=${DELAY_MS}, FAIL_RATE=${FAIL_RATE}, DROP_RATE=${DROP_RATE}`);
  });
}

export { app, server };
