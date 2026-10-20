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

export async function runScenario3() {
  console.log('\n======================================================');
  console.log('--- BẮT ĐẦU TEST TÌNH HUỐNG 3: DUY TRÌ KẾT NỐI (KEEP-ALIVE) ---');
  console.log('======================================================');

  resetFeeServiceMemory();
  process.env.DELAY_MS = '0';
  process.env.FAIL_RATE = '0';
  process.env.DROP_RATE = '0';

  feeServerInstance.listen(4001);
  bankServerInstance.listen(4002);
  await new Promise((r) => setTimeout(r, 200));

  // Reset stats của Bank
  await request('http://localhost:4002/reset', { method: 'POST' });

  try {
    console.log('[Bước 1] Gửi 200 thanh toán (mỗi lần 1.000đ), tối đa 10 yêu cầu đồng thời...');
    const startTime = Date.now();

    const TOTAL_REQUESTS = 200;
    const CONCURRENCY = 10;
    let successCount = 0;
    let failedCount = 0;

    // Chạy với hàng đợi 10 workers đồng thời
    let currentIndex = 0;
    async function worker() {
      while (currentIndex < TOTAL_REQUESTS) {
        currentIndex++;
        try {
          const res = await request('http://localhost:4001/students/1/payments', {
            method: 'POST',
            body: { amount: 1000 },
          });
          if (res.statusCode === 201 && res.data.status === 'PAID') {
            successCount++;
          } else {
            failedCount++;
          }
        } catch {
          failedCount++;
        }
      }
    }

    const workers = Array.from({ length: CONCURRENCY }, () => worker());
    await Promise.all(workers);
    const duration = Date.now() - startTime;

    console.log(`-> Hoàn tất 200 thanh toán trong: ${duration}ms`);
    console.log(`-> Số giao dịch thành công: ${successCount}/${TOTAL_REQUESTS}, thất bại: ${failedCount}`);

    // Kiểm tra /stats từ ngân hàng
    const statsRes = await request('http://localhost:4002/stats');
    console.log('-> Ngân hàng /stats:', statsRes.data);

    if (successCount !== 200) {
      throw new Error(`Kỳ vọng 200/200 thành công nhưng chỉ có ${successCount}`);
    }

    const tcpConnections = statsRes.data.connections;
    console.log(`-> Số kết nối TCP ngân hàng đã mở: ${tcpConnections}`);
    if (tcpConnections > 20) {
      throw new Error(`Số kết nối TCP (${tcpConnections}) vượt quá giới hạn cho phép (≤ 20)`);
    }
    console.log('=> ĐẠT: 200/200 thanh toán thành công và số kết nối TCP ≤ 20 (Nhờ HTTP Keep-Alive)!');

    // Bước 2: Thử nghiệm nhàn rỗi 6 giây (quá thời hạn keepAliveTimeout 5 giây của ngân hàng)
    console.log('\n[Bước 2] Chờ nhàn rỗi 6.5 giây để ngân hàng chủ động đóng các kết nối cũ...');
    await new Promise((r) => setTimeout(r, 6500));

    console.log('-> Gửi tiếp 5 yêu cầu thanh toán mới sau khi kết nối cũ đã bị đóng...');
    let idleSuccessCount = 0;
    for (let i = 1; i <= 5; i++) {
      const res = await request('http://localhost:4001/students/1/payments', {
        method: 'POST',
        body: { amount: 1000 },
      });
      if (res.statusCode === 201 && res.data.status === 'PAID') {
        idleSuccessCount++;
      }
    }
    console.log(`-> Số yêu cầu thành công sau khi nhàn rỗi: ${idleSuccessCount}/5`);

    if (idleSuccessCount !== 5) {
      throw new Error(`Kỳ vọng 5/5 yêu cầu thành công sau khi nhàn rỗi nhưng chỉ đạt ${idleSuccessCount}`);
    }
    console.log('=> ĐẠT: Hệ thống tự động tạo lại kết nối mới sau khi socket cũ đóng!');

    console.log('\n>>> KẾT LUẬN: TÌNH HUỐNG 3 ĐÃ VƯỢT QUA TẤT CẢ TIÊU CHÍ! <<<\n');
  } finally {
    feeServerInstance.close();
    bankServerInstance.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

if (require.main === module) {
  runScenario3().catch((err) => {
    console.error('Test thất bại:', err);
    process.exit(1);
  });
}
