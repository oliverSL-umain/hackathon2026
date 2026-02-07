FROM node:20-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application files
COPY index.html config.js ./
COPY scripts/ scripts/
COPY css/ css/
COPY scans/ scans/

# Create json directory for pin storage
RUN mkdir -p json

EXPOSE 8080

CMD ["node", "scripts/server.js"]
