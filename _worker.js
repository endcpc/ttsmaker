/**
 * A Cloudflare Worker for proxying Microsoft Edge's TTS service with embedded WebUI.
 *
 * @version 1.0.0
 * @description This version fixes the API key validation logic, restores the cURL example,
 * corrects UI alignment, and enables the streaming functionality. It's the definitive release.
 */

// =================================================================================
// Configuration & Global State
// =================================================================================

// Environment variables will be accessed directly from globalThis when needed
const MAX_STORAGE_SIZE = 1024 * 1024 * 1024; // 1GB limit
const OPENAI_VOICE_MAP = {
  shimmer: "zh-CN-XiaoxiaoNeural",
  alloy: "zh-CN-YunyangNeural",
  fable: "zh-CN-YunjianNeural",
  onyx: "zh-CN-XiaoyiNeural",
  nova: "zh-CN-YunxiNeural",
  echo: "zh-CN-liaoning-XiaobeiNeural",
};
let tokenInfo = { endpoint: null, token: null, expiredAt: null };
const TOKEN_REFRESH_BEFORE_EXPIRY = 5 * 60;

// 基於域名生成唯一的用戶ID
function generateUserIdFromDomain(requestUrl) {
  try {
    const url = new URL(requestUrl);
    const domain = url.hostname;
    // 使用簡單的哈希算法生成16位十六進制用戶ID
    let hash = 0;
    for (let i = 0; i < domain.length; i++) {
      const char = domain.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // 轉換爲32位整數
    }
    // 轉換爲16位十六進制字符串，確保爲正數
    return (
      Math.abs(hash).toString(16).padStart(8, "0") +
      Math.abs(hash * 31)
        .toString(16)
        .padStart(8, "0")
    );
  } catch (error) {
    // 如果解析失敗，使用默認值
    console.warn(
      "Failed to generate userId from domain, using default:",
      error
    );
    return "0f04d16a175c411e";
  }
}

// =================================================================================
// Cloudflare Pages Entry Point
// =================================================================================

export default {
  async fetch(request, env, ctx) {
    if (env.API_KEY) {
      globalThis.API_KEY = env.API_KEY;
    }
    if (env.TTS_HISTORY) {
      globalThis.TTS_HISTORY = env.TTS_HISTORY;
    }
    return await handleRequest(request);
  },
};

// =================================================================================
// Main Request Handler
// =================================================================================

async function handleRequest(request) {
  const url = new URL(request.url);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(getWebUIHTML(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Handle favicon
  if (url.pathname === "/favicon.ico") {
    return new Response(getFaviconSVG(), {
      headers: { "Content-Type": "image/svg+xml" },
    });
  }
  if (request.method === "OPTIONS") {
    return handleOptions(request);
  }

  if (url.pathname.startsWith("/v1/")) {
    const authHeader = request.headers.get("authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return errorResponse(
        "Missing or invalid authorization header.",
        401,
        "invalid_api_key"
      );
    }

    const providedKey = authHeader.slice(7);

    // 檢查是否爲分享UUID
    if (providedKey.startsWith("share_")) {
      const shareUUID = providedKey.replace("share_", "");
      console.log("Share UUID validation for:", shareUUID);

      if (!globalThis.TTS_HISTORY) {
        return errorResponse("KV storage not configured", 500, "storage_error");
      }

      try {
        const shareAuthData = await globalThis.TTS_HISTORY.get(
          `share_auth_${shareUUID}`
        );
        if (!shareAuthData) {
          console.log("Share UUID not found");
          return errorResponse("Invalid share UUID.", 403, "invalid_api_key");
        }

        // 解析請求體以驗證內容哈希
        const requestBody = await request.clone().json();
        const shareData = {
          text: requestBody.input,
          voice: requestBody.voice,
          speed: requestBody.speed,
          pitch: requestBody.pitch,
          style: requestBody.style,
          role: requestBody.role,
          styleDegree: requestBody.styleDegree,
          cleaningOptions: requestBody.cleaning_options,
        };

        const contentString = JSON.stringify(shareData);
        const contentHash = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(contentString)
        );
        const hashArray = Array.from(new Uint8Array(contentHash));

        const authData = JSON.parse(shareAuthData);
        const storedHash = authData.contentHash;

        // 比較哈希值
        if (JSON.stringify(hashArray) !== JSON.stringify(storedHash)) {
          console.log("Content hash mismatch");
          return errorResponse(
            "Content validation failed.",
            403,
            "invalid_content"
          );
        }

        console.log("Share UUID validation passed");
      } catch (error) {
        console.log("Share UUID validation error:", error);
        return errorResponse(
          "Share validation failed.",
          403,
          "validation_error"
        );
      }
    } else if (globalThis.API_KEY) {
      // 常規API Key驗證
      if (providedKey !== globalThis.API_KEY) {
        return errorResponse("Invalid API key.", 403, "invalid_api_key");
      }
    }
  }

  try {
    if (url.pathname === "/v1/audio/speech")
      return await handleSpeechRequest(request);
    if (url.pathname === "/v1/models") return handleModelsRequest();
    if (url.pathname === "/history") return await handleHistoryRequest(request);
    if (/^\/share\/[^/]+\/auth$/.test(url.pathname))
      return await handleShareAuthRequest(request);
    if (url.pathname.startsWith("/share/"))
      return await handleShareRequest(request);
    if (url.pathname === "/play") return await handlePlayPageRequest(request);
    if (url.pathname === "/api/save") return await handleSaveRequest(request);
    if (url.pathname === "/api/save-realtime")
      return await handleSaveRealtimeRequest(request);
    if (url.pathname === "/api/history")
      return await handleHistoryApiRequest(request);
    if (url.pathname === "/api/set-password")
      return await handleSetPasswordRequest(request);
    if (url.pathname === "/api/delete")
      return await handleDeleteRequest(request);
    if (url.pathname.startsWith("/api/audio/"))
      return await handleAudioRequest(request);
  } catch (err) {
    return errorResponse(err.message, 500, "internal_server_error");
  }

  return errorResponse("Not Found", 404, "not_found");
}

// =================================================================================
// API Route Handlers
// =================================================================================

// Handle save realtime play to history
async function handleSaveRealtimeRequest(request) {
  if (request.method !== "POST") {
    return errorResponse("Method Not Allowed", 405, "method_not_allowed");
  }

  if (!globalThis.TTS_HISTORY) {
    return errorResponse("KV storage not configured", 500, "storage_error");
  }

  try {
    const realtimeData = await request.json();

    if (!realtimeData.text) {
      return errorResponse("Missing required fields", 400, "invalid_request");
    }

    // Generate unique ID
    const id = crypto.randomUUID();
    const shareUUID = crypto.randomUUID();
    const timestamp = Date.now();

    // 創建用於哈希的內容數據
    const shareData = {
      text: realtimeData.text,
      voice: realtimeData.voice,
      speed: realtimeData.speed,
      pitch: realtimeData.pitch,
      style: realtimeData.style,
      role: realtimeData.role,
      styleDegree: realtimeData.styleDegree,
      cleaningOptions: realtimeData.cleaningOptions,
    };

    // 生成內容哈希
    const contentString = JSON.stringify(shareData);
    const contentHash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(contentString)
    );
    const hashArray = Array.from(new Uint8Array(contentHash));

    // Create metadata for realtime play
    const metadata = {
      id,
      shareUUID, // 添加分享UUID
      text: realtimeData.text,
      voice: realtimeData.voice,
      speed: realtimeData.speed,
      pitch: realtimeData.pitch,
      style: realtimeData.style,
      role: realtimeData.role,
      styleDegree: realtimeData.styleDegree,
      cleaningOptions: realtimeData.cleaningOptions,
      timestamp,
      summary:
        realtimeData.text.substring(0, 100) +
        (realtimeData.text.length > 100 ? "..." : ""),
      type: "realtime", // 標記爲實時播放類型
      size: 0, // 實時播放不存儲音頻文件
    };

    // Save metadata only (no audio file)
    await globalThis.TTS_HISTORY.put(`meta_${id}`, JSON.stringify(metadata), {
      metadata: { type: "realtime", timestamp },
    });

    // 保存分享授權數據
    await globalThis.TTS_HISTORY.put(
      `share_auth_${shareUUID}`,
      JSON.stringify({
        contentHash: hashArray,
        shareData: shareData,
      }),
      {
        metadata: { type: "share_auth", timestamp },
      }
    );

    // Update history index
    await updateHistoryIndex(id, metadata);

    return new Response(
      JSON.stringify({ success: true, id, shareUrl: `/share/${id}` }),
      {
        headers: { "Content-Type": "application/json", ...makeCORSHeaders() },
      }
    );
  } catch (error) {
    return errorResponse(
      `Save realtime failed: ${error.message}`,
      500,
      "save_error"
    );
  }
}

// Handle save TTS to history
async function handleSaveRequest(request) {
  if (request.method !== "POST") {
    return errorResponse("Method Not Allowed", 405, "method_not_allowed");
  }

  if (!globalThis.TTS_HISTORY) {
    return errorResponse("KV storage not configured", 500, "storage_error");
  }

  try {
    // Parse FormData
    const formData = await request.formData();
    const text = formData.get("text");
    const voice = formData.get("voice");
    const speed = parseFloat(formData.get("speed"));
    const pitch = parseFloat(formData.get("pitch"));
    const cleaningOptions = JSON.parse(formData.get("cleaningOptions") || "{}");
    const audioFile = formData.get("audioFile");

    if (!text || !audioFile) {
      return errorResponse("Missing required fields", 400, "invalid_request");
    }

    // Generate unique ID
    const id = crypto.randomUUID();
    const timestamp = Date.now();

    // Get audio data as ArrayBuffer
    const audioArrayBuffer = await audioFile.arrayBuffer();
    const audioData = new Uint8Array(audioArrayBuffer);

    // Create metadata
    const metadata = {
      id,
      text,
      voice,
      speed,
      pitch,
      cleaningOptions,
      timestamp,
      summary: text.substring(0, 100) + (text.length > 100 ? "..." : ""),
      size: audioData.length,
    };

    // Check storage limit and clean if necessary
    await cleanupStorageIfNeeded(audioData.length);

    // Save audio data directly (no encoding needed)
    await globalThis.TTS_HISTORY.put(`audio_${id}`, audioData, {
      metadata: { type: "audio", timestamp },
    });

    // Save metadata
    await globalThis.TTS_HISTORY.put(`meta_${id}`, JSON.stringify(metadata), {
      metadata: { type: "metadata", timestamp },
    });

    // Update history index
    await updateHistoryIndex(id, metadata);

    return new Response(
      JSON.stringify({ success: true, id, shareUrl: `/share/${id}` }),
      {
        headers: { "Content-Type": "application/json", ...makeCORSHeaders() },
      }
    );
  } catch (error) {
    return errorResponse(`Save failed: ${error.message}`, 500, "save_error");
  }
}

// Handle history page
async function handleHistoryRequest(request) {
  return new Response(getHistoryPageHTML(), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// Handle history API
async function handleHistoryApiRequest(request) {
  if (!globalThis.TTS_HISTORY) {
    return errorResponse("KV storage not configured", 500, "storage_error");
  }

  // Check API key for history access
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return errorResponse(
      "API key required to access history",
      401,
      "unauthorized"
    );
  }

  try {
    const historyData = await globalThis.TTS_HISTORY.get("history_index");
    const history = historyData ? JSON.parse(historyData) : [];

    // Sort by timestamp (newest first)
    history.sort((a, b) => b.timestamp - a.timestamp);

    return new Response(JSON.stringify({ history }), {
      headers: { "Content-Type": "application/json", ...makeCORSHeaders() },
    });
  } catch (error) {
    return errorResponse(
      `Failed to load history: ${error.message}`,
      500,
      "history_error"
    );
  }
}

// Handle set password for share
async function handleSetPasswordRequest(request) {
  if (request.method !== "POST") {
    return errorResponse("Method Not Allowed", 405, "method_not_allowed");
  }

  if (!globalThis.TTS_HISTORY) {
    return errorResponse("KV storage not configured", 500, "storage_error");
  }

  // Check API key
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return errorResponse("API key required", 401, "unauthorized");
  }

  try {
    const { id, password } = await request.json();

    if (!id) {
      return errorResponse("Missing item ID", 400, "invalid_request");
    }

    // Get existing metadata
    const metadataStr = await globalThis.TTS_HISTORY.get(`meta_${id}`);
    if (!metadataStr) {
      return errorResponse("Item not found", 404, "not_found");
    }

    const metadata = JSON.parse(metadataStr);

    // Update password (empty string removes password)
    metadata.password = password || null;

    // Save updated metadata
    await globalThis.TTS_HISTORY.put(`meta_${id}`, JSON.stringify(metadata), {
      metadata: { type: "metadata", timestamp: metadata.timestamp },
    });

    return new Response(
      JSON.stringify({ success: true, hasPassword: !!password }),
      {
        headers: { "Content-Type": "application/json", ...makeCORSHeaders() },
      }
    );
  } catch (error) {
    return errorResponse(
      `Failed to set password: ${error.message}`,
      500,
      "password_error"
    );
  }
}

// Handle delete item
async function handleDeleteRequest(request) {
  if (request.method !== "POST") {
    return errorResponse("Method Not Allowed", 405, "method_not_allowed");
  }

  if (!globalThis.TTS_HISTORY) {
    return errorResponse("KV storage not configured", 500, "storage_error");
  }

  // Check API key
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return errorResponse("API key required", 401, "unauthorized");
  }

  try {
    const { id } = await request.json();

    if (!id) {
      return errorResponse("Missing item ID", 400, "invalid_request");
    }

    // Delete audio and metadata
    await globalThis.TTS_HISTORY.delete(`audio_${id}`);
    await globalThis.TTS_HISTORY.delete(`meta_${id}`);

    // Update history index
    const historyData = await globalThis.TTS_HISTORY.get("history_index");
    const history = historyData ? JSON.parse(historyData) : [];
    const updatedHistory = history.filter((item) => item.id !== id);
    await globalThis.TTS_HISTORY.put(
      "history_index",
      JSON.stringify(updatedHistory)
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json", ...makeCORSHeaders() },
    });
  } catch (error) {
    return errorResponse(
      `Failed to delete item: ${error.message}`,
      500,
      "delete_error"
    );
  }
}

// Handle play page (page sharing)
async function handlePlayPageRequest(request) {
  const url = new URL(request.url);
  const params = url.searchParams;

  // 獲取分享參數
  const text = params.get("text");
  const voice = params.get("voice") || "alloy";
  const speed = parseFloat(params.get("speed")) || 1.0;
  const pitch = parseFloat(params.get("pitch")) || 1.0;
  const style = params.get("style") || "general";
  const role = params.get("role") || "";
  const styleDegree = parseFloat(params.get("styleDegree")) || 1.0;

  if (!text) {
    return errorResponse("Missing text parameter", 400, "invalid_request");
  }

  return new Response(
    getPlayPageHTML({
      text: decodeURIComponent(text),
      voice,
      speed,
      pitch,
      style,
      role,
      styleDegree,
    }),
    {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }
  );
}

// Handle share page
async function handleShareRequest(request) {
  const url = new URL(request.url);
  const id = url.pathname.split("/")[2];
  const providedPassword = url.searchParams.get("pwd");
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = parseCookies(cookieHeader);

  if (!id || !globalThis.TTS_HISTORY) {
    return errorResponse("Invalid share link", 404, "not_found");
  }

  try {
    const metadataStr = await globalThis.TTS_HISTORY.get(`meta_${id}`);
    if (!metadataStr) {
      return errorResponse("Share link not found", 404, "not_found");
    }

    const metadata = JSON.parse(metadataStr);

    // Check password protection
    if (metadata.password) {
      const cookieName = `share_auth_${id}`;
      const authorized = cookies[cookieName] === "1";
      if (!authorized) {
        // 兼容舊鏈接：?pwd= 正確則下發 Cookie 並重定向到乾淨鏈接
        if (providedPassword && providedPassword === metadata.password) {
          return new Response(null, {
            status: 302,
            headers: {
              Location: `/share/${id}`,
              "Set-Cookie": `${cookieName}=1; Max-Age=604800; Path=/share/${id}; HttpOnly; SameSite=Lax; Secure`,
              ...makeCORSHeaders(),
            },
          });
        }
        return new Response(getPasswordPageHTML(id), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    // 檢查是否爲實時播放類型
    if (metadata.type === "realtime") {
      // 實時播放類型，返回實時播放頁面
      return new Response(getRealtimeSharePageHTML(metadata, id), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } else {
      // 傳統類型，需要音頻文件
      const audioData = await globalThis.TTS_HISTORY.get(`audio_${id}`);
      if (!audioData) {
        return errorResponse("Audio data not found", 404, "not_found");
      }

      return new Response(getSharePageHTML(metadata, id), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
  } catch (error) {
    return errorResponse(
      `Failed to load share page: ${error.message}`,
      500,
      "share_error"
    );
  }
}

// Handle share page auth (set cookie)
async function handleShareAuthRequest(request) {
  if (request.method !== "POST") {
    return errorResponse("Method Not Allowed", 405, "method_not_allowed");
  }
  const url = new URL(request.url);
  const id = url.pathname.split("/")[2];
  if (!id || !globalThis.TTS_HISTORY) {
    return errorResponse("Invalid share link", 404, "not_found");
  }
  try {
    const metadataStr = await globalThis.TTS_HISTORY.get(`meta_${id}`);
    if (!metadataStr) {
      return errorResponse("Share link not found", 404, "not_found");
    }
    const metadata = JSON.parse(metadataStr);
    if (!metadata.password) {
      // 無密碼直接通過
      return new Response(null, {
        status: 204,
        headers: { ...makeCORSHeaders() },
      });
    }
    const contentType = request.headers.get("Content-Type") || "";
    let password = "";
    if (contentType.includes("application/json")) {
      const body = await request.json().catch(() => ({}));
      password = body.password || "";
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const form = await request.formData();
      password = form.get("password") || "";
    }
    if (password !== metadata.password) {
      return errorResponse("Invalid password", 401, "unauthorized");
    }
    const cookieName = `share_auth_${id}`;
    return new Response(null, {
      status: 204,
      headers: {
        "Set-Cookie": `${cookieName}=1; Max-Age=604800; Path=/share/${id}; HttpOnly; SameSite=Lax; Secure`,
        ...makeCORSHeaders(),
      },
    });
  } catch (error) {
    return errorResponse(`Auth failed: ${error.message}`, 500, "auth_error");
  }
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx > -1) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  }
  return out;
}

// Handle audio file serving
async function handleAudioRequest(request) {
  const url = new URL(request.url);
  const id = url.pathname.split("/")[3];

  if (!id || !globalThis.TTS_HISTORY) {
    return errorResponse("Invalid audio request", 404, "not_found");
  }

  try {
    const audioData = await globalThis.TTS_HISTORY.get(
      `audio_${id}`,
      "arrayBuffer"
    );
    if (!audioData) {
      return errorResponse("Audio not found", 404, "not_found");
    }

    return new Response(audioData, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": audioData.byteLength.toString(),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000",
        ...makeCORSHeaders(),
      },
    });
  } catch (error) {
    return errorResponse(
      `Failed to serve audio: ${error.message}`,
      500,
      "audio_error"
    );
  }
}

function handleOptions(request) {
  return new Response(null, {
    status: 204,
    headers: {
      ...makeCORSHeaders(),
      "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
      "Access-Control-Allow-Headers":
        request.headers.get("Access-Control-Request-Headers") ||
        "Authorization, Content-Type",
    },
  });
}

async function handleSpeechRequest(request) {
  if (request.method !== "POST")
    return errorResponse("Method Not Allowed", 405, "method_not_allowed");

  const requestBody = await request.json();
  if (!requestBody.input)
    return errorResponse(
      "'input' is a required parameter.",
      400,
      "invalid_request_error"
    );

  const {
    model = "tts-1",
    input,
    voice,
    speed = 1.0,
    pitch = 1.0,
    style = "general",
    role = "",
    styleDegree = 1.0,
    stream = false,
    cleaning_options = {},
  } = requestBody;

  // OpenAI 兼容性處理
  let finalVoice;
  if (model === "tts-1" || model === "tts-1-hd") {
    // 標準 OpenAI 格式：使用 voice 參數
    finalVoice = OPENAI_VOICE_MAP[voice] || voice || "zh-CN-XiaoxiaoNeural";
  } else if (model.startsWith("tts-1-")) {
    // 兼容舊格式：從 model 中提取音色
    finalVoice =
      OPENAI_VOICE_MAP[model.replace("tts-1-", "")] || "zh-CN-XiaoxiaoNeural";
  } else {
    // 直接使用指定的音色
    finalVoice = voice || model || "zh-CN-XiaoxiaoNeural";
  }
  const finalCleaningOptions = {
    remove_markdown: true,
    remove_emoji: true,
    remove_urls: true,
    remove_line_breaks: false,
    remove_citation_numbers: true,
    custom_keywords: "",
    ...cleaning_options,
  };
  const cleanedInput = cleanText(input, finalCleaningOptions);
  const rate = ((speed - 1) * 100).toFixed(0);
  const numPitch = ((pitch - 1) * 100).toFixed(0);
  const outputFormat = "audio-24khz-48kbitrate-mono-mp3";

  if (stream) {
    return await getVoiceStream(
      cleanedInput,
      finalVoice,
      rate,
      numPitch,
      style,
      role,
      styleDegree,
      outputFormat,
      request
    );
  } else {
    return await getVoice(
      cleanedInput,
      finalVoice,
      rate,
      numPitch,
      style,
      role,
      styleDegree,
      outputFormat,
      request
    );
  }
}

function handleModelsRequest() {
  const models = [
    { id: "tts-1", object: "model", created: Date.now(), owned_by: "openai" },
    {
      id: "tts-1-hd",
      object: "model",
      created: Date.now(),
      owned_by: "openai",
    },
    ...Object.keys(OPENAI_VOICE_MAP).map((v) => ({
      id: `tts-1-${v}`,
      object: "model",
      created: Date.now(),
      owned_by: "openai",
    })),
  ];
  return new Response(JSON.stringify({ object: "list", data: models }), {
    headers: { "Content-Type": "application/json", ...makeCORSHeaders() },
  });
}

// =================================================================================
// Core TTS Logic (Android App Simulation)
// =================================================================================

async function getVoice(
  text,
  voiceName,
  rate,
  pitch,
  style,
  role,
  styleDegree,
  outputFormat,
  request
) {
  const maxChunkSize = 2000;
  const chunks = [];
  for (let i = 0; i < text.length; i += maxChunkSize) {
    chunks.push(text.slice(i, i + maxChunkSize));
  }
  const audioChunks = await Promise.all(
    chunks.map((chunk) =>
      getAudioChunk(
        chunk,
        voiceName,
        rate,
        pitch,
        style,
        role,
        styleDegree,
        outputFormat,
        request
      )
    )
  );
  const concatenatedAudio = new Blob(audioChunks, { type: "audio/mpeg" });
  return new Response(concatenatedAudio, {
    headers: { "Content-Type": "audio/mpeg", ...makeCORSHeaders() },
  });
}

async function getVoiceStream(
  text,
  voiceName,
  rate,
  pitch,
  style,
  role,
  styleDegree,
  outputFormat,
  request
) {
  const maxChunkSize = 2000;
  const chunks = [];
  for (let i = 0; i < text.length; i += maxChunkSize) {
    chunks.push(text.slice(i, i + maxChunkSize));
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  (async () => {
    try {
      for (const chunk of chunks) {
        const audioBlob = await getAudioChunk(
          chunk,
          voiceName,
          rate,
          pitch,
          style,
          role,
          styleDegree,
          outputFormat,
          request
        );
        const arrayBuffer = await audioBlob.arrayBuffer();
        await writer.write(new Uint8Array(arrayBuffer));
      }
    } catch (error) {
      await writer.abort(error);
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: { "Content-Type": "audio/mpeg", ...makeCORSHeaders() },
  });
}

async function getAudioChunk(
  text,
  voiceName,
  rate,
  pitch,
  style,
  role,
  styleDegree,
  outputFormat,
  request
) {
  const endpoint = await getEndpoint(request);
  const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;

  // 構建高級SSML
  const escapedText = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  let ssmlContent = `<prosody rate="${rate}%" pitch="${pitch}%">${escapedText}</prosody>`;

  // 添加語音風格和強度
  if (style && style !== "general") {
    const styleAttributes =
      styleDegree !== 1.0 ? ` styledegree="${styleDegree}"` : "";
    ssmlContent = `<mstts:express-as style="${style}"${styleAttributes}>${ssmlContent}</mstts:express-as>`;
  }

  // 添加角色扮演
  if (role) {
    ssmlContent = `<mstts:express-as role="${role}">${ssmlContent}</mstts:express-as>`;
  }

  const ssml = `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-TW"><voice name="${voiceName}">${ssmlContent}</voice></speak>`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: endpoint.t,
      "Content-Type": "application/ssml+xml",
      "User-Agent": "okhttp/4.5.0",
      "X-Microsoft-OutputFormat": outputFormat,
    },
    body: ssml,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Edge TTS API error: ${response.status} ${errorText}`);
  }
  return response.blob();
}

async function getEndpoint(request) {
  const now = Date.now() / 1000;
  if (
    tokenInfo.token &&
    now < tokenInfo.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY
  ) {
    return tokenInfo.endpoint;
  }

  const endpointUrl =
    "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
  const clientId = crypto.randomUUID().replace(/-/g, "");
  const userId = generateUserIdFromDomain(request.url);

  // 重試機制
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(endpointUrl, {
        method: "POST",
        headers: {
          "Accept-Language": "zh-Hans",
          "X-ClientVersion": "4.0.530a 5fe1dc6c",
          "X-UserId": userId,
          "X-HomeGeographicRegion": "zh-Hans-CN",
          "X-ClientTraceId": clientId,
          "X-MT-Signature": await sign(endpointUrl),
          "User-Agent": "okhttp/4.5.0",
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": "0",
          "Accept-Encoding": "gzip",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const jwt = data.t.split(".")[1];
      const decodedJwt = JSON.parse(atob(jwt));
      tokenInfo = { endpoint: data, token: data.t, expiredAt: decodedJwt.exp };
      return data;
    } catch (error) {
      lastError = error;
      console.error(`Endpoint attempt ${attempt} failed:`, error.message);

      // 如果不是最後一次嘗試，等待一下再重試
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  // 如果所有重試都失敗，嘗試使用緩存的 token
  if (tokenInfo.token) {
    console.warn("Using cached token due to endpoint failures");
    return tokenInfo.endpoint;
  }

  throw new Error(
    `Failed to get endpoint after 3 attempts: ${lastError.message}`
  );
}

async function sign(urlStr) {
  const url = urlStr.split("://")[1];
  const encodedUrl = encodeURIComponent(url);
  const uuidStr = crypto.randomUUID().replace(/-/g, "");
  const formattedDate =
    new Date().toUTCString().replace(/GMT/, "").trim() + " GMT";
  const bytesToSign =
    `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuidStr}`.toLowerCase();
  const keyBytes = await base64ToBytes(
    "oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw=="
  );
  const signatureBytes = await hmacSha256(keyBytes, bytesToSign);
  const signatureBase64 = await bytesToBase64(signatureBytes);
  return `MSTranslatorAndroidApp::${signatureBase64}::${formattedDate}::${uuidStr}`;
}

// =================================================================================
// Storage Management Functions
// =================================================================================

async function cleanupStorageIfNeeded(newItemSize) {
  if (!globalThis.TTS_HISTORY) return;

  try {
    // Get current storage usage
    const historyData = await globalThis.TTS_HISTORY.get("history_index");
    const history = historyData ? JSON.parse(historyData) : [];

    let totalSize = history.reduce((sum, item) => sum + (item.size || 0), 0);

    // If adding new item would exceed limit, remove oldest items
    while (totalSize + newItemSize > MAX_STORAGE_SIZE && history.length > 0) {
      const oldestItem = history.shift(); // Remove oldest
      totalSize -= oldestItem.size || 0;

      // Delete from KV
      await globalThis.TTS_HISTORY.delete(`audio_${oldestItem.id}`);
      await globalThis.TTS_HISTORY.delete(`meta_${oldestItem.id}`);
    }

    // Update history index
    await globalThis.TTS_HISTORY.put("history_index", JSON.stringify(history));
  } catch (error) {
    console.error("Cleanup failed:", error);
  }
}

async function updateHistoryIndex(id, metadata) {
  if (!globalThis.TTS_HISTORY) return;

  try {
    const historyData = await globalThis.TTS_HISTORY.get("history_index");
    const history = historyData ? JSON.parse(historyData) : [];

    // Add new item to beginning
    history.unshift({
      id: metadata.id,
      summary: metadata.summary,
      timestamp: metadata.timestamp,
      voice: metadata.voice,
      size: metadata.size,
      hasPassword: !!metadata.password,
      type: metadata.type || "stored", // 添加類型信息
    });

    // Keep only last 1000 items for performance
    if (history.length > 1000) {
      history.splice(1000);
    }

    await globalThis.TTS_HISTORY.put("history_index", JSON.stringify(history));
  } catch (error) {
    console.error("Failed to update history index:", error);
  }
}

function formatFileSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderMarkdown(text) {
  if (!text) return "";

  // 簡單的Markdown渲染
  let html = text
    // 轉義HTML
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")

    // 標題
    .replace(/^### (.*$)/gm, "<h3>$1</h3>")
    .replace(/^## (.*$)/gm, "<h2>$1</h2>")
    .replace(/^# (.*$)/gm, "<h1>$1</h1>")

    // 粗體和斜體
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")

    // 代碼
    .replace(/`([^`]+)`/g, "<code>$1</code>")

    // 鏈接
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')

    // 換行處理
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br>");

  // 包裝在段落中
  if (html && !html.startsWith("<h") && !html.startsWith("<p>")) {
    html = "<p>" + html + "</p>";
  }

  return html;
}

// =================================================================================
// Utility Functions
// =================================================================================

function cleanText(text, options) {
  let cleanedText = text;
  if (options.remove_urls)
    cleanedText = cleanedText.replace(/(https?:\/\/[^\s]+)/g, "");
  if (options.remove_markdown)
    cleanedText = cleanedText
      .replace(/!\[.*?\]\(.*?\)/g, "")
      .replace(/\[(.*?)\]\(.*?\)/g, "$1")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/`{1,3}(.*?)`{1,3}/g, "$1")
      .replace(/#{1,6}\s/g, "");
  if (options.custom_keywords) {
    const keywords = options.custom_keywords
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k);
    if (keywords.length > 0) {
      const regex = new RegExp(
        keywords
          .map((k) => k.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"))
          .join("|"),
        "g"
      );
      cleanedText = cleanedText.replace(regex, "");
    }
  }
  if (options.remove_emoji)
    cleanedText = cleanedText.replace(/\p{Emoji_Presentation}/gu, "");
  if (options.remove_citation_numbers)
    cleanedText = cleanedText.replace(/\[\d+\]/g, "").replace(/【\d+】/g, "");
  if (options.remove_line_breaks) {
    // 移除換行符，不添加空格，直接連接文本
    cleanedText = cleanedText.replace(/(\r\n|\n|\r)/gm, "");
    // 合併多個連續空格爲單個空格
    return cleanedText.trim().replace(/\s+/g, " ");
  } else {
    // 保留換行符，只合並非換行的連續空格
    return cleanedText.trim().replace(/[ \t]+/g, " ");
  }
}

async function hmacSha256(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(data)
  );
  return new Uint8Array(signature);
}

async function base64ToBytes(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++)
    bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}

async function bytesToBase64(bytes) {
  return btoa(String.fromCharCode.apply(null, bytes));
}

function errorResponse(message, status, code) {
  return new Response(
    JSON.stringify({ error: { message, type: "api_error", code } }),
    {
      status,
      headers: { "Content-Type": "application/json", ...makeCORSHeaders() },
    }
  );
}

function makeCORSHeaders(extraHeaders = "Content-Type, Authorization") {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": extraHeaders,
    "Access-Control-Max-Age": "86400",
  };
}

// =================================================================================
// Favicon and Assets
// =================================================================================

function getFaviconSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="45" fill="#007bff"/>
    <text x="50" y="65" font-family="Arial, sans-serif" font-size="40" fill="white" text-anchor="middle">🎵</text>
  </svg>`;
}

// =================================================================================
// Embedded WebUI (v7.0 - UI & Auth Fix)
// =================================================================================

function getPasswordPageHTML(id) {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>訪問受限 - 需要密碼</title>
  <style>
    :root { --primary-color: #007bff; --light-gray: #f8f9fa; --gray: #6c757d; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background-color: var(--light-gray); color: #343a40; line-height: 1.8; margin: 0; padding: 1rem; }
    .container { max-width: 520px; margin: 8vh auto 0; background-color: #ffffff; padding: 2rem; border-radius: 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08); text-align: center; }
    .lock-icon { font-size: 3rem; margin-bottom: 1rem; }
    .form-group { margin: 1rem 0; text-align: left; }
    label { display: block; margin-bottom: 0.5rem; color: #333; }
    input { width: 100%; padding: 0.6rem 0.8rem; border: 1px solid #dee2e6; border-radius: 6px; font-size: 1rem; }
    .btn { width: 100%; margin-top: 0.8rem; background-color: var(--primary-color); color: white; border: none; padding: 0.7rem; border-radius: 6px; cursor: pointer; }
    .error { display: none; color: #dc3545; margin-top: 0.8rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="lock-icon">🔒</div>
    <h1>內容受保護</h1>
    <p>此分享內容需要密碼才能訪問</p>
    
    <form id="password-form">
      <div class="form-group">
        <label for="password">請輸入訪問密碼</label>
        <input type="password" id="password" placeholder="輸入密碼" required>
      </div>
      <button type="submit" class="btn">訪問內容</button>
    </form>
    
    <div id="error" class="error">密碼錯誤，請重試</div>
  </div>
 
  <script>
    document.getElementById('password-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      const password = document.getElementById('password').value;
      if (!password) return;
      try {
        const res = await fetch('/share/${id}/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        if (res.ok) {
          window.location.href = '/share/${id}';
        } else {
          document.getElementById('error').style.display = 'block';
        }
      } catch (err) {
        document.getElementById('error').style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
}

function getPlayPageHTML(config) {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TTS 實時播放 - ${config.text.substring(0, 50)}${
    config.text.length > 50 ? "..." : ""
  }</title>
  <meta name="description" content="${config.text.substring(0, 100)}">
  <style>
    :root { --primary-color: #007bff; --success-color: #28a745; --light-gray: #f8f9fa; --gray: #6c757d; --border-color: #dee2e6; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background-color: var(--light-gray); color: #343a40; line-height: 1.8; margin: 0; padding: 1rem; }
    .container { max-width: 800px; margin: 0 auto; background-color: #ffffff; padding: 2rem; border-radius: 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08); }
    .header { text-align: center; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border-color); }
    .title { font-size: 1.5rem; font-weight: 700; color: #333; margin-bottom: 0.5rem; }
    .voice-info { font-size: 0.9rem; color: var(--gray); }
    .content { margin: 2rem 0; }
    .content h1, .content h2, .content h3 { color: #333; margin-top: 1.5rem; margin-bottom: 0.5rem; }
    .content h1 { font-size: 1.8rem; border-bottom: 2px solid var(--primary-color); padding-bottom: 0.5rem; }
    .content p { margin-bottom: 1rem; }
    .content strong { font-weight: 600; }
    .play-section { background-color: var(--light-gray); padding: 1rem; border-radius: 8px; margin: 1.5rem 0; text-align: center; }
    .play-button { background-color: var(--success-color); color: white; border: none; padding: 0.8rem 2rem; border-radius: 25px; font-size: 1rem; cursor: pointer; margin-bottom: 0.8rem; }
    .play-button:hover { background-color: #218838; }
    .play-button:disabled { background-color: var(--gray); cursor: not-allowed; }
    .audio-player { width: 100%; margin-top: 0.8rem; display: none; }
    .footer { text-align: center; margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border-color); }
    @media (max-width: 768px) {
      body { padding: 0; }
      .container { padding: 1rem; margin: 0; border-radius: 0; box-shadow: none; }
      .title { font-size: 1.3rem; }
      .play-section { padding: 0.8rem; margin: 1rem 0; }
      .play-button { padding: 0.6rem 1.5rem; font-size: 0.9rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title">🎵 TTS 實時播放</div>
      <div class="voice-info">
        音色：${config.voice} | 語速：${config.speed}x | 音調：${config.pitch}
      </div>
    </div>
    
    <div class="play-section">
      <button class="play-button" onclick="playAudio()">
        🎵 點擊播放語音
      </button>
      <div id="device-info" style="font-size: 0.85rem; color: var(--gray); margin-top: 0.5rem;"></div>
      <audio id="audioPlayer" class="audio-player" controls></audio>
    </div>
    
    <div class="content">
      ${renderMarkdown(config.text)}
    </div>
    
    <div class="footer">
      <a href="/" style="color: var(--gray); text-decoration: none;">← 返回 TTS 服務</a>
    </div>
  </div>

  <script>
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    let audioLoaded = false;
    
    // 顯示設備信息
    document.addEventListener('DOMContentLoaded', () => {
      const deviceInfo = document.getElementById('device-info');
      if (isMobile) {
        deviceInfo.textContent = '📱 移動端檢測：將使用標準播放模式，請耐心等待語音生成';
      } else {
        deviceInfo.textContent = '🖥️ PC端檢測：將使用流式播放模式，可快速開始播放';
      }
    });
    
    async function playAudio() {
      const audio = document.getElementById('audioPlayer');
      const button = document.querySelector('.play-button');
      
      if (audioLoaded) {
        try {
          audio.style.display = 'block';
          await audio.play();
        } catch (error) {
          alert('播放失敗: ' + error.message);
        }
        return;
      }
      
      button.textContent = '⏳ 正在生成語音...';
      button.disabled = true;
      
      try {
        const requestBody = {
          model: "tts-1",
          voice: "${config.voice}",
          input: ${JSON.stringify(config.text)},
          speed: ${config.speed},
          pitch: ${config.pitch},
          style: "${config.style}",
          role: "${config.role}",
          styleDegree: ${config.styleDegree},
          stream: !isMobile,
          cleaning_options: {
            remove_markdown: true,
            remove_emoji: true,
            remove_urls: true,
            remove_line_breaks: true,
            remove_citation_numbers: true
          }
        };
        
        const response = await fetch('/v1/audio/speech', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: { message: \`服務器錯誤: \${response.statusText}\` } }));
          throw new Error(errorData.error.message);
        }
        
        const blob = await response.blob();
        if (blob.size === 0) throw new Error('音頻文件爲空');
        
        audio.src = URL.createObjectURL(blob);
        audioLoaded = true;
        button.textContent = '🎵 點擊播放語音';
        button.disabled = false;
        
        audio.style.display = 'block';
        await audio.play();
        
      } catch (error) {
        button.textContent = '❌ 生成失敗';
        button.disabled = false;
        alert('語音生成失敗: ' + error.message);
      }
    }
  </script>
</body>
</html>`;
}

function getRealtimeSharePageHTML(metadata, id) {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TTS 實時播放 - ${metadata.summary}</title>
  <meta name="description" content="${metadata.summary}">
  <style>
    :root { --primary-color: #007bff; --success-color: #28a745; --light-gray: #f8f9fa; --gray: #6c757d; --border-color: #dee2e6; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background-color: var(--light-gray); color: #343a40; line-height: 1.8; margin: 0; padding: 1rem; }
    .container { max-width: 800px; margin: 0 auto; background-color: #ffffff; padding: 2rem; border-radius: 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08); }
    .header { text-align: center; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border-color); }
    .title { font-size: 1.5rem; font-weight: 700; color: #333; margin-bottom: 0.5rem; }
    .meta { font-size: 0.9rem; color: var(--gray); }
    .content { margin: 2rem 0; }
    .content h1, .content h2, .content h3 { color: #333; margin-top: 1.5rem; margin-bottom: 0.5rem; }
    .content h1 { font-size: 1.8rem; border-bottom: 2px solid var(--primary-color); padding-bottom: 0.5rem; }
    .content p { margin-bottom: 1rem; }
    .content strong { font-weight: 600; }
    .play-section { background-color: var(--light-gray); padding: 1rem; border-radius: 8px; margin: 1.5rem 0; text-align: center; }
    .play-button { background-color: var(--success-color); color: white; border: none; padding: 0.8rem 2rem; border-radius: 25px; font-size: 1rem; cursor: pointer; margin-bottom: 0.8rem; }
    .play-button:hover { background-color: #218838; }
    .play-button:disabled { background-color: var(--gray); cursor: not-allowed; }
    .device-info { font-size: 0.85rem; color: var(--gray); margin-top: 0.5rem; }
    .audio-player { width: 100%; margin-top: 0.8rem; display: none; }
    .footer { text-align: center; margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border-color); }
    @media (max-width: 768px) {
      body { padding: 0; }
      .container { padding: 1rem; margin: 0; border-radius: 0; box-shadow: none; }
      .title { font-size: 1.3rem; }
      .play-section { padding: 0.8rem; margin: 1rem 0; }
      .play-button { padding: 0.6rem 1.5rem; font-size: 0.9rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title">🎵 TTS 實時播放分享</div>
      <div class="meta">
        ${formatDate(metadata.timestamp)} • ${metadata.voice} • 實時生成
      </div>
    </div>
    
    <div class="play-section">
      <button class="play-button" onclick="playAudio()">
        🎵 點擊播放語音
      </button>
      <div class="device-info" id="device-info"></div>
      <audio id="audioPlayer" class="audio-player" controls></audio>
    </div>
    
    <div class="content">
      ${renderMarkdown(metadata.text)}
    </div>
    
    <div class="footer">
      <div class="share-buttons" style="display: flex; justify-content: center; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap;">
        <button class="share-btn share-copy" onclick="copyLink()" style="padding: 0.5rem 1rem; border: none; border-radius: 6px; cursor: pointer; text-decoration: none; font-size: 0.9rem; background-color: var(--primary-color); color: white;">📋 複製鏈接</button>
      </div>
      <div style="margin-bottom: 1rem;">
        <a href="/" style="color: var(--gray); text-decoration: none;">← 返回 TTS 服務</a>
      </div>
      <div style="padding-top: 1rem; border-top: 1px solid var(--border-color); font-size: 0.85rem; color: var(--gray);">
        <div style="display: flex; justify-content: center; align-items: center; gap: 1rem; flex-wrap: wrap;">
          <a href="https://github.com/samni728/edgetts-cloudflare-workers-webui" target="_blank" style="display: flex; align-items: center; gap: 0.5rem; color: var(--gray); text-decoration: none;">
            <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            GitHub 項目
          </a>
          <span>|</span>
          <a href="https://github.com/samni728/edgetts-cloudflare-workers-webui" target="_blank" style="color: var(--gray); text-decoration: none;">⭐ Star</a>
        </div>
        <div style="margin-top: 0.5rem; font-size: 0.8rem;">
          Powered by Edge TTS & Cloudflare Pages
        </div>
      </div>
    </div>
  </div>

  <script>
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    let audioLoaded = false;
    
    // 顯示設備信息
    document.addEventListener('DOMContentLoaded', () => {
      const deviceInfo = document.getElementById('device-info');
      if (isMobile) {
        deviceInfo.textContent = '📱 移動端檢測：將使用標準播放模式，請耐心等待語音生成';
      } else {
        deviceInfo.textContent = '🖥️ PC端檢測：將使用流式播放模式，可快速開始播放';
      }
    });
    
    async function playAudio() {
      const audio = document.getElementById('audioPlayer');
      const button = document.querySelector('.play-button');
      
      if (audioLoaded) {
        try {
          audio.style.display = 'block';
          await audio.play();
        } catch (error) {
          alert('播放失敗: ' + error.message);
        }
        return;
      }
      
      const isStreaming = !isMobile;
      button.textContent = isStreaming ? '⏳ 正在啓動流式播放...' : '⏳ 正在生成語音...';
      button.disabled = true;
      
      try {
        const requestBody = {
          model: "tts-1",
          voice: "${metadata.voice}",
          input: ${JSON.stringify(metadata.text)},
          speed: ${metadata.speed},
          pitch: ${metadata.pitch},
          style: "${metadata.style || "general"}",
          role: "${metadata.role || ""}",
          styleDegree: ${metadata.styleDegree || 1.0},
          stream: isStreaming,
          cleaning_options: ${JSON.stringify(metadata.cleaningOptions || {})}
        };
        
        console.log('Device detection:', { isMobile, isStreaming });
        console.log('Request body:', requestBody);
        
        const startTime = Date.now();
        
        const response = await fetch('/v1/audio/speech', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': 'Bearer share_${metadata.shareUUID}'
          },
          body: JSON.stringify(requestBody)
        });
        
        const responseTime = Date.now() - startTime;
        console.log(\`Response received in \${responseTime}ms, streaming: \${isStreaming}\`);
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: { message: \`服務器錯誤: \${response.statusText}\` } }));
          throw new Error(errorData.error.message);
        }
        
        if (isStreaming) {
          // 使用 MediaSource 進行真正的流式播放
          button.textContent = '⏳ 正在處理流式數據...';
          const mediaSource = new MediaSource();
          audio.src = URL.createObjectURL(mediaSource);
          audio.style.display = 'block';
          audio.play().catch(() => {});

          mediaSource.addEventListener('sourceopen', () => {
            const sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
            const reader = response.body.getReader();
            const pump = () => {
              reader.read().then(({ done, value }) => {
                if (done) {
                  if (!sourceBuffer.updating) mediaSource.endOfStream();
                  audioLoaded = true;
                  button.textContent = '🎵 點擊播放語音';
                  button.disabled = false;
                  return;
                }
                const append = () => sourceBuffer.appendBuffer(value);
                if (sourceBuffer.updating) {
                  sourceBuffer.addEventListener('updateend', append, { once: true });
                } else {
                  append();
                }
              }).catch(err => {
                console.error('Stream error:', err);
                try { mediaSource.endOfStream('network'); } catch (_) {}
                button.textContent = '❌ 生成失敗';
                button.disabled = false;
              });
            };
            sourceBuffer.addEventListener('error', (e) => console.error('SourceBuffer error:', e));
            mediaSource.addEventListener('error', (e) => console.error('MediaSource error:', e));
            sourceBuffer.addEventListener('updateend', pump);
            pump();
          }, { once: true });
        } else {
          const blob = await response.blob();
          if (blob.size === 0) throw new Error('音頻文件爲空');

          const totalTime = Date.now() - startTime;
          console.log(\`Audio ready in \${totalTime}ms, size: \${blob.size} bytes\`);

          audio.src = URL.createObjectURL(blob);
          audioLoaded = true;
          button.textContent = '🎵 點擊播放語音';
          button.disabled = false;

          audio.style.display = 'block';
          await audio.play();

          console.log(\`Total time from click to play: \${Date.now() - startTime}ms\`);
        }
        
      } catch (error) {
        button.textContent = '❌ 生成失敗';
        button.disabled = false;
        alert('語音生成失敗: ' + error.message);
      }
    }
    
    function copyLink() {
      // 移除URL中的密碼參數，確保分享鏈接不包含密碼
      const url = new URL(window.location.href);
      url.searchParams.delete('pwd'); // 移除密碼參數
      const cleanUrl = url.toString();
      
      navigator.clipboard.writeText(cleanUrl).then(() => {
        const btn = document.querySelector('.share-copy');
        const originalText = btn.textContent;
        btn.textContent = '✅ 已複製';
        setTimeout(() => {
          btn.textContent = originalText;
        }, 2000);
      }).catch(() => {
        prompt('複製鏈接:', cleanUrl);
      });
    }
  </script>
</body>
</html>`;
}

function getSharePageHTML(metadata, id) {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TTS 分享 - ${metadata.summary}</title>
  <meta name="description" content="${metadata.summary}">
  <style>
    :root { --primary-color: #007bff; --success-color: #28a745; --light-gray: #f8f9fa; --gray: #6c757d; --border-color: #dee2e6; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background-color: var(--light-gray); color: #343a40; line-height: 1.8; margin: 0; padding: 1rem; }
    .container { max-width: 800px; margin: 0 auto; background-color: #ffffff; padding: 2rem; border-radius: 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08); }
    .header { text-align: center; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border-color); }
    .title { font-size: 1.5rem; font-weight: 700; color: #333; margin-bottom: 0.5rem; }
    .meta { font-size: 0.9rem; color: var(--gray); }
    .content { margin: 2rem 0; }
    .content h1, .content h2, .content h3, .content h4, .content h5, .content h6 { color: #333; margin-top: 1.5rem; margin-bottom: 0.5rem; }
    .content h1 { font-size: 1.8rem; border-bottom: 2px solid var(--primary-color); padding-bottom: 0.5rem; }
    .content h2 { font-size: 1.5rem; }
    .content h3 { font-size: 1.3rem; }
    .content p { margin-bottom: 1rem; }
    .content blockquote { border-left: 4px solid var(--primary-color); padding-left: 1rem; margin: 1rem 0; font-style: italic; color: var(--gray); }
    .content code { background-color: #f1f3f4; padding: 0.2rem 0.4rem; border-radius: 3px; font-family: 'Courier New', monospace; }
    .content pre { background-color: #f8f9fa; padding: 1rem; border-radius: 6px; overflow-x: auto; }
    .content ul, .content ol { margin-bottom: 1rem; padding-left: 2rem; }
    .content li { margin-bottom: 0.3rem; }
    .content strong { font-weight: 600; }
    .content em { font-style: italic; }
    .audio-section { background-color: var(--light-gray); padding: 1rem; border-radius: 8px; margin: 1.5rem 0; text-align: center; }
    .play-button { background-color: var(--success-color); color: white; border: none; padding: 0.6rem 1.2rem; border-radius: 25px; font-size: 0.9rem; cursor: pointer; margin-bottom: 0.8rem; display: inline-flex; align-items: center; gap: 0.4rem; }
    .play-button:hover { background-color: #218838; }
    .audio-player { width: 100%; margin-top: 0.8rem; display: none; }
    .footer { text-align: center; margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border-color); }
    .share-buttons { display: flex; justify-content: center; gap: 1rem; margin-top: 1rem; flex-wrap: wrap; }
    .share-btn { padding: 0.5rem 1rem; border: none; border-radius: 6px; cursor: pointer; text-decoration: none; font-size: 0.9rem; }
    .share-copy { background-color: var(--primary-color); color: white; }
    .back-link { color: var(--gray); text-decoration: none; font-size: 0.9rem; }
    @media (max-width: 768px) {
      body { padding: 0; }
      .container { padding: 1rem; margin: 0; border-radius: 0; box-shadow: none; }
      .title { font-size: 1.3rem; }
      .content h1 { font-size: 1.5rem; }
      .audio-section { padding: 0.8rem; margin: 1rem 0; }
      .play-button { padding: 0.5rem 1rem; font-size: 0.85rem; }
      .share-buttons { flex-direction: column; align-items: center; }
      .header { margin-bottom: 1.5rem; padding-bottom: 0.8rem; }
      .footer { margin-top: 1.5rem; padding-top: 0.8rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title">🎵 TTS 語音分享</div>
      <div class="meta">
        ${formatDate(metadata.timestamp)} • ${
    metadata.voice
  } • ${formatFileSize(metadata.size)}
      </div>
    </div>
    
    <div class="audio-section">
      <button class="play-button" onclick="playAudio()">
        ▶️ 播放語音
      </button>
      <audio id="audioPlayer" class="audio-player" controls>
        您的瀏覽器不支持音頻播放。
      </audio>
    </div>
    
    <div class="content" id="content">
      ${renderMarkdown(metadata.text)}
    </div>
    
    <div class="footer">
      <div class="share-buttons">
        <button class="share-btn share-copy" onclick="copyLink()">📋 複製鏈接</button>
      </div>
      <div style="margin-top: 1rem;">
        <a href="/" class="back-link">← 返回 TTS 服務</a>
      </div>
      <div style="margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border-color); text-align: center; font-size: 0.85rem; color: var(--gray);">
        <div style="display: flex; justify-content: center; align-items: center; gap: 1rem; flex-wrap: wrap;">
          <a href="https://github.com/samni728/edgetts-cloudflare-workers-webui" target="_blank" style="display: flex; align-items: center; gap: 0.5rem; color: var(--gray); text-decoration: none;">
            <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            GitHub 項目
          </a>
          <span>|</span>
          <a href="https://github.com/samni728/edgetts-cloudflare-workers-webui" target="_blank" style="color: var(--gray); text-decoration: none;">⭐ Star</a>
        </div>
        <div style="margin-top: 0.5rem; font-size: 0.8rem;">
          Powered by Edge TTS & Cloudflare Pages
        </div>
      </div>
    </div>
  </div>

  <script>
    let audioLoaded = false;
    
    async function playAudio() {
      const audio = document.getElementById('audioPlayer');
      const button = document.querySelector('.play-button');
      
      if (!audioLoaded) {
        button.textContent = '⏳ 加載中...';
        button.disabled = true;
        
        try {
          const response = await fetch('/api/audio/${id}');
          if (response.ok) {
            const blob = await response.blob();
            
            // 驗證 blob 是否有效
            if (blob.size === 0) {
              throw new Error('音頻文件爲空');
            }
            
            audio.src = URL.createObjectURL(blob);
            audioLoaded = true;
            button.textContent = '▶️ 播放語音';
            button.disabled = false;
            
            // 添加音頻加載完成事件
            audio.addEventListener('canplaythrough', () => {
              console.log('Audio loaded successfully');
            }, { once: true });
            
            audio.addEventListener('error', (e) => {
              console.error('Audio error:', e);
              button.textContent = '❌ 播放失敗';
              alert('音頻播放失敗，請重試');
            });
            
          } else {
            const errorText = await response.text();
            throw new Error(\`HTTP \${response.status}: \${errorText}\`);
          }
        } catch (error) {
          console.error('Audio loading error:', error);
          button.textContent = '❌ 加載失敗';
          button.disabled = false;
          alert('音頻加載失敗: ' + error.message);
          return;
        }
      }
      
      try {
        audio.style.display = 'block';
        await audio.play();
      } catch (playError) {
        console.error('Audio play error:', playError);
        alert('播放失敗: ' + playError.message);
      }
    }
    
    function copyLink() {
      // 移除URL中的密碼參數，確保分享鏈接不包含密碼
      const url = new URL(window.location.href);
      url.searchParams.delete('pwd'); // 移除密碼參數
      const cleanUrl = url.toString();
      
      navigator.clipboard.writeText(cleanUrl).then(() => {
        const btn = document.querySelector('.share-copy');
        const originalText = btn.textContent;
        btn.textContent = '✅ 已複製';
        setTimeout(() => {
          btn.textContent = originalText;
        }, 2000);
      }).catch(() => {
        prompt('複製鏈接:', cleanUrl);
      });
    }
  </script>
</body>
</html>`;
}

function getHistoryPageHTML() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TTS 歷史記錄</title>
  <style>
    :root { --primary-color: #007bff; --success-color: #28a745; --error-color: #dc3545; --light-gray: #f8f9fa; --gray: #6c757d; --border-color: #dee2e6; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background-color: var(--light-gray); color: #343a40; line-height: 1.6; margin: 0; padding: 2rem; }
    .container { max-width: 1000px; margin: 0 auto; background-color: #ffffff; padding: 2rem; border-radius: 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08); }
    h1 { text-align: center; color: #333; margin-bottom: 2rem; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
    .back-btn { background-color: var(--gray); color: white; border: none; padding: 0.6rem 1.2rem; border-radius: 6px; cursor: pointer; text-decoration: none; }
    .history-item { border: 1px solid var(--border-color); border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; background-color: #fff; }
    .item-header { display: flex; justify-content: between; align-items: flex-start; margin-bottom: 1rem; }
    .item-summary { flex-grow: 1; font-weight: 600; color: #333; margin-bottom: 0.5rem; }
    .item-meta { font-size: 0.85rem; color: var(--gray); }
    .item-actions { display: flex; gap: 0.5rem; }
    
    /* 歷史記錄移動端優化 */
    @media (max-width: 768px) {
      .container { padding: 1rem; margin: 0; border-radius: 0; box-shadow: none; }
      body { padding: 0; }
      .history-item { padding: 1rem; margin-bottom: 0.8rem; border-radius: 6px; }
      .item-header { flex-direction: column; align-items: stretch; margin-bottom: 0.8rem; }
      .item-actions { justify-content: space-between; margin-top: 0.8rem; gap: 0.3rem; }
      .btn { padding: 0.6rem 0.4rem; font-size: 0.75rem; flex: 1; }
      .item-summary { margin-bottom: 0.3rem; font-size: 0.95rem; }
      .item-meta { font-size: 0.8rem; }
      h1 { font-size: 1.3rem; margin-bottom: 1rem; }
      .header { margin-bottom: 1rem; }
      .back-btn { padding: 0.5rem 1rem; font-size: 0.85rem; }
    }
    .btn { padding: 0.5rem; border: none; border-radius: 6px; cursor: pointer; font-size: 0.85rem; margin: 0 0.2rem; display: inline-flex; align-items: center; justify-content: center; transition: all 0.2s; }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
    .btn-play { background-color: var(--success-color); color: white; }
    .btn-play:hover { background-color: #218838; }
    .btn-share { background-color: var(--primary-color); color: white; }
    .btn-share:hover { background-color: #0056b3; }
    .btn-password { background-color: #ffc107; color: #212529; }
    .btn-password:hover { background-color: #e0a800; }
    .btn-delete { background-color: #dc3545; color: white; }
    .btn-delete:hover { background-color: #c82333; }
    .loading { text-align: center; padding: 2rem; color: var(--gray); }
    .empty { text-align: center; padding: 3rem; color: var(--gray); }
    audio { width: 100%; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📚 TTS 歷史記錄</h1>
      <a href="/" class="back-btn">← 返回主頁</a>
    </div>
    <div id="loading" class="loading">正在加載歷史記錄...</div>
    <div id="history-list"></div>
  </div>

  <script>
    async function loadHistory() {
      try {
        const apiKey = getCookie('apiKey');
        if (!apiKey) {
          document.getElementById('loading').innerHTML = '<div class="empty">請先設置 API Key 才能查看歷史記錄<br><a href="/">返回主頁設置</a></div>';
          return;
        }
        
        const response = await fetch('/api/history', {
          headers: {
            'Authorization': \`Bearer \${apiKey}\`
          }
        });
        const data = await response.json();
        
        document.getElementById('loading').style.display = 'none';
        
        if (data.history.length === 0) {
          document.getElementById('history-list').innerHTML = '<div class="empty">暫無歷史記錄</div>';
          return;
        }
        
        const historyHtml = data.history.map(item => \`
          <div class="history-item">
            <div class="item-header">
              <div style="flex-grow: 1;">
                <div class="item-summary">\${item.summary}</div>
                <div class="item-meta">
                  \${formatDate(item.timestamp)} • \${item.voice} • \${formatFileSize(item.size)}
                  \${item.hasPassword ? ' • 🔒 已設密碼' : ''}
                  \${item.type === 'realtime' ? ' • 🌐 實時播放' : ' • 💾 預存儲'}
                </div>
              </div>
              <div class="item-actions">
                <button class="btn btn-play" onclick="playAudio('\${item.id}', '\${item.type || 'stored'}')" title="播放">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z"/>
                  </svg>
                </button>
                <button class="btn btn-share" onclick="shareItem('\${item.id}')" title="分享">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/>
                  </svg>
                </button>
                <button class="btn btn-password" onclick="setPassword('\${item.id}')" title="設置密碼">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M18,8h-1V6c0-2.76-2.24-5-5-5S7,3.24,7,6v2H6c-1.1,0-2,0.9-2,2v10c0,1.1,0.9,2,2,2h12c1.1,0,2-0.9,2-2V10C20,8.9,19.1,8,18,8z M12,17c-1.1,0-2-0.9-2-2s0.9-2,2-2s2,0.9,2,2S13.1,17,12,17z M15.1,8H8.9V6c0-1.71,1.39-3.1,3.1-3.1s3.1,1.39,3.1,3.1V8z"/>
                  </svg>
                </button>
                <button class="btn btn-delete" onclick="deleteItem('\${item.id}')" title="刪除">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                  </svg>
                </button>
              </div>
            </div>
            <audio id="audio-\${item.id}" controls style="display: none;"></audio>
          </div>
        \`).join('');
        
        document.getElementById('history-list').innerHTML = historyHtml;
      } catch (error) {
        document.getElementById('loading').innerHTML = '<div class="empty">加載失敗: ' + error.message + '</div>';
      }
    }
    
    function formatDate(timestamp) {
      return new Date(timestamp).toLocaleString('zh-TW');
    }
    
    function formatFileSize(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
    
    async function playAudio(id, type = 'stored') {
      const audio = document.getElementById(\`audio-\${id}\`);
      const button = document.querySelector(\`[onclick*="playAudio('\${id}'"]\`);
      
      if (audio.src) {
        try {
          audio.style.display = 'block';
          await audio.play();
        } catch (error) {
          console.error('Audio play error:', error);
          alert('播放失敗: ' + error.message);
        }
        return;
      }
      
      // 更新按鈕狀態
      const originalText = button.innerHTML; // 使用innerHTML保存SVG圖標
      button.innerHTML = '⏳';
      button.disabled = true;
      
      try {
        if (type === 'realtime') {
          // 實時播放類型：直接跳轉到分享頁面
          window.open(\`/share/\${id}\`, '_blank');
          button.innerHTML = originalText;
          button.disabled = false;
        } else {
          // 預存儲類型：從API獲取音頻文件
          const response = await fetch(\`/api/audio/\${id}\`);
          if (response.ok) {
            const blob = await response.blob();
            
            // 驗證 blob 是否有效
            if (blob.size === 0) {
              throw new Error('音頻文件爲空');
            }
            
            audio.src = URL.createObjectURL(blob);
            
            // 添加錯誤處理
            audio.addEventListener('error', (e) => {
              console.error('Audio error:', e);
              alert('音頻播放失敗，請重試');
            }, { once: true });
            
            audio.style.display = 'block';
            await audio.play();
            
            button.innerHTML = originalText;
            button.disabled = false;
          } else {
            const errorText = await response.text();
            throw new Error(\`HTTP \${response.status}: \${errorText}\`);
          }
        }
      } catch (error) {
        console.error('Audio loading error:', error);
        button.innerHTML = originalText;
        button.disabled = false;
        alert('播放失敗: ' + error.message);
      }
    }
    
    function shareItem(id) {
      const shareUrl = \`\${window.location.origin}/share/\${id}\`;
      navigator.clipboard.writeText(shareUrl).then(() => {
        alert('分享鏈接已複製到剪貼板！');
      }).catch(() => {
        prompt('分享鏈接:', shareUrl);
      });
    }
    
    async function setPassword(id) {
      const currentPassword = prompt('設置訪問密碼（留空則移除密碼）:');
      if (currentPassword === null) return; // 用戶取消
      
      try {
        const apiKey = getCookie('apiKey');
        if (!apiKey) {
          alert('請先設置 API Key');
          return;
        }
        
        const response = await fetch('/api/set-password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': \`Bearer \${apiKey}\`
          },
          body: JSON.stringify({ id, password: currentPassword })
        });
        
        if (response.ok) {
          const result = await response.json();
          alert(result.hasPassword ? '密碼設置成功！' : '密碼已移除！');
          loadHistory(); // 刷新列表
        } else {
          const error = await response.json();
          alert('設置失敗: ' + error.error.message);
        }
      } catch (error) {
        alert('設置失敗: ' + error.message);
      }
    }
    
    async function deleteItem(id) {
      if (!confirm('確定要刪除這個語音記錄嗎？此操作不可恢復！')) {
        return;
      }
      
      try {
        const apiKey = getCookie('apiKey');
        if (!apiKey) {
          alert('請先設置 API Key');
          return;
        }
        
        const response = await fetch('/api/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': \`Bearer \${apiKey}\`
          },
          body: JSON.stringify({ id })
        });
        
        if (response.ok) {
          alert('刪除成功！');
          loadHistory(); // 刷新列表
        } else {
          const error = await response.json();
          alert('刪除失敗: ' + error.error.message);
        }
      } catch (error) {
        alert('刪除失敗: ' + error.message);
      }
    }
    
    function getCookie(name) {
      const value = \`; \${document.cookie}\`;
      const parts = value.split(\`; \${name}=\`);
      if (parts.length === 2) return parts.pop().split(';').shift();
    }
    
    loadHistory();
  </script>
</body>
</html>`;
}

function getWebUIHTML() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CF-TTS 服務終極測試頁面</title>
    <style>
      :root { --primary-color: #007bff; --success-color: #28a745; --error-color: #dc3545; --light-gray: #f8f9fa; --gray: #6c757d; --border-color: #dee2e6; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background-color: var(--light-gray); color: #343a40; line-height: 1.6; display: flex; justify-content: center; padding: 2rem; margin: 0; }
      .container { max-width: 800px; width: 100%; background-color: #ffffff; padding: 2.5rem; border-radius: 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08); }
      h1 { text-align: center; color: #333; margin-bottom: 2rem; font-weight: 700; }
      .form-group { margin-bottom: 1.5rem; }
      label { display: block; font-weight: 600; margin-bottom: 0.5rem; }
      input, select, textarea, button { width: 100%; padding: 0.8rem 1rem; border: 1px solid var(--border-color); border-radius: 8px; font-size: 1rem; box-sizing: border-box; transition: all 0.2s; }
      input:focus, select:focus, textarea:focus { outline: none; border-color: var(--primary-color); box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.15); }
      textarea { resize: vertical; min-height: 150px; }
      .textarea-footer { display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem; color: var(--gray); margin-top: 0.5rem; }
      #clear-text { background: none; border: none; color: var(--primary-color); cursor: pointer; padding: 0.2rem; width: auto; }
      .grid-layout { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.5rem; }
      .slider-group { display: flex; align-items: center; gap: 1rem; }
      .slider-group input[type="range"] { flex-grow: 1; padding: 0; }
      .slider-group span { font-weight: 500; min-width: 40px; text-align: right; }
      
      /* 按鈕佈局優化 */
      .action-section { margin-top: 2rem; }
      .all-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem; }
      
      /* 桌面端歷史記錄按鈕居中 */
      @media (min-width: 769px) {
        .all-buttons { grid-template-columns: 1fr 1fr auto; align-items: center; }
        .secondary-btn { justify-self: center; min-width: 160px; }
      }
      .usage-tips { margin-top: 0.8rem; padding: 0.8rem; background-color: #e7f3ff; border-radius: 6px; font-size: 0.85rem; color: #004085; }
      
      button { font-weight: 600; cursor: pointer; }
      .primary-btn { background-color: var(--primary-color); color: white; border-color: var(--primary-color); }
      .stream-btn { background-color: var(--success-color); color: white; border-color: var(--success-color); }
      .secondary-btn { background-color: var(--gray); color: white; border: none; padding: 0.6rem 1.5rem; border-radius: 8px; width: auto; }
      
      /* 移動端優化 */
      @media (max-width: 768px) {
        .container { padding: 1rem; margin: 0; border-radius: 0; box-shadow: none; }
        body { padding: 0; }
        .action-section { margin-top: 1rem; }
        .all-buttons { grid-template-columns: 1fr 1fr 1fr; gap: 0.5rem; }
        .primary-btn { padding: 0.7rem 0.3rem; font-size: 0.8rem; }
        .secondary-btn { padding: 0.7rem 0.3rem; font-size: 0.8rem; }
        .usage-tips { font-size: 0.8rem; padding: 0.6rem; margin-top: 0.5rem; }
        .usage-tips ul { margin: 0.3rem 0 0 1rem; }
        .usage-tips li { margin-bottom: 0.2rem; }
        
        /* 使用提示佈局修復 */
        .usage-tips > div:first-child { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; white-space: nowrap; }
        #dismiss-tips { flex-shrink: 0; margin-left: 0.5rem; }
        
        /* 表單組件緊湊化 */
        .form-group { margin-bottom: 1rem; }
        details { padding: 0.8rem; margin-bottom: 1rem; }
        input, select, textarea { padding: 0.6rem 0.8rem; }
        h1 { margin-bottom: 1.5rem; font-size: 1.5rem; }
      }
      #status { margin-top: 1.5rem; padding: 1rem; border-radius: 8px; text-align: center; font-weight: 500; display: none; }
      .status-info { background-color: #e7f3ff; color: #004085; }
      .status-success { background-color: #d4edda; color: #155724; }
      .status-error { background-color: #f8d7da; color: #721c24; }
      audio { width: 100%; margin-top: 1.5rem; display: none; }
      details { border: 1px solid var(--border-color); border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; background-color: var(--light-gray); }
      summary { font-weight: 600; cursor: pointer; }
      .checkbox-grid { margin-top: 1rem; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.8rem; }
      .checkbox-grid label { display: flex; align-items: center; gap: 0.5rem; font-weight: normal; margin: 0; }
      .checkbox-grid input[type="checkbox"] { width: auto; margin: 0; flex-shrink: 0; }
    </style>
  </head>
  <body>
    <main class="container">
      <h1>CF-TTS Proxy Server (v1.2)</h1>
      <details id="api-config" open>
        <summary>API 配置</summary>
        <div class="form-group" style="margin-top: 1rem">
          <label for="baseUrl">API Base URL</label>
          <input type="text" id="baseUrl" value="" readonly/>
        </div>
        <div class="form-group">
          <label for="apiKey">API Key</label>
          <input type="password" id="apiKey" placeholder="輸入部署時設置的 API Key" />
        </div>
        <button id="save-config" style="background-color: var(--primary-color); color: white;">保存並驗證</button>
      </details>
      <div class="form-group">
        <label for="inputText">輸入文本</label>
        <textarea id="inputText">你好，世界！[1] 這是一個 **Markdown** 格式的示例文本，包含鏈接 https://example.com 和 😊 表情符號。自定義關鍵詞：ABC</textarea>
        <div class="textarea-footer">
          <span id="char-count">0 字符</span>
          <button id="clear-text">清除</button>
        </div>
      </div>
      <div class="grid-layout">
        <div class="form-group">
          <label for="voice">選擇音色 (Voice)</label>
          <select id="voice">
            <option value="shimmer">shimmer (溫柔女聲)</option>
            <option value="alloy" selected>alloy (專業男聲)</option>
            <option value="fable">fable (激情男聲)</option>
            <option value="onyx">onyx (活潑女聲)</option>
            <option value="nova">nova (陽光男聲)</option>
            <option value="echo">echo (東北女聲)</option>
            <option value="custom">🎛️ 自定義音色配置</option>
          </select>
        </div>
        
        <div id="custom-voice-config" style="display: none; grid-column: 1 / -1;">
          <div class="form-group">
            <label for="customVoiceName">自定義音色名稱 (ShortName)</label>
            <input type="text" id="customVoiceName" placeholder="例如: zh-CN-XiaoxiaoNeural" />
            <small style="color: #666; font-size: 0.85rem; display: block; margin-top: 0.3rem;">
              完整的音色標識符，如 zh-CN-XiaoxiaoNeural 
              <a href="https://learn.microsoft.com/zh-cn/azure/ai-services/speech-service/language-support?tabs=tts#multilingual-voices" target="_blank" style="color: var(--primary-color); text-decoration: none; margin-left: 0.5rem;">
                📋 查看完整音色列表
              </a>
            </small>
          </div>
          <div class="grid-layout" style="margin-top: 1rem;">
            <div class="form-group">
              <label for="voiceStyle">語音風格 (可選)</label>
              <select id="voiceStyle">
                <option value="">默認風格</option>
                <option value="angry">憤怒 (angry)</option>
                <option value="cheerful">開朗 (cheerful)</option>
                <option value="excited">興奮 (excited)</option>
                <option value="friendly">友好 (friendly)</option>
                <option value="hopeful">希望 (hopeful)</option>
                <option value="sad">悲傷 (sad)</option>
                <option value="shouting">吶喊 (shouting)</option>
                <option value="terrified">恐懼 (terrified)</option>
                <option value="unfriendly">不友好 (unfriendly)</option>
                <option value="whispering">耳語 (whispering)</option>
                <option value="gentle">溫柔 (gentle)</option>
                <option value="lyrical">抒情 (lyrical)</option>
                <option value="newscast">新聞播報 (newscast)</option>
                <option value="poetry-reading">詩歌朗誦 (poetry-reading)</option>
              </select>
            </div>
            <div class="form-group">
              <label for="voiceRole">角色扮演 (可選)</label>
              <select id="voiceRole">
                <option value="">默認角色</option>
                <option value="Girl">女孩</option>
                <option value="Boy">男孩</option>
                <option value="YoungAdultFemale">年輕女性</option>
                <option value="YoungAdultMale">年輕男性</option>
                <option value="OlderAdultFemale">成年女性</option>
                <option value="OlderAdultMale">成年男性</option>
                <option value="SeniorFemale">老年女性</option>
                <option value="SeniorMale">老年男性</option>
              </select>
            </div>
            <div class="form-group">
              <label>風格強度 (可選)</label>
              <div class="slider-group">
                <input type="range" id="styleDegree" min="0.01" max="2" step="0.01" value="1" />
                <span id="styleDegreeValue">1.00</span>
              </div>
              <small style="color: #666; font-size: 0.85rem; display: block; margin-top: 0.3rem;">控制語音風格的強度，範圍 0.01-2.00</small>
            </div>
          </div>
        </div>
        <div class="form-group">
          <label>語速</label>
          <div class="slider-group">
            <input type="range" id="speed" min="0.25" max="2.0" value="1.0" step="0.05" />
            <span id="speed-value">1.00</span>
          </div>
        </div>
        <div class="form-group">
          <label>音調</label>
          <div class="slider-group">
            <input type="range" id="pitch" min="0.5" max="1.5" value="1.0" step="0.05" />
            <span id="pitch-value">1.00</span>
          </div>
        </div>
      </div>
      <details>
        <summary>高級文本清理選項</summary>
        <div class="checkbox-grid">
          <label><input type="checkbox" id="removeMarkdown" checked />移除 Markdown</label>
          <label><input type="checkbox" id="removeEmoji" checked />移除 Emoji</label>
          <label><input type="checkbox" id="removeUrls" checked />移除 URL</label>
          <label><input type="checkbox" id="removeLineBreaks" checked />移除所有換行</label>
          <label><input type="checkbox" id="removeCitation" checked />移除引用標記[數字]</label>
        </div>
        <div class="form-group" style="margin-top: 1rem; margin-bottom: 0">
          <label for="customKeywords">自定義移除關鍵詞 (逗號分隔)</label>
          <input type="text" id="customKeywords" placeholder="例如: ABC,XYZ" />
        </div>
      </details>
      <div class="action-section">
        <div style="margin-bottom: 1rem;">
          <div style="display: flex; gap: 2rem; flex-wrap: wrap; margin-bottom: 0.8rem;">
            <label style="display: flex; align-items: center; gap: 0.5rem; font-weight: normal;">
              <input type="checkbox" id="saveToHistory" style="width: auto; margin: 0;" />
              保存歷史記錄 (文本+錄音)
            </label>
            <label style="display: flex; align-items: center; gap: 0.5rem; font-weight: normal;">
              <input type="checkbox" id="saveAsRealtime" style="width: auto; margin: 0;" />
              保存實時播放 (文本+流播放)
            </label>
          </div>
          <div id="direct-save-buttons" style="display: none; text-align: center;">
            <button id="btn-direct-save" style="background-color: #17a2b8; color: white; padding: 0.6rem 1.5rem; border: none; border-radius: 6px; cursor: pointer;">
              💾 直接保存到歷史記錄
            </button>
          </div>
        </div>
        
        <div class="all-buttons">
          <button id="btn-generate" class="primary-btn">生成語音 (標準)</button>
          <button id="btn-stream" class="primary-btn stream-btn">生成語音 (流式)</button>
          <button id="btn-history" class="secondary-btn">📚 歷史記錄</button>
        </div>
        
        <div id="usage-tips" class="usage-tips" style="display: none;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.5rem;">
            <strong>💡 使用提示：</strong>
            <button id="dismiss-tips" style="background: none; border: none; color: #004085; cursor: pointer; padding: 0; font-size: 1.2rem; line-height: 1;" title="我知道了，不再顯示">×</button>
          </div>
          <ul style="margin: 0 0 0.5rem 1.2rem; padding: 0;">
            <li><strong>標準模式</strong>：適合所有設備，生成完整音頻後播放，穩定可靠</li>
            <li><strong>流式模式</strong>：桌面端可快速開始播放，移動端自動切換爲標準模式</li>
            <li><strong>長文本</strong>：超過1萬字建議使用標準模式，更穩定</li>
          </ul>
          <div style="text-align: center;">
            <button id="confirm-tips" style="background-color: #004085; color: white; border: none; padding: 0.4rem 1rem; border-radius: 4px; font-size: 0.8rem; cursor: pointer;">我知道了</button>
          </div>
        </div>
      </div>
      <div id="status"></div>
      <audio id="audioPlayer" controls></audio>
      <details id="curl-details" style="margin-top: 2rem">
        <summary>cURL 命令示例</summary>
        <div style="position: relative; background-color: #212529; color: #f8f9fa; padding: 1.5rem; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; font-family: 'Courier New', Consolas, monospace; font-size: 0.85rem; line-height: 1.4; overflow-x: auto;">
          <code id="curl-code">正在加載 cURL 示例...</code>
          <button id="copy-curl" style="position: absolute; top: 1rem; right: 1rem; background-color: #495057; color: white; border: none; border-radius: 5px; padding: 0.4rem 0.8rem; cursor: pointer; font-size: 0.8rem; width: auto;">複製</button>
        </div>
      </details>
      <footer style="text-align: center; margin-top: 3rem; padding-top: 2rem; border-top: 1px solid var(--border-color); font-size: 0.85rem; color: var(--gray);">
        <div style="display: flex; justify-content: center; align-items: center; gap: 1rem;">
          <a href="https://github.com/samni728/edgetts-cloudflare-workers-webui" target="_blank" style="display: flex; align-items: center; gap: 0.5rem; color: var(--gray); text-decoration: none;">
            <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            GitHub 項目
          </a>
          <span>|</span>
          <a href="https://github.com/samni728/edgetts-cloudflare-workers-webui" target="_blank" style="color: var(--gray); text-decoration: none;">⭐ Star</a>
        </div>
      </footer>
    </main>
    <script>
      document.addEventListener("DOMContentLoaded", () => {
        const elements = {
          baseUrl: document.getElementById("baseUrl"),
          apiKey: document.getElementById("apiKey"),
          inputText: document.getElementById("inputText"),
          charCount: document.getElementById("char-count"),
          clearText: document.getElementById("clear-text"),
          voice: document.getElementById("voice"),
          speed: document.getElementById("speed"),
          speedValue: document.getElementById("speed-value"),
          pitch: document.getElementById("pitch"),
          pitchValue: document.getElementById("pitch-value"),
          btnGenerate: document.getElementById("btn-generate"),
          btnStream: document.getElementById("btn-stream"),
          btnHistory: document.getElementById("btn-history"),
          status: document.getElementById("status"),
          audioPlayer: document.getElementById("audioPlayer"),
          saveConfig: document.getElementById("save-config"),
          apiConfig: document.getElementById("api-config"),
          curlCode: document.getElementById("curl-code"),
          copyCurl: document.getElementById("copy-curl"),
          removeMarkdown: document.getElementById("removeMarkdown"),
          removeEmoji: document.getElementById("removeEmoji"),
          removeUrls: document.getElementById("removeUrls"),
          removeLineBreaks: document.getElementById("removeLineBreaks"),
          removeCitation: document.getElementById("removeCitation"),
          customKeywords: document.getElementById("customKeywords"),
          saveToHistory: document.getElementById("saveToHistory"),
          saveAsRealtime: document.getElementById("saveAsRealtime"),
          directSaveButtons: document.getElementById("direct-save-buttons"),
          btnDirectSave: document.getElementById("btn-direct-save"),
          customVoiceConfig: document.getElementById("custom-voice-config"),
          customVoiceName: document.getElementById("customVoiceName"),
          voiceStyle: document.getElementById("voiceStyle"),
          voiceRole: document.getElementById("voiceRole"),
          styleDegree: document.getElementById("styleDegree"),
          styleDegreeValue: document.getElementById("styleDegreeValue"),
          usageTips: document.getElementById("usage-tips"),
          dismissTips: document.getElementById("dismiss-tips"),
          confirmTips: document.getElementById("confirm-tips"),
        };

        const setCookie = (name, value, days = 30) => {
          const d = new Date();
          d.setTime(d.getTime() + (days*24*60*60*1000));
          document.cookie = name + "=" + encodeURIComponent(value) + ";expires="+ d.toUTCString() + ";path=/";
        };
        const getCookie = (name) => {
          const ca = decodeURIComponent(document.cookie).split(';');
          for(let c of ca) {
            c = c.trim();
            if (c.startsWith(name + "=")) return c.substring(name.length + 1);
          }
          return "";
        };

        // 使用提示管理
        const initUsageTips = () => {
          const tipsHidden = getCookie("usageTipsHidden");
          if (!tipsHidden) {
            elements.usageTips.style.display = "block";
          }
        };

        const hideUsageTips = () => {
          elements.usageTips.style.display = "none";
          setCookie("usageTipsHidden", "true", 365); // 記住一年
        };

        const updateStatus = (message, type, persistent = false) => {
          elements.status.textContent = message;
          elements.status.className = \`status-\${type}\`;
          elements.status.style.display = "block";
          if (!persistent) {
              setTimeout(() => elements.status.style.display = "none", 3000);
          }
        };

        const updateCurlExample = () => {
          const baseUrl = elements.baseUrl.value;
          const apiKey = elements.apiKey.value.trim();
          let authHeader = apiKey ? \`--header 'Authorization: Bearer \${apiKey}' \\\\\` : '# API Key not set, authorization header is commented out';
          
          const voiceValue = elements.voice.value === 'custom' ? 
            (elements.customVoiceName.value.trim() || 'zh-CN-XiaoxiaoNeural') : 
            elements.voice.value;
          
          const curlCommand = \`# OpenAI Compatible Request
curl --location '\${baseUrl}/v1/audio/speech' \\\\
\${authHeader}
--header 'Content-Type: application/json' \\\\
--data '{
    "model": "tts-1",
    "voice": "\${voiceValue}",
    "input": "你好，世界！這是一個測試語音合成的示例。",
    "speed": \${elements.speed.value},
    "pitch": \${elements.pitch.value}
}' \\\\
--output speech.mp3

# 高級功能示例 (自定義音色配置)
curl --location '\${baseUrl}/v1/audio/speech' \\\\
\${authHeader}
--header 'Content-Type: application/json' \\\\
--data '{
    "model": "tts-1",
    "voice": "zh-CN-XiaoxiaoNeural",
    "input": "這是使用高級配置的語音合成示例。",
    "style": "cheerful",
    "role": "YoungAdultFemale",
    "styleDegree": 1.5,
    "speed": 1.2,
    "pitch": 1.1,
    "cleaning_options": {
        "remove_markdown": true,
        "remove_emoji": true,
        "remove_urls": true,
        "remove_line_breaks": false
    }
}' \\\\
--output advanced.mp3

# 流式請求示例 (長文本優化)
curl --location '\${baseUrl}/v1/audio/speech' \\\\
\${authHeader}
--header 'Content-Type: application/json' \\\\
--data '{
    "model": "tts-1",
    "voice": "alloy",
    "input": "這是一個流式請求的示例，適用於較長的文本內容。",
    "stream": true
}' \\\\
--output streaming.mp3\`;
          elements.curlCode.textContent = curlCommand;
        };

        // Event listener for Save and Validate button
        elements.saveConfig.addEventListener("click", async () => {
          const key = elements.apiKey.value.trim();
          if (!key) {
            updateStatus("請輸入 API Key", "error");
            return;
          }

          // 簡單保存，不進行驗證（驗證會在實際使用時進行）
          setCookie("apiKey", key);
          updateStatus("API Key 已保存！", "success");
          elements.apiConfig.open = false;
          updateCurlExample();
        });

        // 設備檢測函數
        const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

        // Generate speech function with retry mechanism
        const generateSpeech = async (isStream = false, retryCount = 0) => {
          const apiKey = elements.apiKey.value.trim();
          const text = elements.inputText.value.trim();

          if (!apiKey) {
            updateStatus("請先在 API 配置中輸入 API Key", "error");
            elements.apiConfig.open = true;
            return;
          }
          if (!text) {
            updateStatus("請輸入要合成的文本", "error");
            return;
          }

          // 【核心優化】移動端流式降級爲標準模式
          if (isStream && isMobile) {
            console.log("Mobile device detected. Downgrading stream to standard request for compatibility.");
            isStream = false;
          }

          const maxRetries = 2;
          const statusMessage = retryCount > 0 ? 
            \`正在重試生成語音... (第\${retryCount + 1}次嘗試)\` : 
            (isStream ? "正在生成流式語音..." : "正在生成語音...");
          
          updateStatus(statusMessage, "info", true);
          elements.audioPlayer.style.display = "none";
          elements.audioPlayer.src = "";

          try {
            const voiceConfig = getVoiceConfig();
            const requestBody = {
              model: "tts-1", // 符合 OpenAI 標準
              input: text,
              voice: voiceConfig.voice,
              speed: parseFloat(elements.speed.value), 
              pitch: parseFloat(elements.pitch.value), 
              style: voiceConfig.style,
              role: voiceConfig.role,
              styleDegree: voiceConfig.styleDegree,
              stream: isStream,
              cleaning_options: {
                remove_markdown: elements.removeMarkdown.checked, remove_emoji: elements.removeEmoji.checked,
                remove_urls: elements.removeUrls.checked, remove_line_breaks: elements.removeLineBreaks.checked,
                remove_citation_numbers: elements.removeCitation.checked, custom_keywords: elements.customKeywords.value,
              },
            };

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 45000); // 45秒超時

            const response = await fetch(\`\${elements.baseUrl.value}/v1/audio/speech\`, {
              method: "POST",
              headers: { "Authorization": \`Bearer \` + apiKey, "Content-Type": "application/json" },
              body: JSON.stringify(requestBody),
              signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
              const errorData = await response.json().catch(() => ({ error: { message: \`服務器錯誤: \${response.statusText}\` } }));
              throw new Error(errorData.error.message);
            }

            if (isStream) {
              const mediaSource = new MediaSource();
              elements.audioPlayer.src = URL.createObjectURL(mediaSource);
              elements.audioPlayer.style.display = "block";
              elements.audioPlayer.play().catch(e => {});
              
              mediaSource.addEventListener("sourceopen", () => {
                const sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
                const reader = response.body.getReader();
                
                const pump = () => {
                  reader.read().then(({ done, value }) => {
                    if (done) {
                      if (!sourceBuffer.updating) mediaSource.endOfStream();
                      updateStatus("流式播放完畢！", "success");
                      return;
                    }
                    const append = () => sourceBuffer.appendBuffer(value);
                    if (sourceBuffer.updating) {
                      sourceBuffer.addEventListener("updateend", append, { once: true });
                    } else {
                      append();
                    }
                  });
                };
                sourceBuffer.addEventListener("updateend", pump);
                pump();
                
                // 流式播放完成後的保存邏輯
                // 流式播放完成，不自動保存
                // 保存功能由"直接保存"按鈕單獨處理
              }, { once: true });
            } else {
              const blob = await response.blob();
              const audioUrl = URL.createObjectURL(blob);
              elements.audioPlayer.src = audioUrl;
              elements.audioPlayer.style.display = "block";
              elements.audioPlayer.play();
              updateStatus("語音生成成功！", "success");
              
              // 生成語音按鈕只負責生成和播放，不自動保存
              // 保存功能由"直接保存"按鈕單獨處理
            }

          } catch (error) {
            console.error('Speech generation error:', error);
            
            // 檢查是否應該重試
            const shouldRetry = retryCount < maxRetries && (
              error.name === 'AbortError' || 
              error.message.includes('Failed to get endpoint') ||
              error.message.includes('502') ||
              error.message.includes('503') ||
              error.message.includes('timeout')
            );
            
            if (shouldRetry) {
              console.log(\`Retrying speech generation, attempt \${retryCount + 1}\`);
              setTimeout(() => {
                generateSpeech(isStream, retryCount + 1);
              }, 2000 * (retryCount + 1)); // 遞增延遲
            } else {
              let errorMessage = error.message;
              if (error.name === 'AbortError') {
                errorMessage = '請求超時，請檢查網絡連接後重試';
              } else if (errorMessage.includes('Failed to get endpoint')) {
                errorMessage = 'TTS 服務暫時不可用，請稍後重試';
              }
              updateStatus(\`錯誤: \${errorMessage}\`, "error", true);
            }
          }
        };

        // Convert ArrayBuffer to Base64 safely
        const arrayBufferToBase64 = async (buffer) => {
          const bytes = new Uint8Array(buffer);
          let binary = '';
          const chunkSize = 8192;
          
          for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.slice(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, chunk);
          }
          
          return btoa(binary);
        };

        // Save as realtime play function
        const saveAsRealtimePlay = async (requestBody) => {
          try {
            updateStatus("正在保存爲實時播放...", "info", true);
            
            const voiceConfig = getVoiceConfig();
            
            // 創建實時播放的元數據（不包含音頻文件）
            const realtimeData = {
              text: requestBody.input,
              voice: voiceConfig.voice,
              speed: requestBody.speed,
              pitch: requestBody.pitch,
              style: voiceConfig.style,
              role: voiceConfig.role,
              styleDegree: voiceConfig.styleDegree,
              cleaningOptions: requestBody.cleaning_options,
              type: 'realtime' // 標記爲實時播放類型
            };
            
            const response = await fetch('/api/save-realtime', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(realtimeData)
            });
            
            if (response.ok) {
              const result = await response.json();
              const deviceInfo = isMobile ? '移動端將使用標準播放模式' : 'PC端將使用流式播放模式';
              updateStatus(\`✅ 實時播放已保存！\${deviceInfo}，分享鏈接: \${window.location.origin}\${result.shareUrl}\`, "success");
            } else {
              const errorData = await response.json().catch(() => ({}));
              throw new Error(errorData.error?.message || '保存失敗');
            }
          } catch (error) {
            updateStatus(\`保存實時播放失敗: \${error.message}\`, "error");
          }
        };

        // Generate realtime play link function (deprecated)
        const generateRealtimePlayLink = (requestBody) => {
          try {
            const voiceConfig = getVoiceConfig();
            const shareParams = {
              text: encodeURIComponent(requestBody.input),
              voice: voiceConfig.voice,
              speed: requestBody.speed,
              pitch: requestBody.pitch,
              style: voiceConfig.style,
              role: voiceConfig.role,
              styleDegree: voiceConfig.styleDegree
            };
            
            const shareUrl = \`\${window.location.origin}/play?\${new URLSearchParams(shareParams)}\`;
            
            // 設備檢測和用戶提示
            const deviceInfo = isMobile ? '移動端將使用標準播放模式' : 'PC端將使用流式播放模式';
            
            // 複製到剪貼板並顯示友好提示
            navigator.clipboard.writeText(shareUrl).then(() => {
              updateStatus(\`🔗 實時播放鏈接已複製！\${deviceInfo}，接收者需耐心等待語音生成\`, "success");
              console.log('Realtime play URL:', shareUrl);
            }).catch(() => {
              // 如果複製失敗，顯示鏈接讓用戶手動複製
              updateStatus(\`🔗 實時播放鏈接生成成功！\${deviceInfo}\`, "success");
              prompt('實時播放鏈接（按需生成）:', shareUrl);
            });
            
          } catch (error) {
            updateStatus(\`生成分享鏈接失敗: \${error.message}\`, "error");
          }
        };

        // Save to history function
        const saveToHistory = async (requestBody, audioBlob) => {
          try {
            updateStatus("正在保存到歷史記錄...", "info", true);
            
            // Create FormData to send binary data directly
            const formData = new FormData();
            formData.append('text', requestBody.input);
            formData.append('voice', requestBody.voice); // 使用 voice 而不是 model
            formData.append('speed', requestBody.speed.toString());
            formData.append('pitch', requestBody.pitch.toString());
            formData.append('cleaningOptions', JSON.stringify(requestBody.cleaning_options));
            formData.append('audioFile', audioBlob, 'audio.mp3');
            
            const response = await fetch('/api/save', {
              method: 'POST',
              body: formData  // No Content-Type header needed for FormData
            });
            
            if (response.ok) {
              const result = await response.json();
              updateStatus(\`已保存！分享鏈接: \${window.location.origin}\${result.shareUrl}\`, "success");
            } else {
              const errorData = await response.json().catch(() => ({}));
              throw new Error(errorData.error?.message || '保存失敗');
            }
          } catch (error) {
            updateStatus(\`保存失敗: \${error.message}\`, "error");
          }
        };

        // Event listeners
        elements.btnGenerate.addEventListener("click", () => generateSpeech(false));
        elements.btnStream.addEventListener("click", () => generateSpeech(true));
        elements.btnHistory.addEventListener("click", async () => {
          const apiKey = getCookie("apiKey");
          if (!apiKey) {
            updateStatus("請先設置 API Key 才能查看歷史記錄", "error");
            elements.apiConfig.open = true;
            return;
          }
          
          // 驗證API Key是否有效
          try {
            const response = await fetch('/api/history', {
              headers: { 'Authorization': \`Bearer \${apiKey}\` }
            });
            
            if (!response.ok) {
              updateStatus("API Key 無效，無法訪問歷史記錄", "error");
              elements.apiConfig.open = true;
              return;
            }
            
            window.open('/history', '_blank');
          } catch (error) {
            updateStatus("驗證 API Key 失敗，請檢查網絡連接", "error");
          }
        });
        
        // 使用提示事件監聽
        elements.dismissTips.addEventListener("click", hideUsageTips);
        elements.confirmTips.addEventListener("click", hideUsageTips);
        
        // 保存選項互斥邏輯：勾選時二選一，並顯示/隱藏直接保存按鈕
        const updateDirectSaveButton = () => {
          const showButton = elements.saveToHistory.checked || elements.saveAsRealtime.checked;
          elements.directSaveButtons.style.display = showButton ? 'block' : 'none';
        };
        
        elements.saveToHistory.addEventListener("change", () => {
          if (elements.saveToHistory.checked && elements.saveAsRealtime.checked) {
            elements.saveAsRealtime.checked = false;
          }
          updateDirectSaveButton();
        });
        
        elements.saveAsRealtime.addEventListener("change", () => {
          if (elements.saveAsRealtime.checked && elements.saveToHistory.checked) {
            elements.saveToHistory.checked = false;
          }
          updateDirectSaveButton();
        });
        
        // 直接保存按鈕點擊事件
        elements.btnDirectSave.addEventListener("click", async () => {
          const apiKey = elements.apiKey.value.trim();
          const text = elements.inputText.value.trim();

          if (!apiKey) {
            updateStatus("請先在 API 配置中輸入 API Key", "error");
            elements.apiConfig.open = true;
            return;
          }
          if (!text) {
            updateStatus("請輸入要合成的文本", "error");
            return;
          }

          const voiceConfig = getVoiceConfig();
          const requestBody = {
            model: "tts-1",
            input: text,
            voice: voiceConfig.voice,
            speed: parseFloat(elements.speed.value),
            pitch: parseFloat(elements.pitch.value),
            style: voiceConfig.style,
            role: voiceConfig.role,
            styleDegree: voiceConfig.styleDegree,
            stream: false, // 直接保存使用標準模式
            cleaning_options: {
              remove_markdown: elements.removeMarkdown.checked,
              remove_emoji: elements.removeEmoji.checked,
              remove_urls: elements.removeUrls.checked,
              remove_line_breaks: elements.removeLineBreaks.checked,
              remove_citation_numbers: elements.removeCitation.checked,
              custom_keywords: elements.customKeywords.value,
            },
          };

          try {
            updateStatus("正在直接保存到歷史記錄...", "info", true);
            
            if (elements.saveToHistory.checked) {
              // 生成音頻並保存到歷史記錄
              const response = await fetch(\`\${elements.baseUrl.value}/v1/audio/speech\`, {
                method: "POST",
                headers: { "Authorization": \`Bearer \` + apiKey, "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
              });
              
              if (response.ok) {
                const blob = await response.blob();
                await saveToHistory(requestBody, blob);
              } else {
                throw new Error('生成音頻失敗');
              }
            }
            
            if (elements.saveAsRealtime.checked) {
              // 直接保存爲實時播放
              await saveAsRealtimePlay(requestBody);
            }
            
          } catch (error) {
            updateStatus(\`直接保存失敗: \${error.message}\`, "error");
          }
        });
        
        elements.copyCurl.addEventListener("click", () => {
          navigator.clipboard.writeText(elements.curlCode.textContent).then(() => {
            elements.copyCurl.textContent = "已複製!";
            setTimeout(() => elements.copyCurl.textContent = "複製", 2000);
          });
        });
        elements.inputText.addEventListener("input", () => { 
          elements.charCount.textContent = \`\${elements.inputText.value.length} 字符\`;
          updateCurlExample();
        });
        elements.clearText.addEventListener("click", () => { 
          elements.inputText.value = ""; 
          elements.charCount.textContent = "0 字符"; 
        });
        // Handle custom voice configuration visibility
        const toggleCustomVoiceConfig = () => {
          const isCustom = elements.voice.value === 'custom';
          elements.customVoiceConfig.style.display = isCustom ? 'block' : 'none';
        };

        // Get effective voice configuration
        const getVoiceConfig = () => {
          if (elements.voice.value === 'custom') {
            return {
              voice: elements.customVoiceName.value.trim() || 'zh-CN-XiaoxiaoNeural',
              style: elements.voiceStyle.value || 'general',
              role: elements.voiceRole.value || '',
              styleDegree: parseFloat(elements.styleDegree.value)
            };
          } else {
            return {
              voice: elements.voice.value,
              style: 'general',
              role: '',
              styleDegree: 1.0
            };
          }
        };

        const updateUI = () => {
          elements.speedValue.textContent = parseFloat(elements.speed.value).toFixed(2);
          elements.pitchValue.textContent = parseFloat(elements.pitch.value).toFixed(2);
          elements.styleDegreeValue.textContent = parseFloat(elements.styleDegree.value).toFixed(2);
          toggleCustomVoiceConfig();
          updateCurlExample();
        };
        
        ['speed', 'voice', 'apiKey'].forEach(id => elements[id].addEventListener('input', updateUI));
        ['pitch'].forEach(id => elements[id].addEventListener('input', () => elements.pitchValue.textContent = parseFloat(elements.pitch.value).toFixed(2)));
        elements.styleDegree.addEventListener('input', () => elements.styleDegreeValue.textContent = parseFloat(elements.styleDegree.value).toFixed(2));


        // Initial page setup
        elements.baseUrl.value = window.location.origin;
        const savedApiKey = getCookie("apiKey");
        if (savedApiKey) {
            elements.apiKey.value = savedApiKey;
            elements.apiConfig.open = false;
        } else {
            elements.apiConfig.open = true;
        }
        elements.charCount.textContent = \`\${elements.inputText.value.length} 字符\`;
        
        // 初始化使用提示
        initUsageTips();
        
        updateUI();
      });
    </script>
  </body>
</html>`;
}
