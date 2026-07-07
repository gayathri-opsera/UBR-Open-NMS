#!/usr/bin/env python3
"""
Opsera Code-to-Cloud Generator for UBR Open NMS (Senao)
Generates: bootstrap workflow, per-service CI/CD workflows,
           Dockerfiles, K8s manifests, ArgoCD applications.

Config: tenant=opsera, app=ubr-nms, region=us-west-2, env=dev
"""
import os, textwrap

# ─────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────
TENANT       = "opsera"
APP          = "ubr-nms"
ENV          = "dev"
REGION       = "us-west-2"
REGION_SHORT = "usw2"
HUB_CLUSTER  = f"argocd-{REGION_SHORT}"
SPOKE_CLUSTER= f"{TENANT}-{REGION_SHORT}-np"
ARGOCD_SERVER= f"argocd-{REGION_SHORT}.agent.opsera.dev"
NAMESPACE    = f"{TENANT}-{APP}-{ENV}"
BRANCH       = "main"
REPO         = f"gayathri-opsera/UBR-Open-NMS"
ROOT         = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ─────────────────────────────────────────────────────────────
# Services registry
# (name, lang, container_port, src_dir, has_ingress)
# ─────────────────────────────────────────────────────────────
SERVICES = [
    ("frontend",              "frontend", 8080,  "frontend",                        True),
    ("api-gateway",           "node",     3000,  "services/api-gateway",            True),
    ("auth-service",          "node",     3001,  "services/auth-service",           False),
    ("audit-service",         "node",     3007,  "services/audit-service",          False),
    ("notification-service",  "node",     3003,  "services/notification-service",   False),
    ("alarm-service",         "java",     8083,  "services/alarm-service",          False),
    ("config-service",        "java",     8084,  "services/config-service",         False),
    ("diagnostics-service",   "java",     8090,  "services/diagnostics-service",    False),
    ("health-monitor",        "java",     8092,  "services/health-monitor",         False),
    ("inventory-service",     "java",     8082,  "services/inventory-service",      False),
    ("kpi-aggregation-service","java",    8088,  "services/kpi-aggregation-service",False),
    ("kpi-query-service",     "java",     8089,  "services/kpi-query-service",      False),
    ("report-service",        "java",     8091,  "services/report-service",         False),
    ("topology-service",      "java",     8086,  "services/topology-service",       False),
    ("config-push-worker",    "go",       8080,  "services/config-push-worker",     False),
    ("discovery-service",     "go",       8081,  "services/discovery-service",      False),
    ("event-collector",       "go",       9090,  "services/event-collector",        False),
    ("kpi-collector",         "go",       8080,  "services/kpi-collector",          False),
    ("mobinet-sync",          "go",       8080,  "services/mobinet-sync",           False),
    ("mycom-forwarder",       "go",       8080,  "services/mycom-forwarder",        False),
    ("netcool-forwarder",     "go",       8080,  "services/netcool-forwarder",      False),
    ("syslog-forwarder",      "go",       8080,  "services/syslog-forwarder",       False),
]

def ecr_repo(svc_name):
    return f"{TENANT}/{APP}-{svc_name}"

def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)
    print(f"  ✅ {path.replace(ROOT+'/', '')}")

# ─────────────────────────────────────────────────────────────
# 1. Bootstrap workflow
# ─────────────────────────────────────────────────────────────
def gen_bootstrap():
    ecr_repos = "\n".join(
        f'          - {TENANT}/{APP}-{s[0]}' for s in SERVICES
    )
    content = f"""\
name: "00 - Bootstrap: UBR NMS Infrastructure"

on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'Environment to bootstrap'
        required: true
        type: choice
        options: [dev, qa, staging, prod, all]
        default: dev

env:
  TENANT: {TENANT}
  APP_NAME: {APP}
  AWS_REGION: {REGION}
  HUB_CLUSTER: {HUB_CLUSTER}
  SPOKE_CLUSTER: {SPOKE_CLUSTER}
  ARGOCD_SERVER: {ARGOCD_SERVER}

jobs:
  # ── 01 Pre-flight Checks ─────────────────────────────────────
  preflight:
    name: "01 - Pre-flight Checks"
    runs-on: ubuntu-latest
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{{{ secrets.AWS_ACCESS_KEY_ID }}}}
          aws-secret-access-key: ${{{{ secrets.AWS_SECRET_ACCESS_KEY }}}}
          aws-region: ${{{{ env.AWS_REGION }}}}

      - name: Get AWS Account Info
        run: |
          AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
          echo "AWS Account: ${{AWS_ACCOUNT}}"
          echo "Region: ${{{{ env.AWS_REGION }}}}"

      - name: Install kubectl
        uses: azure/setup-kubectl@v4

      - name: Check EKS Clusters
        run: |
          echo "Checking hub cluster: ${{{{ env.HUB_CLUSTER }}}}"
          aws eks describe-cluster --name ${{{{ env.HUB_CLUSTER }}}} --region ${{{{ env.AWS_REGION }}}} \
            --query 'cluster.status' --output text || echo "⚠️  Hub cluster not found - will be created"
          echo "Checking spoke cluster: ${{{{ env.SPOKE_CLUSTER }}}}"
          aws eks describe-cluster --name ${{{{ env.SPOKE_CLUSTER }}}} --region ${{{{ env.AWS_REGION }}}} \
            --query 'cluster.status' --output text || echo "⚠️  Spoke cluster not found - will be created"

      - name: Check ArgoCD Spoke Registration
        run: |
          aws eks update-kubeconfig --name ${{{{ env.HUB_CLUSTER }}}} --region ${{{{ env.AWS_REGION }}}} 2>/dev/null || echo "Hub cluster kubeconfig update skipped"
          kubectl get secret -n argocd -l argocd.argoproj.io/secret-type=cluster 2>/dev/null | grep ${{{{ env.SPOKE_CLUSTER }}}} \
            && echo "✅ Spoke registered" || echo "⚠️  Spoke not registered yet"

  # ── 02 ECR Repositories ──────────────────────────────────────
  ecr-setup:
    name: "02 - ECR Repositories"
    runs-on: ubuntu-latest
    needs: [preflight]
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{{{ secrets.AWS_ACCESS_KEY_ID }}}}
          aws-secret-access-key: ${{{{ secrets.AWS_SECRET_ACCESS_KEY }}}}
          aws-region: ${{{{ env.AWS_REGION }}}}

      - name: Create ECR Repositories (Idempotent)
        run: |
          REPOS=(
{ecr_repos}
          )
          for REPO in "${{{{REPOS[@]}}}}"; do
            if aws ecr describe-repositories --repository-names "${{{{REPO}}}}" --region ${{{{ env.AWS_REGION }}}} &>/dev/null; then
              echo "✅ ECR repo exists: ${{{{REPO}}}}"
            else
              aws ecr create-repository --repository-name "${{{{REPO}}}}" --region ${{{{ env.AWS_REGION }}}} \
                --image-scanning-configuration scanOnPush=true \
                --encryption-configuration encryptionType=AES256
              echo "✅ Created ECR repo: ${{{{REPO}}}}"
            fi
          done

  # ── 03 ArgoCD Configuration ───────────────────────────────────
  argocd-setup:
    name: "03 - ArgoCD Configuration"
    runs-on: ubuntu-latest
    needs: [preflight, ecr-setup]
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{{{ secrets.AWS_ACCESS_KEY_ID }}}}
          aws-secret-access-key: ${{{{ secrets.AWS_SECRET_ACCESS_KEY }}}}
          aws-region: ${{{{ env.AWS_REGION }}}}

      - name: Install kubectl
        uses: azure/setup-kubectl@v4

      - name: Connect to Hub Cluster
        run: |
          aws eks update-kubeconfig --name ${{{{ env.HUB_CLUSTER }}}} --region ${{{{ env.AWS_REGION }}}}

      - name: Register Spoke Cluster in ArgoCD (Idempotent)
        run: |
          SPOKE_ARN=$(aws eks describe-cluster --name ${{{{ env.SPOKE_CLUSTER }}}} \
            --region ${{{{ env.AWS_REGION }}}} --query 'cluster.arn' --output text 2>/dev/null || echo "")
          if [ -z "${{{{SPOKE_ARN}}}}" ]; then
            echo "⚠️  Spoke cluster not found, skipping registration"
            exit 0
          fi
          if kubectl get secret -n argocd -l argocd.argoproj.io/secret-type=cluster 2>/dev/null | grep -q ${{{{ env.SPOKE_CLUSTER }}}}; then
            echo "✅ Spoke already registered"
          else
            kubectl apply -f - <<EOF
          apiVersion: v1
          kind: Secret
          metadata:
            name: ${{{{ env.SPOKE_CLUSTER }}}}
            namespace: argocd
            labels:
              argocd.argoproj.io/secret-type: cluster
          type: Opaque
          stringData:
            name: ${{{{ env.SPOKE_CLUSTER }}}}
            server: https://kubernetes.default.svc
            config: '{{"execProviderConfig":{{"command":"aws","args":["eks","get-token","--cluster-name","${{{{ env.SPOKE_CLUSTER }}}}"],"apiVersion":"client.authentication.k8s.io/v1beta1"}}}}'
          EOF
            echo "✅ Spoke cluster registered"
          fi

      - name: Setup ArgoCD Repository Secret (Idempotent)
        run: |
          if kubectl get secret -n argocd ubr-nms-repo &>/dev/null; then
            echo "✅ ArgoCD repo secret exists"
          else
            kubectl create secret generic ubr-nms-repo \
              --namespace argocd \
              --from-literal=type=git \
              --from-literal=url=https://github.com/{REPO}.git \
              --from-literal=password=${{{{ secrets.GITHUB_TOKEN }}}} \
              --from-literal=username=x-access-token
            kubectl label secret ubr-nms-repo -n argocd argocd.argoproj.io/secret-type=repository
            echo "✅ ArgoCD repo secret created"
          fi

  # ── 04 Kubernetes Setup ───────────────────────────────────────
  k8s-setup:
    name: "04 - Kubernetes Setup"
    runs-on: ubuntu-latest
    needs: [preflight, argocd-setup]
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{{{ secrets.AWS_ACCESS_KEY_ID }}}}
          aws-secret-access-key: ${{{{ secrets.AWS_SECRET_ACCESS_KEY }}}}
          aws-region: ${{{{ env.AWS_REGION }}}}

      - name: Install kubectl
        uses: azure/setup-kubectl@v4

      - name: Connect to Spoke Cluster
        run: |
          aws eks update-kubeconfig --name ${{{{ env.SPOKE_CLUSTER }}}} --region ${{{{ env.AWS_REGION }}}}

      - name: Setup Namespace (Idempotent)
        run: |
          ENV="${{{{ inputs.environment }}}}"
          [ "${{{{ENV}}}}" = "all" ] && ENVS="dev qa staging prod" || ENVS="${{{{ENV}}}}"
          for E in ${{{{ENVS}}}}; do
            NS="{TENANT}-{APP}-${{{{E}}}}"
            kubectl create namespace "${{{{NS}}}}" --dry-run=client -o yaml | kubectl apply -f -
            echo "✅ Namespace ready: ${{{{NS}}}}"
          done

  # ── 05 Verification ───────────────────────────────────────────
  verify:
    name: "05 - Verification"
    runs-on: ubuntu-latest
    needs: [preflight, ecr-setup, argocd-setup, k8s-setup]
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{{{ secrets.AWS_ACCESS_KEY_ID }}}}
          aws-secret-access-key: ${{{{ secrets.AWS_SECRET_ACCESS_KEY }}}}
          aws-region: ${{{{ env.AWS_REGION }}}}

      - name: Install kubectl
        uses: azure/setup-kubectl@v4

      - name: Verify All Components
        run: |
          echo "=== ECR Repositories ==="
          aws ecr describe-repositories --region ${{{{ env.AWS_REGION }}}} \
            --query 'repositories[?starts_with(repositoryName, `{TENANT}/{APP}`)].repositoryName' \
            --output table

          echo "=== Namespaces ==="
          aws eks update-kubeconfig --name ${{{{ env.SPOKE_CLUSTER }}}} --region ${{{{ env.AWS_REGION }}}} 2>/dev/null
          kubectl get namespaces | grep {TENANT}-{APP} || echo "No namespaces yet"

          echo "✅ Bootstrap verification complete"
"""
    path = os.path.join(ROOT, ".github/workflows/00-bootstrap-infrastructure-ubr-nms.yaml")
    write(path, content)


# ─────────────────────────────────────────────────────────────
# 2. CI/CD workflow per service
# ─────────────────────────────────────────────────────────────
def cicd_workflow(svc_name, lang, port, src_dir):
    svc_safe = svc_name.replace("-", "_").upper()
    ecr = ecr_repo(svc_name)
    # Path trigger: src dir + workflow file itself
    path_trigger = f"      - '{src_dir}/**'\n      - '.github/workflows/cicd-{APP}-{svc_name}-{ENV}.yaml'"
    # Dockerfile is already in the src_dir, build context is repo root
    if svc_name == "frontend":
        dockerfile_path = "frontend/Dockerfile"
        build_context = "frontend"
    else:
        dockerfile_path = f"{src_dir}/Dockerfile"
        build_context = src_dir

    return f"""\
name: "CI/CD - {APP} {svc_name} ({ENV})"

on:
  push:
    branches: ["{BRANCH}"]
    paths:
{path_trigger}
  workflow_dispatch:
    inputs:
      force_deploy:
        description: 'Force deploy even without code changes'
        type: boolean
        default: false

env:
  APP_NAME: {APP}
  SERVICE: {svc_name}
  TENANT: {TENANT}
  ENV: {ENV}
  REGION: {REGION}
  ECR_REPO: {ecr}
  NAMESPACE: {NAMESPACE}
  HUB_CLUSTER: {HUB_CLUSTER}
  SPOKE_CLUSTER: {SPOKE_CLUSTER}

permissions:
  contents: write
  id-token: write
  security-events: write

jobs:
  # ── Stage 1: Bootstrap Prerequisites ─────────────────────────
  check-bootstrap-prerequisites:
    name: "01 - Check Prerequisites"
    runs-on: ubuntu-latest
    outputs:
      ready: ${{{{ steps.check.outputs.ready }}}}
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{{{ secrets.AWS_ACCESS_KEY_ID }}}}
          aws-secret-access-key: ${{{{ secrets.AWS_SECRET_ACCESS_KEY }}}}
          aws-region: ${{{{ env.REGION }}}}

      - name: Check Bootstrap Prerequisites
        id: check
        run: |
          if ! aws ecr describe-repositories --repository-names "${{{{ env.ECR_REPO }}}}" \
               --region "${{{{ env.REGION }}}}" &>/dev/null; then
            echo "❌ ECR repository '${{{{ env.ECR_REPO }}}}' not found."
            echo "   Run: gh workflow run 00-bootstrap-infrastructure-ubr-nms.yaml -f environment=dev"
            exit 1
          fi
          echo "ready=true" >> $GITHUB_OUTPUT
          echo "✅ Prerequisites satisfied"

  # ── Stage 2: Security Scan (Gitleaks, warn-only) ─────────────
  security-scan:
    name: "02 - Security Scan"
    runs-on: ubuntu-latest
    needs: [check-bootstrap-prerequisites]
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Gitleaks Secret Scan
        uses: gitleaks/gitleaks-action@v2
        continue-on-error: true
        env:
          GITLEAKS_LICENSE: ${{{{ secrets.GITLEAKS_LICENSE }}}}

      - name: Upload Gitleaks report
        if: always()
        uses: actions/upload-artifact@v4
        continue-on-error: true
        with:
          name: gitleaks-{svc_name}-${{{{ github.sha }}}}
          path: results.sarif
          retention-days: 30

  # ── Stage 3: Build Image ──────────────────────────────────────
  build-image:
    name: "03 - Build Image"
    runs-on: ubuntu-latest
    needs: [check-bootstrap-prerequisites, security-scan]
    if: always() && needs.check-bootstrap-prerequisites.outputs.ready == 'true'
    outputs:
      image-tag: ${{{{ steps.tag.outputs.tag }}}}
      ecr-uri: ${{{{ steps.login.outputs.registry }}}}/${{{{ env.ECR_REPO }}}}
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{{{ secrets.AWS_ACCESS_KEY_ID }}}}
          aws-secret-access-key: ${{{{ secrets.AWS_SECRET_ACCESS_KEY }}}}
          aws-region: ${{{{ env.REGION }}}}

      - name: Login to ECR
        id: login
        uses: aws-actions/amazon-ecr-login@v2

      - name: Generate image tag
        id: tag
        run: |
          SHORT_SHA="${{{{ github.sha }}}}"
          SHORT_SHA="${{{{SHORT_SHA:0:8}}}}"
          TAG="${{{{ env.ENV }}}}-${{{{SHORT_SHA}}}}-$(date +%Y%m%d%H%M%S)"
          echo "tag=${{{{TAG}}}}" >> $GITHUB_OUTPUT
          echo "✅ Image tag: ${{{{TAG}}}}"

      - name: Build Docker image
        run: |
          IMAGE_URI="${{{{ steps.login.outputs.registry }}}}/${{{{ env.ECR_REPO }}}}:${{{{ steps.tag.outputs.tag }}}}"
          docker build \\
            -f {dockerfile_path} \\
            -t "${{{{IMAGE_URI}}}}" \\
            {build_context}
          echo "IMAGE_URI=${{{{IMAGE_URI}}}}" >> $GITHUB_ENV
          echo "✅ Build complete: ${{{{IMAGE_URI}}}}"

  # ── Stage 4: Grype Container Scan ────────────────────────────
  grype-scan:
    name: "04 - Grype Vulnerability Scan"
    runs-on: ubuntu-latest
    needs: [build-image]
    continue-on-error: true
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{{{ secrets.AWS_ACCESS_KEY_ID }}}}
          aws-secret-access-key: ${{{{ secrets.AWS_SECRET_ACCESS_KEY }}}}
          aws-region: ${{{{ env.REGION }}}}

      - name: Login to ECR
        uses: aws-actions/amazon-ecr-login@v2

      - name: Grype Vulnerability Scan
        uses: anchore/scan-action@v4
        continue-on-error: true
        with:
          image: "${{{{ needs.build-image.outputs.ecr-uri }}}}:${{{{ needs.build-image.outputs.image-tag }}}}"
          fail-build: false
          severity-cutoff: critical
          output-format: sarif

      - name: Upload Grype SARIF
        uses: github/codeql-action/upload-sarif@v3
        continue-on-error: true
        if: always()
        with:
          sarif_file: results.sarif

  # ── Stage 5: Push to ECR ──────────────────────────────────────
  push-to-ecr:
    name: "05 - Push to ECR"
    runs-on: ubuntu-latest
    needs: [build-image, grype-scan]
    if: always() && needs.build-image.result == 'success'
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{{{ secrets.AWS_ACCESS_KEY_ID }}}}
          aws-secret-access-key: ${{{{ secrets.AWS_SECRET_ACCESS_KEY }}}}
          aws-region: ${{{{ env.REGION }}}}

      - name: Login to ECR
        uses: aws-actions/amazon-ecr-login@v2

      - name: Push image to ECR
        run: |
          docker push "${{{{ needs.build-image.outputs.ecr-uri }}}}:${{{{ needs.build-image.outputs.image-tag }}}}"
          echo "✅ Pushed: ${{{{ needs.build-image.outputs.ecr-uri }}}}:${{{{ needs.build-image.outputs.image-tag }}}}"

  # ── Stage 6: Update Manifests ─────────────────────────────────
  update-manifests:
    name: "06 - Update K8s Manifests"
    runs-on: ubuntu-latest
    needs: [build-image, push-to-ecr]
    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{{{ secrets.GITHUB_TOKEN }}}}
          fetch-depth: 0

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{{{ secrets.AWS_ACCESS_KEY_ID }}}}
          aws-secret-access-key: ${{{{ secrets.AWS_SECRET_ACCESS_KEY }}}}
          aws-region: ${{{{ env.REGION }}}}

      - name: Install kustomize
        run: |
          curl -s "https://raw.githubusercontent.com/kubernetes-sigs/kustomize/master/hack/install_kustomize.sh" | bash
          sudo mv kustomize /usr/local/bin/

      - name: Update image tag in kustomization
        run: |
          AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
          ECR_URI="${{{{AWS_ACCOUNT}}}}.dkr.ecr.${{{{ env.REGION }}}}.amazonaws.com/${{{{ env.ECR_REPO }}}}"
          OVERLAY=".opsera-{APP}/k8s/{svc_name}/overlays/{ENV}"

          kustomize edit set image "PLACEHOLDER_{svc_safe}_ECR_URI=${{{{ECR_URI}}}}:${{{{ needs.build-image.outputs.image-tag }}}}"
        working-directory: ${{{{ github.workspace }}}}/${{{{OVERLAY}}}}

      - name: Validate kustomize build
        run: |
          OVERLAY=".opsera-{APP}/k8s/{svc_name}/overlays/{ENV}"
          if ! kubectl kustomize "${{{{OVERLAY}}}}" > /dev/null 2>&1; then
            echo "❌ Kustomize build validation FAILED"
            kubectl kustomize "${{{{OVERLAY}}}}"
            exit 1
          fi
          echo "✅ Kustomize build validated"

      - name: Commit and push manifests
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          if git diff --quiet && git diff --cached --quiet; then
            echo "No changes to commit"
            exit 0
          fi
          git add -A
          git commit -m "chore: update {svc_name} image to ${{{{ needs.build-image.outputs.image-tag }}}} [skip ci]"
          for i in 1 2 3; do
            if git push origin {BRANCH}; then
              echo "✅ Pushed manifests"
              exit 0
            fi
            echo "Push failed, retrying (${{{{i}}}}/3)..."
            if ! git pull --rebase origin {BRANCH}; then
              git rebase --abort || true
              git pull --no-rebase origin {BRANCH}
            fi
            sleep 3
          done
          exit 1

  # ── Stage 7: Create/Update ArgoCD App ─────────────────────────
  create-argocd-app:
    name: "07 - Create ArgoCD App"
    runs-on: ubuntu-latest
    needs: [update-manifests]
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{{{ secrets.AWS_ACCESS_KEY_ID }}}}
          aws-secret-access-key: ${{{{ secrets.AWS_SECRET_ACCESS_KEY }}}}
          aws-region: ${{{{ env.REGION }}}}

      - name: Install kubectl
        uses: azure/setup-kubectl@v4

      - name: Connect to Hub Cluster
        run: aws eks update-kubeconfig --name ${{{{ env.HUB_CLUSTER }}}} --region ${{{{ env.REGION }}}}

      - name: Apply ArgoCD Application manifest
        run: |
          kubectl apply -f .opsera-{APP}/argocd/{ENV}/{svc_name}-app.yaml
          echo "✅ ArgoCD app created/updated: {TENANT}-{APP}-{svc_name}-{ENV}"

  # ── Stage 8 & 9: Refresh ECR Secret + ArgoCD Refresh ────────
  refresh-ecr-secret:
    name: "08 - Refresh ECR Secret (Spoke)"
    runs-on: ubuntu-latest
    needs: [create-argocd-app]
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{{{ secrets.AWS_ACCESS_KEY_ID }}}}
          aws-secret-access-key: ${{{{ secrets.AWS_SECRET_ACCESS_KEY }}}}
          aws-region: ${{{{ env.REGION }}}}

      - name: Install kubectl
        uses: azure/setup-kubectl@v4

      - name: Connect to Spoke Cluster
        run: aws eks update-kubeconfig --name ${{{{ env.SPOKE_CLUSTER }}}} --region ${{{{ env.REGION }}}}

      - name: Refresh ECR pull secret
        run: |
          AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
          ECR_TOKEN=$(aws ecr get-login-password --region ${{{{ env.REGION }}}})
          kubectl create secret docker-registry ecr-pull-secret \\
            --namespace ${{{{ env.NAMESPACE }}}} \\
            --docker-server="${{{{AWS_ACCOUNT}}}}.dkr.ecr.${{{{ env.REGION }}}}.amazonaws.com" \\
            --docker-username=AWS \\
            --docker-password="${{{{ECR_TOKEN}}}}" \\
            --dry-run=client -o yaml | kubectl apply -f -
          echo "✅ ECR pull secret refreshed"

  argocd-refresh:
    name: "09 - ArgoCD Hard Refresh"
    runs-on: ubuntu-latest
    needs: [create-argocd-app]
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{{{ secrets.AWS_ACCESS_KEY_ID }}}}
          aws-secret-access-key: ${{{{ secrets.AWS_SECRET_ACCESS_KEY }}}}
          aws-region: ${{{{ env.REGION }}}}

      - name: Install kubectl
        uses: azure/setup-kubectl@v4

      - name: Connect to Hub Cluster
        run: aws eks update-kubeconfig --name ${{{{ env.HUB_CLUSTER }}}} --region ${{{{ env.REGION }}}}

      - name: ArgoCD Hard Refresh
        run: |
          APP_ARGOCD="{TENANT}-{APP}-{svc_name}-{ENV}"
          kubectl patch app "${{{{APP_ARGOCD}}}}" -n argocd --type merge \\
            -p '{{"metadata":{{"annotations":{{"argocd.argoproj.io/refresh":"hard"}}}}}}'
          echo "✅ Hard refresh triggered: ${{{{APP_ARGOCD}}}}"
          sleep 5

  # ── Stage 10: ArgoCD Sync ─────────────────────────────────────
  argocd-sync:
    name: "10 - ArgoCD Sync"
    runs-on: ubuntu-latest
    needs: [argocd-refresh, refresh-ecr-secret]
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{{{ secrets.AWS_ACCESS_KEY_ID }}}}
          aws-secret-access-key: ${{{{ secrets.AWS_SECRET_ACCESS_KEY }}}}
          aws-region: ${{{{ env.REGION }}}}

      - name: Install kubectl
        uses: azure/setup-kubectl@v4

      - name: Connect to Hub Cluster
        run: aws eks update-kubeconfig --name ${{{{ env.HUB_CLUSTER }}}} --region ${{{{ env.REGION }}}}

      - name: Trigger ArgoCD Sync
        run: |
          APP_ARGOCD="{TENANT}-{APP}-{svc_name}-{ENV}"
          kubectl patch app "${{{{APP_ARGOCD}}}}" -n argocd --type merge \\
            -p '{{"operation":{{"initiatedBy":{{"username":"github-actions"}},"sync":{{"revision":"HEAD"}}}}}}'
          echo "✅ Sync triggered"

      - name: Wait for Sync Completion
        run: |
          APP_ARGOCD="{TENANT}-{APP}-{svc_name}-{ENV}"
          for i in $(seq 1 60); do
            HEALTH=$(kubectl get app "${{{{APP_ARGOCD}}}}" -n argocd \\
              -o jsonpath='{{.status.health.status}}' 2>/dev/null || echo "Unknown")
            OPERATION=$(kubectl get app "${{{{APP_ARGOCD}}}}" -n argocd \\
              -o jsonpath='{{.status.operationState.phase}}' 2>/dev/null || echo "Unknown")
            echo "[${{{{i}}}}/60] Health: ${{{{HEALTH}}}}, Operation: ${{{{OPERATION}}}}"
            if [ "${{{{HEALTH}}}}" = "Healthy" ] && [ "${{{{OPERATION}}}}" = "Succeeded" ]; then
              echo "✅ ArgoCD sync succeeded"
              exit 0
            fi
            sleep 10
          done
          echo "⚠️  Sync timeout — checking status"
          kubectl get app "${{{{APP_ARGOCD}}}}" -n argocd -o yaml | grep -A5 "operationState:"
          exit 1

  # ── Stage 11: Verify Deployment ───────────────────────────────
  verify-deployment:
    name: "11 - Verify Deployment"
    runs-on: ubuntu-latest
    needs: [build-image, argocd-sync]
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{{{ secrets.AWS_ACCESS_KEY_ID }}}}
          aws-secret-access-key: ${{{{ secrets.AWS_SECRET_ACCESS_KEY }}}}
          aws-region: ${{{{ env.REGION }}}}

      - name: Install kubectl
        uses: azure/setup-kubectl@v4

      - name: Connect to Spoke Cluster
        run: aws eks update-kubeconfig --name ${{{{ env.SPOKE_CLUSTER }}}} --region ${{{{ env.REGION }}}}

      - name: Wait for Deployment
        run: |
          NS="{NAMESPACE}"
          SVC="{svc_name}"
          for i in $(seq 1 60); do
            if kubectl get deployment "${{{{SVC}}}}" -n "${{{{NS}}}}" &>/dev/null; then
              echo "✅ Deployment found"
              break
            fi
            echo "⏳ Waiting for deployment... (${{{{i}}}}/60)"
            sleep 5
          done
          kubectl wait --for=condition=available --timeout=300s deployment/"${{{{SVC}}}}" -n "${{{{NS}}}}"
          RUNNING=$(kubectl get pods -n "${{{{NS}}}}" -l app="${{{{SVC}}}}" \\
            --field-selector=status.phase=Running -o name | wc -l)
          echo "✅ ${{{{RUNNING}}}} pod(s) running for {svc_name}"
          kubectl get pods -n "${{{{NS}}}}" -l app="{svc_name}" -o wide

  # ── Stage 12: Deployment Landscape (MUST BE LAST) ─────────────
  deployment-landscape:
    name: "12 - Deployment Landscape"
    runs-on: ubuntu-latest
    needs: [verify-deployment]
    if: success()
    steps:
      - name: Record Deployment
        run: |
          echo "==================================="
          echo "  DEPLOYMENT COMPLETE"
          echo "==================================="
          echo "  Service:   {svc_name}"
          echo "  Image:     ${{{{ needs.build-image.outputs.image-tag }}}}"
          echo "  Namespace: {NAMESPACE}"
          echo "  Cluster:   {SPOKE_CLUSTER}"
          echo "  Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
          echo "==================================="
"""

# ─────────────────────────────────────────────────────────────
# 3. K8s Manifests
# ─────────────────────────────────────────────────────────────
def gen_k8s_base_deployment(svc_name, port):
    svc_safe = svc_name.replace("-", "_").upper()
    return f"""\
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {svc_name}
  labels:
    app: {svc_name}
    tenant: {TENANT}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: {svc_name}
  template:
    metadata:
      labels:
        app: {svc_name}
        tenant: {TENANT}
    spec:
      serviceAccountName: {APP}
      imagePullSecrets:
        - name: ecr-pull-secret
      containers:
        - name: {svc_name}
          image: PLACEHOLDER_{svc_safe}_ECR_URI
          ports:
            - containerPort: {port}
          env:
            - name: ENV
              value: "{ENV}"
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /health
              port: {port}
            initialDelaySeconds: 30
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: {port}
            initialDelaySeconds: 60
            periodSeconds: 30
      securityContext:
        runAsNonRoot: true
"""

def gen_k8s_base_service(svc_name, port):
    return f"""\
apiVersion: v1
kind: Service
metadata:
  name: {svc_name}
  labels:
    app: {svc_name}
    tenant: {TENANT}
spec:
  selector:
    app: {svc_name}
  ports:
    - name: http
      port: {port}
      targetPort: {port}
  type: ClusterIP
"""

def gen_k8s_base_ingress(svc_name, port, label):
    host = f"{APP}-{label}-{ENV}.agent.opsera.dev"
    return f"""\
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {svc_name}
  annotations:
    kubernetes.io/ingress.class: nginx
    nginx.ingress.kubernetes.io/rewrite-target: /
  labels:
    app: {svc_name}
    tenant: {TENANT}
spec:
  ingressClassName: nginx
  rules:
    - host: {host}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {svc_name}
                port:
                  number: {port}
"""

def gen_k8s_base_kustomization(svc_name, has_ingress):
    resources = "  - deployment.yaml\n  - service.yaml"
    if has_ingress:
        resources += "\n  - ingress.yaml"
    svc_safe = svc_name.replace("-", "_").upper()
    return f"""\
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
{resources}
"""

def gen_k8s_overlay_kustomization(svc_name):
    svc_safe = svc_name.replace("-", "_").upper()
    return f"""\
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: {NAMESPACE}

resources:
  - ../../base
  - namespace.yaml

images:
  - name: PLACEHOLDER_{svc_safe}_ECR_URI
    newName: PLACEHOLDER_{svc_safe}_ECR_URI
    newTag: v1.0.0

labels:
  - pairs:
      environment: {ENV}
      tenant: {TENANT}
    includeSelectors: false
"""

def gen_k8s_namespace():
    return f"""\
apiVersion: v1
kind: Namespace
metadata:
  name: {NAMESPACE}
  labels:
    tenant: {TENANT}
    app: {APP}
    environment: {ENV}
"""

def gen_k8s_sa():
    return f"""\
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {APP}
  labels:
    app: {APP}
    tenant: {TENANT}
"""

# ─────────────────────────────────────────────────────────────
# 4. ArgoCD Application
# ─────────────────────────────────────────────────────────────
def gen_argocd_app(svc_name):
    return f"""\
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: {TENANT}-{APP}-{svc_name}-{ENV}
  namespace: argocd
  labels:
    tenant: {TENANT}
    app: {APP}
    service: {svc_name}
    environment: {ENV}
spec:
  project: default
  source:
    repoURL: https://github.com/{REPO}.git
    targetRevision: {BRANCH}
    path: .opsera-{APP}/k8s/{svc_name}/overlays/{ENV}
  destination:
    name: {SPOKE_CLUSTER}
    namespace: {NAMESPACE}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
"""

# ─────────────────────────────────────────────────────────────
# 5. Shared base files
# ─────────────────────────────────────────────────────────────
def gen_opsera_config():
    return f"""\
# Opsera Code-to-Cloud Configuration
# UBR Open NMS - Senao
tenant: {TENANT}
app: {APP}
region: {REGION}
hub_cluster: {HUB_CLUSTER}
spoke_cluster: {SPOKE_CLUSTER}
argocd_server: {ARGOCD_SERVER}
namespace_pattern: "{TENANT}-{APP}-{{env}}"
branch: {BRANCH}
environments:
  - {ENV}
services:
""" + "\n".join(f"  - {s[0]}" for s in SERVICES)

def gen_nginx_conf():
    return """\
worker_processes auto;
pid /tmp/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    sendfile on;
    client_body_temp_path /tmp/client_temp;
    proxy_temp_path /tmp/proxy_temp;
    fastcgi_temp_path /tmp/fastcgi_temp;
    uwsgi_temp_path /tmp/uwsgi_temp;
    scgi_temp_path /tmp/scgi_temp;
    gzip on;
    gzip_types text/css application/javascript application/json;

    server {
        listen 8080;
        server_name _;
        root /usr/share/nginx/html;
        index index.html;

        location / {
            try_files $uri $uri/ /index.html;
        }

        location /health {
            return 200 'OK';
            add_header Content-Type text/plain;
        }
    }
}
"""

# ─────────────────────────────────────────────────────────────
# Main generation
# ─────────────────────────────────────────────────────────────
def main():
    print(f"\n🚀 Generating Code-to-Cloud infrastructure for {APP}...")
    print(f"   Tenant: {TENANT}  |  Region: {REGION}  |  Env: {ENV}")
    print(f"   Services: {len(SERVICES)}\n")

    # 1. Bootstrap
    print("📋 Bootstrap workflow:")
    gen_bootstrap()

    # 2. CI/CD workflows + K8s manifests + ArgoCD apps
    print("\n⚙️  Service workflows + manifests:")
    for svc_name, lang, port, src_dir, has_ingress in SERVICES:
        # CI/CD workflow
        wf = cicd_workflow(svc_name, lang, port, src_dir)
        wf_path = os.path.join(ROOT, f".github/workflows/cicd-{APP}-{svc_name}-{ENV}.yaml")
        write(wf_path, wf)

        # K8s base
        base = os.path.join(ROOT, f".opsera-{APP}/k8s/{svc_name}/base")
        write(os.path.join(base, "deployment.yaml"), gen_k8s_base_deployment(svc_name, port))
        write(os.path.join(base, "service.yaml"),    gen_k8s_base_service(svc_name, port))
        if has_ingress:
            label = "frontend" if svc_name == "frontend" else "dev"
            write(os.path.join(base, "ingress.yaml"), gen_k8s_base_ingress(svc_name, port, label))
        write(os.path.join(base, "kustomization.yaml"), gen_k8s_base_kustomization(svc_name, has_ingress))
        write(os.path.join(base, "serviceaccount.yaml"), gen_k8s_sa())

        # K8s overlay
        overlay = os.path.join(ROOT, f".opsera-{APP}/k8s/{svc_name}/overlays/{ENV}")
        write(os.path.join(overlay, "kustomization.yaml"), gen_k8s_overlay_kustomization(svc_name))
        write(os.path.join(overlay, "namespace.yaml"),     gen_k8s_namespace())

        # ArgoCD app
        argocd_dir = os.path.join(ROOT, f".opsera-{APP}/argocd/{ENV}")
        write(os.path.join(argocd_dir, f"{svc_name}-app.yaml"), gen_argocd_app(svc_name))

    # 3. Shared files
    print("\n📁 Shared configuration files:")
    write(os.path.join(ROOT, f".opsera-{APP}/opsera-config.yaml"), gen_opsera_config())
    write(os.path.join(ROOT, f".opsera-{APP}/nginx.conf"), gen_nginx_conf())

    print(f"\n✅ Done! Generated all Code-to-Cloud infrastructure files.")
    print(f"   Folder: .opsera-{APP}/")
    print(f"   Workflows: .github/workflows/")

if __name__ == "__main__":
    main()
