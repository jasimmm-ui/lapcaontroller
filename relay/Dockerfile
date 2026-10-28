FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY relay ./relay
COPY server/validation.js ./server/validation.js

ENV NODE_ENV=production \
    RELAY_HOST=0.0.0.0 \
    RELAY_DB_PATH=/data/relay.sqlite \
    PORT=8788

RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 8788
CMD ["node", "relay/index.js"]
