const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const db = new sqlite3.Database('./database.sqlite');

// Crear tablas si no existen
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
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS mensajeros (
      telefono TEXT PRIMARY KEY,
      codigo TEXT,
      expiracion INTEGER,
      token TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Crear nuevo pedido
app.post('/api/pedidos', (req, res) => {
  const pedido = req.body;
  
  db.run(
    `INSERT INTO pedidos (id, productos, ubicacionVenta, ubicacionEntrega, estado, distanciaCarreteraKm, precioDelivery) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      pedido.id,
      JSON.stringify(pedido.productos),
      JSON.stringify(pedido.ubicacionVenta),
      JSON.stringify(pedido.ubicacionEntrega),
      'en proceso',
      pedido.distanciaCarreteraKm,
      pedido.precioDelivery
    ],
    function(err) {
      if (err) {
        console.error('Error al crear pedido:', err);
        return res.status(500).json({ error: 'Error al crear pedido' });
      }
      res.json({ success: true, id: pedido.id });
    }
  );
});

// Obtener pedidos disponibles
app.get('/api/pedidos/disponibles', (req, res) => {
  db.all("SELECT * FROM pedidos WHERE estado = 'en proceso'", (err, rows) => {
    if (err) {
      console.error('Error al obtener pedidos disponibles:', err);
      return res.status(500).json({ error: 'Error al obtener pedidos' });
    }
    
    const pedidos = rows.map(row => ({
      ...row,
      productos: JSON.parse(row.productos),
      ubicacionVenta: JSON.parse(row.ubicacionVenta),
      ubicacionEntrega: JSON.parse(row.ubicacionEntrega)
    }));
    
    res.json(pedidos);
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
  const codigo = Math.floor(100000 + Math.random() * 900000).toString();
  const expiracion = Date.now() + 10 * 60 * 1000; // 10 minutos
  
  db.run(
    `INSERT OR REPLACE INTO mensajeros (telefono, codigo, expiracion) VALUES (?, ?, ?)`,
    [telefono, codigo, expiracion],
    function(err) {
      if (err) {
        console.error('Error al guardar código:', err);
        return res.status(500).json({ error: 'Error al solicitar código' });
      }
      
      console.log(`Código ${codigo} enviado a ${telefono}`);
      res.json({ success: true });
    }
  );
});

// Verificar código de acceso
app.post('/api/mensajeros/verificar-codigo', (req, res) => {
  const { telefono, codigo } = req.body;
  
  db.get(
    `SELECT * FROM mensajeros WHERE telefono = ?`,
    [telefono],
    (err, row) => {
      if (err) {
        console.error('Error al verificar código:', err);
        return res.status(500).json({ error: 'Error al verificar código' });
      }
      
      if (!row) {
        return res.status(400).json({ error: 'Teléfono no encontrado' });
      }
      
      if (row.codigo !== codigo) {
        return res.status(400).json({ error: 'Código incorrecto' });
      }
      
      if (Date.now() > row.expiracion) {
        return res.status(400).json({ error: 'Código expirado' });
      }
      
      const token = `token-${Date.now()}`;
      
      db.run(
        `UPDATE mensajeros SET token = ? WHERE telefono = ?`,
        [token, telefono],
        (err) => {
          if (err) {
            console.error('Error al actualizar token:', err);
            return res.status(500).json({ error: 'Error al iniciar sesión' });
          }
          res.json({ success: true, token });
        }
      );
    }
  );
});

// Obtener información de un pedido específico
app.get('/api/pedidos/:id', (req, res) => {
  db.get(
    `SELECT * FROM pedidos WHERE id = ?`,
    [req.params.id],
    (err, row) => {
      if (err) {
        console.error('Error al obtener pedido:', err);
        return res.status(500).json({ error: 'Error al obtener pedido' });
      }
      
      if (!row) {
        return res.status(404).json({ error: 'Pedido no encontrado' });
      }
      
      res.json({
        ...row,
        productos: JSON.parse(row.productos),
        ubicacionVenta: JSON.parse(row.ubicacionVenta),
        ubicacionEntrega: JSON.parse(row.ubicacionEntrega)
      });
    }
  );
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor backend ejecutándose en http://localhost:${PORT}`);
});