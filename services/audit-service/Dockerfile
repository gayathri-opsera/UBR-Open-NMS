FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

FROM node:20-alpine AS final
WORKDIR /app
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY package.json ./
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 3007
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3007/healthz || exit 1
CMD ["node", "src/server.js"]
