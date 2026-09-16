// WO-067: Block Prohibited LI API Exposure
package com.ubr.nms.gateway;

import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

@Component
public class LawfulInterceptAccessControl implements HandlerInterceptor {

    private static final String[] PROHIBITED_LI_PATHS = {
        "/api/v1/li/",
        "/api/v1/lawful-intercept/",
        "/api/v1/surveillance/"
    };

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response,
                            Object handler) throws Exception {
        String path = request.getRequestURI();

        // Block all LI-related endpoints
        for (String prohibitedPath : PROHIBITED_LI_PATHS) {
            if (path.startsWith(prohibitedPath)) {
                // Audit the blocked attempt
                auditLIAccessAttempt(request, path);

                response.setStatus(HttpServletResponse.SC_FORBIDDEN);
                response.getWriter().write(
                    "{\"error\":\"Access to lawful intercept APIs is prohibited\"}");
                return false;
            }
        }

        return true;
    }

    private void auditLIAccessAttempt(HttpServletRequest request, String path) {
        // Log to audit service
        // Include: timestamp, user, IP, path, blocked
    }
}
