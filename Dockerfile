# Imagem de produção/homologação: backend servindo o frontend compilado.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY server server
COPY web web
RUN npm run build -w server && npm run build -w web

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY server/migrations server/migrations
COPY --from=build /app/web/dist web/dist
USER node
WORKDIR /app/server
ENV WEB_DIST_DIR=/app/web/dist HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
