FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Explicit allowlist of public build settings. Backend secrets are never build args.
ARG VITE_SENTRY_DSN=""
ARG VITE_SENTRY_DISABLED=false
ARG VITE_SENTRY_ENVIRONMENT=production
ARG VITE_SENTRY_RELEASE=""
ARG VITE_SENTRY_TRACES_SAMPLE_RATE=0
ENV VITE_API_URL=/api
RUN npm run build

FROM nginxinc/nginx-unprivileged:stable-alpine AS runtime
COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz
# Bypass entrypoint scripts that edit /etc on an immutable image.
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
