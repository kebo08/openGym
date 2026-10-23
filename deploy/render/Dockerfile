# Full official v1.4.2 browser app and licensed exercise media, without a frontend
# rebuild or media hotlinks. This is the verified multi-architecture release digest.
FROM ghcr.io/duartesantos8/opengym-web:1.4.2@sha256:748c77417d40969d9840f064fd0cafecd84e47ac786d424688d0cff0d6b53299 AS web

FROM node:22-alpine
RUN apk upgrade --no-cache \
 && apk add --no-cache nginx \
 && adduser -D -H -s /sbin/nologin coach
WORKDIR /app/api
COPY api/package.json api/package-lock.json ./
# External Codex manages plans through the paired API. No embedded AI runtime is
# needed; the upstream default image also omits optional Agent SDK dependencies.
RUN npm ci --omit=dev --omit=optional && npm cache clean --force
COPY api/ ./
# Keep the upstream nginx template's document root unchanged.
COPY --from=web /usr/share/nginx/html/ /usr/share/nginx/html/
COPY web/nginx.conf.template /app/render/nginx.conf.template
COPY deploy/render/start.mjs /app/render/start.mjs
COPY LICENSE NOTICE.md /app/
ENV NODE_ENV=production PORT=10000 DATA_DIR=/tmp/opengym-data \
    COACH_DISABLED=1 MEDIA_UPLOADS=0 TRUST_PROXY=1
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget --spider -q "http://127.0.0.1:${PORT}/api/health" || exit 1
CMD ["node", "/app/render/start.mjs"]
