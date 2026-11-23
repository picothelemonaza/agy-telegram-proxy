# 🚀 AGY OpenAI Proxy + Telegram Bot (100% Auto Setup)

Biến **Antigravity CLI (`agy`)** thành **OpenAI-Compatible API** có **HTTPS công khai** (qua Cloudflare Tunnel), **bảo mật bằng API Key**, và **điều khiển hoàn toàn bằng Bot Telegram** — hỗ trợ Termux (Android), Linux và macOS.

## ✨ Tính năng
- **Cài đặt 100% tự động** qua `./setup.sh` (tự cài `nodejs`, `cloudflared`, tự tạo API Key bảo mật, tự mở tab đăng nhập nếu cần).
- **Hỗ trợ toàn bộ model AGY mới nhất** (`gemini-4-neon-*`, `gemini-4-hydrogen-*`, `gemini-4-argon-*`, `claude-opus-5-5-*`, `claude-sonnet-5-5-*`, `gpt-oss-120b-medium`, v.v.).
- **Dùng được trên mọi web/app** (ChatGPT UI, OpenWebUI, TypingMind, Cursor, Zed, SillyTavern...) nhờ HTTPS Cloudflare Tunnel + CORS.
- **Bot Telegram tiếng Việt siêu đơn giản**:
  - 🔑 Lấy Key & Link (copy 1 chạm)
  - 🤖 Danh sách Model mới nhất
  - ⚡ Xem Hạn Mức (5 giờ & 1 tuần)
  - 📊 Trạng thái & ▶️ Bật / ⏹ Tắt / 🔄 Chạy lại

## ⚡ Cài đặt nhanh (Chỉ 1 lệnh)

```bash
git clone https://github.com/picothelemonaza/agy-telegram-proxy.git
cd agy-telegram-proxy
chmod +x setup.sh && ./setup.sh
```

Script chỉ hỏi **2 thông tin**:
1. **Telegram Bot Token** (tạo tại [@BotFather](https://t.me/BotFather))
2. **Telegram User ID** (lấy tại [@userinfobot](https://t.me/userinfobot))

Sau đó mở Telegram, bấm **🔑 Lấy Key & Link** và dán vào bất kỳ web/app AI nào!
