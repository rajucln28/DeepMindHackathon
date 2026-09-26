# Stage 1: build the client
FROM node:20-slim AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: runtime (server serves the built client)
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY server/package*.json ./server/
RUN npm --prefix server ci --omit=dev
COPY server/ ./server/
COPY --from=client /app/client/dist ./client/dist
EXPOSE 8080
CMD ["node", "server/index.js"]
