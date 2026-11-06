# PanelZilla Wings image — node daemon that runs the game server "containers"
FROM node:22-alpine

# tar is used to create/restore real .tar.gz backups
RUN apk add --no-cache tar

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./server.js

# Server files, logs, backups and daemon state live on a mounted volume
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3001
CMD ["node", "server.js"]
