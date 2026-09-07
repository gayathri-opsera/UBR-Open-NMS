// WO-063: Deliver Alarm Incident Webhooks Reliably
package com.ubr.nms.notification;

import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;
import org.springframework.http.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

@Service
public class WebhookDispatchService {
    private final RestTemplate restTemplate;
    private static final int MAX_RETRIES = 3;

    public WebhookDispatchService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public boolean dispatchWebhook(WebhookTarget target, AlarmIncident incident) {
        String payload = serializeIncident(incident);
        String signature = signPayload(payload, target.getSecret());

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("X-Webhook-Signature", signature);
        headers.set("X-Webhook-Version", "v1");

        HttpEntity<String> request = new HttpEntity<>(payload, headers);

        for (int attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                ResponseEntity<String> response = restTemplate.postForEntity(
                    target.getUrl(), request, String.class);
                if (response.getStatusCode().is2xxSuccessful()) {
                    return true;
                }
            } catch (Exception e) {
                if (attempt == MAX_RETRIES - 1) {
                    return false;
                }
                // Exponential backoff
                try {
                    Thread.sleep((long) Math.pow(2, attempt) * 1000);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return false;
                }
            }
        }
        return false;
    }

    private String serializeIncident(AlarmIncident incident) {
        return "{}"; // Serialize to JSON
    }

    private String signPayload(String payload, String secret) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            SecretKeySpec secretKey = new SecretKeySpec(
                secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
            mac.init(secretKey);
            byte[] hash = mac.doFinal(payload.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(hash);
        } catch (Exception e) {
            throw new RuntimeException("Failed to sign webhook payload", e);
        }
    }
}

class WebhookTarget {
    private String url;
    private String secret;
    public String getUrl() { return url; }
    public String getSecret() { return secret; }
}

class AlarmIncident {
    private String alarmId;
    private String severity;
    private String message;
    public String getAlarmId() { return alarmId; }
}
