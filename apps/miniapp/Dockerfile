FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/miniapp apps/miniapp
RUN pnpm install --frozen-lockfile --filter "@ishonch/miniapp..."
ARG VITE_OFFER_URL
ARG VITE_PRIVACY_URL
ARG VITE_PROHIBITED_URL
ENV VITE_OFFER_URL=$VITE_OFFER_URL VITE_PRIVACY_URL=$VITE_PRIVACY_URL VITE_PROHIBITED_URL=$VITE_PROHIBITED_URL
RUN pnpm --filter @ishonch/miniapp build

FROM nginx:1.27-alpine
COPY apps/miniapp/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/miniapp/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/apps/miniapp/dist /usr/share/nginx/html
