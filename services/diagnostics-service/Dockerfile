FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /build
COPY pom.xml .
RUN mvn dependency:go-offline -Dmaven.test.skip=true -q
COPY src ./src
RUN mvn package -Dmaven.test.skip=true -q &&     find target -maxdepth 1 -name "*.jar" ! -name "*sources*" ! -name "*tests*" | head -1 | xargs -I{} cp {} target/app.jar

FROM eclipse-temurin:17-jre-jammy
WORKDIR /app
RUN groupadd -r appgroup && useradd -r -g appgroup appuser
COPY --from=build /build/target/app.jar app.jar
RUN chown appuser:appgroup app.jar
USER appuser
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:8090/actuator/health || exit 1
ENTRYPOINT ["java", "-XX:+UseContainerSupport", "-XX:MaxRAMPercentage=75", "-jar", "app.jar"]
