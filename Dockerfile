FROM node:20-alpine AS vendor
WORKDIR /repo
COPY full.ini ./
COPY server/scripts ./server/scripts
RUN node server/scripts/vendor-rules.mjs

FROM node:20-alpine AS build
WORKDIR /app/server
COPY server/package.json server/package-lock.json server/tsconfig.json ./
RUN npm ci
COPY server/src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 CACHE_DIR=/app/data/cache
COPY full.ini ./
COPY rules ./rules
COPY shadowrocket ./shadowrocket
COPY surge ./surge
COPY --from=vendor /repo/vendor ./vendor
COPY --from=build /app/server/dist ./server/dist
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "server/dist/server.js"]
