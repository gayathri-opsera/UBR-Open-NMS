package com.ubrnms.diagnostics;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cache.annotation.EnableCaching;
import org.springframework.kafka.annotation.EnableKafka;

@SpringBootApplication
@EnableCaching
@EnableKafka
public class DiagnosticsServiceApplication {
    public static void main(String[] args) {
        SpringApplication.run(DiagnosticsServiceApplication.class, args);
    }
}
