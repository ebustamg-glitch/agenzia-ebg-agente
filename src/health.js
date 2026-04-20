// src/health.js
const express = require('express');
const axios = require('axios');

function crearServidor() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      agente: 'agenzia-ebg',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime())
    });
  });

  app.get('/', (req, res) => {
    res.json({
      agente: 'Agenzia EBG WhatsApp Agent',
      version: '1.0.0',
      status: 'running'
    });
  });

  app.get('/qr', async (req, res) => {
    try {
      const base = process.env.WAHA_URL || 'http://waha.railway.internal:3000';
      const session = process.env.WAHA_SESSION || 'default';
      const apiKey = process.env.WHATSAPP_API_KEY || '';
      const r = await axios.get(`${base}/api/screenshot?session=${session}`, {
        headers: { 'X-Api-Key': apiKey },
        responseType: 'arraybuffer',
        timeout: 10000
      });
      res.set('Content-Type', 'image/png');
      res.send(r.data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/webhook/evento', (req, res) => {
    const payload = req.body;
    console.log('[Webhook entrante] Evento recibido:', JSON.stringify(payload, null, 2));
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ received: false, error: 'Payload inválido' });
    }
    res.status(200).json({ received: true, timestamp: new Date().toISOString() });
  });

  return app;
}

function iniciarServidor() {
  const app = crearServidor();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Servidor] Agenzia EBG Agent corriendo en puerto ${PORT}`);
  });
  return app;
}

module.exports = { iniciarServidor, crearServidor };
