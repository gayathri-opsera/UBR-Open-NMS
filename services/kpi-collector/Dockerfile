FROM golang:1.22 AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev librdkafka-dev && rm -rf /var/lib/apt/lists/*
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN go mod tidy && CGO_ENABLED=1 GOOS=linux go build -o kpi-collector .

FROM debian:12-slim
RUN groupadd -r appgroup && useradd -r -g appgroup appuser
WORKDIR /app
COPY --from=builder /app/kpi-collector .
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 8087 9090
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:8087/healthz || exit 1
ENTRYPOINT ["./kpi-collector"]
