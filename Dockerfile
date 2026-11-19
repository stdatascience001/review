# Website Review & Task Management — production image (API + dashboard + widget, one origin).
#
#   docker build -t wrtm .
#   docker run --env-file backend/.env.production -p 4000:4000 -v wrtm-uploads:/data wrtm
#
# Migrations: set RUN_MIGRATIONS=true (uses MIGRATION_DATABASE_URL if set, else DATABASE_URL),
# or run `docker run … wrtm npx prisma migrate deploy` once per release.

# ── build ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
RUN apk add --no-cache openssl && corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY widget/package.json widget/
RUN pnpm install --frozen-lockfile
COPY . .
# Same-origin deployment: the dashboard calls the API at /api/v1.
ENV VITE_API_URL=/api/v1
RUN pnpm --filter @wrtm/backend exec prisma generate \
 && pnpm --filter @wrtm/widget build \
 && pnpm --filter @wrtm/frontend build \
 && pnpm --filter @wrtm/backend build
# Production dependencies only (prisma CLI included for migrations).
RUN pnpm --filter @wrtm/backend deploy --prod --legacy /out/backend \
 && cd /out/backend && npx prisma generate

# ── runtime ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
RUN apk add --no-cache openssl tini && addgroup -S app && adduser -S app -G app \
 && mkdir -p /data/uploads && chown -R app:app /data
ENV NODE_ENV=production \
    PORT=4000 \
    FRONTEND_DIST_DIR=/app/frontend/dist \
    WIDGET_DIST_DIR=/app/widget/dist \
    UPLOAD_DIR=/data/uploads
WORKDIR /app/backend
COPY --from=build --chown=app:app /out/backend ./
COPY --from=build --chown=app:app /app/backend/dist ./dist
COPY --from=build --chown=app:app /app/backend/prisma ./prisma
COPY --from=build --chown=app:app /app/frontend/dist /app/frontend/dist
COPY --from=build --chown=app:app /app/widget/dist /app/widget/dist
USER app
VOLUME ["/data"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:4000/api/v1/health >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "if [ \"$RUN_MIGRATIONS\" = \"true\" ]; then DATABASE_URL=\"${MIGRATION_DATABASE_URL:-$DATABASE_URL}\" npx prisma migrate deploy; fi && exec node dist/server.js"]
