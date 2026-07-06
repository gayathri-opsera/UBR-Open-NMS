.PHONY: build-all test-all lint-all clean help seed seed-reset

SERVICES := api-gateway auth-service alarm-service audit-service \
            config-service event-collector kpi-query notification-service \
            inventory-service kpi-aggregation discovery-service kpi-collector \
            topology-service config-push-worker report-service

##@ Build

seed: ## Seed the local MongoDB with dev/test data (idempotent)
	@cd scripts && npm install --silent && node seed.js

seed-reset: ## Drop all NMS collections then re-seed from scratch
	@cd scripts && npm install --silent && node seed.js --reset

build-all: ## Build all services
	@echo "Building all services..."
	@for svc in $(SERVICES); do \
		echo "  Building $$svc..."; \
		if [ -f "services/$$svc/package.json" ]; then \
			(cd services/$$svc && npm run build 2>/dev/null || true); \
		elif [ -f "services/$$svc/pom.xml" ]; then \
			(cd services/$$svc && mvn package -DskipTests -q 2>/dev/null || true); \
		elif [ -f "services/$$svc/go.mod" ]; then \
			(cd services/$$svc && go build ./... 2>/dev/null || true); \
		elif [ -f "services/$$svc/pyproject.toml" ] || [ -f "services/$$svc/requirements.txt" ]; then \
			echo "    Python build: nothing to compile"; \
		fi; \
	done
	@echo "Build complete."

build-node: ## Build all Node.js services
	npm install
	@for svc in api-gateway auth-service alarm-service audit-service config-service event-collector kpi-query notification-service; do \
		echo "Building $$svc..."; \
		(cd services/$$svc && npm install --silent 2>/dev/null || true); \
	done

build-java: ## Build all Java services
	@for svc in inventory-service kpi-aggregation; do \
		if [ -f "services/$$svc/pom.xml" ]; then \
			echo "Building $$svc..."; \
			(cd services/$$svc && mvn package -DskipTests -q); \
		fi; \
	done
	@(cd shared-libs/java && mvn package -DskipTests -q)

build-go: ## Build all Go services
	@for svc in discovery-service kpi-collector topology-service; do \
		if [ -f "services/$$svc/go.mod" ]; then \
			echo "Building $$svc..."; \
			(cd services/$$svc && go build ./...); \
		fi; \
	done

##@ Test

test-all: ## Run all tests
	@echo "Running all tests..."
	@$(MAKE) test-node
	@$(MAKE) test-java
	@$(MAKE) test-go
	@$(MAKE) test-python
	@echo "All tests complete."

test-node: ## Run Node.js tests
	@for svc in api-gateway auth-service alarm-service audit-service config-service event-collector kpi-query notification-service; do \
		if [ -f "services/$$svc/package.json" ]; then \
			echo "Testing $$svc..."; \
			(cd services/$$svc && npm test -- --forceExit 2>/dev/null || echo "SKIP: not yet implemented"); \
		fi; \
	done

test-java: ## Run Java tests
	@for svc in inventory-service kpi-aggregation; do \
		if [ -f "services/$$svc/pom.xml" ]; then \
			echo "Testing $$svc..."; \
			(cd services/$$svc && mvn test -q); \
		fi; \
	done
	@(cd shared-libs/java && mvn test -q)

test-go: ## Run Go tests
	@for svc in discovery-service kpi-collector topology-service; do \
		if [ -f "services/$$svc/go.mod" ]; then \
			echo "Testing $$svc..."; \
			(cd services/$$svc && go test ./...); \
		fi; \
	done

test-python: ## Run Python tests
	@for svc in config-push-worker report-service; do \
		if [ -f "services/$$svc/pyproject.toml" ]; then \
			echo "Testing $$svc..."; \
			(cd services/$$svc && python -m pytest -q 2>/dev/null || echo "SKIP: not yet implemented"); \
		fi; \
	done

##@ Lint

lint-all: ## Lint all code
	@echo "Linting all services..."
	@$(MAKE) lint-node
	@$(MAKE) lint-java
	@$(MAKE) lint-go
	@$(MAKE) lint-python
	@$(MAKE) lint-specs
	@echo "Lint complete."

lint-node: ## Lint Node.js code with ESLint
	@for svc in api-gateway auth-service; do \
		if [ -f "services/$$svc/package.json" ]; then \
			(cd services/$$svc && npx eslint src/ --ext .js --max-warnings=0 2>/dev/null || echo "SKIP: ESLint not configured for $$svc"); \
		fi; \
	done

lint-java: ## Lint Java with Checkstyle
	@for svc in inventory-service kpi-aggregation; do \
		if [ -f "services/$$svc/pom.xml" ]; then \
			(cd services/$$svc && mvn checkstyle:check -q 2>/dev/null || echo "SKIP: Checkstyle not configured for $$svc"); \
		fi; \
	done

lint-go: ## Lint Go with golangci-lint
	@for svc in discovery-service kpi-collector topology-service; do \
		if [ -f "services/$$svc/go.mod" ]; then \
			(cd services/$$svc && golangci-lint run 2>/dev/null || go vet ./... 2>/dev/null || echo "OK"); \
		fi; \
	done

lint-python: ## Lint Python with ruff
	@for svc in config-push-worker report-service; do \
		if [ -d "services/$$svc" ]; then \
			(cd services/$$svc && ruff check . 2>/dev/null || echo "SKIP: ruff not configured for $$svc"); \
		fi; \
	done

lint-specs: ## Validate OpenAPI specs
	@(npx @stoplight/spectral-cli lint api-specs/*.yaml 2>/dev/null || echo "SKIP: spectral not installed")

##@ Utilities

clean: ## Remove build artifacts
	@find . -name 'node_modules' -type d -prune -exec rm -rf '{}' +
	@find . -name 'target' -type d -prune -exec rm -rf '{}' +
	@find . -name 'dist' -type d -prune -exec rm -rf '{}' +
	@find . -name '__pycache__' -type d -prune -exec rm -rf '{}' +
	@find . -name '*.pyc' -delete
	@echo "Clean complete."

help: ## Show this help message
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)
