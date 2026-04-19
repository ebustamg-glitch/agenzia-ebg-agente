// src/health.js
const express = require('express');

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
