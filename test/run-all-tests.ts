import { runScenario1 } from './test-scenario-1';
import { runScenario2 } from './test-scenario-2';
import { runScenario3 } from './test-scenario-3';
import { runScenario4 } from './test-scenario-4';

async function main() {
  const startTotal = Date.now();

  try {
    await runScenario1();
    await new Promise((r) => setTimeout(r, 500));

    await runScenario2();
    await new Promise((r) => setTimeout(r, 500));

    await runScenario3();
    await new Promise((r) => setTimeout(r, 500));

    await runScenario4();

    const totalTime = ((Date.now() - startTotal) / 1000).toFixed(2);
    console.log('\n============================================================');
    console.log(`🎉 TẤT CẢ 4 TÌNH HUỐNG ĐỀU ĐẠT 100% TIÊU CHÍ ĐỀ BÀI YÊU CẦU!`);
    console.log(`⏱️ Tổng thời gian chạy toàn bộ kiểm thử: ${totalTime}s`);
    console.log('============================================================\n');
    process.exit(0);
  } catch (err: any) {
    console.error('\n❌ BỘ TEST GẶP LỖI:', err.message || err);
    process.exit(1);
  }
}

main();
