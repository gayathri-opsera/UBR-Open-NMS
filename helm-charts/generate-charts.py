#!/usr/bin/env python3
"""
Generates Helm chart stubs for all UBR NMS microservices.
Each chart reuses the templates from auth-service with service-specific values.
"""
import os
import pathlib

BASE = pathlib.Path(__file__).parent

# Service definitions: name → (port, namespace, hpa_min, hpa_max, hpa_cpu%, is_java)
SERVICES = {
    "alarm-service":           (8080, "ubr-platform", 4,  16, 70, True),
    "inventory-service":       (8080, "ubr-platform", 2,  8,  70, True),
    "kpi-aggregation-service": (8080, "ubr-platform", 4,  12, 60, True),
    "kpi-query-service":       (8089, "ubr-platform", 2,  8,  70, True),
    "diagnostics-service":     (8090, "ubr-platform", 2,  8,  70, True),
    "report-service":          (8091, "ubr-platform", 2,  6,  70, False),  # Python
    "config-management-service":(8080,"ubr-platform", 2,  8,  70, True),
    "topology-service":        (8080, "ubr-platform", 2,  8,  70, True),
    "notification-service":    (3030, "ubr-platform", 2,  8,  70, False),  # Node.js
    "audit-service":           (3040, "ubr-platform", 2,  6,  70, False),  # Node.js
    "event-collector":         (8080, "ubr-platform", 6,  20, 50, True),
    "kpi-collector":           (8080, "ubr-platform", 8,  30, 50, True),
    "discovery-service":       (8080, "ubr-platform", 2,  8,  70, False),  # Go
    "api-gateway":             (3010, "ubr-ingress",  2,  10, 60, False),  # Node.js
    "health-monitor":          (8092, "ubr-platform", 1,  3,  70, True),
}

CHART_YAML = """\
apiVersion: v2
name: {name}
description: UBR NMS {display_name}
type: application
version: 1.0.0
appVersion: "1.0.0"
dependencies:
  - name: ubrnms-common
    version: "1.0.0"
    repository: "file://../ubrnms-common"
"""

VALUES_YAML = """\
replicaCount: 2

image:
  repository: ubrnms/{name}
  pullPolicy: IfNotPresent
  tag: "latest"

nameOverride: ""
fullnameOverride: ""

serviceAccount:
  create: true
  annotations: {{}}
  name: ""

service:
  type: ClusterIP
  port: 80
  targetPort: {port}

containerPort: {port}

resources:
  requests:
    cpu: "{cpu_req}"
    memory: "{mem_req}"
  limits:
    cpu: "{cpu_lim}"
    memory: "{mem_lim}"

autoscaling:
  enabled: true
  minReplicas: {hpa_min}
  maxReplicas: {hpa_max}
  targetCPUUtilizationPercentage: {hpa_cpu}

probes:
  liveness:
    initialDelaySeconds: {liveness_delay}
    periodSeconds: 15
    timeoutSeconds: 5
    failureThreshold: 3
  readiness:
    initialDelaySeconds: 10
    periodSeconds: 10
    timeoutSeconds: 3
    failureThreshold: 5

namespace: {namespace}

nodeSelector: {{}}
tolerations: []
affinity: {{}}

ingress:
  enabled: false
  className: "nginx"
  annotations: {{}}
  hosts: []
  tls: []

env:
  - name: SERVICE_NAME
    value: "{name}"

networkPolicy:
  enabled: true
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ubr-platform
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ubr-ingress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ubr-data
"""

DEPLOYMENT_YAML = """\
{{{{ include "ubrnms-common.fullname" . | indent 0 }}}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{{{ include "ubrnms-common.fullname" . }}}}
  namespace: {{{{ .Values.namespace | default "{namespace}" }}}}
  labels:
    {{{{- include "ubrnms-common.labels" . | nindent 4 }}}}
spec:
  {{{{- if not .Values.autoscaling.enabled }}}}
  replicas: {{{{ .Values.replicaCount }}}}
  {{{{- end }}}}
  selector:
    matchLabels:
      {{{{- include "ubrnms-common.selectorLabels" . | nindent 6 }}}}
  template:
    metadata:
      labels:
        {{{{- include "ubrnms-common.selectorLabels" . | nindent 8 }}}}
    spec:
      serviceAccountName: {{{{ include "ubrnms-common.serviceAccountName" . }}}}
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
      containers:
        - name: {{{{ .Chart.Name }}}}
          image: "{{{{ .Values.image.repository }}}}:{{{{ .Values.image.tag | default .Chart.AppVersion }}}}"
          imagePullPolicy: {{{{ .Values.image.pullPolicy }}}}
          ports:
            - name: http
              containerPort: {{{{ .Values.containerPort }}}}
              protocol: TCP
          env:
            {{{{- toYaml .Values.env | nindent 12 }}}}
          livenessProbe:
            {{{{- include "ubrnms-common.livenessProbe" . | nindent 12 }}}}
          readinessProbe:
            {{{{- include "ubrnms-common.readinessProbe" . | nindent 12 }}}}
          resources:
            {{{{- toYaml .Values.resources | nindent 12 }}}}
"""


def resource_sizing(is_java: bool):
    if is_java:
        return "200m", "512Mi", "1", "1Gi", 45  # cpu_req, mem_req, cpu_lim, mem_lim, liveness_delay
    else:
        return "100m", "256Mi", "500m", "512Mi", 20


def generate_charts():
    for name, (port, ns, hpa_min, hpa_max, hpa_cpu, is_java) in SERVICES.items():
        chart_dir = BASE / name
        templates_dir = chart_dir / "templates"
        templates_dir.mkdir(parents=True, exist_ok=True)

        display_name = name.replace("-", " ").title()
        cpu_req, mem_req, cpu_lim, mem_lim, liveness_delay = resource_sizing(is_java)

        # Chart.yaml
        (chart_dir / "Chart.yaml").write_text(
            CHART_YAML.format(name=name, display_name=display_name)
        )

        # values.yaml
        (chart_dir / "values.yaml").write_text(
            VALUES_YAML.format(
                name=name, port=port, namespace=ns,
                hpa_min=hpa_min, hpa_max=hpa_max, hpa_cpu=hpa_cpu,
                cpu_req=cpu_req, mem_req=mem_req,
                cpu_lim=cpu_lim, mem_lim=mem_lim,
                liveness_delay=liveness_delay,
            )
        )

        # templates/deployment.yaml — symlink to auth-service template for DRY
        deploy_target = templates_dir / "deployment.yaml"
        deploy_target.write_text(
            "{{- include \"ubrnms-common.fullname\" . -}}\n"
            + open(BASE / "auth-service" / "templates" / "deployment.yaml").read()
            .replace("ubr-platform", ns)
        )

        # templates/service.yaml — copy from auth-service
        (templates_dir / "service.yaml").write_text(
            open(BASE / "auth-service" / "templates" / "service.yaml").read()
            .replace("ubr-platform", ns)
        )

        print(f"Generated chart: {name}")


if __name__ == "__main__":
    generate_charts()
    print("Done.")
