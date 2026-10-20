import http from 'node:http';
import { server as feeServerInstance, resetFeeServiceMemory } from '../src/fee-service';
import { server as bankServerInstance } from '../src/bank';

async function request(url: string, options: { method?: string; headers?: Record<string, string>; body?: any } = {}) {
  const parsed = new URL(url);
  const postData = options.body ? JSON.stringify(options.body) : undefined;

  return new Promise<{ statusCode: number; data: any; timeMs: number }>((resolve, reject) => {
    const start = Date.now();
    const req = http.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers: {
          ...(postData ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } : {}),
          ...options.headers,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let data: any = body;
          try {
            data = JSON.parse(body);
          } catch {}
          resolve({ statusCode: res.statusCode || 0, data, timeMs: Date.now() - start });
        });
      }
    );
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

export async function runScenario2() {
  console.log('\n======================================================');
  console.log('--- BẮT ĐẦU TEST TÌNH HUỐNG 2: NGÂN HÀNG PHẢN HỒI RẤT CHẬM ---');
  console.log('======================================================');

  resetFeeServiceMemory();

  // Thiết lập biến môi trường DELAY_MS = 5000 (5 giây)
  process.env.DELAY_MS = '5000';

  feeServerInstance.listen(4001);
  bankServerInstance.listen(4002);
  await new Promise((r) => setTimeout(r, 200));

  // Reset bộ nhớ Bank để xóa các khóa idempotency từ test trước
  await request('http://localhost:4002/reset', { method: 'POST' });

  try {
    // Bước 1: Gọi 1 thanh toán đơn lẻ và đo thời gian
    console.log('[Bước 1] Gửi 1 thanh toán trong khi Ngân hàng trễ 5 giây (DELAY_MS=5000)...');
    const payRes = await request('http://localhost:4001/students/1/payments', {
      method: 'POST',
      body: { amount: 100000 },
    });

    console.log(`-> Kết quả thanh toán: HTTP ${payRes.statusCode}, Thời gian phản hồi: ${payRes.timeMs}ms`);
    console.log(`-> Phản hồi:`, payRes.data);

    if (payRes.statusCode !== 504) {
      throw new Error(`Kỳ vọng HTTP 504 nhưng nhận được ${payRes.statusCode}`);
    }
    if (payRes.data.status !== 'PENDING') {
      throw new Error(`Kỳ vọng status "PENDING" nhưng nhận được "${payRes.data.status}"`);
    }
    if (payRes.timeMs > 4500) {
      throw new Error(`Thời gian phản hồi (${payRes.timeMs}ms) vượt quá giới hạn 4.5 giây (4500ms)`);
    }
    console.log('=> ĐẠT: Thanh toán trả 504 PENDING đúng hạn (≤ 4.5s)!');

    // Bước 2: Bắn cùng lúc 20 thanh toán và trong lúc đó gọi GET /students/1/fees
    console.log('\n[Bước 2] Bắn cùng lúc 20 thanh toán và đồng thời gọi GET /students/1/fees...');

    // Khởi chạy 20 thanh toán đồng thời (không await ngay)
    const paymentPromises = Array.from({ length: 20 }, (_, i) =>
      request('http://localhost:4001/students/1/payments', {
        method: 'POST',
        body: { amount: 1000 },
      })
    );

    // Đợi 200ms để 20 requests đều đã gửi đi và đang chờ ngân hàng
    await new Promise((r) => setTimeout(r, 200));

    // Gọi GET fees
    console.log('-> Đo thời gian gọi GET /students/1/fees trong lúc 20 thanh toán đang treo...');
    const feeCheck = await request('http://localhost:4001/students/1/fees');
    console.log(`-> Kết quả GET fees: HTTP ${feeCheck.statusCode}, Thời gian: ${feeCheck.timeMs}ms`);

    if (feeCheck.statusCode !== 200) {
      throw new Error(`GET fees không trả 200`);
    }
    if (feeCheck.timeMs >= 300) {
      throw new Error(`GET fees mất ${feeCheck.timeMs}ms, vượt quá yêu cầu < 300ms!`);
    }
    console.log(`=> ĐẠT: GET /students/1/fees phản hồi chỉ trong ${feeCheck.timeMs}ms (< 300ms)!`);

    // Chờ 20 payments hoàn tất để dọn dẹp
    console.log('-> Chờ 20 requests thanh toán hoàn tất...');
    const results = await Promise.all(paymentPromises);
    const allPending = results.every((r) => r.statusCode === 504 && r.data.status === 'PENDING');
    const maxTime = Math.max(...results.map((r) => r.timeMs));
    console.log(`-> Cả 20 requests đều trả 504 PENDING: ${allPending}. Thời gian lớn nhất: ${maxTime}ms`);

    if (!allPending || maxTime > 4500) {
      throw new Error('Các request 20 payments không đạt chuẩn ≤ 4.5s hoặc không trả 504 PENDING');
    }

    console.log('\n>>> KẾT LUẬN: TÌNH HUỐNG 2 ĐÃ VƯỢT QUA TẤT CẢ TIÊU CHÍ! <<<\n');
  } finally {
    // Reset DELAY_MS
    process.env.DELAY_MS = '0';
    feeServerInstance.close();
    bankServerInstance.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

if (require.main === module) {
  runScenario2().catch((err) => {
    console.error('Test thất bại:', err);
    process.exit(1);
  });
}
