const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const pedidos = {};
const OPENROUTE_API_KEY = process.env.OPENROUTE_API_KEY;

// Middleware para loggear todas las solicitudes
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Endpoint para calcular rutas
app.post('/api/ruta', async (req, res) => {
  try {
    const { origen, destino } = req.body;
    console.log('Solicitud de ruta recibida:', { origen, destino });
    
    if (!OPENROUTE_API_KEY) {
      console.error('API key no configurada');
      return res.status(500).json({ error: 'API key no configurada' });
    }

    const url = 'https://api.openrouteservice.org/v2/directions/driving-car';
    const body = {
      coordinates: [
        [origen.lng, origen.lat],
        [destino.lng, destino.lat]
      ],
      instructions: false,
      geometry: true
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': OPENROUTE_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body),
      timeout: 10000
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error('Error de OpenRouteService:', data);
      return res.status(response.status).json({ 
        error: data.error || 'Error en el servicio de rutas' 
      });
    }

    const ruta = data.routes[0];
    const resultado = {
      distancia: ruta.summary.distance,
      duracion: route.summary.duration,
      geometria: ruta.geometry
    };

    console.log('Ruta calculada:', {
      distancia: `${(resultado.distancia / 1000).toFixed(2)} km`
    });
    
    res.json(resultado);
  } catch (error) {
    console.error('Error al calcular ruta:', error);
    res.status(500).json({ 
      error: error.message || 'Error interno al calcular la ruta' 
    });
  }
});

// Endpoint para crear pedidos
app.post('/api/pedidos', (req, res) => {
  try {
    const pedido = req.body;
    console.log('Creando pedido:', pedido.id);
    
    if (!pedido.id) {
      return res.status(400).json({ error: 'ID de pedido faltante' });
    }
    
    pedidos[pedido.id] = pedido;
    res.status(201).json({ message: 'Pedido creado', id: pedido.id });
  } catch (error) {
    console.error('Error creando pedido:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Endpoint para obtener un pedido
app.get('/api/pedidos/:id', (req, res) => {
  try {
    const pedido = pedidos[req.params.id];
    if (!pedido) {
      console.log(`Pedido no encontrado: ${req.params.id}`);
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    
    res.json(pedido);
  } catch (error) {
    console.error('Error obteniendo pedido:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Health check mejorado
app.get('/api/health', (req, res) => {
  const status = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    servicioRutas: OPENROUTE_API_KEY ? 'CONFIGURADO' : 'NO CONFIGURADO',
    totalPedidos: Object.keys(pedidos).length
  };
  res.status(200).json(status);
});

// Manejo de errores global
app.use((err, req, res, next) => {
  console.error('Error global:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor backend en puerto ${PORT}`);
  console.log(`Ruta de cálculo: POST /api/ruta`);
  console.log(`OpenRouteService: ${OPENROUTE_API_KEY ? 'Configurado' : 'NO CONFIGURADO'}`);
});