const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Configurar base de datos en directorio persistente
const dbPath = process.env.NODE_ENV === 'production' 
  ? path.join('/opt/render/.render', 'database.sqlite')
  : './database.sqlite';

const db = new sqlite3.Database(dbPath);

// Crear tablas
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id TEXT PRIMARY KEY,
      productos TEXT NOT NULL,
      ubicacionVenta TEXT NOT NULL,
      ubicacionEntrega TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'en proceso',
      mensajeroId TEXT,
      distanciaCarreteraKm REAL,
      precioDelivery REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error('Error creando tabla pedidos:', err);
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
  });
});

// Endpoint de prueba
app.get('/', (req, res) => {
  res.send('Backend A TU PUERTA funcionando');
});

// Endpoint para crear pedidos
app.post('/api/pedidos', (req, res) => {
  const pedido = req.body;
  
  const query = `
    INSERT INTO pedidos (id, productos, ubicacionVenta, ubicacionEntrega, estado, distanciaCarreteraKm, precioDelivery) 
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
  
  db.run(query, [
    pedido.id,
    JSON.stringify(pedido.productos),
    JSON.stringify(pedido.ubicacionVenta),
    JSON.stringify(pedido.ubicacionEntrega),
    'en proceso',
    pedido.distanciaCarreteraKm,
    pedido.precioDelivery
  ], function(err) {
    if (err) {
      console.error('Error al crear pedido:', err);
      return res.status(500).json({ error: 'Error al crear pedido' });
    }
    res.json({ success: true, id: pedido.id });
  });
});

// Obtener pedidos disponibles
app.get('/api/pedidos/disponibles', (req, res) => {
  const query = "SELECT * FROM pedidos WHERE estado = 'en proceso'";
  
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
});

// Marcar pedido como entregado
app.post('/api/pedidos/entregado', (req, res) => {
  const { pedidoId } = req.body;
  
  db.run(
    `UPDATE pedidos SET estado = 'entregado' WHERE id = ?`,
    [pedidoId],
    function(err) {
      if (err) {
        console.error('Error al finalizar pedido:', err);
        return res.status(500).json({ error: 'Error al finalizar pedido' });
      }
      res.json({ success: true });
    }
  );
});

// Solicitar código de verificación
app.post('/api/mensajeros/solicitar-codigo', (req, res) => {
  const { telefono } = req.body;
  
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
    
    console.log(`Código ${codigo} enviado a ${telefono}`);
    res.json({ success: true });
  });
});

// Verificar código de acceso
app.post('/api/mensajeros/verificar-codigo', (req, res) => {
  const { telefono, codigo } = req.body;
  
  if (!telefono || !codigo) {
    return res.status(400).json({ error: 'Datos incompletos' });
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

// Manejo de errores global
app.use((err, req, res, next) => {
  console.error('Error global:', err.stack);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// Iniciar servidor
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor backend ejecutándose en puerto ${PORT}`);
});