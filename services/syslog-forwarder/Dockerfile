FROM golang:1.22-alpine AS builder
RUN apk add --no-cache gcc musl-dev
WORKDIR /build
COPY go.mod go.sum* ./
RUN go mod download || true
COPY . .
RUN go mod tidy && CGO_ENABLED=1 GOOS=linux go build -o syslog-forwarder ./cmd/...

FROM alpine:3.19
RUN apk add --no-cache libstdc++ ca-certificates wget
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app
COPY --from=builder /build/syslog-forwarder .
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 9104
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:9104/metrics || exit 1
ENTRYPOINT ["./syslog-forwarder"]
