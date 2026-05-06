#!/bin/bash
# Build OpenPostings Docker image.
# Usage:
#   bash docker-build.sh                                   # local deployment
#   bash docker-build.sh https://your-api.example.com      # reverse proxy
API_URL=${1:-http://localhost:8787}

echo "Building with API URL: $API_URL"

docker build \
    --build-arg EXPO_PUBLIC_API_BASE_URL="$API_URL" \
    -t local/open-postings:latest .

echo "Done. Run with: docker compose -f docker-compose.example.yml up -d"
