# Stage 1: Build the React client SPA
FROM node:20-slim AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: Install and compile server-side dependencies
FROM node:20 AS server-builder
# Install canvas compilation prerequisites (if compiling from source falls back)
RUN apt-get update && apt-get install -y \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

# Stage 3: Clean runtime image
FROM node:20-slim

# Install runtime dependencies for canvas and document conversion
RUN apt-get update && apt-get install -y \
    libcairo2 \
    libpango-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    libreoffice-nogui \
    fonts-dejavu \
    && rm -rf /var/lib/apt/lists/*


WORKDIR /app

# Copy built server files and dependencies
COPY --from=server-builder /app/server/node_modules ./server/node_modules
COPY server/ ./server/

# Copy built React client assets
COPY --from=client-builder /app/client/dist ./client/dist

# Expose port and run in production mode
ENV PORT=5050
ENV NODE_ENV=production
ENV ALLOW_API_FALLBACK=true
EXPOSE 5050

WORKDIR /app/server
CMD ["node", "index.js"]
