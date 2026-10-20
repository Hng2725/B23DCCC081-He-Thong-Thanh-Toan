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

export async function runScenario1() {
  console.log('\n======================================================');
  console.log('--- BẮT ĐẦU TEST TÌNH HUỐNG 1: NGÂN HÀNG CHƯA BẬT / BẬT LẠI ---');
  console.log('======================================================');

  resetFeeServiceMemory();

  // 1. Khởi động Fee Service (Cổng 4001), Ngân hàng đang TẮT
  feeServerInstance.listen(4001);
  await new Promise((r) => setTimeout(r, 200));

  let bankStarted = false;

  try {
    // Bước 1: Khi ngân hàng tắt, gọi thanh toán
    console.log('[Bước 1] Gọi thanh toán khi Ngân hàng đang TẮT...');
    const pay1 = await request('http://localhost:4001/students/1/payments', {
      method: 'POST',
      body: { amount: 100000 },
    });

    console.log(`-> Kết quả thanh toán: HTTP ${pay1.statusCode}, Thời gian: ${pay1.timeMs}ms`);
    console.log(`-> Phản hồi:`, pay1.data);

    if (pay1.statusCode !== 503) {
      throw new Error(`Kỳ vọng HTTP 503 nhưng nhận được ${pay1.statusCode}`);
    }
    if (pay1.timeMs >= 1500) {
      throw new Error(`Thời gian phản hồi (${pay1.timeMs}ms) vượt quá giới hạn 1500ms`);
    }
    if (!pay1.data.error || pay1.data.status !== 'FAILED') {
      throw new Error(`Body phản hồi không đúng cấu trúc { error, paymentId, status: "FAILED" }`);
    }
    console.log('=> ĐẠT: Trả về 503 FAILED trong < 1.5s đúng yêu cầu!');

    // Bước 2: Kiểm tra Fee Service còn sống không, xem công nợ
    console.log('\n[Bước 2] Kiểm tra xem công nợ GET /students/1/fees...');
    const feeCheck = await request('http://localhost:4001/students/1/fees');
    console.log(`-> Kết quả: HTTP ${feeCheck.statusCode}, Thời gian: ${feeCheck.timeMs}ms, Dữ liệu:`, feeCheck.data);

    if (feeCheck.statusCode !== 200 || feeCheck.data.debt !== 50000000) {
      throw new Error('Fee Service không trả 200 hoặc công nợ bị sai');
    }
    console.log('=> ĐẠT: Fee Service vẫn hoạt động bình thường, xem công nợ nhanh!');

    // Bước 3: Bật ngân hàng lên (Cổng 4002) - KHÔNG khởi động lại Fee Service
    console.log('\n[Bước 3] Khởi động Ngân hàng (Cổng 4002), KHÔNG restart Fee Service...');
    bankServerInstance.listen(4002);
    bankStarted = true;
    await new Promise((r) => setTimeout(r, 200));

    // Gọi lại thanh toán
    console.log('-> Gọi lại thanh toán POST /students/1/payments...');
    const pay2 = await request('http://localhost:4001/students/1/payments', {
      method: 'POST',
      body: { amount: 100000 },
    });

    console.log(`-> Kết quả: HTTP ${pay2.statusCode}, Thời gian: ${pay2.timeMs}ms, Phản hồi:`, pay2.data);
    if (pay2.statusCode !== 201 || pay2.data.status !== 'PAID') {
      throw new Error(`Kỳ vọng HTTP 201 PAID nhưng nhận được ${pay2.statusCode}`);
    }

    // Kiểm tra công nợ đã giảm 100.000đ chưa
    const feeAfter = await request('http://localhost:4001/students/1/fees');
    if (feeAfter.data.debt !== 49900000) {
      throw new Error(`Công nợ chưa giảm đúng: hiện tại là ${feeAfter.data.debt}`);
    }
    console.log('=> ĐẠT: Khi Ngân hàng hoạt động lại, thanh toán lập tức thành công (201 PAID), công nợ giảm!');

    console.log('\n>>> KẾT LUẬN: TÌNH HUỐNG 1 ĐÃ VƯỢT QUA TẤT CẢ TIÊU CHÍ! <<<\n');
  } finally {
    feeServerInstance.close();
    if (bankStarted) bankServerInstance.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

if (require.main === module) {
  runScenario1().catch((err) => {
    console.error('Test thất bại:', err);
    process.exit(1);
  });
}
