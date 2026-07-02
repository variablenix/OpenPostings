#!/usr/bin/env bash
export DOCKER_BUILDKIT=1

# --- Configuration — edit these for your environment ---
GITHUB_USER="your-github-username"
GITHUB_REPO="OpenPostings"
GHCR_IMAGE="ghcr.io/${GITHUB_USER}/${GITHUB_REPO,,}:latest"   # lowercase image name
FORK_REPO="https://github.com/${GITHUB_USER}/${GITHUB_REPO}.git"
UPSTREAM_REPO="https://github.com/Masterjx9/OpenPostings.git"
API_URL="https://your-api.example.com"                         # baked into the bundle at build time
COMPOSE_PROJECT="openpostings"                                 # docker compose -p value
COMPOSE_DIR="/home/user/openpostings"                          # directory containing your docker-compose.yml
BASE_DIR="/home/user/open-postings"                            # working directory for source + Dockerfile
# -------------------------------------------------------

SOURCE_DIR="$BASE_DIR/open-postings-source"
PERSISTENT_DOCKERFILE="$BASE_DIR/Dockerfile"

echo "--- Starting OpenPostings Update ---"
echo "Image : $GHCR_IMAGE"
echo "API URL: $API_URL"
echo ""

# 1. Update or Clone Source
if [ -d "$SOURCE_DIR" ]; then
    echo "[1/5] Pulling latest source and syncing upstream..."
    cd "$SOURCE_DIR" || exit 1
    git stash
    git pull
    git remote add upstream "$UPSTREAM_REPO" 2>/dev/null || true
    git fetch upstream
    git merge upstream/main --no-edit
else
    echo "[1/5] Cloning source repository..."
    cd "$BASE_DIR" || exit 1
    git clone "$FORK_REPO" open-postings-source
    cd "$SOURCE_DIR" || exit 1
    git remote add upstream "$UPSTREAM_REPO"
    git fetch upstream
fi

# 2. Inject the custom Dockerfile into the build context
echo "[2/5] Injecting custom Dockerfile..."
if [ ! -f "$PERSISTENT_DOCKERFILE" ]; then
    echo "ERROR: Custom Dockerfile not found at $PERSISTENT_DOCKERFILE"
    exit 1
fi
cp "$PERSISTENT_DOCKERFILE" "$SOURCE_DIR/Dockerfile"

# 3. Build and tag for ghcr.io
echo "[3/5] Building $GHCR_IMAGE..."
cd "$SOURCE_DIR" || exit 1
docker build \
    --build-arg EXPO_PUBLIC_API_BASE_URL="$API_URL" \
    -t "$GHCR_IMAGE" .

if [ $? -ne 0 ]; then
    echo "ERROR: Build failed. Check logs above."
    exit 1
fi
echo "Build successful!"

# 3.5. Push to ghcr.io
echo "[3.5/5] Pushing to ghcr.io..."
echo "       If this fails, run: docker login ghcr.io -u ${GITHUB_USER}"
docker push "$GHCR_IMAGE"
if [ $? -ne 0 ]; then
    echo "ERROR: Push failed. Check ghcr.io auth."
    exit 1
fi
echo "Push successful!"

# 4. Remove orphaned containers that would block compose
echo "[4/5] Removing any orphaned containers..."
for container in openpostings-ui openpostings-api; do
    if docker ps -a --format '{{.Names}}' | grep -q "^${container}$"; then
        echo "  Removing container: $container"
        docker rm -f "$container"
    fi
done

# 5. Recreate both services in the stack
echo "[5/5] Recreating services..."
cd "$COMPOSE_DIR" || exit 1
docker compose -p "$COMPOSE_PROJECT" pull openpostings-ui openpostings-api
docker compose -p "$COMPOSE_PROJECT" up -d --no-deps --force-recreate openpostings-ui openpostings-api

echo ""
echo "--- Update Complete ---"
echo ""
echo "Verifying API URL baked into container..."
sleep 5
docker exec "${COMPOSE_PROJECT}-openpostings-ui-1" printenv EXPO_PUBLIC_API_BASE_URL 2>/dev/null \
    || echo "WARNING: Could not verify env var in container"

echo ""
echo "Tailing logs for 20s — Ctrl+C to exit early:"
echo ""
docker compose -p "$COMPOSE_PROJECT" logs -f --tail=30 openpostings-ui openpostings-api &
LOG_PID=$!
sleep 20
kill $LOG_PID 2>/dev/null
