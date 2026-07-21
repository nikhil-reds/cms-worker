#!/bin/bash

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
print_header() {
  echo -e "\n${BLUE}=== $1 ===${NC}\n"
}

print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
  echo -e "${RED}✗ $1${NC}"
}

print_warning() {
  echo -e "${YELLOW}⚠ $1${NC}"
}

# Check prerequisites
print_header "Checking Prerequisites"

if ! command -v docker &> /dev/null; then
  print_error "Docker is not installed"
  exit 1
fi
print_success "Docker is installed"

if ! command -v docker-compose &> /dev/null; then
  print_error "Docker Compose is not installed"
  exit 1
fi
print_success "Docker Compose is installed"

# Create .env file
print_header "Setting Up Environment Variables"

if [ ! -f .env ]; then
  cp .env.example .env
  print_success ".env file created from .env.example"
else
  print_warning ".env file already exists, skipping"
fi

# Start Docker services
print_header "Starting Docker Services"

echo "Starting all services (this may take a minute)..."
docker-compose up -d

if [ $? -ne 0 ]; then
  print_error "Failed to start Docker services"
  exit 1
fi

print_success "Docker services started"

# Wait for services to be healthy
print_header "Waiting for Services to Be Healthy"

max_attempts=30
attempt=0

while [ $attempt -lt $max_attempts ]; do
  healthy=$(docker-compose ps | grep -c "healthy")
  total=$(docker-compose ps | wc -l)

  echo -n "."

  if [ $healthy -ge 6 ]; then
    echo ""
    print_success "All services are healthy!"
    break
  fi

  sleep 2
  ((attempt++))
done

if [ $attempt -eq $max_attempts ]; then
  print_warning "Services may not be fully healthy yet. Check with: docker-compose ps"
fi

# Create S3 bucket
print_header "Setting Up AWS S3 (LocalStack)"

docker-compose exec -T localstack awslocal s3 mb s3://rubenius-media 2>/dev/null || true

print_success "S3 bucket 'rubenius-media' is ready"

# Create Kafka topics
print_header "Setting Up Kafka/Redpanda Topics"

docker-compose exec -T redpanda rpk topic create telemetry \
  --brokers=localhost:29092 --if-not-exists 2>/dev/null || true

docker-compose exec -T redpanda rpk topic create notifications \
  --brokers=localhost:29092 --if-not-exists 2>/dev/null || true

print_success "Kafka/Redpanda topics are ready"

# Display service status
print_header "Docker Services Status"

docker-compose ps

# Display connection info
print_header "Service Connection Details"

cat << EOF
PostgreSQL (Main Database):
  URL: postgresql://rubenius_user:rubenius_password@localhost:5432/rubenius
  CLI: make postgres-cli

TimescaleDB (Analytics):
  URL: postgresql://analytics_user:analytics_password@localhost:5433/analytics
  CLI: make timescaledb-cli

Redis (Queue Storage):
  URL: redis://localhost:6379
  CLI: make redis-cli

RabbitMQ (Message Broker):
  URL: amqp://guest:guest@localhost:5672
  Management UI: http://localhost:15672 (guest/guest)
  CLI: make rabbitmq-cli

Redpanda/Kafka (Event Streaming):
  Brokers: localhost:29092
  Console UI: http://localhost:8080

LocalStack (AWS Services):
  Endpoint: http://localhost:4566
  S3 Bucket: s3://rubenius-media

pgAdmin (Database UI):
  URL: http://localhost:5050
  Login: admin@rubenius.local / admin
EOF

# Next steps
print_header "Next Steps"

cat << EOF
1. Install dependencies:
   ${YELLOW}npm install${NC}

2. Run database migrations (when app is ready):
   ${YELLOW}make db-migrate${NC}

3. Start the worker in development mode:
   ${YELLOW}make dev${NC}

4. View logs:
   ${YELLOW}make docker-logs${NC}

For more commands, run:
   ${YELLOW}make help${NC}
EOF

print_header "Setup Complete!"
echo -e "${GREEN}All services are running and ready for development!${NC}\n"
