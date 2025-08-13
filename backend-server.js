const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fetch = require('node-fetch');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

// Configuración de CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
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

// Crear tablas corregidas
db.serialize(() => {
  // Tabla pedidos (corregida)
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
      usuarioId TEXT,
      usuarioNombre TEXT,
      usuarioTelefono TEXT,
      mensajeroNombre TEXT,
      mensajeroTelefono TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error('Error creando tabla pedidos:', err);
    else console.log('Tabla pedidos lista');
  });
  
  // Tabla mensajeros (nueva estructura)
  db.run(`
    CREATE TABLE IF NOT EXISTS mensajeros (
      id TEXT PRIMARY KEY,
      nombres TEXT NOT NULL,
      apellidos TEXT NOT NULL,
      carnet TEXT UNIQUE NOT NULL,
      telefono TEXT UNIQUE NOT NULL,
      tipo_vehiculo TEXT NOT NULL,
      correo TEXT UNIQUE NOT NULL,
      contrasena TEXT NOT NULL,
      token TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error('Error creando tabla mensajeros:', err);
    else console.log('Tabla mensajeros lista');
  });
  
  // Tabla usuarios
  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id TEXT PRIMARY KEY,
      nombres TEXT NOT NULL,
      apellidos TEXT NOT NULL,
      carnet TEXT UNIQUE NOT NULL,
      telefono TEXT UNIQUE NOT NULL,
      correo TEXT UNIQUE NOT NULL,
      contrasena TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) console.error('Error creando tabla usuarios:', err);
    else console.log('Tabla usuarios lista');
  });
});

// Middleware de logs
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

// Middleware de autenticación
function authenticate(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Acceso no autorizado' });
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    console.error('Error verificando token:', error);
    res.status(401).json({ error: 'Token inválido' });
  }
}

// Generar ID único
function generarId() {
  return crypto.randomBytes(8).toString('hex');
}

// Funciones de validación
function validarCarnet(carnet) {
  return /^\d{11}$/.test(carnet);
}

function validarTelefono(telefono) {
  const tel = telefono.replace(/\D/g, '');
  return /^[56]\d{7}$/.test(tel) || /^(535|536)\d{7}$/.test(tel);
}

function validarCorreo(correo) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo);
}

// Registro de usuario
app.post('/api/registro', async (req, res) => {
  try {
    const { nombres, apellidos, carnet, telefono, correo, contrasena, rol } = req.body;
    
    // Validar campos
    if (!nombres || !apellidos || !carnet || !telefono || !correo || !contrasena || !rol) {
      return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }
    
    if (!validarCarnet(carnet)) {
      return res.status(400).json({ error: 'Carnet debe tener 11 dígitos' });
    }
    
    if (!validarTelefono(telefono)) {
      return res.status(400).json({ error: 'Teléfono inválido' });
    }
    
    if (!validarCorreo(correo)) {
      return res.status(400).json({ error: 'Correo inválido' });
    }
    
    // Registrar en Supabase Auth
    const { data, error } = await supabase.auth.signUp({
      email: correo,
      password: contrasena,
      options: {
        data: {
          nombres,
          apellidos,
          carnet,
          telefono,
          rol
        }
      }
    });
    
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    
    // Guardar en base de datos local
    const tabla = rol === 'usuario' ? 'usuarios' : 'mensajeros';
    const campos = rol === 'mensajero' ? ', tipo_vehiculo' : '';
    const valores = rol === 'mensajero' ? ', ?' : '';
    
    const query = `
      INSERT INTO ${tabla} (id, nombres, apellidos, carnet, telefono, correo, contrasena ${campos})
      VALUES (?, ?, ?, ?, ?, ?, ? ${valores})
    `;
    
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(contrasena, salt);
    
    const params = [
      data.user.id,
      nombres,
      apellidos,
      carnet,
      telefono,
      correo,
      hash
    ];
    
    if (rol === 'mensajero') {
      params.push(req.body.tipo_vehiculo);
    }
    
    db.run(query, params, (err) => {
      if (err) {
        // Intentar eliminar usuario de Supabase
        supabase.auth.admin.deleteUser(data.user.id);
        return res.status(500).json({ error: 'Error registrando usuario' });
      }
      
      res.json({ 
        success: true,
        message: 'Registro exitoso. Por favor verifica tu correo electrónico.'
      });
    });
    
  } catch (error) {
    console.error('Error en registro:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { identificador, contrasena, rol } = req.body;
    
    // Buscar en las tablas de usuarios y mensajeros
    const query = `
      SELECT * FROM (
        SELECT id, nombres, apellidos, carnet, telefono, correo, contrasena, 'usuario' as rol FROM usuarios
        UNION ALL
        SELECT id, nombres, apellidos, carnet, telefono, correo, contrasena, 'mensajero' as rol FROM mensajeros
      ) WHERE (telefono = ? OR correo = ?) AND rol = ?
    `;
    
    db.get(query, [identificador, identificador, rol], async (err, row) => {
      if (err) {
        console.error('Error en consulta de login:', err);
        return res.status(500).json({ error: 'Error en autenticación' });
      }
      
      if (!row) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }
      
      // Verificar contraseña
      const contrasenaValida = await bcrypt.compare(contrasena, row.contrasena);
      if (!contrasenaValida) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }
      
      // Autenticar con Supabase para obtener token de acceso
      const { data, error: supabaseError } = await supabase.auth.signInWithPassword({
        email: row.correo,
        password: contrasena
      });
      
      if (supabaseError) {
        console.error('Error en Supabase login:', supabaseError);
        return res.status(401).json({ error: 'Error en autenticación' });
      }
      
      // Verificar si el correo está confirmado
      if (!data.user.confirmed_at) {
        return res.status(401).json({ error: 'Por favor verifica tu correo electrónico antes de iniciar sesión' });
      }
      
      // Generar token JWT para nuestra API
      const token = jwt.sign({ 
        id: row.id, 
        rol,
        telefono: row.telefono,
        nombres: row.nombres,
        apellidos: row.apellidos
      }, process.env.JWT_SECRET, {
        expiresIn: '8h'
      });
      
      res.json({ success: true, token });
    });
  } catch (error) {
    console.error('Error inesperado en login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Endpoint para calcular rutas
app.post('/api/ruta', async (req, res) => {
  try {
    const { origen, destino } = req.body;
    console.log('Solicitud de ruta recibida:', { origen, destino });

    const OPENROUTE_API_KEY = process.env.OPENROUTE_API_KEY;
    if (!OPENROUTE_API_KEY) {
      return res.status(500).json({ error: 'Clave ORS no configurada' });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

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

// Crear pedidos
app.post('/api/pedidos', authenticate, (req, res) => {
  try {
    const usuarioId = req.user.id;
    const pedido = {
      ...req.body,
      usuarioId,
      usuarioNombre: `${req.user.nombres} ${req.user.apellidos}`,
      usuarioTelefono: req.user.telefono
    };
    
    console.log('Creando pedido:', pedido.id);
    
    const query = `
      INSERT INTO pedidos (id, productos, ubicacionVenta, ubicacionEntrega, estado, distanciaCarreteraKm, precioDelivery, geometria_ruta, usuarioId, usuarioNombre, usuarioTelefono) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    db.run(query, [
      pedido.id,
      JSON.stringify(pedido.productos),
      JSON.stringify(pedido.ubicacionVenta),
      JSON.stringify(pedido.ubicacionEntrega),
      'disponible',
      pedido.distanciaCarreteraKm,
      pedido.precioDelivery,
      pedido.geometria_ruta || null,
      usuarioId,
      pedido.usuarioNombre,
      pedido.usuarioTelefono
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
  const query = "SELECT * FROM pedidos WHERE estado = 'disponible'";
  
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
app.post('/api/pedidos/asignar', authenticate, (req, res) => {
  try {
    const { pedidoId } = req.body;
    const mensajeroId = req.user.id;
    
    console.log(`Asignando pedido ${pedidoId} a mensajero ${mensajeroId}`);
    
    // Obtener datos del mensajero
    const mensajeroNombre = `${req.user.nombres} ${req.user.apellidos}`;
    const mensajeroTelefono = req.user.telefono;
    
    db.run(
      `UPDATE pedidos 
       SET estado = 'en proceso', 
           mensajeroId = ?,
           mensajeroNombre = ?,
           mensajeroTelefono = ?
       WHERE id = ?`,
      [mensajeroId, mensajeroNombre, mensajeroTelefono, pedidoId],
      function(err) {
        if (err) {
          console.error('Error al asignar pedido:', err);
          return res.status(500).json({ error: 'Error al asignar pedido' });
        }
        
        db.get(`SELECT * FROM pedidos WHERE id = ?`, [pedidoId], (err, row) => {
          if (err) {
            console.error('Error al obtener pedido actualizado:', err);
            return res.status(500).json({ error: 'Error al obtener pedido actualizado' });
          }
          
          if (!row) {
            return res.status(404).json({ error: 'Pedido no encontrado después de actualizar' });
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
        });
      }
    );
  } catch (error) {
    console.error('Error inesperado en asignación de pedido:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Verificar ubicación
app.post('/api/pedidos/verificar-ubicacion', async (req, res) => {
  try {
    const { pedidoId, lat, lng } = req.body;
    const MARGEN_METROS = 30;

    const pedido = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM pedidos WHERE id = ?`, [pedidoId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!pedido) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const ubicacionEntrega = JSON.parse(pedido.ubicacionEntrega);
    const puntoVenta = JSON.parse(pedido.ubicacionVenta);

    function calcularDistancia(lat1, lon1, lat2, lon2) {
      const R = 6371e3;
      const φ1 = lat1 * Math.PI/180;
      const φ2 = lat2 * Math.PI/180;
      const Δφ = (lat2-lat1) * Math.PI/180;
      const Δλ = (lon2-lon1) * Math.PI/180;

      const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                Math.cos(φ1) * Math.cos(φ2) *
                Math.sin(Δλ/2) * Math.sin(Δλ/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

      return R * c;
    }

    const distanciaVenta = calcularDistancia(
      lat, lng, 
      puntoVenta.lat, puntoVenta.lng
    );
    
    const distanciaEntrega = calcularDistancia(
      lat, lng, 
      ubicacionEntrega.lat, ubicacionEntrega.lng
    );

    res.json({ 
      success: true,
      estado: pedido.estado,
      distanciaVenta,
      distanciaEntrega
    });
    
  } catch (error) {
    console.error('Error verificando ubicación:', error);
    res.status(500).json({ error: 'Error verificando ubicación' });
  }
});

// Marcar como en camino
app.post('/api/pedidos/en-camino', authenticate, (req, res) => {
  try {
    const { pedidoId } = req.body;
    
    db.run(
      `UPDATE pedidos SET estado = 'en camino' WHERE id = ?`,
      [pedidoId],
      function(err) {
        if (err) {
          console.error('Error al actualizar estado a en camino:', err);
          return res.status(500).json({ error: 'Error al actualizar estado' });
        }
        res.json({ success: true });
      }
    );
  } catch (error) {
    console.error('Error inesperado en actualizar estado:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Marcar como entregado
app.post('/api/pedidos/entregado', authenticate, async (req, res) => {
  try {
    const { pedidoId } = req.body;
    
    const pedido = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM pedidos WHERE id = ?`, [pedidoId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!pedido) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    // Guardar en Supabase
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

    // Actualizar estado a entregado
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

// Obtener pedido por ID
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

// Middleware de administrador
function esAdmin(req, res, next) {
  if (req.user.rol !== 'admin') {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  next();
}

// Endpoints de administración
app.get('/api/admin/usuarios', authenticate, esAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.auth.admin.listUsers();
    if (error) throw error;
    
    // Filtrar solo usuarios normales
    const usuarios = data.users.filter(u => u.user_metadata.rol === 'usuario');
    res.json(usuarios);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/mensajeros', authenticate, esAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.auth.admin.listUsers();
    if (error) throw error;
    
    // Filtrar solo mensajeros
    const mensajeros = data.users.filter(u => u.user_metadata.rol === 'mensajero');
    res.json(mensajeros);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/admin/mensajeros/:id', authenticate, esAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.auth.admin.deleteUser(id);
    
    if (error) throw error;
    
    // Eliminar de la base de datos local
    db.run(`DELETE FROM mensajeros WHERE id = ?`, [id], (err) => {
      if (err) console.error('Error eliminando mensajero local', err);
      res.json({ success: true });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/pedidos', authenticate, esAdmin, (req, res) => {
  const { fecha, mensajeroId, usuarioId } = req.query;
  
  let query = "SELECT * FROM pedidos WHERE estado = 'entregado'";
  const params = [];
  
  if (fecha) {
    query += " AND DATE(created_at) = ?";
    params.push(fecha);
  }
  
  if (mensajeroId) {
    query += " AND mensajeroId = ?";
    params.push(mensajeroId);
  }
  
  if (usuarioId) {
    query += " AND usuarioId = ?";
    params.push(usuarioId);
  }
  
  db.all(query, params, (err, rows) => {
    if (err) {
      console.error('Error al obtener pedidos:', err);
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

// Recuperación de contraseña
app.post('/api/recuperar-contrasena', async (req, res) => {
  try {
    const { correo } = req.body;
    
    if (!validarCorreo(correo)) {
      return res.status(400).json({ error: 'Correo inválido' });
    }
    
    const { data, error } = await supabase.auth.resetPasswordForEmail(correo, {
      redirectTo: 'https://tudominio.com/restablecer-contrasena'
    });
    
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
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
  console.log(`JWT: ${process.env.JWT_SECRET ? 'Configurado' : 'NO configurado'}`);
  console.log(`=================================\n`);
});