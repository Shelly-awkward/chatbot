# 部署說明

## 你只需要手動操作 Cloudflare 這一步

---

## Step 1：上傳到 GitHub（你已完成）

repo：`chatbot`（private）

---

## Step 2：部署 Cloudflare Worker

### 2-1 安裝 Wrangler（只需做一次）
```bash
npm install -g wrangler
wrangler login
```

### 2-2 部署 Worker
```bash
cd worker
wrangler deploy
```

### 2-3 設定環境變數（在 Cloudflare Dashboard）

前往 Workers & Pages → chatbot-worker → Settings → Environment Variables

新增以下四個變數：

| 變數名稱 | 值 | 說明 |
|---------|-----|------|
| `GEMINI_API_KEY` | 你的 Google AI Studio key | 開頭 AIza... |
| `NOTION_TOKEN` | 你的 Notion Integration Token | 開頭 secret_... |
| `NOTION_DB_ID` | 你的 Notion 資料庫 ID | 從資料庫 URL 取得 |
| `ALLOWED_ORIGIN` | https://chatbot.pages.dev | 部署後確認實際網址 |

---

## Step 3：取得 Notion 設定值

### 3-1 建立 Notion Integration
1. 前往 https://www.notion.so/my-integrations
2. 點 + New integration
3. 名稱填「語言學習助理」
4. 複製 Internal Integration Token（這是 NOTION_TOKEN）

### 3-2 建立學習卡片資料庫
在 Notion 新建一個 Database，加入以下欄位：

| 欄位名稱 | 類型 |
|---------|------|
| 標題 | Title |
| 卡片類型 | Select（選項：單字卡、文法卡、糾錯卡）|
| 語言 | Select（選項：日文、英文、韓文...）|
| 說明 | Text |
| 例句 | Text |
| 學習日期 | Date |
| 熟悉度 | Select（選項：新學、複習中、已熟悉）|

### 3-3 取得資料庫 ID
資料庫 URL 格式：
`https://www.notion.so/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=...`
32 個字元那段就是 NOTION_DB_ID

### 3-4 允許 Integration 存取資料庫
打開資料庫頁面 → 右上角 ··· → Connections → 找到「語言學習助理」→ 連接

---

## Step 4：部署 Cloudflare Pages

1. 前往 https://dash.cloudflare.com → Workers & Pages
2. 點 Create → Pages → Connect to Git
3. 選擇 `chatbot` repo
4. 設定：
   - Framework preset：None
   - Build command：（空白）
   - Build output directory：`/`（根目錄）
5. 點 Save and Deploy

部署完成後取得網址，例如 `https://chatbot.pages.dev`

---

## Step 5：更新 WORKER_URL

部署完 Worker 後，把 `index.html` 第 220 行的 WORKER_URL 改成你的 Worker 網址：

```javascript
const WORKER_URL = 'https://chatbot-worker.你的帳號.workers.dev';
```

改完後 commit 並 push 到 GitHub，Cloudflare Pages 會自動重新部署。

---

## Step 6：加到 iPhone 主畫面（PWA）

1. 用 Safari 開啟你的 Pages 網址
2. 點底部分享按鈕 □↑
3. 選「加入主畫面」
4. 完成，可以像 app 一樣使用

---

## 常見問題

**Q：麥克風沒有反應？**
確認是用 Safari 開啟，且已允許麥克風權限（設定 → Safari → 麥克風）

**Q：Worker 回傳 403？**
確認 ALLOWED_ORIGIN 設定的網址和你實際的 Pages 網址完全一致（包含 https://）

**Q：Notion 推送失敗？**
確認 Integration 已連接到資料庫（Step 3-4），且 NOTION_DB_ID 正確
