FROM node:22-alpine AS frontend-build
ARG GIT_SHA=unknown
ARG IMAGE_REVISION=unknown
ARG IMAGE_SOURCE=unknown
ARG RELEASE_VERSION=unknown
ARG COMPOSE_SHA256=unknown
WORKDIR /build/frontend-vite
COPY frontend-vite/package.json frontend-vite/package-lock.json ./
RUN npm ci
COPY frontend-vite/ ./
RUN npm run build

FROM python:3.11-slim
ARG GIT_SHA=unknown
ARG IMAGE_REVISION=unknown
ARG IMAGE_SOURCE=unknown
ARG RELEASE_VERSION=unknown
ARG COMPOSE_SHA256=unknown
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc default-libmysqlclient-dev iputils-ping \
    && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt ./
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --no-cache-dir -r requirements.txt -i ${PIP_INDEX_URL}
COPY backend/ ./
# Canonical Agent runtime: the installer downloads these version-controlled files
# from the running image rather than maintaining a second heredoc implementation.
COPY scripts/vps-agent.py scripts/agent_tasks.py /app/agent-runtime/
COPY --from=frontend-build /build/frontend-dist /app/frontend-dist
COPY scripts/release/build_provenance.py /app/build_provenance.py
ENV GIT_SHA=${GIT_SHA} IMAGE_REVISION=${IMAGE_REVISION} IMAGE_SOURCE=${IMAGE_SOURCE} RELEASE_VERSION=${RELEASE_VERSION} COMPOSE_SHA256=${COMPOSE_SHA256} FRONTEND_DIST_DIR=/app/frontend-dist PROVENANCE_OUTPUT=/app/release-provenance.json RELEASE_PROVENANCE_FILE=/app/release-provenance.json
RUN python3 /app/build_provenance.py
LABEL org.opencontainers.image.revision=$IMAGE_REVISION \
      org.opencontainers.image.source=$IMAGE_SOURCE \
      org.opencontainers.image.version=$RELEASE_VERSION
RUN mkdir -p /var/log/vps-dashboard /var/lib/vps-dashboard \
    && useradd -m -u 1000 appuser \
    && chown -R appuser:appuser /app /var/log/vps-dashboard /var/lib/vps-dashboard
USER appuser
# Deployment-neutral default. Operators may explicitly set GUNICORN_BIND='[::]:5000'.
ENV PYTHONUNBUFFERED=1 \
    FLASK_APP=app.py \
    GUNICORN_WORKERS=1 \
    GUNICORN_THREADS=4 \
    GUNICORN_BIND=0.0.0.0:5000
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
    CMD python3 -c "import requests,sys; r=requests.get('http://localhost:5000/health',timeout=5); sys.exit(0 if r.status_code in (200,503) else 1)"
CMD ["sh", "-c", "gunicorn --bind ${GUNICORN_BIND} --workers ${GUNICORN_WORKERS} --threads ${GUNICORN_THREADS} --worker-class gthread --timeout 30 --access-logfile - --error-logfile - 'app:create_app()'"]
