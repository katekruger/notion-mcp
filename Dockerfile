# Webhook mode: receives Notion webhook deliveries and runs workflows. Put it behind HTTPS (Notion only delivers to
# https URLs) and mount a volume at /data so the queue, run records, and undo journal survive restarts.
#   docker build -t notion-plus .
#   docker run -p 8787:8787 -v notion-plus:/data -e NOTION_TOKEN=… -e NOTION_PLUS_WEBHOOK_TOKEN=… notion-plus
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NOTION_PLUS_HOME=/data NOTION_PLUS_WEBHOOK_PORT=8787
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/webhook-server.js"]
