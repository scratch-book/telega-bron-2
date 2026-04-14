# Base image with Node.js and Playwright dependencies
FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npx tsc

# Create storage directories
RUN mkdir -p storage/screenshots storage/logs

# Start the bot
CMD ["node", "dist/index.js"]
