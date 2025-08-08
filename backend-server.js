const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fetch = require('node-fetch');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Configuración de CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(bodyParser.json());

// Configuración de base de datos
const dbDir = process.env.NODE_ENV === 'production' 
  ? '/opt/render/.render' 
  : __dirname;

const dbPath = path.join(dbDir, 'database.sqlite');

// Crear directorio si no existe
if (!fs.existsSync(dbDir)) {
  try {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log(`Directorio creado: ${dbDir}`);
  } catch (err) {
    console.error('Error creando directorio:', err);
  }
}

console.log(`Usando base de datos en: ${dbPath}`);
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error al abrir la base de datos', err);
  } else {
    console.log('Base de datos abierta correctamente');
  }
});

// Configurar Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Crear tablas
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id TEXT PRIMARY KEY,
      productos TEXT NOT NULL,
      ubicacionVenta TEXT NOT NULL,
      ubicacionEntrega TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'disponible',
      mensajeroId TEXT,
      distanciaCarreteraKm REAL,
      precioDelivery REAL,
      geometria_ruta TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error('Error creando tabla pedidos:', err);
    else console.log('Tabla pedidos lista');
  });
  
  db.run(`
    CREATE TABLE IF NOT EXISTS mensajeros (
      telefono TEXT PRIMARY KEY,
      codigo TEXT,
      expiracion INTEGER,
      token TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error('Error creando tabla mensajeros:', err);
    else console.log('Tabla mensajeros lista');
  });
});

// Middleware de logs (ignorar health checks)
app.use((req, res, next) => {
  if (req.path !== '/api/health') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK',
    environment: process.env.NODE_ENV || 'development',
    database: dbPath
  });
});

// Endpoint para calcular rutas con timeout mejorado
app.post('/api/ruta', async (req, res) => {
  try {
    const { origen, destino } = req.body;
    console.log('Solicitud de ruta recibida:', { origen, destino });

    const OPENROUTE_API_KEY = process.env.OPENROUTE_API_KEY;
    if (!OPENROUTE_API_KEY) {
      return res.status(500).json({ error: 'Clave ORS no configurada' });
    }

    // Usar AbortController para timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 segundos

    const response = await fetch('https://api.openrouteservice.org/v2/directions/driving-car', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': OPENROUTE_API_KEY
      },
      body: JSON.stringify({
        coordinates: [
          [origen.lng, origen.lat],
          [destino.lng, destino.lat]
        ]
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(500).json({ error: `Error ORS: ${errorText}` });
    }

    const data = await response.json();
    const distancia = data.routes[0].summary.distance;
    const geometria = data.routes[0].geometry;

    res.json({
      distancia,
      geometria
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('Timeout al calcular ruta');
      return res.status(500).json({ error: 'Timeout al calcular la ruta' });
    }
    console.error('Error al calcular ruta:', error);
    res.status(500).json({ error: 'Error al calcular la ruta' });
  }
});

// Endpoint para crear pedidos
app.post('/api/pedidos', (req, res) => {
  try {
    const pedido = req.body;
    console.log('Creando pedido:', pedido.id);
    
    const query = `
      INSERT INTO pedidos (id, productos, ubicacionVenta, ubicacionEntrega, estado, distanciaCarreteraKm, precioDelivery, geometria_ruta) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    db.run(query, [
      pedido.id,
      JSON.stringify(pedido.productos),
      JSON.stringify(pedido.ubicacionVenta),
      JSON.stringify(pedido.ubicacionEntrega),
      'disponible', // Estado inicial: disponible
      pedido.distanciaCarreteraKm,
      pedido.precioDelivery,
      pedido.geometria_ruta || null  // Guardar geometría si existe
    ], function(err) {
      if (err) {
        console.error('Error al crear pedido:', err);
        return res.status(500).json({ error: 'Error al crear pedido' });
      }
      res.json({ success: true, id: pedido.id });
    });
  } catch (error) {
    console.error('Error inesperado en creación de pedido:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Obtener pedidos disponibles
app.get('/api/pedidos/disponibles', (req, res) => {
  const query = "SELECT * FROM pedidos WHERE estado = 'disponible'"; // Cambiado a 'disponible'
  
  db.all(query, (err, rows) => {
    if (err) {
      console.error('Error al obtener pedidos disponibles:', err);
      return res.status(500).json({ error: 'Error al obtener pedidos' });
    }
    
    try {
      const pedidos = rows.map(row => ({
        ...row,
        productos: JSON.parse(row.productos),
        ubicacionVenta: JSON.parse(row.ubicacionVenta),
        ubicacionEntrega: JSON.parse(row.ubicacionEntrega)
      }));
      res.json(pedidos);
    } catch (parseErr) {
      console.error('Error parseando datos:', parseErr);
      res.status(500).json({ error: 'Error procesando datos' });
    }
  });
});

// Asignar mensajero a pedido
app.post('/api/pedidos/asignar', (req, res) => {
  try {
    const { pedidoId, mensajeroId } = req.body;
    
    db.run(
      `UPDATE pedidos SET estado = 'asignado', mensajeroId = ? WHERE id = ?`,
      [mensajeroId, pedidoId],
      function(err) {
        if (err) {
          console.error('Error al asignar pedido:', err);
          return res.status(500).json({ error: 'Error al asignar pedido' });
        }
        res.json({ success: true });
      }
    );
  } catch (error) {
    console.error('Error inesperado en asignación de pedido:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Endpoint para actualizar estado del pedido - IMPORTANTE: VALIDA ESTADOS PERMITIDOS
app.post('/api/pedidos/actualizar-estado', (req, res) => {
  try {
    const { pedidoId, estado } = req.body;
    
    // Validar estado permitido
    const estadosPermitidos = ['disponible', 'asignado', 'en proceso', 'en camino', 'entregado'];
    if (!estadosPermitidos.includes(estado)) {
      return res.status(400).json({ error: 'Estado no válido' });
    }
    
    db.run(
      `UPDATE pedidos SET estado = ? WHERE id = ?`,
      [estado, pedidoId],
      function(err) {
        if (err) {
          console.error('Error al actualizar estado:', err);
          return res.status(500).json({ error: 'Error al actualizar estado' });
        }
        
        res.json({ success: true });
      }
    );
  } catch (error) {
    console.error('Error inesperado al actualizar estado:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Marcar pedido como entregado (guarda en Supabase y actualiza estado)
app.post('/api/pedidos/entregado', async (req, res) => {
  try {
    const { pedidoId } = req.body;
    
    // 1. Obtener el pedido completo
    const pedido = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM pedidos WHERE id = ?`, [pedidoId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!pedido) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    // 2. Guardar en Supabase
    const { error } = await supabase
      .from('pedidos_entregados')
      .insert([
        { 
          pedido_id: pedido.id,
          datos_pedido: pedido
        }
      ]);

    if (error) {
      console.error('Error guardando en Supabase:', error);
      throw new Error('Error al guardar el pedido en el historial');
    }

    // 3. Actualizar el estado en la base de datos local
    db.run(
      `UPDATE pedidos SET estado = 'entregado' WHERE id = ?`,
      [pedidoId],
      function(err) {
        if (err) {
          console.error('Error al actualizar estado:', err);
          return res.status(500).json({ error: 'Error al actualizar estado' });
        }
        res.json({ success: true });
      }
    );
  } catch (error) {
    console.error('Error en entregado:', error);
    res.status(500).json({ error: error.message || 'Error interno del servidor' });
  }
});

// Verificar ubicación y cambiar estado automáticamente
app.post('/api/pedidos/verificar-ubicacion', async (req, res) => {
  try {
    const { pedidoId, lat, lng } = req.body;
    const MARGEN_ERROR = 0.00027; // ~30 metros en grados (aproximadamente)

    // Obtener pedido
    const pedido = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM pedidos WHERE id = ?`, [pedidoId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!pedido) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    let nuevoEstado = null;
    const ubicacionEntrega = JSON.parse(pedido.ubicacionEntrega);
    const puntoVenta = JSON.parse(pedido.ubicacionVenta);

    // Verificar si está en punto de venta
    const distanciaVenta = Math.sqrt(
      Math.pow(lat - puntoVenta.lat, 2) + 
      Math.pow(lng - puntoVenta.lng, 2)
    );

    // Verificar si está en punto de entrega
    const distanciaEntrega = Math.sqrt(
      Math.pow(lat - ubicacionEntrega.lat, 2) + 
      Math.pow(lng - ubicacionEntrega.lng, 2)
    );

    // Cambiar estado a 'en camino' si está cerca del punto de venta y el estado actual es 'en proceso'
    if (distanciaVenta <= MARGEN_ERROR && pedido.estado === 'en proceso') {
      nuevoEstado = 'en camino';
    } 
    // Cambiar estado a 'entregado' si está cerca del punto de entrega y el estado actual es 'en camino'
    else if (distanciaEntrega <= MARGEN_ERROR && pedido.estado === 'en camino') {
      nuevoEstado = 'entregado';
    }

    if (nuevoEstado) {
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE pedidos SET estado = ? WHERE id = ?`,
          [nuevoEstado, pedidoId],
          (err) => err ? reject(err) : resolve()
        );
      });
    }

    res.json({ 
      success: true,
      estado: nuevoEstado || pedido.estado,
      distanciaVenta,
      distanciaEntrega
    });
    
  } catch (error) {
    console.error('Error verificando ubicación:', error);
    res.status(500).json({ error: 'Error verificando ubicación' });
  }
});

// Solicitar código de verificación
app.post('/api/mensajeros/solicitar-codigo', (req, res) => {
  try {
    const { telefono } = req.body;
    console.log('Solicitud de código para:', telefono);
    
    if (!telefono || telefono.length < 8) {
      return res.status(400).json({ error: 'Número de teléfono inválido' });
    }
    
    const codigo = Math.floor(100000 + Math.random() * 900000).toString();
    const expiracion = Date.now() + 10 * 60 * 1000; // 10 minutos
    
    const query = `
      INSERT OR REPLACE INTO mensajeros (telefono, codigo, expiracion) 
      VALUES (?, ?, ?)
    `;
    
    db.run(query, [telefono, codigo, expiracion], (err) => {
      if (err) {
        console.error('Error al guardar código:', err);
        return res.status(500).json({ error: 'Error al solicitar código' });
      }
      
      console.log(`[SMS SIMULADO] Enviado a ${telefono}: Código ${codigo}`);
      res.json({ success: true, codigo: codigo }); // En desarrollo, devolvemos el código
    });
  } catch (error) {
    console.error('Error inesperado en solicitud de código:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Verificar código de acceso
app.post('/api/mensajeros/verificar-codigo', (req, res) => {
  try {
    const { telefono, codigo } = req.body;
    
    if (!telefono || !codigo) {
      return res.status(400).json({ error: 'Complete todos los campos' });
    }
    
    const query = `SELECT * FROM mensajeros WHERE telefono = ?`;
    
    db.get(query, [telefono], (err, row) => {
      if (err) {
        console.error('Error al verificar código:', err);
        return res.status(500).json({ error: 'Error al verificar código' });
      }
      
      if (!row) {
        return res.status(404).json({ error: 'Teléfono no registrado' });
      }
      
      if (row.codigo !== codigo) {
        return res.status(401).json({ error: 'Código incorrecto' });
      }
      
      if (Date.now() > row.expiracion) {
        return res.status(401).json({ error: 'Código expirado' });
      }
      
      const token = `token-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      db.run(
        `UPDATE mensajeros SET token = ? WHERE telefono = ?`,
        [token, telefono],
        (updateErr) => {
          if (updateErr) {
            console.error('Error al actualizar token:', updateErr);
            return res.status(500).json({ error: 'Error al iniciar sesión' });
          }
          res.json({ success: true, token });
        }
      );
    });
  } catch (error) {
    console.error('Error inesperado en verificación de código:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Obtener información de un pedido
app.get('/api/pedidos/:id', (req, res) => {
  const pedidoId = req.params.id;
  
  if (!pedidoId) {
    return res.status(400).json({ error: 'ID de pedido requerido' });
  }
  
  db.get(
    `SELECT * FROM pedidos WHERE id = ?`,
    [pedidoId],
    (err, row) => {
      if (err) {
        console.error('Error al obtener pedido:', err);
        return res.status(500).json({ error: 'Error al obtener pedido' });
      }
      
      if (!row) {
        return res.status(404).json({ error: 'Pedido no encontrado' });
      }
      
      try {
        const pedido = {
          ...row,
          productos: JSON.parse(row.productos),
          ubicacionVenta: JSON.parse(row.ubicacionVenta),
          ubicacionEntrega: JSON.parse(row.ubicacionEntrega)
        };
        res.json(pedido);
      } catch (parseErr) {
        console.error('Error parseando datos:', parseErr);
        res.status(500).json({ error: 'Error procesando datos del pedido' });
      }
    }
  );
});

// Manejo de rutas no encontradas
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// Manejo de errores global
app.use((err, req, res, next) => {
  console.error('Error global no manejado:', err.stack);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// Iniciar servidor
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`\n=== Servidor backend iniciado ===`);
  console.log(`Puerto: ${PORT}`);
  console.log(`Entorno: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Base de datos: ${dbPath}`);
  console.log(`OpenRouteService: ${process.env.OPENROUTE_API_KEY ? 'Configurado' : 'NO configurado'}`);
  console.log(`Supabase: ${supabaseUrl ? 'Configurado' : 'NO configurado'}`);
  console.log(`=================================\n`);
});