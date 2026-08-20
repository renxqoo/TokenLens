import { describe, expect, it } from 'vitest';

/**
 * 密钥强度回归测试（B3/C-1）：.env.example 占位值必须被拒，
 * 防止照抄部署 → JWT 可伪造 + 渠道 Key 可解密。
 */

describe('core env — 弱密钥拒绝', () => {
  it('change-me-32-chars-minimum-secret 必须被拒绝', async () => {
    const { loadAdminApiEnv, loadClientApiEnv, loadGatewayEnv } =
      await import('../../src/env.js');
    expect(() =>
      loadAdminApiEnv({
        DATABASE_URL: 'postgres://x',
        REDIS_URL: 'redis://x',
        ADMIN_JWT_SECRET: 'change-me-32-chars-minimum-secret',
        ENCRYPTION_KEY: 'a-strong-encryption-key-32-chars-min!!',
      }),
    ).toThrow(/占位|弱密钥/);

    expect(() =>
      loadClientApiEnv({
        DATABASE_URL: 'postgres://x',
        REDIS_URL: 'redis://x',
        JWT_SECRET: 'change-me-32-chars-minimum-secret',
        ENCRYPTION_KEY: 'a-strong-encryption-key-32-chars-min!!',
      }),
    ).toThrow(/占位|弱密钥/);

    expect(() =>
      loadGatewayEnv({
        DATABASE_URL: 'postgres://x',
        REDIS_URL: 'redis://x',
        JWT_SECRET: 'change-me-32-chars-minimum-secret',
        ENCRYPTION_KEY: 'change-me-32-chars-minimum-secret',
      }),
    ).toThrow(/占位|弱密钥/);
  });

  it('合法强密钥应通过', async () => {
    const { loadAdminApiEnv, loadClientApiEnv } = await import('../../src/env.js');
    const adminEnv = loadAdminApiEnv({
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://x',
      ADMIN_JWT_SECRET: 'a-strong-admin-jwt-secret-for-testing-9k2m',
      ENCRYPTION_KEY: 'a-strong-encryption-key-32-chars-min!!',
    });
    expect(adminEnv.ADMIN_JWT_SECRET).toBe('a-strong-admin-jwt-secret-for-testing-9k2m');

    const clientEnv = loadClientApiEnv({
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://x',
      JWT_SECRET: 'a-strong-jwt-secret-for-testing-only-7f3a',
      ENCRYPTION_KEY: 'a-strong-encryption-key-32-chars-min!!',
    });
    expect(clientEnv.JWT_SECRET).toBe('a-strong-jwt-secret-for-testing-only-7f3a');
  });

  it('GLOBAL_RPM 生产环境强制硬上限 5000', async () => {
    const { loadGatewayEnv } = await import('../../src/env.js');
    const env = loadGatewayEnv({
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://x',
      NODE_ENV: 'production',
      GLOBAL_RPM: '200000',
      JWT_SECRET: 'a-strong-jwt-secret-for-testing-only-7f3a',
      ENCRYPTION_KEY: 'a-strong-encryption-key-32-chars-min!!',
    });
    expect(env.GLOBAL_RPM).toBe(5000);

    const devEnv = loadGatewayEnv({
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://x',
      NODE_ENV: 'development',
      GLOBAL_RPM: '200000',
      JWT_SECRET: 'a-strong-jwt-secret-for-testing-only-7f3a',
      ENCRYPTION_KEY: 'a-strong-encryption-key-32-chars-min!!',
    });
    expect(devEnv.GLOBAL_RPM).toBe(200000);
  });
});
