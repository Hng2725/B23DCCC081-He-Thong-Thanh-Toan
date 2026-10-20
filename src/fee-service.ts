import express, { Request, Response } from 'express';
import http from 'node:http';
import { URL } from 'node:url';

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT) || 4001;
const BANK_URL = process.env.BANK_URL || 'http://localhost:4002';

// 1. Dữ liệu trong bộ nhớ (In-memory storage)
interface Student {
  id: number;
  debt: number;
}

export const students: Record<number, Student> = {
  1: { id: 1, debt: 50_000_000 },
  2: { id: 2, debt: 0 },
  3: { id: 3, debt: 3_200_000 },
};

let paymentCounter = 0;

export function resetFeeServiceMemory() {
  students[1] = { id: 1, debt: 50_000_000 };
  students[2] = { id: 2, debt: 0 };
  students[3] = { id: 3, debt: 3_200_000 };
  paymentCounter = 0;
}

app.post('/reset', (req: Request, res: Response) => {
  resetFeeServiceMemory();
  res.json({ message: 'Reset fee service memory successfully' });
});

// 2. HTTP Keep-Alive Agent để duy trì kết nối TCP với Ngân hàng (Tối đa 20 sockets)
export const bankHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 20,
  maxFreeSockets: 20,
  keepAliveMsecs: 10000,
});

// 3. Endpoint: Xem công nợ sinh viên (GET /students/:id/fees)
app.get('/students/:id/fees', (req: Request, res: Response) => {
  const studentId = Number(req.params.id);
  const student = students[studentId];

  if (!student) {
    return res.status(404).json({ error: 'Không tìm thấy sinh viên' });
  }

  return res.json({
    studentId: student.id,
    debt: student.debt,
  });
});

interface BankResponse {
  statusCode: number;
  data: any;
}

function sendChargeRequest(
  urlStr: string,
  paymentId: string,
  amount: number,
  timeoutMs: number
): Promise<BankResponse> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const postData = JSON.stringify({
      reference: paymentId,
      amount: amount,
    });

    const req = http.request(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: '/charges',
        method: 'POST',
        agent: bankHttpAgent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'Idempotency-Key': paymentId, // Khóa Idempotency không đổi khi thử lại
        },
        timeout: timeoutMs,
      },
      (res) => {
        let responseBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          responseBody += chunk;
        });
        res.on('end', () => {
          let parsedData: any = {};
          try {
            parsedData = JSON.parse(responseBody);
          } catch {
            parsedData = { raw: responseBody };
          }
          resolve({
            statusCode: res.statusCode || 500,
            data: parsedData,
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('REQUEST_TIMEOUT'));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

// 4. Endpoint: Thanh toán học phí (POST /students/:id/payments)
app.post('/students/:id/payments', async (req: Request, res: Response) => {
  const startTime = Date.now();
  const studentId = Number(req.params.id);
  const { amount } = req.body;
  const currentBankUrl = process.env.BANK_URL || BANK_URL;

  // Kiểm tra sinh viên
  const student = students[studentId];
  if (!student) {
    return res.status(404).json({ error: 'Không tìm thấy sinh viên' });
  }

  // Kiểm tra số tiền hợp lệ
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'Số tiền thanh toán không hợp lệ' });
  }

  if (amount > student.debt) {
    return res.status(400).json({
      error: 'Số tiền thanh toán vượt quá công nợ hiện tại',
      currentDebt: student.debt,
    });
  }

  paymentCounter++;
  const paymentId = `P${paymentCounter}`;

  const MAX_TOTAL_TIME = 4000;
  const MAX_ATTEMPTS = 3;

  let lastError: any = null;
  let lastStatusCode = 0;
  let bankResult: any = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const elapsed = Date.now() - startTime;
    const remainingTime = MAX_TOTAL_TIME - elapsed;

    if (remainingTime < 500) {
      break;
    }
    const attemptTimeout = Math.min(3800, remainingTime);

    try {
      const response = await sendChargeRequest(
        currentBankUrl,
        paymentId,
        amount,
        attemptTimeout
      );

      lastStatusCode = response.statusCode;
      bankResult = response.data;

      if (lastStatusCode === 201) {
        student.debt -= amount;
        return res.status(201).json({
          paymentId,
          status: 'PAID',
          amount,
          remainingDebt: student.debt,
          chargeId: bankResult.chargeId,
        });
      }

      if (lastStatusCode === 400 || lastStatusCode === 402) {
        return res.status(lastStatusCode).json({
          error: bankResult.error || 'Ngân hàng từ chối giao dịch',
          paymentId,
          status: 'FAILED',
        });
      }

      // Lỗi máy chủ ngân hàng tạm thời (500): thử lại ở vòng lặp sau
      console.log(`[FeeService] Lần ${attempt} nhận mã lỗi ${lastStatusCode} từ Ngân hàng, đang thử lại...`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (err: any) {
      lastError = err;

      if (err.code === 'ECONNREFUSED') {
        return res.status(503).json({
          error: 'Không thể kết nối tới cổng ngân hàng (Ngân hàng chưa khởi động hoặc gặp sự cố)',
          paymentId,
          status: 'FAILED',
        });
      }

      console.log(`[FeeService] Lần ${attempt} gặp lỗi mạng (${err.message}), đang thử lại với Idempotency-Key=${paymentId}...`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  if (lastError && lastError.code === 'ECONNREFUSED') {
    return res.status(503).json({
      error: 'Không thể kết nối tới ngân hàng',
      paymentId,
      status: 'FAILED',
    });
  }

  // Công nợ ko giảm
  return res.status(504).json({
    error: 'Hết thời gian chờ hoặc kết nối bị gián đoạn khi đang chờ phản hồi từ ngân hàng',
    paymentId,
    status: 'PENDING',
  });
});

const server = http.createServer(app);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`=== FEE SERVICE ĐANG CHẠY TRÊN CỔNG ${PORT} ===`);
    console.log(`Kết nối ngân hàng: ${BANK_URL}`);
  });
}

export { app, server };
