FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY target/credential-vault-runtime-*.jar app.jar
EXPOSE 8094
ENTRYPOINT ["java", "-jar", "app.jar"]
