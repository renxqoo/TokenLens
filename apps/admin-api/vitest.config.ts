import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 根 .env 载入测试环境（进程已有同名变量时不覆盖）：DB/Redis 连接与生产同源，
// 测试不再依赖「手工 source .env」仪式
const rootEnv = (() => {
  try {
    const raw = readFileSync(fileURLToPath(new URL('../../.env', import.meta.url)), 'utf8');
    return Object.fromEntries(
      raw
        .split('\n')
        .filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line))
        .map((line) => {
          const eq = line.indexOf('=');
          return [line.slice(0, eq), line.slice(eq + 1).trim()];
        }),
    );
  } catch {
    return {};
  }
})();

export default defineConfig({
  test: {
    // 集成套件共享单实例 PG：文件级串行换确定性（用户/订单清理互不踩踏）
    fileParallelism: false,
    // DB 集成单测：CI 慢机满载下往返时延放大，超时对齐 wallet 包 15s 约定
    testTimeout: 15_000,
    // E2E（真服务进程）走独立通道 test:e2e
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e-*.test.ts'],
    env: rootEnv,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 入口/装配（进程编排，E2E 通道覆盖）、env 解析与测试基建不计入产品覆盖率
      exclude: ['src/index.ts', 'src/assembly.ts', 'src/app.ts', 'src/shutdown.ts', 'src/config.ts', 'src/__tests__/**'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
