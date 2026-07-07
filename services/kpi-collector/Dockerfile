FROM golang:1.22 AS builder
WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o kpi-collector .

FROM alpine:3.19
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /app
COPY --from=builder /app/kpi-collector .
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 8087 9090
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:8087/healthz || exit 1
ENTRYPOINT ["./kpi-collector"]
