# 專屬語言學習助理

以 Gemini Live API 為核心的多語言語音對話學習 PWA。

## 功能
- 🎓 學習模式：語音對話練習、情境模擬、文法問答、跟讀
- 🔄 翻譯模式：即時語音翻譯（純語音／純文字／語音＋文字）
- 📚 學習卡片：自動生成單字卡、文法卡，推送 Notion + 下載 md

## 架構
- 前端：Cloudflare Pages（PWA）
- 代理：Cloudflare Worker（保護 API 金鑰）
- AI：Google Gemini Live API

## 部署
見 `docs/deployment.md`
