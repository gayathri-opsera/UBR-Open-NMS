FROM golang:1.22 AS builder
WORKDIR /build
COPY go.mod go.sum* ./
RUN go mod download || true
COPY . .
RUN go mod tidy && CGO_ENABLED=1 GOOS=linux go build -o mycom-forwarder ./cmd/...

FROM alpine:3.19
RUN apk add --no-cache libstdc++ ca-certificates wget
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app
COPY --from=builder /build/mycom-forwarder .
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 9091
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:9091/healthz || exit 1
ENTRYPOINT ["./mycom-forwarder"]
