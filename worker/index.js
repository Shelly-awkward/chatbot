/**
 * Cloudflare Worker — 語言學習助理後端
 *
 * 環境變數（在 Cloudflare Dashboard 設定，不要寫在程式碼裡）：
 *   GEMINI_API_KEY   — Google AI Studio API Key
 *   NOTION_TOKEN     — Notion Integration Token
 *   NOTION_DB_ID     — Notion 學習卡片資料庫 ID
 *   ALLOWED_ORIGIN   — 前端網址，例如 https://chatbot.pages.dev
 */

export default {
  async fetch(request, env) {
    // CORS
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = env.ALLOWED_ORIGIN || '';

    // 開發期間允許 localhost；正式部署後只允許自己的 domain
    const isAllowed = origin === allowedOrigin ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1');

    if (request.method === 'OPTIONS') {
      return corsResponse('', 204, origin, isAllowed);
    }

    if (!isAllowed) {
      return new Response('Forbidden', { status: 403 });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/chat' && request.method === 'POST') {
        return await handleChat(request, env, origin);
      }
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
  }
};

// ─── /chat ─────────────────────────────────────────────────────────────────
// 接收音訊 → Gemini 轉錄 + 回應 → 回傳文字 + 音訊 base64
async function handleChat(request, env, origin) {
  const formData = await request.formData();
  const audioFile = formData.get('audio');
  const systemPrompt = formData.get('systemPrompt') || '';
  const history = JSON.parse(formData.get('history') || '[]');
  const lang = formData.get('lang') || 'ja';
  const outputMode = formData.get('outputMode') || 'both';

  // Step 1：將音訊轉成 base64
  const audioBuffer = await audioFile.arrayBuffer();
  const audioBase64 = arrayBufferToBase64(audioBuffer);

  // Step 2：呼叫 Gemini（音訊輸入 + 文字回應）
  // 使用 gemini-2.5-flash 處理語音轉錄 + 對話回應
  const geminiMessages = [
    ...history.map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }]
    })),
    {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'audio/webm',
            data: audioBase64
          }
        },
        { text: '請先轉錄我說的話，然後根據你的角色設定回應。回應格式：\n[轉錄]使用者說的原文\n[回應]你的回應內容' }
      ]
    }
  ];

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: geminiMessages,
        generationConfig: { temperature: 0.8, maxOutputTokens: 1000 }
      })
    }
  );

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    throw new Error(`Gemini API 失敗：${geminiRes.status} ${errText}`);
  }

  const geminiData = await geminiRes.json();
  const fullText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // 解析轉錄和回應
  const transcriptMatch = fullText.match(/\[轉錄\]([\s\S]*?)(?=\[回應\]|$)/);
  const responseMatch = fullText.match(/\[回應\]([\s\S]*?)$/);
  const userText = transcriptMatch ? transcriptMatch[1].trim() : '';
  const aiText = responseMatch ? responseMatch[1].trim() : fullText.trim();

  // Step 3：如果需要語音輸出，呼叫 Gemini TTS
  let audioBase64Out = null;
  if (outputMode === 'audio' || outputMode === 'both') {
    audioBase64Out = await generateTTS(aiText, lang, env);
  }

  const result = { userText, aiText, audioBase64: audioBase64Out };
  return corsResponse(JSON.stringify(result), 200, origin, true);
}

// ─── /cards ────────────────────────────────────────────────────────────────
// 分析對話 → 生成學習卡片 JSON
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

  // 優先用 Gemma 4 省 Gemini 配額
  const gemmaRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-it:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2000 }
      })
    }
  );

  const gemmaData = await gemmaRes.json();
  let rawText = gemmaData.candidates?.[0]?.content?.parts?.[0]?.text || '{"cards":[]}';

  // 清理 JSON
  rawText = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  let cards;
  try {
    cards = JSON.parse(rawText).cards || [];
  } catch {
    cards = [];
  }

  return corsResponse(JSON.stringify({ cards }), 200, origin, true);
}

// ─── /notion ───────────────────────────────────────────────────────────────
// 將學習卡片寫進 Notion 資料庫
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
      }
    };

    const notionRes = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify(body)
    });

    results.push(notionRes.ok);
  }

  const success = results.every(Boolean);
  return corsResponse(JSON.stringify({ success, count: results.filter(Boolean).length }), 200, origin, true);
}

// ─── TTS ────────────────────────────────────────────────────────────────────
async function generateTTS(text, lang, env) {
  const voiceMap = {
    ja: 'ja-JP-Neural2-B',
    en: 'en-US-Neural2-D',
    ko: 'ko-KR-Neural2-A',
    fr: 'fr-FR-Neural2-B',
    de: 'de-DE-Neural2-B',
    es: 'es-ES-Neural2-B',
  };

  // 使用 Gemini 2.5 Flash TTS
  const ttsRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
        }
      })
    }
  );

  if (!ttsRes.ok) return null;

  const ttsData = await ttsRes.json();
  return ttsData.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || null;
}

// ─── 工具函式 ───────────────────────────────────────────────────────────────
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function corsResponse(body, status, origin, isAllowed) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': isAllowed ? origin || '*' : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  return new Response(body, { status, headers });
}
