FROM golang:1.22 AS builder
WORKDIR /build
COPY go.mod go.sum* ./
RUN go mod download || true
COPY . .
RUN go mod tidy && CGO_ENABLED=1 GOOS=linux go build -o netcool-forwarder ./cmd/...

FROM alpine:3.19
RUN apk add --no-cache libstdc++ ca-certificates wget
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app
COPY --from=builder /build/netcool-forwarder .
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 9090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:9090/healthz || exit 1
ENTRYPOINT ["./netcool-forwarder"]
