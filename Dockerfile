# Shared image for api and bot (TypeScript runs via tsx; no build step needed for the MVP).
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/bot/package.json apps/bot/
COPY apps/miniapp/package.json apps/miniapp/
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/bot apps/bot
ENV NODE_ENV=production

FROM base AS api
WORKDIR /app/apps/api
EXPOSE 3000
# exec: the server becomes PID 1's child process directly and receives SIGTERM (graceful shutdown).
CMD ["sh", "-c", "npx tsx src/db/migrate.ts && npx tsx src/db/seed.ts && exec npx tsx src/server.ts"]

FROM base AS bot
WORKDIR /app/apps/bot
CMD ["npx", "tsx", "src/index.ts"]

# Demo (docker-compose.demo.yml): the real API with demo data, deterministic AI from fixtures, no Telegram
# and no keys. Never use it for a real deployment.
FROM base AS demo
WORKDIR /app/apps/api
ENV NODE_ENV=development
EXPOSE 3000
CMD ["sh", "-c", "npx tsx src/db/migrate.ts && npx tsx src/db/seed.ts && npx tsx test/dev-seed-catalog.ts && exec npx tsx test/dev-mock-server.ts"]
