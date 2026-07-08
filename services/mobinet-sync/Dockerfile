FROM golang:1.22 AS builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev librdkafka-dev && rm -rf /var/lib/apt/lists/*
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN go mod tidy && CGO_ENABLED=1 GOOS=linux go build -o mobinet-sync ./cmd/...

FROM debian:12-slim
RUN groupadd -r appgroup && useradd -r -g appgroup appuser
WORKDIR /app
COPY --from=builder /build/mobinet-sync .
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 9092
ENTRYPOINT ["./mobinet-sync"]
