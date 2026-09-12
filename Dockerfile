# Build and run R2NETTE.
#
# One image, several roles. The web process and the workers share the same
# code and the same migrations, so a deploy can never leave a worker running
# against a schema it does not understand.

FROM node:22-slim AS base
WORKDIR /app
# openssl: Prisma needs it. postgresql-client: the backup job runs pg_dump.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl postgresql-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

FROM deps AS build
COPY . .
RUN npx prisma generate && npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY package*.json ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts
COPY web ./web
COPY tsconfig.json vite.config.ts ./

# Never run as root.
RUN useradd --system --uid 10001 r2nette && chown -R r2nette:r2nette /app
USER r2nette

EXPOSE 3000
# Liveness only — this must not touch the database, so a Postgres blip does
# not cause the orchestrator to restart a healthy process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
