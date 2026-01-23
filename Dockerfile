# 选择基础镜像
FROM python:3.12-slim

# 设置工作目录
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 

# 拷贝依赖文件并安装
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 拷贝项目文件
COPY . .

# 暴露端口（如 Flask 默认 5000）
EXPOSE 5000

# 使用 gunicorn 启动 Flask 应用，假设入口为 app:app（即 app.py 下的 app 实例）
# 如果你的入口文件或应用实例名不同，请相应修改
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "app:app"]
