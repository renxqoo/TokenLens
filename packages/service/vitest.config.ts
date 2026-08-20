import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // DB 集成单测：CI 慢机满载下往返时延放大，超时对齐 wallet 包 15s 约定
    testTimeout: 15_000,
  },
});
