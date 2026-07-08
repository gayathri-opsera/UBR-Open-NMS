FROM golang:1.22 AS builder
WORKDIR /build
COPY go.mod go.sum* ./
RUN go mod download || true
COPY . .
RUN go mod tidy && CGO_ENABLED=1 GOOS=linux go build -o mycom-forwarder ./cmd/...

FROM debian:12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates wget libstdc++6 && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -r appgroup && useradd -r -g appgroup appuser
WORKDIR /app
COPY --from=builder /build/mycom-forwarder .
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 9091
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:9091/healthz || exit 1
ENTRYPOINT ["./mycom-forwarder"]
