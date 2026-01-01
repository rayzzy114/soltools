##
## Multi-stage build for Next.js (App Router) + pnpm + Prisma
##

FROM node:24-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# Needed by some deps (e.g. for native modules if any appear in future)
RUN apk add --no-cache libc6-compat openssl

FROM base AS deps
RUN apk add --no-cache python3 make g++ linux-headers libusb-dev eudev-dev
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV HUSKY=0
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM base AS builder
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
ARG DATABASE_URL
ARG RPC
ARG NEXT_PUBLIC_SOLANA_NETWORK
ENV DATABASE_URL=$DATABASE_URL
ENV RPC=$RPC
ENV NEXT_PUBLIC_SOLANA_NETWORK=$NEXT_PUBLIC_SOLANA_NETWORK

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build (includes prisma generate by package.json script)
RUN pnpm build

FROM base AS runner

# run as non-root
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

WORKDIR /app

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.mjs ./next.config.mjs

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT||3000) + '/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/entrypoint.sh"]
CMD ["pnpm", "start"]


