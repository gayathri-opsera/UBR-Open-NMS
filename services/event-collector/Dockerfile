FROM golang:1.22-alpine AS builder
RUN apk add --no-cache gcc musl-dev
WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod download || true
COPY . .
RUN go mod tidy && CGO_ENABLED=1 GOOS=linux go build -o event-collector ./main.go

FROM alpine:3.19
RUN apk add --no-cache libstdc++ ca-certificates wget
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app
COPY --from=builder /app/event-collector .
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 9090
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:9090/healthz || exit 1
CMD ["./event-collector"]
