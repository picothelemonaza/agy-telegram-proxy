#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}🚀 AGY OpenAI Proxy + Telegram Bot Auto-Setup${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# 1. Detect environment & install missing tools
IS_TERMUX=false
if [ -n "${TERMUX_VERSION:-}" ] || [ -d "/data/data/com.termux" ]; then
  IS_TERMUX=true
fi

install_pkg() {
  local pkg="$1"
  echo -e "${YELLOW}📦 Đang cài đặt ${pkg}...${NC}"
  if [ "$IS_TERMUX" = true ]; then
    pkg install -y "$pkg"
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y && sudo apt-get install -y "$pkg"
  elif command -v brew >/dev/null 2>&1; then
    brew install "$pkg"
  else
    echo -e "${RED}❌ Không thể tự cài ${pkg}. Vui lòng cài thủ công rồi chạy lại.${NC}"
    exit 1
  fi
}

command -v node >/dev/null 2>&1 || install_pkg nodejs
command -v cloudflared >/dev/null 2>&1 || install_pkg cloudflared

if ! command -v agy >/dev/null 2>&1; then
  echo -e "${YELLOW}⚠️  Chưa tìm thấy 'agy' CLI trong PATH.${NC}"
  echo "   Vui lòng cài Antigravity CLI (agy) trước, sau đó chạy lại ./setup.sh"
  exit 1
fi

echo -e "${GREEN}✅ Đã sẵn sàng: Node $(node -v), cloudflared, agy${NC}"
echo ""

# 2. Ask ONLY for Telegram Bot Token & User ID
if [ ! -f .env ]; then
  echo -e "${CYAN}🤖 Cấu hình Bot Telegram:${NC}"
  echo "   • Lấy Bot Token tại: @BotFather (/newbot)"
  echo "   • Lấy User ID của bạn tại: @userinfobot"
  echo ""
  read -rp "👉 Nhập Telegram Bot Token: " TG_TOKEN
  read -rp "👉 Nhập Telegram User ID của bạn: " TG_USER_ID

  if [ -z "$TG_TOKEN" ] || [ -z "$TG_USER_ID" ]; then
    echo -e "${RED}❌ Thiếu Bot Token hoặc User ID.${NC}"
    exit 1
  fi

  API_KEY="sk-agy-$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"

  cat > .env <<EOF
PORT=3000
HOST=0.0.0.0
TELEGRAM_BOT_TOKEN=${TG_TOKEN}
ALLOWED_USER_ID=${TG_USER_ID}
PROXY_API_KEY=${API_KEY}
EOF

  echo -e "${GREEN}✅ Đã lưu cấu hình vào .env (API Key bảo mật đã tự tạo!)${NC}"
else
  echo -e "${GREEN}✅ Đã tìm thấy file .env hiện có.${NC}"
fi
echo ""

# 3. Check AGY login & auto-open auth tab if needed
echo -e "${CYAN}🔐 Kiểm tra đăng nhập tài khoản AGY...${NC}"
if agy models >/dev/null 2>&1; then
  echo -e "${GREEN}✅ Tài khoản AGY đã đăng nhập!${NC}"
else
  echo -e "${YELLOW}👉 Chưa đăng nhập AGY. Đang mở trình duyệt để bạn đăng nhập...${NC}"
  # Trigger interactive login; agy opens browser automatically or prints URL
  agy -p "hi" --print-timeout 5s 2>&1 | while IFS= read -r line; do
    echo "$line"
    url=$(echo "$line" | grep -oE 'https://accounts\.google\.com[^ ]+' || true)
    if [ -n "$url" ]; then
      if command -v termux-open-url >/dev/null 2>&1; then
        termux-open-url "$url" || true
      elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$url" || true
      elif command -v open >/dev/null 2>&1; then
        open "$url" || true
      fi
    fi
  done || true
fi

echo ""
echo -e "${GREEN}🎉 Hoàn tất cài đặt! Đang khởi động Bot Telegram + Proxy + Cloudflare Tunnel...${NC}"
echo -e "${CYAN}   Mở Telegram của bạn để nhận Link HTTPS & API Key nhé!${NC}"
echo ""

exec node scripts/telegram-bot.mjs
