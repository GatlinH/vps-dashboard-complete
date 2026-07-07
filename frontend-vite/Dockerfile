# Frontend image: build Vite assets and serve them with nginx.
FROM node:24-alpine AS build
WORKDIR /src

COPY frontend-vite/package*.json ./frontend-vite/
WORKDIR /src/frontend-vite
RUN npm ci

COPY frontend-vite/ ./
RUN npm run build

FROM nginx:1.27-alpine
COPY frontend-vite/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/frontend-dist/ /usr/share/nginx/html/

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
