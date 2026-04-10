FROM node:20-alpine

WORKDIR /app

COPY backend/package*.json ./
RUN npm ci --omit=dev

COPY backend/ .
COPY frontend/ ./frontend/

EXPOSE 3000
CMD ["node", "src/server.js"]
