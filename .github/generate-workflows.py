#!/usr/bin/env python3
"""
Generate GitHub Actions CI/CD workflow files for all UBR NMS microservices.
Each workflow reuses the same 11-stage pipeline structure as auth-service.yml,
with language-specific build/test commands.
"""
import pathlib, re

BASE = pathlib.Path(__file__).parent / ".github/workflows"
BASE.mkdir(parents=True, exist_ok=True)

# service → (language, build_cmd, test_cmd, coverage_flag, working_dir_extra)
SERVICES = {
    "alarm-service":           ("java",   "mvn -B package -DskipTests", "mvn -B test", "", ""),
    "inventory-service":       ("java",   "mvn -B package -DskipTests", "mvn -B test", "", ""),
    "kpi-aggregation-service": ("java",   "mvn -B package -DskipTests", "mvn -B test", "", ""),
    "kpi-query-service":       ("java",   "mvn -B package -DskipTests", "mvn -B test", "", ""),
    "diagnostics-service":     ("java",   "mvn -B package -DskipTests", "mvn -B test", "", ""),
    "report-service":          ("python", "pip install -e '.[dev]'",    "pytest --cov=src --cov-fail-under=80", "", ""),
    "config-management-service":("java",  "mvn -B package -DskipTests", "mvn -B test", "", ""),
    "topology-service":        ("java",   "mvn -B package -DskipTests", "mvn -B test", "", ""),
    "notification-service":    ("nodejs", "npm ci --ignore-scripts",    "npm test -- --coverage", "--coverageThreshold='{\"global\":{\"lines\":80}}'", ""),
    "audit-service":           ("nodejs", "npm ci --ignore-scripts",    "npm test -- --coverage", "--coverageThreshold='{\"global\":{\"lines\":80}}'", ""),
    "event-collector":         ("java",   "mvn -B package -DskipTests", "mvn -B test", "", ""),
    "kpi-collector":           ("go",     "go build ./...",             "go test ./... -cover", "", ""),
    "discovery-service":       ("go",     "go build ./...",             "go test ./... -cover", "", ""),
    "api-gateway":             ("nodejs", "npm ci --ignore-scripts",    "npm test -- --coverage", "--coverageThreshold='{\"global\":{\"lines\":80}}'", ""),
    "health-monitor":          ("java",   "mvn -B package -DskipTests", "mvn -B test", "", ""),
    "netcool-forwarder":       ("go",     "go build ./...",             "go test ./... -cover", "", ""),
    "mycom-forwarder":         ("go",     "go build ./...",             "go test ./... -cover", "", ""),
    "syslog-forwarder":        ("go",     "go build ./...",             "go test ./... -cover", "", ""),
}

SETUP_JAVA = """
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "17"
          cache: maven"""

SETUP_NODE = """
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
          cache-dependency-path: services/{svc}/package-lock.json"""

SETUP_GO = """
      - uses: actions/setup-go@v5
        with:
          go-version: "1.22"
          cache: true"""

SETUP_PYTHON = """
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
          cache: pip"""

SNYK_JAVA = """
      - name: Snyk dependency scan
        uses: snyk/actions/maven@master
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
        with:
          args: --severity-threshold=high"""

SNYK_NODE = """
      - name: Snyk dependency scan
        uses: snyk/actions/node@master
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
        with:
          args: --severity-threshold=high --file=services/{svc}/package.json"""

SNYK_GO = """
      - name: Snyk dependency scan
        uses: snyk/actions/golang@master
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
        with:
          args: --severity-threshold=high"""

SNYK_PYTHON = """
      - name: Snyk dependency scan
        uses: snyk/actions/python@master
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
        with:
          args: --severity-threshold=high"""

TEMPLATE = """\
name: UBR NMS — {display} CI/CD
on:
  push:
    paths:
      - "services/{svc}/**"
      - ".github/workflows/{svc}.yml"
  pull_request:
    paths:
      - "services/{svc}/**"
      - ".github/workflows/{svc}.yml"

env:
  SERVICE: {svc}
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{{{ github.repository }}}}/{svc}

jobs:

  build:
    name: Build
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: services/{svc}
    steps:
      - uses: actions/checkout@v4{setup}
      - name: Build
        run: {build_cmd}
      - name: Validate no secrets committed
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{{{ secrets.GITHUB_TOKEN }}}}
      - name: Validate no .env files committed
        run: |
          if git ls-files | grep -qE '\\.env$|\\.env\\.(local|prod|staging)$'; then
            echo "ERROR: .env file found in repository"; exit 1
          fi

  test:
    name: Test
    runs-on: ubuntu-latest
    needs: build
    defaults:
      run:
        working-directory: services/{svc}
    steps:
      - uses: actions/checkout@v4{setup}
      - name: Install / build
        run: {build_cmd}
      - name: Run tests with coverage gate
        run: {test_cmd} {coverage_flag}
        env:
          CI: true

  scan:
    name: Security Scan
    runs-on: ubuntu-latest
    needs: build
    defaults:
      run:
        working-directory: services/{svc}
    steps:
      - uses: actions/checkout@v4{setup}
      - name: Install / build
        run: {build_cmd}
{snyk}
      - name: Semgrep SAST
        uses: returntocorp/semgrep-action@v1
        with:
          config: "p/security-audit"
      - name: SonarQube Analysis
        uses: sonarsource/sonarqube-scan-action@master
        env:
          SONAR_TOKEN: ${{{{ secrets.SONAR_TOKEN }}}}
          SONAR_HOST_URL: ${{{{ secrets.SONAR_HOST_URL }}}}
        with:
          projectBaseDir: services/{svc}

  package:
    name: Package
    runs-on: ubuntu-latest
    needs: [test, scan]
    if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/release/')
    outputs:
      image-tag: ${{{{ steps.meta.outputs.version }}}}
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ${{{{ env.REGISTRY }}}}
          username: ${{{{ github.actor }}}}
          password: ${{{{ secrets.GITHUB_TOKEN }}}}
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{{{ env.REGISTRY }}}}/${{{{ env.IMAGE_NAME }}}}
          tags: |
            type=sha,prefix=
            type=raw,value=latest,enable=${{{{ github.ref == 'refs/heads/main' }}}}
      - uses: docker/build-push-action@v5
        with:
          context: services/{svc}
          push: true
          tags: ${{{{ steps.meta.outputs.tags }}}}
          cache-from: type=gha
          cache-to: type=gha,mode=max
      - uses: anchore/scan-action@v3
        with:
          image: ${{{{ env.REGISTRY }}}}/${{{{ env.IMAGE_NAME }}}}:${{{{ steps.meta.outputs.version }}}}
          fail-build: true
          severity-cutoff: high

  deploy-dev:
    name: Deploy (dev)
    runs-on: ubuntu-latest
    needs: package
    environment: dev
    steps:
      - name: ArgoCD sync — dev
        run: |
          argocd app set ubrnms-dev-${{{{ env.SERVICE }}}} --helm-set image.tag=${{{{ needs.package.outputs.image-tag }}}}
          argocd app sync ubrnms-dev-${{{{ env.SERVICE }}}} --timeout 300
          argocd app wait ubrnms-dev-${{{{ env.SERVICE }}}} --health --timeout 300
        env:
          ARGOCD_SERVER: ${{{{ secrets.ARGOCD_SERVER }}}}
          ARGOCD_AUTH_TOKEN: ${{{{ secrets.ARGOCD_AUTH_TOKEN }}}}

  test-dev:
    name: Integration Test (dev)
    runs-on: ubuntu-latest
    needs: deploy-dev
    steps:
      - uses: actions/checkout@v4
      - run: pip install --quiet pyyaml aiohttp
      - run: python test-harness/scenario-runner/src/runner.py test-harness/scenario-runner/scenarios/device-onboarding.yaml
        env:
          DISCOVERY_URL: https://discovery.dev.ubrnms.internal
          INVENTORY_URL: https://inventory.dev.ubrnms.internal
          STUB_URL: https://stubs.dev.ubrnms.internal

  deploy-staging:
    name: Deploy (staging)
    runs-on: ubuntu-latest
    needs: test-dev
    environment: staging
    steps:
      - name: ArgoCD sync — staging
        run: |
          argocd app set ubrnms-staging-${{{{ env.SERVICE }}}} --helm-set image.tag=${{{{ needs.package.outputs.image-tag }}}}
          argocd app sync ubrnms-staging-${{{{ env.SERVICE }}}} --timeout 300
          argocd app wait ubrnms-staging-${{{{ env.SERVICE }}}} --health --timeout 300
        env:
          ARGOCD_SERVER: ${{{{ secrets.ARGOCD_SERVER }}}}
          ARGOCD_AUTH_TOKEN: ${{{{ secrets.ARGOCD_AUTH_TOKEN }}}}

  test-staging:
    name: Smoke Test (staging)
    runs-on: ubuntu-latest
    needs: deploy-staging
    steps:
      - uses: actions/checkout@v4
      - run: pip install --quiet pyyaml aiohttp
      - run: python test-harness/scenario-runner/src/runner.py test-harness/scenario-runner/scenarios/auth-flow.yaml
        env:
          AUTH_URL: https://auth.staging.ubrnms.example.com

  deploy-prod:
    name: Deploy (prod — canary 10%)
    runs-on: ubuntu-latest
    needs: test-staging
    environment: production
    steps:
      - name: ArgoCD canary sync — prod
        run: |
          argocd app set ubrnms-prod-${{{{ env.SERVICE }}}} \\
            --helm-set image.tag=${{{{ needs.package.outputs.image-tag }}}} \\
            --helm-set rollout.canaryWeight=10
          argocd app sync ubrnms-prod-${{{{ env.SERVICE }}}} --timeout 300
          argocd app wait ubrnms-prod-${{{{ env.SERVICE }}}} --health --timeout 300
        env:
          ARGOCD_SERVER: ${{{{ secrets.ARGOCD_SERVER }}}}
          ARGOCD_AUTH_TOKEN: ${{{{ secrets.ARGOCD_AUTH_TOKEN }}}}

  canary-validation:
    name: Canary Validation
    runs-on: ubuntu-latest
    needs: deploy-prod
    steps:
      - name: Error rate gate (< 1%)
        run: |
          ERROR_RATE=$(curl -sf "$PROMETHEUS_URL/api/v1/query" \
            --data-urlencode 'query=rate(http_requests_total[5m])' \
            | python3 -c "import json,sys; d=json.load(sys.stdin); r=d['data']['result']; print(float(r[0]['value'][1]) if r else 0)" || echo 0)
          echo "Error rate: ${{ERROR_RATE}}%"
          if [ "$(echo "${{ERROR_RATE}} > 1" | bc -l)" = "1" ]; then
            echo "Canary error rate > 1% -- rollback triggered"; exit 1
          fi
          argocd app set ubrnms-prod-${{{{ env.SERVICE }}}} --helm-set rollout.canaryWeight=100
          argocd app sync ubrnms-prod-${{{{ env.SERVICE }}}}
        env:
          PROMETHEUS_URL: ${{{{ secrets.PROMETHEUS_URL }}}}
          ARGOCD_SERVER: ${{{{ secrets.ARGOCD_SERVER }}}}
          ARGOCD_AUTH_TOKEN: ${{{{ secrets.ARGOCD_AUTH_TOKEN }}}}

  rollback:
    name: Rollback (on failure)
    runs-on: ubuntu-latest
    needs: canary-validation
    if: failure()
    steps:
      - name: ArgoCD rollback
        run: argocd app rollback ubrnms-prod-${{{{ env.SERVICE }}}}
        env:
          ARGOCD_SERVER: ${{{{ secrets.ARGOCD_SERVER }}}}
          ARGOCD_AUTH_TOKEN: ${{{{ secrets.ARGOCD_AUTH_TOKEN }}}}
"""

SETUP_MAP = {
    "java": SETUP_JAVA,
    "nodejs": SETUP_NODE,
    "go": SETUP_GO,
    "python": SETUP_PYTHON,
}
SNYK_MAP = {
    "java": SNYK_JAVA,
    "nodejs": SNYK_NODE,
    "go": SNYK_GO,
    "python": SNYK_PYTHON,
}

for svc, (lang, build_cmd, test_cmd, cov_flag, _) in SERVICES.items():
    display = svc.replace("-", " ").title()
    setup = SETUP_MAP[lang].format(svc=svc)
    snyk = SNYK_MAP[lang].format(svc=svc)
    content = TEMPLATE.format(
        svc=svc, display=display,
        setup=setup, build_cmd=build_cmd,
        test_cmd=test_cmd, coverage_flag=cov_flag,
        snyk=snyk,
    )
    (BASE / f"{svc}.yml").write_text(content)
    print(f"Generated workflow: {svc}.yml")

print(f"Total: {len(SERVICES)} workflows")
