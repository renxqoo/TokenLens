# syntax=docker/dockerfile:1
# client（端用户面板，Next.js standalone 输出）
# 构建段：全 bun（bun install + bun x next build）；运行段：bun 跑 standalone server
FROM oven/bun:1.4-alpine AS builder
WORKDIR /repo
COPY package.json bun.lock tsconfig.base.json tsconfig.next.json ./
COPY apps/client ./apps/client
COPY apps/admin ./apps/admin
COPY packages ./packages
RUN bun install --frozen-lockfile
RUN bun run --filter "@ai-gateway/client..." build

FROM oven/bun:1.4-alpine AS runtime
ENV NODE_ENV=production
# Next standalone 标准配方：Docker 的 HOSTNAME(=容器ID) 会劫持绑定地址；PORT 缺省 3000
ENV HOSTNAME=0.0.0.0 PORT=3001
WORKDIR /app
# standalone 输出结构与项目目录一致（apps/client/server.js）
COPY --from=builder /repo/apps/client/.next/standalone ./
COPY --from=builder /repo/apps/client/.next/static ./apps/client/.next/static
# 无 public 目录（无静态资源）；将来添加时恢复 COPY --from=builder /repo/apps/client/public ./apps/client/public
EXPOSE 3001
CMD ["bun", "apps/client/server.js"]
