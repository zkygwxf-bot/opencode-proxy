#!/bin/bash
# OpenCode 免费反代 - Termux 一键安装
# 用法: curl -sL <script-url> | bash
set -e
ZIP_URL="https://muse.ai/files/1289210620950685/1598702262035725/0vtmpkcvgr5lpv3u343y4jmp/opencode-proxy-phone-v3.zip"
DIR="$HOME/spark-proxy"

echo "=== 正在安装 OpenCode 反代 ==="
mkdir -p "$DIR"
cd "$DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "正在安装 Node.js..."
  pkg install -y nodejs
fi
if ! command -v unzip >/dev/null 2>&1; then
  pkg install -y unzip
fi

echo "正在下载..."
curl -sL "$ZIP_URL" -o /tmp/spark.zip
unzip -o -q /tmp/spark.zip -d "$DIR"
rm /tmp/spark.zip

echo ""
echo "=== 安装完成 ==="
echo "启动命令: cd ~/spark-proxy && node proxy.mjs"
echo "RikkaHub 填: http://127.0.0.1:8788/v1"
echo ""
echo "正在启动..."
node proxy.mjs
