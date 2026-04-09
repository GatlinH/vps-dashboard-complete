# 备份与回滚手册 (Backup & Rollback)

本文档提供可直接执行的命令示例，覆盖 MySQL 备份/恢复、容器镜像回滚和配置回退。

---

## 一、MySQL 数据库备份

### 1.1 手动备份

```bash
# 进入 backend 目录（docker-compose.yml 所在位置）
cd /opt/vps-dashboard/backend

# 执行备份（输出到宿主机 /opt/backups/）
mkdir -p /opt/backups
docker exec vps_mysql \
  mysqldump -u vps_user -p"${MYSQL_PASSWORD}" \
  --single-transaction --routines --triggers vps_dashboard \
  | gzip > /opt/backups/vps_dashboard_$(date +%Y%m%d_%H%M%S).sql.gz

echo "备份完成：$(ls -lh /opt/backups/ | tail -1)"
```

> 💡 **`MYSQL_PASSWORD`** 从宿主机 `backend/.env` 读取：  
> `source backend/.env && docker exec vps_mysql mysqldump ...`

### 1.2 自动每日备份（cron）

```bash
# 编辑 root crontab
crontab -e

# 每天凌晨 3 点备份，保留最近 7 天
0 3 * * * \
  source /opt/vps-dashboard/backend/.env && \
  docker exec vps_mysql mysqldump -u vps_user -p"${MYSQL_PASSWORD}" \
    --single-transaction vps_dashboard \
  | gzip > /opt/backups/vps_dashboard_$(date +\%Y\%m\%d).sql.gz && \
  find /opt/backups -name "vps_dashboard_*.sql.gz" -mtime +7 -delete
```

---

## 二、MySQL 数据恢复

```bash
# 1. 选择备份文件
BACKUP_FILE=/opt/backups/vps_dashboard_20240101_030000.sql.gz

# 2. 恢复（会清空并重建数据库）
zcat "${BACKUP_FILE}" | docker exec -i vps_mysql \
  mysql -u vps_user -p"${MYSQL_PASSWORD}" vps_dashboard

echo "恢复完成，验证数据："
docker exec vps_mysql mysql -u vps_user -p"${MYSQL_PASSWORD}" \
  -e "SELECT COUNT(*) AS server_count FROM vps_dashboard.servers;"
```

> ⚠️ **恢复操作会覆盖当前数据库内容，请确认已备份最新状态再执行。**

---

## 三、容器镜像回滚

### 3.1 查看历史镜像

```bash
cd /opt/vps-dashboard/backend

# 查看当前使用的镜像
docker images | grep vps

# 查看容器状态
docker compose ps
```

### 3.2 回滚到上一个 Git 版本（推荐方式）

```bash
cd /opt/vps-dashboard

# 查看最近几次提交
git log --oneline -10

# 回退到指定 commit（替换 <commit-sha>）
git checkout <commit-sha>

# 重新构建并启动
cd backend
docker compose up -d --build --remove-orphans

# 验证服务健康
docker compose ps
curl -sf http://localhost:5000/health && echo "✅ API 健康"
```

### 3.3 保存当前镜像作为回滚点（可选）

```bash
# 在部署前保存当前镜像
docker commit vps_api vps_api_backup:$(date +%Y%m%d_%H%M%S)

# 回滚时
docker stop vps_api
docker run -d --name vps_api_rollback vps_api_backup:<tag>
```

---

## 四、配置回退

### 4.1 .env 配置回退

```bash
# 备份当前配置
cp /opt/vps-dashboard/backend/.env /opt/backups/.env.$(date +%Y%m%d_%H%M%S)

# 恢复备份
cp /opt/backups/.env.20240101_120000 /opt/vps-dashboard/backend/.env

# 重启应用使配置生效
cd /opt/vps-dashboard/backend
docker compose restart api
```

### 4.2 nginx.conf 回退

```bash
# 测试新配置语法
docker exec vps_nginx nginx -t

# 若有问题，恢复上一版本并重新加载
git diff HEAD~1 -- backend/nginx.conf   # 查看改动
git checkout HEAD~1 -- backend/nginx.conf
docker exec vps_nginx nginx -s reload
```

---

## 五、回滚演练清单

每次重大版本发布前，建议在预生产环境执行一次回滚演练：

```
1. [ ] 记录当前版本（git rev-parse HEAD、docker images）
2. [ ] 执行全量 MySQL 备份
3. [ ] 模拟故障（停止 API 容器或切换到有问题的配置）
4. [ ] 执行回滚步骤（见第三节）
5. [ ] 验证健康检查通过：curl http://localhost:5000/health
6. [ ] 验证登录与核心功能正常
7. [ ] 记录回滚耗时（目标 < 5 分钟）
```

---

## 六、紧急联系与升级路径

| 故障类型 | 首选处理方式 | 升级条件 |
|---------|------------|---------|
| API 无响应 | `docker compose restart api` | 重启 3 次仍失败 |
| DB 连接失败 | 检查 MySQL 容器状态 + 配置 | 数据文件损坏 |
| Redis 连接失败 | `docker compose restart redis` | 数据持久化问题 |
| 全服务不可用 | 按顺序重启：mysql → redis → api → nginx | 硬件/网络故障 |

```bash
# 标准重启顺序
docker compose restart mysql
sleep 10
docker compose restart redis
sleep 5
docker compose restart api
sleep 5
docker compose restart nginx
docker compose ps
```
