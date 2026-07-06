FROM golang:1.22-alpine AS builder
RUN apk add --no-cache gcc musl-dev
WORKDIR /app
COPY go.mod ./
RUN go mod download && go mod tidy || true
COPY . .
RUN go mod tidy && CGO_ENABLED=1 GOOS=linux go build -o discovery-service ./main.go

FROM alpine:3.19
RUN apk add --no-cache libstdc++ ca-certificates wget
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app
COPY --from=builder /app/discovery-service .
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:8081/healthz || exit 1
CMD ["./discovery-service"]
