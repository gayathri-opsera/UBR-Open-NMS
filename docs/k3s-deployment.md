# UBR Open NMS — Bare-Metal k3s Deployment Guide

This document describes how to deploy the full UBR Open NMS stack to a single-node
**k3s** cluster on a bare Ubuntu machine, using the Helm charts in `helm-charts/`.
It was validated end-to-end on a fresh AWS EC2 instance (Ubuntu 26.04, 16 vCPU, 62 GB RAM).

It also documents several **real bugs found in the Helm charts** during this
validation. Those bugs are fixed directly in the chart files under `helm-charts/`
— see [Chart fixes applied](#chart-fixes-applied) for what changed and why. The
full procedure below (steps 1-7) was re-run end-to-end after a full teardown
(`helm uninstall`, delete infra/namespaces, delete images, `rm -rf` the synced
repo dir on the target) to confirm it's reproducible from a clean `main` — it
came up with zero pod restarts on the first `helm install`.

## Architecture recap

- 15 application microservices (Node.js, Java/Spring Boot, Go, Python) + a React frontend
- Shared infra: MongoDB, Redis, Kafka+Zookeeper
- 4 namespaces: `ubr-platform` (most services + frontend), `ubr-ingress` (api-gateway),
  `ubr-data` (infra), `ubr-monitoring` (unused by the charts today)
- The Helm charts originally shipped in `helm-charts/*/` only covered the 15 app
  services — **not** the frontend, monitoring stack, the Mongo/Redis/Kafka infra, or
  the 3 forwarder services (`netcool-forwarder`, `mycom-forwarder`, `syslog-forwarder`).
  A `helm-charts/frontend/` chart was added as part of this work (see
  [Chart fixes applied](#chart-fixes-applied) item 8) and wired into the `ubrnms`
  umbrella chart's dependencies. The infra (Mongo/Redis/Kafka) is still assumed to
  already exist in `ubr-data`; this guide stands it up manually (see
  `dev/k8s-local/infra.yaml`). The forwarders and monitoring stack remain out of
  scope — no charts exist for them.

## Prerequisites

- A bare Ubuntu machine (validated on 26.04) with a public/reachable IP and SSH access
- Outbound internet access (to pull base images, Docker, k3s, Helm)
- Local machine: a full clone of this repo with **no Git credentials required on the
  remote box** — we `rsync` the repo over instead of cloning on the remote

## 1. Install Docker, k3s, and Helm on the target machine

```bash
ssh -i <key.pem> ubuntu@<host> '
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker ubuntu
  curl -sfL https://get.k3s.io | sudo sh -
  sudo chmod 644 /etc/rancher/k3s/k3s.yaml
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | sudo bash
'
```

k3s installs its own kubectl (symlinked) and containerd; no separate CNI/ingress
install needed for this single-node setup. `KUBECONFIG=/etc/rancher/k3s/k3s.yaml`
for all `kubectl`/`helm` commands below.

## 2. Generate JWT keys and the k8s values file, then copy the repo over

`dev/k8s-local/values-kind.yaml` (the values override used in step 5) embeds the
JWT signing keypair and is **git-ignored on purpose** — it's generated locally,
never committed:

```bash
cd /path/to/UBR-Open-NMS
bash dev-setup.sh --infra-only   # or any run that generates dev/jwt_{private,public}.pem
python3 dev/k8s-local/gen_values.py    # writes dev/k8s-local/values-kind.yaml
```

The remote box has no GitHub deploy key, so clone locally and `rsync` over
(excluding `node_modules`, `.git`, and the local kind kubeconfig — `values-kind.yaml`
itself, though git-ignored, *should* be synced since the target needs it):

```bash
rsync -az --progress -e "ssh -i <key.pem>" \
  --exclude 'node_modules' --exclude '.git' \
  --exclude 'dev/k8s-local/kubeconfig.yaml' --exclude 'dev/k8s-local/kind-config.yaml' \
  /path/to/UBR-Open-NMS/ ubuntu@<host>:/home/ubuntu/UBR-Open-NMS/
```

## 3. Build the application images on the target machine

```bash
ssh -i <key.pem> ubuntu@<host> '
  cd /home/ubuntu/UBR-Open-NMS
  sudo docker compose -f docker-compose.dev.yml build \
    auth-service alarm-service inventory-service discovery-service event-collector \
    config-service topology-service kpi-aggregation-service kpi-query-service \
    diagnostics-service health-monitor report-service notification-service \
    audit-service api-gateway
  sudo docker compose -f docker-compose.dev.yml build \
    --build-arg VITE_API_BASE_URL=http://localhost:3100 frontend
'
```

This reuses the same Dockerfiles/build contexts as the local dev docker-compose
stack — takes ~5-10 minutes on first run (buildkit builds in parallel).
`VITE_API_BASE_URL` is baked into the frontend's static JS bundle at build time
(Vite inlines `import.meta.env.VITE_*` at build, not runtime) — set it to whatever
host:port the *browser* will use to reach the gateway. `http://localhost:3100`
matches the SSH-tunnel access pattern in [Access the UI](#access-the-ui) below;
change it if you're exposing the gateway differently.

## 4. Retag and import images into k3s's containerd

k3s uses containerd directly, not the Docker daemon's image store, so images built
with `docker build` must be exported and imported:

```bash
ssh -i <key.pem> ubuntu@<host> '
  # retag ubr-open-nms-<compose-name>:latest -> ubrnms/<chart-name>:latest
  # (chart names differ from compose names for config-management-service only:
  #  compose calls it "config-service")
  sudo docker tag ubr-open-nms-auth-service:latest ubrnms/auth-service:latest
  # ... repeat for all 15 services (see gen_values.py mapping) ...

  sudo docker tag ubr-open-nms-frontend:latest ubrnms/frontend:latest

  for img in auth-service alarm-service inventory-service kpi-aggregation-service \
    kpi-query-service diagnostics-service report-service config-management-service \
    topology-service notification-service audit-service event-collector \
    discovery-service api-gateway health-monitor frontend; do
    sudo docker save "ubrnms/${img}:latest" | sudo k3s ctr images import -
  done
'
```

`kpi-collector` has no docker-compose equivalent/image — its Helm subchart is
scaled to 0 replicas in `values-kind.yaml` rather than built.

## 4b. Set up namespaces, infra, and Helm dependencies

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
cd /home/ubuntu/UBR-Open-NMS
kubectl apply -f helm-charts/namespaces.yaml
kubectl apply -f dev/k8s-local/infra.yaml   # mongo, redis, kafka, zookeeper

cd helm-charts
for d in alarm-service api-gateway audit-service auth-service config-management-service \
  diagnostics-service discovery-service event-collector health-monitor inventory-service \
  kpi-aggregation-service kpi-collector kpi-query-service notification-service \
  report-service topology-service frontend; do
  (cd "$d" && helm dependency update .)
done
(cd ubrnms && helm dependency update .)
```

## 5. Deploy the Helm chart

```bash
cd helm-charts/ubrnms
helm install ubrnms . -n ubr-platform \
  -f values-dev.yaml \
  -f ../../dev/k8s-local/values-kind.yaml \
  --set 'event-collector.probes.readiness.path=/healthz' \
  --set 'event-collector.probes.liveness.path=/healthz'
```

`dev/k8s-local/values-kind.yaml` (generated by `dev/k8s-local/gen_values.py`) is
the key file here — it ports the **working** env vars/ports from
`docker-compose.dev.yml` into every subchart (see [Chart fixes applied](#chart-fixes-applied)
for why the chart defaults alone are not sufficient), and disables
`networkPolicy` (see below).

## 6. Seed the database

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl port-forward svc/mongo -n ubr-data 27017:27017 --address 127.0.0.1 &
cd scripts
sudo docker run --rm --network host -v "$(pwd)":/app -w /app node:20-slim \
  sh -c "npm install --no-audit --no-fund --silent && MONGO_URL=mongodb://127.0.0.1:27017 node seed.js"
```

Login credentials after seeding:

| Role | Username | Password |
|---|---|---|
| Admin | `admin` | `Admin@NMS2024!` |
| Operator | `operator` | `Operator@NMS2024!` |
| NOC Ops | `noc_operator` | `NocOp@NMS2024!` |
| Viewer | `viewer` | `Viewer@NMS2024!` |

## 7. Verify

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl get pods -n ubr-platform -n ubr-ingress -n ubr-data   # all should be 1/1 Running

kubectl port-forward svc/ubrnms-api-gateway -n ubr-ingress 3100:80 --address 127.0.0.1 &
curl -X POST http://127.0.0.1:3100/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin@NMS2024!"}'
# -> 200 with an accessToken
```

At this point `admin`/`Admin@NMS2024!` logs in, and the token works against every
backend service through the gateway (verified against `/api/v1/alarms` and
`/api/v1/devices`).

## Access the UI

There's no ingress-controller chart, so nothing is exposed publicly by default —
access is via `kubectl port-forward` tunneled over SSH. Two tunnels are needed:
the frontend itself, and the gateway (the frontend's JS bundle calls the gateway
directly at the `VITE_API_BASE_URL` baked in at build time — see step 3 — in
addition to nginx's own same-origin `/api/` proxy).

On the target machine:

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl port-forward svc/ubrnms-frontend -n ubr-platform 5173:80 --address 127.0.0.1 &
kubectl port-forward svc/ubrnms-api-gateway -n ubr-ingress 3100:80 --address 127.0.0.1 &
```

From your laptop:

```bash
ssh -i <key.pem> -L 5173:localhost:5173 -L 3100:localhost:3100 -N ubuntu@<host>
```

Then open **http://localhost:5173** in a browser and log in with
`admin` / `Admin@NMS2024!`.

To expose this publicly instead (no SSH tunnel), change the frontend/gateway
Services to `NodePort` or add a LoadBalancer/Ingress, rebuild the frontend image
with `VITE_API_BASE_URL` pointing at that public host:port, and open the
corresponding port in the EC2 security group. Not done here by default since it
changes external-facing infrastructure.

## Chart fixes applied

These were real defects found while getting a first successful deployment, not
environment quirks. They're fixed directly in the chart files on `main`.

1. **Wrong health-check paths for Java services** — `helm-charts/ubrnms-common/templates/_helpers.tpl`
   hardcoded `/healthz` (liveness) and `/readyz` (readiness) for every service.
   The 8 Spring Boot services (alarm, inventory, kpi-aggregation, kpi-query,
   diagnostics, config-management, topology, health-monitor) only expose
   `/actuator/health` — confirmed against `docker-compose.dev.yml`'s healthchecks
   and the absence of `/healthz`/`/readyz` in their Java source. Fix: probe paths
   are now templated from `.Values.probes.{liveness,readiness}.path` (default
   unchanged), overridden to `/actuator/health` for the 8 Java services in
   `values-kind.yaml`.

2. **Broken multi-document YAML in every `service.yaml`** — the `---` document
   separator for the optional ServiceAccount/HPA/Ingress/NetworkPolicy blocks sat
   *before* each `{{- if }}` instead of inside it, so disabling any of them (the
   common case) emitted an empty YAML document. `helm install`'s manifest builder
   rejects those with `error validating data: apiVersion not set`. Fixed across
   all 16 `helm-charts/*/templates/service.yaml`.

3. **Dead template line breaking every Deployment** — every `deployment.yaml`
   except `auth-service`'s (the hand-written original the generator copied from)
   started with `{{- include "ubrnms-common.fullname" . -}}`, a line with no
   purpose that renders the release name directly into the document and — because
   of the trailing `-}}` — merges onto the same line as `apiVersion: apps/v1` on
   the next line, corrupting the YAML. Deleted from all 15 affected
   `deployment.yaml` files.

4. **`event-collector` has no `/readyz` endpoint** — unlike the Node.js services,
   this Go service's `main.go` only implements `/healthz`. Readiness probe path
   overridden to `/healthz` via `--set` at install time (see step 5).

5. **`api-gateway` uses bare cross-namespace service names** — `api-gateway`
   deploys to `ubr-ingress` while every backend it calls lives in `ubr-platform`.
   Bare Kubernetes service names only resolve within the same namespace. Fixed in
   `values-kind.yaml`/`gen_values.py`: every `*_SERVICE_URL` for api-gateway is
   `http://ubrnms-<service>.ubr-platform`.

6. **`NetworkPolicy` egress rules block DNS** — every chart ships a default-enabled
   `NetworkPolicy` whose egress allow-list doesn't include kube-system/CoreDNS.
   Once any egress rule exists, DNS becomes an implicit deny, and every Mongo/
   Redis/Kafka hostname lookup fails (`EAI_AGAIN`/timeouts). This isn't a k3s-only
   issue — expect the same on any NetworkPolicy-enforcing CNI (Calico, Cilium —
   i.e. most managed clusters). We disabled `networkPolicy.enabled` for all
   16 services in `values-kind.yaml` rather than author correct DNS-egress rules
   for every chart; do the latter before running this in a real multi-tenant
   cluster.
   **Important:** `NetworkPolicy` objects are regular Helm-managed resources —
   deleting them with `kubectl delete` without also fixing the values will not
   stick; the next `helm upgrade` recreates them from the chart defaults.

7. **Missing infra + `KAFKA_PORT` collision** — the charts assume Mongo/Redis/Kafka
   already exist in `ubr-data`; `dev/k8s-local/infra.yaml` stands up minimal
   Deployments/Services for them. The Kafka Deployment needs
   `enableServiceLinks: false` — Kubernetes auto-injects a `KAFKA_PORT=tcp://...`
   env var into every pod in the namespace because the Service is literally named
   `kafka`, and the Confluent image's entrypoint treats any `KAFKA_PORT` env var
   as a fatal deprecated-config error.

8. **No Helm chart for the frontend, and a hardcoded upstream in its nginx config**
   — `helm-charts/frontend/` didn't exist; added it (Chart.yaml, values.yaml,
   deployment.yaml, service.yaml — same pattern as the other charts, reusing
   `ubrnms-common`, wired into `ubrnms/Chart.yaml`'s dependencies) and registered
   it in `gen_values.py`/`values-kind.yaml`. Two things needed to change from the
   other charts' template:
   - **No `runAsNonRoot`/`runAsUser: 1000` securityContext.** nginx needs to start
     as root to bind port 80, then drops privileges internally; the other 15
     charts' Deployments all hardcode that securityContext, which would make nginx
     fail to bind and crash. Omitted for this chart only.
   - `frontend/nginx.conf` had `proxy_pass http://api-gateway:3000` hardcoded for
     its own same-origin `/api/` proxy — `api-gateway:3000` is the docker-compose
     hostname:port and doesn't exist in k8s (nginx resolves `proxy_pass` hostnames
     at config-load time and refuses to start at all if resolution fails, so this
     broke the entire frontend, not just the proxy path). Fixed generally, without
     breaking docker-compose: renamed `nginx.conf` → `nginx.conf.template` and
     placed it at `/etc/nginx/templates/default.conf.template` (nginx's official
     image auto-runs `envsubst` on files there before startup), replaced the
     hardcoded host with `${API_GATEWAY_UPSTREAM}`, and defaulted that env var to
     `api-gateway:3000` in the Dockerfile (unchanged docker-compose behavior).
     The k8s deployment overrides it to `ubrnms-api-gateway.ubr-ingress` via
     `values-kind.yaml`.

## Troubleshooting notes

- **Don't run this alongside the docker-compose dev stack on the same host.**
  During initial validation on a resource-constrained laptop, running both
  simultaneously overcommitted memory to >150% and caused sporadic, hard-to-diagnose
  DNS timeouts (`EAI_AGAIN`) in application pods that had nothing to do with the
  chart config. `docker compose -f docker-compose.dev.yml down` first.
- If a service is stuck in `CrashLoopBackOff`, `kubectl delete pod` to skip the
  backoff timer once the underlying issue (env var, DNS, NetworkPolicy) is fixed —
  kubelet does not retry sooner on its own.
- `pkill -f "<pattern>"` over SSH can match its own invoking command line and kill
  the parent shell if the pattern string appears in the remote command itself —
  use `ps`/`grep -v grep`/`awk` instead when scripting process cleanup remotely.
- A `kubectl port-forward` doesn't die when its target pod is deleted — it errors
  ("failed to find sandbox ... not found") on the next connection attempt but
  keeps holding the local port, so a later `port-forward` on the same port fails
  with "address already in use". If you tear down and redeploy, kill old
  `port-forward` processes first (`ps aux | grep kubectl`, not `pkill -f
  port-forward` — see above) rather than assuming the port is free.

## Teardown

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
helm uninstall ubrnms -n ubr-platform
kubectl delete -f dev/k8s-local/infra.yaml
kubectl delete -f helm-charts/namespaces.yaml
# or, to remove k3s entirely:
sudo /usr/local/bin/k3s-uninstall.sh
```
