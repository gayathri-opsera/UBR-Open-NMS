FROM golang:1.22 AS builder
WORKDIR /build
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o mobinet-sync ./cmd/...

FROM alpine:3.19
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app
COPY --from=builder /build/mobinet-sync .
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 9092
ENTRYPOINT ["./mobinet-sync"]
