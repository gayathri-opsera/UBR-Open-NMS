package com.ubrnms.topology;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.kafka.annotation.EnableKafka;

@SpringBootApplication
@EnableKafka
public class TopologyServiceApplication {
    public static void main(String[] args) {
        SpringApplication.run(TopologyServiceApplication.class, args);
    }
}
