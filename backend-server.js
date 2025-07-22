const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const pedidos = {};
const OPENROUTE_API_KEY = process.env.OPENROUTE_API_KEY; // API Key desde variables de entorno

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

// Nuevo endpoint para calcular rutas con OpenRouteService
app.post('/api/ruta', async (req, res) => {
  try {
    const { origen, destino } = req.body;
    
    if (!OPENROUTE_API_KEY) {
      return res.status(500).json({ error: 'API key no configurada' });
    }

    const url = `https://api.openrouteservice.org/v2/directions/driving-car`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': OPENROUTE_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        coordinates: [
          [origen.lng, origen.lat],
          [destino.lng, destino.lat]
        ]
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Error en OpenRouteService');
    }

    const data = await response.json();
    
    // Extraer información relevante
    const resultado = {
      distancia: data.routes[0].summary.distance,
      duracion: data.routes[0].summary.duration,
      geometria: data.routes[0].geometry // Polilínea codificada
    };

    res.json(resultado);
  } catch (error) {
    console.error('Error al calcular ruta:', error);
    res.status(500).json({ error: error.message || 'Error al calcular la ruta' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor backend en puerto ${PORT}`);
  console.log(`Usando API key: ${OPENROUTE_API_KEY ? 'Configurada' : 'NO CONFIGURADA'}`);
});