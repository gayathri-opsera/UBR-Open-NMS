package com.ubrnms.productdef;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.data.mongodb.config.EnableMongoAuditing;

@SpringBootApplication
@EnableMongoAuditing
public class ProductDefinitionServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(ProductDefinitionServiceApplication.class, args);
    }
}
