/**
 * Cloudflare Worker — 語言學習助理後端 (WebSocket 版)
 *
 * 環境變數（在 Cloudflare Dashboard 設定，不要寫在程式碼裡）：
 *   GEMINI_API_KEY   — Google AI Studio API Key
 *   NOTION_TOKEN     — Notion Integration Token
 *   NOTION_DB_ID     — Notion 學習卡片資料庫 ID
 *   ALLOWED_ORIGIN   — 前端網址，例如 https://chatbot.shellydiligence.workers.dev
 */

// Gemini Live API 模型名稱
// 穩定版：gemini-2.0-flash-live-001
// 若有 2.5 Native Audio 存取權，可改為：gemini-2.5-flash-native-audio-preview
const GEMINI_LIVE_MODEL = 'models/gemini-2.0-flash-live-001';

// 各語言對應 Gemini 語音名稱
const VOICE_MAP = {
  ja: 'Kore',
  en: 'Puck',
  ko: 'Kore',
  fr: 'Aoede',
  de: 'Aoede',
  es: 'Aoede',
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = env.ALLOWED_ORIGIN || '';
    const isAllowed =
      origin === allowedOrigin ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1');

    if (request.method === 'OPTIONS') {
      return corsResponse('', 204, origin, isAllowed);
    }

    if (!isAllowed) {
      return new Response('Forbidden', { status: 403 });
    }

    const url = new URL(request.url);

    // ── WebSocket 升級 ───────────────────────────────────────────
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      return handleWebSocket(request, env, url);
    }

    try {
      if (url.pathname === '/cards' && request.method === 'POST') {
        return await handleCards(request, env, origin);
      }
      if (url.pathname === '/notion' && request.method === 'POST') {
        return await handleNotion(request, env, origin);
      }
      if (url.pathname === '/health') {
        return corsResponse(JSON.stringify({ ok: true }), 200, origin, isAllowed);
      }
      return new Response('Not Found', { status: 404 });
    } catch (err) {
      console.error(err);
      return corsResponse(JSON.stringify({ error: err.message }), 500, origin, isAllowed);
    }
  },
};

// ─── WebSocket 代理 ─────────────────────────────────────────────────────────
// 瀏覽器 ↔ Worker ↔ Gemini Live API
async function handleWebSocket(request, env, url) {
  const systemPrompt = url.searchParams.get('system') || '';
  const lang = url.searchParams.get('lang') || 'ja';

  // 建立與瀏覽器的 WebSocket 連線對
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();

  // 連線到 Gemini Live API
  const geminiEndpoint =
    `https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${env.GEMINI_API_KEY}`;

  let geminiWs;
  try {
    const resp = await fetch(geminiEndpoint, {
      headers: { Upgrade: 'websocket' },
    });
    geminiWs = resp.webSocket;
    if (!geminiWs) throw new Error('Gemini 未回傳 WebSocket');
    geminiWs.accept();
  } catch (err) {
    console.error('Gemini WS connect failed:', err);
    server.close(1011, 'Failed to connect to Gemini: ' + err.message);
    return new Response(null, { status: 101, webSocket: client });
  }

  // 送出 Gemini setup 訊息
  const setupMsg = {
    setup: {
      model: GEMINI_LIVE_MODEL,
      inputAudioTranscription: {},   // 使用者語音轉文字
      outputAudioTranscription: {},  // AI 語音轉文字（字幕用）
      generationConfig: {
        responseModalities: ['AUDIO'],  // 純語音；文字透過 outputTranscription 取得
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: VOICE_MAP[lang] || 'Puck',
            },
          },
        },
      },
      ...(systemPrompt
        ? { systemInstruction: { parts: [{ text: systemPrompt }] } }
        : {}),
    },
  };
  geminiWs.send(JSON.stringify(setupMsg));

  // Gemini → 瀏覽器（全部轉發）
  geminiWs.addEventListener('message', ({ data }) => {
    try { server.send(data); } catch {}
  });
  geminiWs.addEventListener('close', ({ code, reason }) => {
    try { server.close(code, reason); } catch {}
  });
  geminiWs.addEventListener('error', () => {
    try { server.close(1011, 'Gemini connection error'); } catch {}
  });

  // 瀏覽器 → Gemini（全部轉發）
  server.addEventListener('message', ({ data }) => {
    try { geminiWs.send(data); } catch {}
  });
  server.addEventListener('close', () => {
    try { geminiWs.close(); } catch {}
  });

  return new Response(null, { status: 101, webSocket: client });
}

// ─── /cards ─────────────────────────────────────────────────────────────────
async function handleCards(request, env, origin) {
  const { history, lang } = await request.json();

  const conversationText = history
    .map(h => `${h.role === 'user' ? '學習者' : 'AI老師'}：${h.content}`)
    .join('\n');

  const prompt = `以下是一段${lang === 'ja' ? '日文' : '外語'}學習對話。請從中抽取值得學習的單字和文法點，生成學習卡片。

對話內容：
${conversationText}

請只回傳 JSON，不要加任何說明文字：
{
  "cards": [
    {
      "type": "單字卡",
      "title": "單字（假名）",
      "description": "中文意思、詞性",
      "examples": ["例句1（中文翻譯）", "例句2（中文翻譯）", "例句3（中文翻譯）"]
    },
    {
      "type": "文法卡",
      "title": "文法點",
      "description": "用法說明",
      "examples": ["例句1", "例句2", "例句3"]
    }
  ]
}

如果沒有值得記錄的內容，回傳 {"cards": []}`;

  const gemmaRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
      }),
    }
  );

  const gemmaData = await gemmaRes.json();
  let rawText = gemmaData.candidates?.[0]?.content?.parts?.[0]?.text || '{"cards":[]}';
  rawText = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  let cards;
  try {
    cards = JSON.parse(rawText).cards || [];
  } catch {
    cards = [];
  }

  return corsResponse(JSON.stringify({ cards }), 200, origin, true);
}

// ─── /notion ────────────────────────────────────────────────────────────────
async function handleNotion(request, env, origin) {
  const { cards, lang } = await request.json();

  if (!env.NOTION_TOKEN || !env.NOTION_DB_ID) {
    return corsResponse(JSON.stringify({ success: false, error: 'Notion 未設定' }), 200, origin, true);
  }

  const langNames = { ja: '日文', en: '英文', ko: '韓文', fr: '法文', de: '德文', es: '西班牙文' };
  const today = new Date().toISOString().split('T')[0];
  const results = [];

  for (const card of cards) {
    const examplesText = card.examples ? card.examples.join('\n') : '';
    const body = {
      parent: { database_id: env.NOTION_DB_ID },
      properties: {
        '標題': { title: [{ text: { content: card.title } }] },
        '卡片類型': { select: { name: card.type } },
        '語言': { select: { name: langNames[lang] || lang } },
        '說明': { rich_text: [{ text: { content: card.description || '' } }] },
        '例句': { rich_text: [{ text: { content: examplesText } }] },
        '學習日期': { date: { start: today } },
        '熟悉度': { select: { name: '新學' } },
      },
    };

    const notionRes = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify(body),
    });

    results.push(notionRes.ok);
  }

  const success = results.every(Boolean);
  return corsResponse(
    JSON.stringify({ success, count: results.filter(Boolean).length }),
    200,
    origin,
    true
  );
}

// ─── 工具函式 ────────────────────────────────────────────────────────────────
function corsResponse(body, status, origin, isAllowed) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': isAllowed ? origin || '*' : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  return new Response(body, { status, headers });
}
