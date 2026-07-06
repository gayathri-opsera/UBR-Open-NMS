# Developer Onboarding Guide — UBR Open NMS

Welcome to the UBR Open Network Management System. This guide gets you from zero to a running local environment in under 30 minutes.

---

## Prerequisites

| Tool | Minimum Version | Install |
|------|----------------|---------|
| Docker Desktop | 4.x | https://docs.docker.com/get-docker/ |
| `kubectl` | 1.28 | `brew install kubectl` |
| `helm` | 3.14 | `brew install helm` |
| Node.js | 20 | `brew install node` |
| Java JDK | 17 | `brew install temurin@17` |
| Go | 1.22 | `brew install go` |
| Python | 3.11 | `brew install python@3.11` |
| Maven | 3.9 | `brew install maven` |

---

## 1. Clone and Bootstrap

```bash
git clone https://github.com/example/ubr-open-nms-senao.git
cd ubr-open-nms-senao
```

---

## 2. Start Local Infrastructure

All dependencies run via Docker Compose:

```bash
# From the repo root — starts Kafka, MongoDB, Redis, ScyllaDB, Zookeeper
docker compose -f docker-compose.dev.yml up -d

# Verify everything is healthy
docker compose -f docker-compose.dev.yml ps
```

Wait ~30 seconds for Kafka and MongoDB to finish initializing.

---

## 3. Start Individual Services

Each service has a `dev` script. Open separate terminals:

```bash
# Auth Service (Node.js)
cd services/auth-service && npm install && npm run dev

# Alarm Service (Java)
cd services/alarm-service && mvn spring-boot:run

# Report Service (Python)
cd services/report-service && pip install -e ".[dev]" && uvicorn src.app:app --reload --port 8091
```

Or start all services at once using the test harness simulator profile:

```bash
cd test-harness/device-simulator
pip install -e .
python src/simulator.py --profile profiles/small-10.yaml
```

---

## 4. Service Dependency Map

```
Browser
  └─► api-gateway (:3010)
        ├─► auth-service (:3000)          → MongoDB, Redis
        ├─► alarm-service (:8080)         → MongoDB, Kafka(raw-alarms)
        ├─► inventory-service (:8082)     → MongoDB, Kafka(inventory-events)
        ├─► kpi-query-service (:8089)     → ScyllaDB
        ├─► diagnostics-service (:8090)   → MongoDB
        ├─► report-service (:8091)        → MongoDB, ScyllaDB
        ├─► config-management (:8080)     → MongoDB
        ├─► topology-service (:8080)      → MongoDB
        └─► notification-service (:3030)  → Redis, MongoDB

Kafka consumers (internal only):
  event-collector → raw-alarms → alarm-service
  alarm-service → netcool-alarms-forward → netcool-forwarder
  kpi-collector → kpi-events → kpi-aggregation-service → mycom-forwarder
  inventory-service → inventory-events → mobinet-sync
  audit-service → operational-events → syslog-forwarder
```

---

## 5. Running Tests

```bash
# Java (from any Java service directory)
mvn test

# Node.js
npm test

# Go
go test ./... -v

# Python
pytest -v

# E2E (requires running infrastructure)
cd test-harness/e2e-tests
bash scripts/setup.sh
bash scripts/run-tests.sh
```

---

## 6. Contribution Workflow

1. **Branch naming:** `feature/<wo-id>-short-description` or `fix/<issue>-description`
2. **Commit convention:** `feat(service): description` / `fix(service): description`
3. **Before opening a PR:**
   - `mvn test` / `npm test` / `go test ./...` / `pytest` must pass
   - Coverage must stay ≥ 80% (CI will enforce this)
   - No new Snyk HIGH/CRITICAL vulnerabilities
4. **PR review:** Requires 1 approval from the service owner (see CODEOWNERS)
5. **Merge:** Squash merge to `main`
6. **Deploy:** CI/CD pipeline deploys automatically to dev on merge to `main`

---

## 7. Key Configuration Files

| File | Purpose |
|------|---------|
| `docker-compose.dev.yml` | Local dev infrastructure |
| `helm-charts/ubrnms/values-dev.yaml` | Dev Kubernetes values |
| `monitoring/prometheus.yml` | Prometheus scrape config |
| `monitoring/dashboards/` | Grafana dashboard JSONs |
| `.github/workflows/` | CI/CD pipeline definitions |
| `test-harness/scenario-runner/scenarios/` | Integration test scenarios |

---

## 8. Useful Commands

```bash
# Watch all pods in ubr-platform namespace
watch kubectl get pods -n ubr-platform

# Follow logs from alarm service
kubectl logs -f -n ubr-platform -l app.kubernetes.io/name=alarm-service

# Check Kafka consumer lag
kubectl exec -it kafka-0 -n ubr-data -- kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 --describe --group alarm-service-group

# Open Grafana locally
kubectl port-forward svc/grafana -n ubr-monitoring 3000:3000
# Open http://localhost:3000 (admin / changeme)
```
