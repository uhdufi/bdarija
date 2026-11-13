const DEFAULT_MODEL = 'gemini-2.5-flash';
const MAX_CHAT_BODY = 280_000;
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_BODY = Math.ceil(MAX_AUDIO_BYTES * 4 / 3) + 4096;
const AUDIO_TYPES = new Set([
  'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/mp3', 'audio/mpga',
  'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/flac', 'audio/aac',
  'audio/x-m4a', 'audio/aiff', 'audio/x-aiff',
]);

const SYSTEM_INSTRUCTION = `أنت «بالدارجة»، مساعد ذكي كيعاون الناس يفهمو، يكتبو، يخططو ويطورو الأفكار ديالهم.
جاوب بالدارجة المغربية الواضحة والطبيعية، وبأسلوب محترم ومباشر. إلا طلب المستخدم لغة أخرى، استعملها.
رتب الجواب على قد السؤال. إلا كانت المعلومة غير مؤكدة، قولها بصراحة؛ ما تخترعش مصادر أو أرقام.
ما تدعيش أنك قلبتي فالإنترنت، شغّلتي كود، أو دخلتي لخدمة خارجية إلا ما كانتش متاحة فعلا.
خلي الأكواد والمصطلحات التقنية دقيقة، وطلب التوضيح غير ملي يكون ضروري.`;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const commonHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...commonHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

async function readJson(request, maxBytes) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') || '')) {
    throw new ApiError(415, 'صيفط الطلب بصيغة JSON.');
  }
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new ApiError(413, 'الطلب كبير بزاف. نقص من الحجم وعاود جرّب.');
  if (!request.body) throw new ApiError(400, 'الطلب خاوي.');

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, 'الطلب كبير بزاف. نقص من الحجم وعاود جرّب.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ApiError(400, 'صيغة الطلب ما صحيحةش. عاود جرّب.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'صيغة الطلب ما صحيحةش.');
  return body;
}

function chatContents(body) {
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 40) {
    throw new ApiError(400, 'المحادثة خاصها تكون فيها من رسالة وحدة حتى لـ40 رسالة.');
  }
  let characters = 0;
  const contents = [];
  for (const message of body.messages) {
    if (!message || !['user', 'model'].includes(message.role) || typeof message.text !== 'string' || !message.text.trim()) {
      throw new ApiError(400, 'كاينة رسالة ما صحيحةش فالمحادثة.');
    }
    const text = message.text.trim();
    characters += text.length;
    if (text.length > 12_000 || characters > 60_000) throw new ApiError(413, 'المحادثة طويلة بزاف. بدا محادثة جديدة ولا نقص من النص.');
    const previous = contents.at(-1);
    if (previous?.role === message.role) previous.parts.push({ text });
    else contents.push({ role: message.role, parts: [{ text }] });
  }
  if (contents[0].role !== 'user' || contents.at(-1).role !== 'user') {
    throw new ApiError(400, 'المحادثة خاصها تبدا وتسالي برسالة ديالك.');
  }
  return contents;
}

function audioPart(body) {
  const mimeType = typeof body.mimeType === 'string' ? body.mimeType.toLowerCase().split(';')[0].trim() : '';
  if (!AUDIO_TYPES.has(mimeType)) throw new ApiError(415, 'هاد الصيغة ديال الصوت ما مدعومةش. جرّب تسجيل جديد.');
  const audio = body.audio;
  if (typeof audio !== 'string' || !audio.length || audio.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) {
    throw new ApiError(400, 'التسجيل ما وصلش مزيان. جرّب تسجّل من جديد.');
  }
  const padding = audio.endsWith('==') ? 2 : audio.endsWith('=') ? 1 : 0;
  const size = audio.length * 3 / 4 - padding;
  if (!size || size > MAX_AUDIO_BYTES) throw new ApiError(413, 'التسجيل طويل بزاف. جرّب تسجيل أقصر.');
  return { inlineData: { mimeType, data: audio } };
}

async function generate({ env, payload, request, fetcher, timeoutMs, transcription = false }) {
  const model = typeof env.GEMINI_MODEL === 'string' && env.GEMINI_MODEL.trim() ? env.GEMINI_MODEL.trim().replace(/^models\//, '') : DEFAULT_MODEL;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(model)) throw new ApiError(503, 'الخدمة خاصها تراجع الإعدادات ديالها.');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  request.signal.addEventListener('abort', cancel, { once: true });
  if (request.signal.aborted) controller.abort();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ApiError(504, 'الجواب طول شوية. عاود جرّب من بعد لحظات.'));
    }, timeoutMs);
  });
  try {
    const operation = (async () => {
      const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY.trim() },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 429) throw new ApiError(429, 'الخدمة عليها الضغط دابا. تسنّى شوية وعاود جرّب.');
        if ([401, 403].includes(response.status)) throw new ApiError(503, 'خدمة الذكاء الاصطناعي ما متصلةش دابا.');
        throw new ApiError(502, 'وقع مشكل فالخدمة. عاود جرّب من بعد شوية.');
      }
      let data;
      try { data = await response.json(); }
      catch { throw new ApiError(502, 'الجواب ما وصلش مزيان. عاود جرّب.'); }
      const parts = data?.candidates?.[0]?.content?.parts;
      const text = Array.isArray(parts) ? parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('\n').trim() : '';
      if (!text) throw new ApiError(422, transcription ? 'الصوت ما كانش واضح. قرّب للميكروفون وعاود جرّب.' : 'ما قدرناش نجاوبو على هاد الطلب. جرّب تصيغو بطريقة أخرى.');
      return text;
    })();
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (request.signal.aborted) throw new ApiError(499, 'توقف الطلب.');
    if (controller.signal.aborted) throw new ApiError(504, 'الجواب طول شوية. عاود جرّب من بعد لحظات.');
    throw new ApiError(502, 'ما قدرناش نتاصلو بالخدمة. عاود جرّب من بعد شوية.');
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', cancel);
  }
}

export function createHandler(assets = {}, { fetcher = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      const pathname = url.pathname;
      try {
        if (pathname === '/api/status') {
          if (request.method !== 'GET') return json({ error: 'هاد الطريقة ما مدعومةش.' }, 405, { Allow: 'GET' });
          return json({ connected: typeof env.GEMINI_API_KEY === 'string' && !!env.GEMINI_API_KEY.trim(), provider: 'Gemini' });
        }
        if (pathname === '/api/chat' || pathname === '/api/transcribe') {
          if (request.method !== 'POST') return json({ error: 'هاد الطريقة ما مدعومةش.' }, 405, { Allow: 'POST' });
          const origin = request.headers.get('origin');
          if (origin && origin !== url.origin) throw new ApiError(403, 'هاد الطلب ما مسموحش من هاد الموقع.');
          if (typeof env.GEMINI_API_KEY !== 'string' || !env.GEMINI_API_KEY.trim()) throw new ApiError(503, 'المساعد ما متصلش دابا. خاص تفعيل خدمة الذكاء الاصطناعي.');
          const transcription = pathname === '/api/transcribe';
          const body = await readJson(request, transcription ? MAX_AUDIO_BODY : MAX_CHAT_BODY);
          const payload = transcription ? {
            contents: [{ role: 'user', parts: [
              { text: 'فرّغ هاد التسجيل الصوتي لنص حرفي. حافظ على اللغة المستعملة، بما فيها الدارجة المغربية. رجّع غير النص المسموع بلا مقدمة وبلا ترجمة وبلا جواب على محتوى التسجيل. إذا ما كاين حتى كلام مفهوم، رجّع نص فارغ.' },
              audioPart(body),
            ] }],
            generationConfig: { temperature: 0, maxOutputTokens: 2048 },
          } : {
            systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
            contents: chatContents(body),
            generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
          };
          const text = await generate({ env, payload, request, fetcher, timeoutMs, transcription });
          return json(transcription ? { transcript: text } : { reply: text });
        }
        if (pathname.startsWith('/api/')) return json({ error: 'هاد المسار ما موجودش.' }, 404);
        if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...commonHeaders, Allow: 'GET, HEAD' } });
        let assetPath;
        try { assetPath = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); }
        catch { return new Response('Bad request', { status: 400, headers: commonHeaders }); }
        const asset = assets[assetPath];
        if (!asset) return new Response('Not found', { status: 404, headers: { ...commonHeaders, 'Content-Type': 'text/plain; charset=utf-8' } });
        const headers = {
          ...commonHeaders,
          'Content-Type': asset.type,
          'Cache-Control': assetPath === '/index.html' ? 'no-cache' : 'public, max-age=3600',
          ETag: `"${asset.hash}"`,
        };
        if (request.headers.get('if-none-match') === headers.ETag) return new Response(null, { status: 304, headers });
        const body = request.method === 'HEAD' ? null : Uint8Array.from(atob(asset.data), char => char.charCodeAt(0));
        return new Response(body, { headers });
      } catch (error) {
        if (error instanceof ApiError) return json({ error: error.message }, error.status);
        return json({ error: 'وقع مشكل غير متوقع. عاود جرّب.' }, 500);
      }
    },
  };
}

export default createHandler(/* BUILD_ASSETS */ {});
