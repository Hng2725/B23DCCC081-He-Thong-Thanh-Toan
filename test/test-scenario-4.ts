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

export async function runScenario4() {
  console.log('\n======================================================');
  console.log('--- BẮT ĐẦU TEST TÌNH HUỐNG 4: ĐỨT GIỮA CHỪNG, LỖI TẠM THỜI, TỪ CHỐI ---');
  console.log('======================================================');

  resetFeeServiceMemory();

  feeServerInstance.listen(4001);
  bankServerInstance.listen(4002);
  await new Promise((r) => setTimeout(r, 200));

  try {
    // -------------------------------------------------------------------------
    // Phần (a): DROP_RATE = 0.3 (Trừ tiền xong rồi cắt kết nối)
    // -------------------------------------------------------------------------
    console.log('\n--- PHẦN (a): DROP_RATE = 0.3 (Ngân hàng trừ tiền xong ngắt kết nối) ---');
    process.env.DROP_RATE = '0.3';
    process.env.FAIL_RATE = '0';
    process.env.DELAY_MS = '0';

    await request('http://localhost:4002/reset', { method: 'POST' });
    resetFeeServiceMemory();

    const feeBeforeA = await request('http://localhost:4001/students/1/fees');
    const initialDebtA = feeBeforeA.data.debt;

    console.log(`-> Công nợ ban đầu sinh viên 1: ${initialDebtA.toLocaleString()}đ`);
    console.log('-> Gửi 60 thanh toán lần lượt (mỗi lần 1.000đ)...');

    let paidCountA = 0;
    let pendingCountA = 0;
    const TOTAL_TESTS = 60;

    for (let i = 1; i <= TOTAL_TESTS; i++) {
      const res = await request('http://localhost:4001/students/1/payments', {
        method: 'POST',
        body: { amount: 1000 },
      });

      if (res.statusCode === 201 && res.data.status === 'PAID') {
        paidCountA++;
      } else if (res.statusCode === 504 && res.data.status === 'PENDING') {
        pendingCountA++;
      }
    }

    const statsA = (await request('http://localhost:4002/stats')).data;
    const feeAfterA = (await request('http://localhost:4001/students/1/fees')).data;
    const expectedDebtA = initialDebtA - paidCountA * 1000;

    console.log(`-> Kết quả phần (a):`);
    console.log(`   + Số lệnh PAID: ${paidCountA}/${TOTAL_TESTS}`);
    console.log(`   + Số lệnh PENDING: ${pendingCountA}/${TOTAL_TESTS}`);
    console.log(`   + Bank stats: charges=${statsA.charges}, duplicates=${statsA.duplicates}`);
    console.log(`   + Công nợ thực tế: ${feeAfterA.debt.toLocaleString()}đ (Kỳ vọng: ${expectedDebtA.toLocaleString()}đ)`);

    if (statsA.duplicates !== 0) {
      throw new Error(`Phát hiện trừ tiền trùng! duplicates = ${statsA.duplicates} (kỳ vọng phải = 0)`);
    }
    if (paidCountA < 54) {
      throw new Error(`Số thanh toán thành công (${paidCountA}) < 54/60 yêu cầu`);
    }
    if (feeAfterA.debt !== expectedDebtA) {
      throw new Error(`Công nợ giảm không khớp với số lệnh PAID!`);
    }
    console.log('=> ĐẠT PHẦN (a): duplicates = 0, thành công ≥ 54/60, công nợ giảm chính xác!');

    // -------------------------------------------------------------------------
    // Phần (b): FAIL_RATE = 0.3 (Lỗi 500 tạm thời trước khi trừ tiền)
    // -------------------------------------------------------------------------
    console.log('\n--- PHẦN (b): FAIL_RATE = 0.3 (Ngân hàng trả lỗi 500 trước khi trừ tiền) ---');
    process.env.DROP_RATE = '0';
    process.env.FAIL_RATE = '0.3';
    process.env.DELAY_MS = '0';

    await request('http://localhost:4002/reset', { method: 'POST' });

    console.log('-> Gửi 60 thanh toán lần lượt (mỗi lần 1.000đ)...');
    let paidCountB = 0;

    for (let i = 1; i <= TOTAL_TESTS; i++) {
      const res = await request('http://localhost:4001/students/1/payments', {
        method: 'POST',
        body: { amount: 1000 },
      });

      if (res.statusCode === 201 && res.data.status === 'PAID') {
        paidCountB++;
      }
    }

    const statsB = (await request('http://localhost:4002/stats')).data;
    console.log(`-> Kết quả phần (b):`);
    console.log(`   + Số lệnh PAID: ${paidCountB}/${TOTAL_TESTS}`);
    console.log(`   + Bank stats: charges=${statsB.charges}, duplicates=${statsB.duplicates}`);

    if (statsB.duplicates !== 0) {
      throw new Error(`Phần (b): duplicates = ${statsB.duplicates} (kỳ vọng = 0)`);
    }
    if (paidCountB < 54) {
      throw new Error(`Phần (b): Số thanh toán thành công (${paidCountB}) < 54/60`);
    }
    console.log('=> ĐẠT PHẦN (b): duplicates = 0, thành công ≥ 54/60 không bị trừ tiền 2 lần!');

    // -------------------------------------------------------------------------
    // Phần (c): Thanh toán 25.000.000đ (Vượt hạn mức ngân hàng 20.000.000đ)
    // -------------------------------------------------------------------------
    console.log('\n--- PHẦN (c): Thanh toán 25.000.000đ (Vượt hạn mức ngân hàng) ---');
    process.env.DROP_RATE = '0';
    process.env.FAIL_RATE = '0';

    await request('http://localhost:4002/reset', { method: 'POST' });

    const requestsBeforeC = (await request('http://localhost:4002/stats')).data.requests;
    console.log(`-> Số requests ngân hàng trước khi gọi: ${requestsBeforeC}`);

    const resC = await request('http://localhost:4001/students/1/payments', {
      method: 'POST',
      body: { amount: 25000000 },
    });

    const requestsAfterC = (await request('http://localhost:4002/stats')).data.requests;
    console.log(`-> Kết quả thanh toán: HTTP ${resC.statusCode}, Phản hồi:`, resC.data);
    console.log(`-> Số requests ngân hàng sau khi gọi: ${requestsAfterC} (Tăng thêm: ${requestsAfterC - requestsBeforeC})`);

    if (resC.statusCode !== 402) {
      throw new Error(`Kỳ vọng HTTP 402 từ chối nhưng nhận được ${resC.statusCode}`);
    }
    if (resC.data.status !== 'FAILED') {
      throw new Error(`Kỳ vọng status "FAILED" nhưng nhận được "${resC.data.status}"`);
    }
    if (requestsAfterC - requestsBeforeC !== 1) {
      throw new Error(`Ngân hàng nhận ${requestsAfterC - requestsBeforeC} yêu cầu, kỳ vọng chỉ đúng 1 yêu cầu (không retry)!`);
    }
    console.log('=> ĐẠT PHẦN (c): Trả 402 FAILED, ngân hàng chỉ nhận đúng 1 yêu cầu duy nhất!');

    console.log('\n>>> KẾT LUẬN: TÌNH HUỐNG 4 ĐÃ VƯỢT QUA TẤT CẢ TIÊU CHÍ! <<<\n');
  } finally {
    process.env.DROP_RATE = '0';
    process.env.FAIL_RATE = '0';
    feeServerInstance.close();
    bankServerInstance.close();
    await new Promise((r) => setTimeout(r, 200));
  }
}

if (require.main === module) {
  runScenario4().catch((err) => {
    console.error('Test thất bại:', err);
    process.exit(1);
  });
}
