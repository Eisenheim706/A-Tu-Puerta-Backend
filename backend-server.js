const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Almacenar API key en variables de entorno (Render.com)
const OPENROUTE_API_KEY = process.env.OPENROUTE_API_KEY || "tu_api_key_por_defecto";

// Endpoint seguro para proveer API key
app.get('/api/openroute-key', (req, res) => {
  // Validar origen de la solicitud
  const origin = req.get('origin');
  const allowedOrigins = [
    'https://tu-usuario.github.io', // Tu GitHub Pages
    'http://localhost:3000'         // Desarrollo local
  ];

  if (!allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: 'Acceso no autorizado' });
  }

  res.json({ key: OPENROUTE_API_KEY });
});

// Base de datos temporal (en producción usarías una DB real)
const pedidos = {};

// Endpoint para crear pedidos
app.post('/api/pedidos', (req, res) => {
  const pedido = req.body;
  pedidos[pedido.id] = pedido;
  res.status(201).json({ message: 'Pedido creado', id: pedido.id });
});

// Endpoint para obtener un pedido
app.get('/api/pedidos/:id', (req, res) => {
  const pedido = pedidos[req.params.id];
  if (!pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
  res.json(pedido);
});

// Health check
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor backend en puerto ${PORT}`);
});