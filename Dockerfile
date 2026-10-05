# Build and run R2NETTE.
#
# One image, several roles. The web process and the workers share the same
# code and the same migrations, so a deploy can never leave a worker running
# against a schema it does not understand.

FROM node:22-slim AS base
WORKDIR /app
# openssl: Prisma needs it. postgresql-client-16: the backup job runs pg_dump
# against the postgres:16 server, and pg_dump refuses a server newer than
# itself. Debian's own postgresql-client is 15 on bookworm (node:22-slim), so
# the client comes from the PostgreSQL project's repository (PGDG) for
# whichever Debian release the base image is on. curl only fetches the key.
RUN set -eu \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl openssl \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/keyrings/postgresql-pgdg.asc \
 && . /etc/os-release \
 && echo "deb [signed-by=/usr/share/keyrings/postgresql-pgdg.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

FROM deps AS build
COPY . .
RUN npx prisma generate && npm run build

FROM base AS runtime
ARG GIT_SHA=unknown
ENV NODE_ENV=production
ENV R2NETTE_GIT_SHA=${GIT_SHA}
LABEL org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.source="https://github.com/takatakca/r2neet" \
      org.opencontainers.image.title="r2nette"
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
