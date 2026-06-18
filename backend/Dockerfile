# backend/Dockerfile - 生产优化版本

FROM python:3.11-slim

LABEL maintainer="Your Name <your@email.com>"

# 设置工作目录
WORKDIR /app

# 安装系统依赖
RUN apt-get update && apt-get install -y \
    gcc \
    default-libmysqlclient-dev \
    iputils-ping \
    && rm -rf /var/lib/apt/lists/*

# 复制依赖文件
COPY requirements.txt .

# 安装 Python 依赖（PyPI 镜像源可通过构建参数配置）
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN pip install --no-cache-dir -r requirements.txt \
    -i ${PIP_INDEX_URL}

# 复制应用代码
COPY . .

# 创建日志目录
RUN mkdir -p /var/log/vps-dashboard

# 创建非 root 用户
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app /var/log/vps-dashboard
USER appuser

# 环境变量
ENV PYTHONUNBUFFERED=1
ENV FLASK_APP=app.py
# Gunicorn 并发配置（APScheduler 要求 workers=1，用 threads 提升并发）
ENV GUNICORN_WORKERS=1
ENV GUNICORN_THREADS=4

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
    CMD python3 -c "import requests,sys; r=requests.get('http://localhost:5000/health',timeout=5); sys.exit(0 if r.status_code in (200,503) else 1)"

# 启动应用
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:5000 --workers ${GUNICORN_WORKERS} --threads ${GUNICORN_THREADS} --worker-class gthread --timeout 30 --access-logfile - --error-logfile - 'app:create_app()'"]
