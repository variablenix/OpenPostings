# Debian Trixie has glibc 2.38 which sqlite3 native addon requires.
# Bookworm (default Node.js base) only ships glibc 2.36 and causes
# ERR_DLOPEN_FAILED at runtime with the sqlite3 native addon.
FROM node:20-trixie-slim

WORKDIR /app

# Build dependencies required for compiling sqlite3 from source
RUN apt-get update && apt-get install -y python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

# Force sqlite3 to compile from source against the local glibc
# rather than using a prebuilt binary linked against a newer glibc
RUN npm ci && npm rebuild sqlite3 --build-from-source

COPY . .

# EXPO_PUBLIC_API_BASE_URL must be baked into the Expo bundle at build time.
# Metro compiles env vars when the bundle is first built — not at container
# startup. Passing this as a Docker env var alone will not work.
#
# Default is http://localhost:8787 for local deployment.
# For reverse proxy deployments pass your public API URL as a build arg:
#   docker build --build-arg EXPO_PUBLIC_API_BASE_URL=https://your-api.example.com .
#   or use: bash docker-build.sh https://your-api.example.com
#
# Note: the variable name is EXPO_PUBLIC_API_BASE_URL — note the _BASE suffix.
# Using EXPO_PUBLIC_API_URL without _BASE will not work.
ARG EXPO_PUBLIC_API_BASE_URL=http://localhost:8787
RUN echo "EXPO_PUBLIC_API_BASE_URL=${EXPO_PUBLIC_API_BASE_URL}" > /app/.env

EXPOSE 3000
CMD ["npm", "run", "server"]
