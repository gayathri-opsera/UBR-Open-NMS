# Runbook: Certificate Rotation

**Audience:** Platform Engineering / Security  
**Runbook URL:** https://runbooks.ubrnms.example.com/certificate-rotation

---

## TLS Certificates (Kubernetes Secrets)

### Check certificate expiry

```bash
# For all TLS secrets in ubr-ingress namespace
kubectl get secrets -n ubr-ingress -o json \
  | jq -r '.items[] | select(.type == "kubernetes.io/tls") | .metadata.name' \
  | while read s; do
      echo -n "$s: "
      kubectl get secret "$s" -n ubr-ingress -o jsonpath='{.data.tls\.crt}' \
        | base64 -d | openssl x509 -noout -enddate
    done
```

### Rotate TLS secret (cert-manager managed)

If using cert-manager, annotate the Certificate to trigger renewal:
```bash
kubectl annotate certificate ubrnms-prod-tls -n ubr-ingress \
  cert-manager.io/renew-before=720h --overwrite
```

### Manual rotation

```bash
# Create new secret with updated certificate
kubectl create secret tls ubrnms-prod-tls-new \
  --cert=new-cert.pem --key=new-key.pem -n ubr-ingress

# Update ingress to use new secret
kubectl patch ingress ubrnms-api -n ubr-ingress \
  --type=json -p='[{"op":"replace","path":"/spec/tls/0/secretName","value":"ubrnms-prod-tls-new"}]'

# Delete old secret after verification
kubectl delete secret ubrnms-prod-tls -n ubr-ingress
kubectl rename secret ubrnms-prod-tls-new ubrnms-prod-tls -n ubr-ingress
```

---

## JWT Secret Rotation

> Rotating the JWT secret will invalidate all active sessions.
> Schedule during off-peak hours and notify users.

```bash
# Generate new secret
NEW_SECRET=$(openssl rand -base64 64)

# Update the Kubernetes secret
kubectl create secret generic auth-service-secrets \
  --from-literal=JWT_SECRET="${NEW_SECRET}" \
  --from-literal=MONGODB_URI="${MONGODB_URI}" \
  -n ubr-platform \
  --dry-run=client -o yaml | kubectl apply -f -

# Restart auth-service to pick up new secret
kubectl rollout restart deployment/auth-service -n ubr-platform
kubectl rollout status deployment/auth-service -n ubr-platform
```

---

## Escalation Path

| Tier | Contact | Condition |
|------|---------|-----------|
| L2 Platform | @platform-oncall | Certificate expired or approaching expiry |
| L3 Security | @security-team | Suspected compromise |
