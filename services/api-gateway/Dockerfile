FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
RUN addgroup -S nms && adduser -S nms -G nms
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./
RUN chown -R nms:nms /app
USER nms
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1
CMD ["node", "src/server.js"]
