# Stage 1: Install node_modules
FROM node:18-slim AS deps
WORKDIR /app
COPY backend/package*.json ./
RUN npm install --omit=dev

# Stage 2: Runtime with Chromium
FROM node:18-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY backend/ .

CMD ["node", "index.js"]
