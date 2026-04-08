FROM python:3.11-slim

LABEL maintainer="VPS 星图"

# 系统依赖（socket / SSL）
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libffi-dev libssl-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# 创建空 __init__ 文件（Blueprint 模块需要）
RUN touch api/__init__.py models/__init__.py services/__init__.py utils/__init__.py

EXPOSE 5000

# 生产：gunicorn 4 workers
CMD ["gunicorn", "-w", "4", "-b", "0.0.0.0:5000", \
     "--timeout", "60", "--access-logfile", "-", "app:create_app()"]
