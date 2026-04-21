require('dotenv').config();
require('events').EventEmitter.defaultMaxListeners = 50;

const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { iniciarServidor } = require('./src/health');

// ── Validación de variables de entorno ────────────────────────────────────────
const ENV_REQUIRED = ['ANTHROPIC_API_KEY', 'WHATSAPP_API_KEY'];
const ENV_WARN = ['WHATSAPP_API_URL', 'WAHA_URL', 'OWNER_PHONE'];
const missingRequired = ENV_REQUIRED.filter(k => !process.env[k]);
const missingWarn = ENV_WARN.filter(k => !process.env[k]);
if (missingRequired.length) {
  console.error('[Config] ❌ Variables de entorno FALTANTES (críticas):', missingRequired.join(', '));
  console.error('[Config] El agente NO funcionará sin estas variables.');
}
if (missingWarn.length) {
  console.warn('[Config] ⚠️  Variables de entorno no configuradas:', missingWarn.join(', '));
}
console.log('[Config] WAHA_URL:', process.env.WAHA_URL || '(derivada de WHATSAPP_API_URL)');
console.log('[Config] WHATSAPP_API_URL:', process.env.WHATSAPP_API_URL || '(no configurada)');
console.log('[Config] WAHA_SESSION:', process.env.WAHA_SESSION || 'default');
console.log('[Config] OWNER_PHONE:', process.env.OWNER_PHONE || '(no configurado)');
console.log('[Config] ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? '✓ configurada' : '❌ FALTA');
console.log('[Config] WHATSAPP_API_KEY:', process.env.WHATSAPP_API_KEY ? '✓ configurada' : '❌ FALTA');

// ── Lead scoring ──────────────────────────────────────────────────────────────
function calcularScore(historial) {
  const texto = historial.map(m => (typeof m.content === 'string' ? m.content : '')).join(' ').toLowerCase();
  const caliente = ['precio', 'contratar', 'quiero', 'plan', 'cuanto', 'pagar', 'empezar'];
  const tibio = ['como funciona', 'info', 'que es', 'demo'];
  if (caliente.some(kw => texto.includes(kw))) return 'caliente';
  if (tibio.some(kw => texto.includes(kw))) return 'tibio';
  return 'frio';
}

const OWNER_PHONE = process.env.OWNER_PHONE || '5644145407';
const OWNER_CHAT_ID = `${OWNER_PHONE}@c.us`;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = require('fs').readFileSync(require('path').join(__dirname, 'src', 'system-prompt.txt'), 'utf8');

const historiales = new Map();
const silenciados = new Map();       // telefono → timestamp hasta cuando está silenciado
const ultimoMensaje = new Map();     // telefono → timestamp del último mensaje del cliente
const reactivacionesEnviadas = new Map();
const telefonosRaw = new Map();      // telefono limpio → chatId original
const enviosRecientes = new Map();   // telefono → timestamp del último mensaje enviado por el bot

const MAX_HISTORIAL = 20;
const HORAS_SILENCIO = 24;

function obtenerHistorial(telefono) {
  if (!historiales.has(telefono)) historiales.set(telefono, []);
  return historiales.get(telefono);
}

function agregarAlHistorial(telefono, role, content) {
  const hist = obtenerHistorial(telefono);
  hist.push({ role, content });
  if (hist.length > MAX_HISTORIAL * 2) hist.splice(0, 2);
}

function extraerMensaje(body) {
  const proveedor = (process.env.WHATSAPP_PROVIDER || 'waha').toLowerCase();

  if (proveedor === 'waha') {
    const payload = body?.payload;
    if (!payload) return null;
    const fromMe = !!payload.fromMe;
    const telefonoRaw = fromMe ? (payload.to || payload.from || '') : (payload.from || '');
    const telefono = telefonoRaw.replace('@s.whatsapp.net', '').replace('@c.us', '').replace('@lid', '');
    return { telefono, texto: payload.body || payload.caption || payload.extendedTextMessage?.text || '', fromMe, telefonoRaw };
  }

  return null;
}

async function enviarMensaje(telefono, texto) {
  const url = process.env.WHATSAPP_API_URL;
  if (!url) {
    console.warn('[enviarMensaje] WHATSAPP_API_URL no configurada');
    return;
  }

  const payload = {
    chatId: telefono,
    text: texto,
    session: process.env.WAHA_SESSION || 'default'
  };

  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Key': process.env.WHATSAPP_API_KEY || ''
  };

  try {
    await axios.post(url, payload, { headers, timeout: 10000 });
    console.log(`[enviarMensaje] OK → ${telefono}`);
    const telefonoLimpio = telefono.replace('@s.whatsapp.net', '').replace('@c.us', '').replace('@lid', '');
    enviosRecientes.set(telefonoLimpio, Date.now());
  } catch (err) {
    console.error(`[enviarMensaje] ERROR → ${telefono}:`, err.response?.data || err.message);
    if (telefono.includes('@lid')) {
      try {
        const chatIdFallback = payload.chatId.replace('@lid', '@c.us');
        payload.chatId = chatIdFallback;
        await axios.post(url, payload, { headers, timeout: 10000 });
        console.log(`[enviarMensaje] OK (fallback @c.us) → ${chatIdFallback}`);
        const telefonoLimpio = chatIdFallback.replace('@c.us', '');
        enviosRecientes.set(telefonoLimpio, Date.now());
      } catch (err2) {
        console.error(`[enviarMensaje] ERROR fallback:`, err2.response?.data || err2.message);
      }
    }
  }
}

async function notificarDueno(telefono, texto) {
  try {
    await enviarMensaje(OWNER_CHAT_ID, `🔔 Lead nuevo requiere atención:\nTeléfono: ${telefono}\nÚltimo mensaje: ${texto}`);
  } catch (err) {
    console.error('[notificarDueno] Error:', err.message);
  }
}

function estaSilenciado(telefono) {
  const hasta = silenciados.get(telefono);
  return hasta && hasta > Date.now();
}

function silenciar(telefono) {
  silenciados.set(telefono, Date.now() + HORAS_SILENCIO * 3600 * 1000);
  console.log(`[Takeover] ${telefono} silenciado por ${HORAS_SILENCIO}h`);
}

async function dispararWebhook({ telefono, mensaje, score }) {
  const webhookUrl = process.env.MAKE_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    await axios.post(webhookUrl, { telefono, mensaje, score, timestamp: new Date().toISOString() }, { timeout: 5000 });
  } catch (err) {
    console.error('[Webhook Make] Error:', err.message);
  }
}

async function manejarMensaje(telefono, texto) {
  ultimoMensaje.set(telefono, Date.now());
  reactivacionesEnviadas.set(telefono, { r1: false, r2: false, r3: false });

  if (estaSilenciado(telefono)) {
    console.log(`[Takeover] ${telefono} silenciado — ignorando`);
    return null;
  }

  agregarAlHistorial(telefono, 'user', texto);

  const hist = obtenerHistorial(telefono);

  let respuesta;
  try {
    const response = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: hist
    });
    respuesta = response.content[0]?.text || '';
  } catch (err) {
    console.error('[Claude] Error:', err.message);
    return 'Lo siento, ocurrió un error. Por favor intenta de nuevo en un momento.';
  }

  if (respuesta.includes('[IGNORAR]')) {
    hist.pop();
    return null;
  }

  const respuestaLimpia = respuesta.replace('[LEAD_CAPTURADO]', '').trim();

  if (respuesta.includes('[LEAD_CAPTURADO]')) {
    console.log(`[Lead] Capturado: ${telefono}`);
    notificarDueno(telefono, texto);
  }

  agregarAlHistorial(telefono, 'assistant', respuestaLimpia);
  return respuestaLimpia;
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = iniciarServidor();

app.post('/whatsapp/webhook', async (req, res) => {
  res.json({ received: true });

  const evento = req.body?.event || '';
  const mensaje = extraerMensaje(req.body);
  if (!mensaje) return;

  const { telefono, texto, fromMe, telefonoRaw } = mensaje;

  if (!telefono || telefono.includes('status@broadcast') || telefono.includes('broadcast')) return;

  const chatId = telefonoRaw || `${telefono}@c.us`;
  telefonosRaw.set(telefono, chatId);

  // Deduplicación por ID de mensaje (evita doble proceso si WAHA envía 'message' Y 'message.any')
  const msgId = req.body?.payload?.id?._serialized || req.body?.payload?.id || null;
  if (msgId) {
    if (mensajesWebhookProcesados.has(msgId)) return;
    mensajesWebhookProcesados.add(msgId);
    if (mensajesWebhookProcesados.size > 500) {
      const first = mensajesWebhookProcesados.values().next().value;
      mensajesWebhookProcesados.delete(first);
    }
  }

  // Actualizar marca de tiempo para evitar que polling reprocese
  const msgTs = req.body?.payload?.timestamp;
  if (msgTs) ultimoProcesado.set(chatId, msgTs);

  console.log(`[Webhook] evento=${evento} fromMe=${fromMe} tel=${telefono} texto="${texto?.substring(0, 40)}"`);

  if (fromMe) {
    const ultimoEnvioBot = enviosRecientes.get(telefono) || 0;
    const fueElBot = (Date.now() - ultimoEnvioBot) < 30000;
    if (!fueElBot) silenciar(telefono);
    return;
  }

  if (!texto || !texto.trim()) return;

  try {
    const respuesta = await manejarMensaje(telefono, texto);
    if (!respuesta) return;

    const score = calcularScore(obtenerHistorial(telefono));
    await Promise.allSettled([
      enviarMensaje(chatId, respuesta),
      dispararWebhook({ telefono, mensaje: texto, score })
    ]);
  } catch (error) {
    console.error('[Webhook] Error procesando mensaje de', telefono, ':', error.message);
    try {
      await enviarMensaje(chatId, 'Lo siento, ocurrió un error. Por favor intenta de nuevo en un momento.');
    } catch (_) {}
  }
});

// ── Diagnóstico y admin ───────────────────────────────────────────────────────
const ADMIN_KEY = process.env.ADMIN_KEY || 'agenzia-admin';

app.post('/admin/unsilence/:telefono', (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { telefono } = req.params;
  silenciados.delete(telefono);
  console.log(`[Admin] ${telefono} des-silenciado`);
  res.json({ ok: true, telefono });
});

app.get('/admin/silenciados', (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const lista = [...silenciados.entries()].map(([tel, hasta]) => ({
    telefono: tel,
    hasta: new Date(hasta).toISOString(),
    activo: hasta > Date.now()
  }));
  res.json(lista);
});

app.get('/admin/diagnostico', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const base = process.env.WAHA_URL || (process.env.WHATSAPP_API_URL || '').replace('/api/sendText', '');
  const session = process.env.WAHA_SESSION || 'default';
  let wahaStatus = 'desconocido';
  let wahaError = null;
  try {
    const r = await axios.get(`${base}/api/sessions/${session}`, {
      headers: { 'X-Api-Key': process.env.WHATSAPP_API_KEY }, timeout: 8000
    });
    wahaStatus = r.data?.status || 'sin status';
  } catch (e) {
    wahaError = e.message;
  }
  res.json({
    uptime: Math.floor(process.uptime()),
    env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? '✓' : '❌ FALTA',
      WHATSAPP_API_KEY: process.env.WHATSAPP_API_KEY ? '✓' : '❌ FALTA',
      WHATSAPP_API_URL: process.env.WHATSAPP_API_URL || '❌ FALTA',
      WAHA_URL: base,
      WAHA_SESSION: session,
      OWNER_PHONE: process.env.OWNER_PHONE || '(no configurado)',
    },
    waha: { status: wahaStatus, error: wahaError },
    estado: {
      conversaciones_activas: historiales.size,
      silenciados_activos: [...silenciados.values()].filter(t => t > Date.now()).length,
      chats_en_polling: ultimoProcesado.size,
      pollEnCurso,
    }
  });
});

app.post('/admin/test-send', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { telefono, texto } = req.body || {};
  if (!telefono || !texto) return res.status(400).json({ error: 'Requiere telefono y texto' });
  try {
    await enviarMensaje(`${telefono}@c.us`, texto);
    res.json({ ok: true, telefono, texto });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/test-claude', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await anthropic.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Responde solo: OK' }]
    });
    res.json({ ok: true, respuesta: r.content[0]?.text });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Deduplicación de mensajes (compartida entre webhook y polling) ─────────────
const ultimoProcesado = new Map();   // chatId → timestamp del último mensaje procesado
const mensajesWebhookProcesados = new Set(); // IDs de mensajes ya procesados via webhook
let pollEnCurso = false;

async function pollMensajes() {
  if (pollEnCurso) return;
  pollEnCurso = true;
  try {
    const base = process.env.WAHA_URL || (process.env.WHATSAPP_API_URL || '').replace('/api/sendText', '');
    const apiKey = process.env.WHATSAPP_API_KEY;
    const session = process.env.WAHA_SESSION || 'default';

    const statusRes = await axios.get(`${base}/api/sessions/${session}`, {
      headers: { 'X-Api-Key': apiKey }, timeout: 15000
    });
    if (statusRes.data?.status !== 'WORKING') {
      console.log(`[Polling] Sesión ${session} no está WORKING (${statusRes.data?.status}) — omitiendo`);
      return;
    }

    const chatsRes = await axios.get(`${base}/api/${session}/chats?limit=30`, {
      headers: { 'X-Api-Key': apiKey }, timeout: 15000
    });
    const chats = chatsRes.data || [];

    for (const chat of chats) {
      const chatId = chat.id?._serialized || chat.id;
      if (!chatId || chatId.includes('@g.us') || chatId.includes('broadcast')) continue;

      const msgsRes = await axios.get(
        `${base}/api/${session}/chats/${encodeURIComponent(chatId)}/messages?limit=1&downloadMedia=false`,
        { headers: { 'X-Api-Key': apiKey }, timeout: 15000 }
      );
      const msgs = msgsRes.data || [];
      if (!msgs.length) continue;
      const msg = msgs[0];
      if (msg.fromMe) continue;

      const ts = msg.timestamp || 0;
      if (ts <= (ultimoProcesado.get(chatId) || 0)) continue;
      ultimoProcesado.set(chatId, ts);

      const texto = msg.body || msg.caption || '';
      if (!texto.trim()) continue;

      const telefono = chatId.replace('@c.us', '').replace('@s.whatsapp.net', '').replace('@lid', '');
      telefonosRaw.set(telefono, chatId);
      console.log(`[Polling] Nuevo mensaje de ${telefono}: ${texto.substring(0, 50)}`);

      if (estaSilenciado(telefono)) {
        console.log(`[Polling] ${telefono} silenciado — omitiendo`);
        continue;
      }

      let respuesta;
      try {
        respuesta = await manejarMensaje(telefono, texto);
      } catch (err) {
        console.error('[Polling] Error en manejarMensaje:', err.message);
        continue;
      }
      if (!respuesta) continue;

      const score = calcularScore(obtenerHistorial(telefono));
      await Promise.allSettled([
        enviarMensaje(chatId, respuesta),
        dispararWebhook({ telefono, mensaje: texto, score })
      ]);
    }
  } catch (err) {
    console.error('[Polling] Error:', err.code || err.message);
  } finally {
    pollEnCurso = false;
  }
}

async function inicializarPolling() {
  const base = process.env.WAHA_URL || (process.env.WHATSAPP_API_URL || '').replace('/api/sendText', '');
  console.log('[Polling] Base URL:', base);
  try {
    const apiKey = process.env.WHATSAPP_API_KEY;
    const session = process.env.WAHA_SESSION || 'default';
    const chatsRes = await axios.get(`${base}/api/${session}/chats?limit=30`, {
      headers: { 'X-Api-Key': apiKey }, timeout: 15000
    });
    const chats = chatsRes.data || [];
    for (const chat of chats) {
      const chatId = chat.id?._serialized || chat.id;
      if (!chatId) continue;
      try {
        const msgsRes = await axios.get(
          `${base}/api/${session}/chats/${encodeURIComponent(chatId)}/messages?limit=1&downloadMedia=false`,
          { headers: { 'X-Api-Key': apiKey }, timeout: 15000 }
        );
        const msgs = msgsRes.data || [];
        if (msgs.length) ultimoProcesado.set(chatId, msgs[0].timestamp || 0);
      } catch (_) {}
    }
    console.log(`[Polling] Inicializado — ${ultimoProcesado.size} chats marcados como procesados`);
  } catch (err) {
    console.error('[Polling] Error en inicialización:', err.code || err.message);
  }
  setInterval(pollMensajes, 3000);
}

inicializarPolling();
