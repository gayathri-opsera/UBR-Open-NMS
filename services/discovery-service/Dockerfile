FROM golang:1.22 AS builder
WORKDIR /app
COPY go.mod ./
RUN go mod download && go mod tidy || true
COPY . .
RUN go mod tidy && CGO_ENABLED=1 GOOS=linux go build -o discovery-service ./main.go

FROM debian:12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates wget libstdc++6 && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -r appgroup && useradd -r -g appgroup appuser
WORKDIR /app
COPY --from=builder /app/discovery-service .
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:8081/healthz || exit 1
CMD ["./discovery-service"]
