FROM node:20-trixie-slim

WORKDIR /app

RUN apt-get update && apt-get install -y python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci && npm rebuild sqlite3 --build-from-source

COPY . .

ARG EXPO_PUBLIC_API_BASE_URL=https://postings-api.example.com
ENV EXPO_PUBLIC_API_BASE_URL=$EXPO_PUBLIC_API_BASE_URL

EXPOSE 3000
CMD ["npm", "run", "server"]
