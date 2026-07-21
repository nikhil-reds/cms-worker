.PHONY: help docker-up docker-down docker-logs docker-ps docker-clean \
        db-migrate db-seed redis-cli postgres-cli timescaledb-cli rabbitmq-cli \
        s3-setup kafka-topics-create test

help:
	@echo "CMS Worker - Docker & Development Commands"
	@echo ""
	@echo "Docker Management:"
	@echo "  make docker-up           Start all Docker services"
	@echo "  make docker-down         Stop all Docker services (keep volumes)"
	@echo "  make docker-clean        Stop and remove all volumes"
	@echo "  make docker-ps           Show status of all services"
	@echo "  make docker-logs         Tail logs from all services"
	@echo "  make docker-logs-<svc>   Tail logs from specific service (e.g., docker-logs-postgres)"
	@echo ""
	@echo "Database Management:"
	@echo "  make db-migrate          Run Prisma migrations on PostgreSQL"
	@echo "  make db-seed             Seed database with initial data"
	@echo "  make db-reset            Reset database (drop & recreate)"
	@echo ""
	@echo "CLI Access:"
	@echo "  make redis-cli           Connect to Redis"
	@echo "  make postgres-cli        Connect to PostgreSQL"
	@echo "  make timescaledb-cli     Connect to TimescaleDB"
	@echo "  make rabbitmq-cli        Connect to RabbitMQ diagnostics"
	@echo ""
	@echo "Setup & Configuration:"
	@echo "  make env-copy            Copy .env.example to .env"
	@echo "  make s3-setup            Create S3 buckets in LocalStack"
	@echo "  make kafka-topics-create Create Kafka/Redpanda topics"
	@echo ""
	@echo "Development:"
	@echo "  make install             Install npm dependencies"
	@echo "  make dev                 Start worker in development mode"
	@echo "  make test                Run test suite"
	@echo "  make build               Build for production"

# ============================================================================
# Docker Management
# ============================================================================

docker-up:
	@echo "Starting all Docker services..."
	docker-compose up -d
	@echo "Waiting for services to be healthy..."
	@sleep 5
	@docker-compose ps

docker-down:
	@echo "Stopping all Docker services..."
	docker-compose down

docker-clean:
	@echo "Stopping services and removing all volumes..."
	docker-compose down -v
	@echo "All data has been removed."

docker-ps:
	docker-compose ps

docker-logs:
	docker-compose logs -f

docker-logs-postgres:
	docker-compose logs -f postgres

docker-logs-timescaledb:
	docker-compose logs -f timescaledb

docker-logs-redis:
	docker-compose logs -f redis

docker-logs-rabbitmq:
	docker-compose logs -f rabbitmq

docker-logs-redpanda:
	docker-compose logs -f redpanda

docker-logs-localstack:
	docker-compose logs -f localstack

# ============================================================================
# Database Management
# ============================================================================

db-migrate:
	@echo "Running Prisma migrations..."
	npx prisma migrate deploy

db-seed:
	@echo "Seeding database..."
	npx prisma db seed

db-reset:
	@echo "Resetting database..."
	npx prisma migrate reset --force

# ============================================================================
# CLI Access
# ============================================================================

redis-cli:
	docker-compose exec redis redis-cli

postgres-cli:
	docker-compose exec postgres psql -U rubenius_user -d rubenius

timescaledb-cli:
	docker-compose exec timescaledb psql -U analytics_user -d analytics

rabbitmq-cli:
	docker-compose exec rabbitmq rabbitmq-diagnostics status

rabbitmq-queues:
	docker-compose exec rabbitmq rabbitmqctl list_queues

rabbitmq-exchanges:
	docker-compose exec rabbitmq rabbitmqctl list_exchanges

# ============================================================================
# Setup & Configuration
# ============================================================================

env-copy:
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		echo ".env file created from .env.example"; \
	else \
		echo ".env file already exists"; \
	fi

s3-setup:
	@echo "Creating S3 buckets in LocalStack..."
	docker-compose exec localstack awslocal s3 mb s3://rubenius-media || true
	@echo "S3 buckets created:"
	docker-compose exec localstack awslocal s3 ls

kafka-topics-create:
	@echo "Creating Kafka/Redpanda topics..."
	docker-compose exec redpanda rpk topic create telemetry --brokers=localhost:29092 --if-not-exists || true
	docker-compose exec redpanda rpk topic create notifications --brokers=localhost:29092 --if-not-exists || true
	@echo "Redpanda topics:"
	docker-compose exec redpanda rpk topic list --brokers=localhost:29092

# ============================================================================
# Development
# ============================================================================

install:
	npm install

dev:
	@echo "Starting cms-worker in development mode..."
	@echo "Make sure Docker services are running: make docker-up"
	npm run start:dev

dev-watch:
	npm run start:dev -- --watch

build:
	@echo "Building for production..."
	npm run build

lint:
	npm run lint

format:
	npm run format

format-check:
	npm run format:check

# ============================================================================
# Testing
# ============================================================================

test:
	npm test

test-watch:
	npm test -- --watch

test-coverage:
	npm test -- --coverage

# ============================================================================
# Setup Commands (Interactive)
# ============================================================================

setup: env-copy docker-up
	@echo ""
	@echo "✅ Docker services are running!"
	@echo ""
	@echo "Next steps:"
	@echo "1. Wait a few seconds for all services to be healthy"
	@echo "2. Set up S3 buckets:      make s3-setup"
	@echo "3. Create Kafka topics:    make kafka-topics-create"
	@echo "4. Install dependencies:  make install"
	@echo "5. Run migrations:         make db-migrate"
	@echo "6. Start the worker:       make dev"
	@echo ""
	@echo "Access UIs:"
	@echo "  - RabbitMQ:       http://localhost:15672 (guest/guest)"
	@echo "  - Redpanda:       http://localhost:8080"
	@echo "  - pgAdmin:        http://localhost:5050 (admin@rubenius.local/admin)"
	@echo ""

# ============================================================================
# Health Checks
# ============================================================================

health-check:
	@echo "Checking service health..."
	@docker-compose ps --format "table {{.Service}}\t{{.Status}}"

wait-healthy:
	@echo "Waiting for services to be healthy..."
	@for i in 1 2 3 4 5; do \
		echo "  Attempt $$i/5..."; \
		if docker-compose ps | grep -q "healthy"; then \
			echo "✅ Services are healthy!"; \
			exit 0; \
		fi; \
		sleep 5; \
	done; \
	echo "⚠️  Some services may not be healthy yet. Run: make docker-ps"

# ============================================================================
# Utility
# ============================================================================

.DEFAULT_GOAL := help

PHONY += docker-logs-postgres docker-logs-timescaledb docker-logs-redis \
         docker-logs-rabbitmq docker-logs-redpanda docker-logs-localstack \
         dev-watch test-watch test-coverage health-check wait-healthy setup
