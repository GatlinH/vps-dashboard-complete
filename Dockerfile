FROM node:22-alpine AS frontend-build
WORKDIR /build/frontend-vite
COPY frontend-vite/package.json frontend-vite/package-lock.json ./
RUN npm ci
COPY frontend-vite/ ./
RUN npm run build

FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc default-libmysqlclient-dev iputils-ping \
    && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt ./
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --no-cache-dir -r requirements.txt -i ${PIP_INDEX_URL}
COPY backend/ ./
COPY --from=frontend-build /build/frontend-dist /app/frontend-dist
RUN mkdir -p /var/log/vps-dashboard /var/lib/vps-dashboard \
    && useradd -m -u 1000 appuser \
    && chown -R appuser:appuser /app /var/log/vps-dashboard /var/lib/vps-dashboard
USER appuser
ENV PYTHONUNBUFFERED=1 \
    FLASK_APP=app.py \
    FRONTEND_DIST_DIR=/app/frontend-dist \
    GUNICORN_WORKERS=1 \
    GUNICORN_THREADS=4
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
    CMD python3 -c "import requests,sys; r=requests.get('http://localhost:5000/health',timeout=5); sys.exit(0 if r.status_code in (200,503) else 1)"
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:5000 --workers ${GUNICORN_WORKERS} --threads ${GUNICORN_THREADS} --worker-class gthread --timeout 30 --access-logfile - --error-logfile - 'app:create_app()'"]
