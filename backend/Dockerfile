# backend/Dockerfile - 生产优化版本

FROM python:3.11-slim

LABEL maintainer="Your Name <your@email.com>"

# 设置工作目录
WORKDIR /app

# 安装系统依赖
RUN apt-get update && apt-get install -y \
    gcc \
    default-libmysqlclient-dev \
    && rm -rf /var/lib/apt/lists/*

# 复制依赖文件
COPY requirements.txt .

# 安装 Python 依赖（使用清华源加速）
RUN pip install --no-cache-dir -r requirements.txt \
    -i https://pypi.tsinghua.edu.cn/simple

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

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:5000/health', timeout=5)"

# 启动应用
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "4", "--worker-class", "sync", "--timeout", "30", "--access-logfile", "-", "--error-logfile", "-", "app:app"]
