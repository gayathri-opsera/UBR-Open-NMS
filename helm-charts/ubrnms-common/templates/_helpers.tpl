{{/*
Expand the name of the chart.
*/}}
{{- define "ubrnms-common.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "ubrnms-common.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "ubrnms-common.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{ include "ubrnms-common.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: ubrnms
{{- end }}

{{/*
Selector labels
*/}}
{{- define "ubrnms-common.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ubrnms-common.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
ServiceAccount name
*/}}
{{- define "ubrnms-common.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "ubrnms-common.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Standard environment variables for database/messaging connectivity.
These reference Kubernetes Secrets via secretKeyRef.
*/}}
{{- define "ubrnms-common.envFrom" -}}
- secretRef:
    name: {{ include "ubrnms-common.fullname" . }}-secrets
    optional: true
- configMapRef:
    name: {{ include "ubrnms-common.fullname" . }}-config
    optional: true
{{- end }}

{{/*
Standard liveness probe
*/}}
{{- define "ubrnms-common.livenessProbe" -}}
httpGet:
  path: /healthz
  port: http
initialDelaySeconds: {{ .Values.probes.liveness.initialDelaySeconds | default 30 }}
periodSeconds: {{ .Values.probes.liveness.periodSeconds | default 15 }}
timeoutSeconds: {{ .Values.probes.liveness.timeoutSeconds | default 5 }}
failureThreshold: {{ .Values.probes.liveness.failureThreshold | default 3 }}
{{- end }}

{{/*
Standard readiness probe
*/}}
{{- define "ubrnms-common.readinessProbe" -}}
httpGet:
  path: /readyz
  port: http
initialDelaySeconds: {{ .Values.probes.readiness.initialDelaySeconds | default 10 }}
periodSeconds: {{ .Values.probes.readiness.periodSeconds | default 10 }}
timeoutSeconds: {{ .Values.probes.readiness.timeoutSeconds | default 3 }}
failureThreshold: {{ .Values.probes.readiness.failureThreshold | default 5 }}
{{- end }}
