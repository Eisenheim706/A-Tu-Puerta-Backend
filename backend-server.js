const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fetch = require('node-fetch');
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

// Configuración de Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Cliente para operaciones normales
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Cliente para operaciones administrativas (solo backend)
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

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
    database: 'Supabase PostgreSQL'
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
    const { nombres, apellidos, carnet, telefono, correo, contrasena, rol, vehiculo } = req.body;
    
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
    
    // Validar rol
    if (!['usuario', 'mensajero'].includes(rol)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }
    
    // Validar tipo de vehículo si es mensajero
    if (rol === 'mensajero' && !vehiculo) {
      return res.status(400).json({ error: 'Tipo de vehículo es obligatorio para mensajeros' });
    }
    
    // Construir URL de redirección para verificación de correo
    const frontendUrl = process.env.FRONTEND_URL || 'https://tu-frontend.com';
    const emailRedirectTo = `${frontendUrl}/confirmar.html?type=signup&rol=${rol}`;
    
    // Registrar en Supabase Auth
    const userData = {
      nombres,
      apellidos,
      carnet,
      telefono,
      rol
    };
    
    // Añadir tipo de vehículo solo para mensajeros
    if (rol === 'mensajero') {
      userData.tipo_vehiculo = vehiculo;
    }
    
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: correo,
      password: contrasena,
      options: {
        data: userData,
        emailRedirectTo
      }
    });
    
    if (authError) {
      console.error('Error Supabase:', authError);
      let errorMsg = 'Error en registro';
      
      if (authError.message.includes('email')) {
        errorMsg = 'El correo ya está registrado';
      } else if (authError.message.includes('phone')) {
        errorMsg = 'El teléfono ya está registrado';
      }
      
      return res.status(400).json({ error: errorMsg });
    }
    
    // Guardar en la tabla correspondiente de Supabase
    const tabla = rol === 'usuario' ? 'usuarios' : 'mensajeros';
    const { error: dbError } = await supabase
      .from(tabla)
      .insert({
        id: authData.user.id,
        nombres,
        apellidos,
        carnet,
        telefono,
        correo,
        ...(rol === 'mensajero' && { tipo_vehiculo: vehiculo })
      });
    
    if (dbError) {
      console.error('Error registrando usuario:', dbError);
      
      // Intentar eliminar usuario de Supabase Auth
      await supabase.auth.admin.deleteUser(authData.user.id);
      
      if (dbError.code === '23505') { // Violación de unique constraint
        if (dbError.details.includes('carnet')) {
          return res.status(400).json({ error: 'El carnet ya está registrado' });
        } else if (dbError.details.includes('telefono')) {
          return res.status(400).json({ error: 'El teléfono ya está registrado' });
        } else if (dbError.details.includes('correo')) {
          return res.status(400).json({ error: 'El correo ya está registrado' });
        }
      }
      
      return res.status(500).json({ error: 'Error registrando usuario' });
    }
    
    res.json({ 
      success: true,
      message: 'Registro exitoso. Por favor verifica tu correo electrónico.'
    });
    
  } catch (error) {
    console.error('Error en registro:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Registro de mensajero (endpoint específico)
app.post('/api/registro/mensajero', async (req, res) => {
  try {
    const { nombres, apellidos, carnet, telefono, vehiculo, correo, contrasena } = req.body;
    const rol = 'mensajero';
    
    // Validar campos
    if (!nombres || !apellidos || !carnet || !telefono || !vehiculo || !correo || !contrasena) {
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
    
    // Construir URL de redirección para verificación de correo
    const frontendUrl = process.env.FRONTEND_URL || 'https://tu-frontend.com';
    const emailRedirectTo = `${frontendUrl}/confirmar.html?type=signup&rol=mensajero`;
    
    // Registrar en Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email: correo,
      password: contrasena,
      options: {
        data: {
          nombres,
          apellidos,
          carnet,
          telefono,
          rol,
          tipo_vehiculo: vehiculo
        },
        emailRedirectTo
      }
    });
    
    if (authError) {
      console.error('Error Supabase:', authError);
      let errorMsg = 'Error en registro';
      
      if (authError.message.includes('email')) {
        errorMsg = 'El correo ya está registrado';
      } else if (authError.message.includes('phone')) {
        errorMsg = 'El teléfono ya está registrado';
      }
      
      return res.status(400).json({ error: errorMsg });
    }
    
    // Guardar en la tabla de mensajeros de Supabase
    const { error: dbError } = await supabase
      .from('mensajeros')
      .insert({
        id: authData.user.id,
        nombres,
        apellidos,
        carnet,
        telefono,
        tipo_vehiculo: vehiculo,
        correo
      });
    
    if (dbError) {
      console.error('Error registrando mensajero:', dbError);
      
      // Intentar eliminar usuario de Supabase Auth
      await supabase.auth.admin.deleteUser(authData.user.id);
      
      if (dbError.code === '23505') { // Violación de unique constraint
        if (dbError.details.includes('carnet')) {
          return res.status(400).json({ error: 'El carnet ya está registrado' });
        } else if (dbError.details.includes('telefono')) {
          return res.status(400).json({ error: 'El teléfono ya está registrado' });
        } else if (dbError.details.includes('correo')) {
          return res.status(400).json({ error: 'El correo ya está registrado' });
        }
      }
      
      return res.status(500).json({ error: 'Error registrando mensajero' });
    }
    
    res.json({ 
      success: true,
      message: 'Registro exitoso. Por favor verifica tu correo electrónico.'
    });
    
  } catch (error) {
    console.error('Error en registro de mensajero:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Función auxiliar para obtener correo por teléfono
async function obtenerCorreoPorTelefono(telefono) {
  // Buscar en usuarios
  const { data: usuario } = await supabase
    .from('usuarios')
    .select('correo')
    .eq('telefono', telefono)
    .single();
  
  if (usuario) return usuario.correo;
  
  // Buscar en mensajeros
  const { data: mensajero } = await supabase
    .from('mensajeros')
    .select('correo')
    .eq('telefono', telefono)
    .single();
  
  return mensajero ? mensajero.correo : null;
}

// Login mejorado para aceptar teléfono o correo
app.post('/api/login', async (req, res) => {
  try {
    const { identificador, contrasena, rol } = req.body;
    
    // Determinar si el identificador es un correo o teléfono
    let email;
    if (identificador.includes('@')) {
      email = identificador;
    } else {
      email = await obtenerCorreoPorTelefono(identificador);
      if (!email) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
      }
    }
    
    // Autenticar con Supabase
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email,
      password: contrasena
    });
    
    if (error) {
      console.error('Error en Supabase login:', error);
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    
    // Verificar si el correo está confirmado
    if (!data.user.confirmed_at) {
      return res.status(401).json({ error: 'Por favor verifica tu correo electrónico antes de iniciar sesión' });
    }
    
    // Verificar rol
    if (data.user.user_metadata.rol !== rol) {
      await supabase.auth.signOut();
      return res.status(401).json({ error: 'No tienes permisos para acceder como ' + rol });
    }
    
    // Generar token JWT para nuestra API
    const token = jwt.sign({ 
      id: data.user.id, 
      rol,
      telefono: data.user.user_metadata.telefono,
      nombres: data.user.user_metadata.nombres,
      apellidos: data.user.user_metadata.apellidos
    }, process.env.JWT_SECRET, {
      expiresIn: '8h'
    });
    
    res.json({ 
      success: true, 
      token,
      nombres: data.user.user_metadata.nombres,
      apellidos: data.user.user_metadata.apellidos
    });
  } catch (error) {
    console.error('Error inesperado en login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Endpoint para obtener perfil de usuario autenticado
app.get('/api/perfil', authenticate, async (req, res) => {
  try {
    // Obtener datos adicionales de la tabla correspondiente
    const tabla = req.user.rol === 'usuario' ? 'usuarios' : 'mensajeros';
    const { data, error } = await supabase
      .from(tabla)
      .select('*')
      .eq('id', req.user.id)
      .single();
    
    if (error) throw error;
    
    res.json({
      id: req.user.id,
      nombres: data.nombres,
      apellidos: data.apellidos,
      telefono: data.telefono,
      rol: req.user.rol,
      ...(req.user.rol === 'mensajero' && { tipo_vehiculo: data.tipo_vehiculo })
    });
  } catch (error) {
    console.error('Error obteniendo perfil:', error);
    res.status(500).json({ error: 'Error obteniendo perfil' });
  }
});

// Endpoint para renovar token
app.post('/api/renovar-token', authenticate, (req, res) => {
  // Crear un nuevo token con los mismos datos
  const token = jwt.sign(
    { 
      id: req.user.id, 
      rol: req.user.rol,
      telefono: req.user.telefono,
      nombres: req.user.nombres,
      apellidos: req.user.apellidos
    }, 
    process.env.JWT_SECRET, 
    { expiresIn: '8h' }
  );
  
  res.json({ token });
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
app.post('/api/pedidos', authenticate, async (req, res) => {
  try {
    const usuarioId = req.user.id;
    const pedido = {
      ...req.body,
      usuario_id: usuarioId,
      usuario_nombre: `${req.user.nombres} ${req.user.apellidos}`,
      usuario_telefono: req.user.telefono
    };
    
    console.log('Creando pedido:', pedido.id);
    
    const { data, error } = await supabase
      .from('pedidos')
      .insert([pedido])
      .select();
    
    if (error) {
      console.error('Error al crear pedido:', error);
      return res.status(500).json({ error: 'Error al crear pedido' });
    }
    
    res.json({ success: true, id: pedido.id });
  } catch (error) {
    console.error('Error inesperado en creación de pedido:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Obtener pedidos disponibles
app.get('/api/pedidos/disponibles', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pedidos')
      .select('*')
      .eq('estado', 'disponible');
    
    if (error) throw error;
    
    res.json(data);
  } catch (error) {
    console.error('Error al obtener pedidos disponibles:', error);
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
});

// Asignar mensajero a pedido
app.post('/api/pedidos/asignar', authenticate, async (req, res) => {
  try {
    const { pedidoId } = req.body;
    const mensajeroId = req.user.id;
    
    console.log(`Asignando pedido ${pedidoId} a mensajero ${mensajeroId}`);
    
    // Obtener datos del mensajero
    const mensajeroNombre = `${req.user.nombres} ${req.user.apellidos}`;
    const mensajeroTelefono = req.user.telefono;
    
    // Actualizar el pedido
    const { data, error } = await supabase
      .from('pedidos')
      .update({
        estado: 'en proceso',
        mensajero_id: mensajeroId,
        mensajero_nombre: mensajeroNombre,
        mensajero_telefono: mensajeroTelefono
      })
      .eq('id', pedidoId)
      .select();
    
    if (error) {
      console.error('Error al asignar pedido:', error);
      return res.status(500).json({ error: 'Error al asignar pedido' });
    }
    
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    
    res.json(data[0]);
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

    // Obtener el pedido
    const { data: pedido, error } = await supabase
      .from('pedidos')
      .select('*')
      .eq('id', pedidoId)
      .single();
    
    if (error || !pedido) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    const ubicacionEntrega = pedido.ubicacion_entrega;
    const puntoVenta = pedido.ubicacion_venta;

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
app.post('/api/pedidos/en-camino', authenticate, async (req, res) => {
  try {
    const { pedidoId } = req.body;
    
    const { error } = await supabase
      .from('pedidos')
      .update({ estado: 'en camino' })
      .eq('id', pedidoId);
    
    if (error) {
      console.error('Error al actualizar estado a en camino:', error);
      return res.status(500).json({ error: 'Error al actualizar estado' });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error inesperado en actualizar estado:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Marcar como entregado
app.post('/api/pedidos/entregado', authenticate, async (req, res) => {
  try {
    const { pedidoId } = req.body;
    
    // Obtener el pedido
    const { data: pedido, error: pedidoError } = await supabase
      .from('pedidos')
      .select('*')
      .eq('id', pedidoId)
      .single();
    
    if (pedidoError || !pedido) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }

    // Guardar en Supabase (ya estamos usando Supabase, no necesitamos hacer esto adicionalmente)
    // Pero si quieres mantener un historial, podrías tener una tabla de pedidos_entregados
    // Por ahora, simplemente actualizamos el estado

    // Actualizar estado a entregado
    const { error } = await supabase
      .from('pedidos')
      .update({ estado: 'entregado' })
      .eq('id', pedidoId);
    
    if (error) {
      console.error('Error al actualizar estado:', error);
      return res.status(500).json({ error: 'Error al actualizar estado' });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error en entregado:', error);
    res.status(500).json({ error: error.message || 'Error interno del servidor' });
  }
});

// Obtener pedido por ID
app.get('/api/pedidos/:id', async (req, res) => {
  const pedidoId = req.params.id;
  
  if (!pedidoId) {
    return res.status(400).json({ error: 'ID de pedido requerido' });
  }
  
  try {
    const { data, error } = await supabase
      .from('pedidos')
      .select('*')
      .eq('id', pedidoId)
      .single();
    
    if (error || !data) {
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    
    res.json(data);
  } catch (error) {
    console.error('Error al obtener pedido:', error);
    res.status(500).json({ error: 'Error al obtener pedido' });
  }
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
    const { data, error } = await supabaseAdmin.auth.admin.listUsers();
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
    const { data, error } = await supabaseAdmin.auth.admin.listUsers();
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
    const { error } = await supabaseAdmin.auth.admin.deleteUser(id);
    
    if (error) throw error;
    
    // Eliminar de la tabla mensajeros
    const { error: dbError } = await supabase
      .from('mensajeros')
      .delete()
      .eq('id', id);
    
    if (dbError) console.error('Error eliminando mensajero de la tabla', dbError);
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/pedidos', authenticate, esAdmin, async (req, res) => {
  try {
    const { fecha, mensajeroId, usuarioId } = req.query;
    
    let query = supabase
      .from('pedidos')
      .select('*')
      .eq('estado', 'entregado');
    
    if (fecha) {
      query = query.eq('created_at', fecha);
    }
    
    if (mensajeroId) {
      query = query.eq('mensajero_id', mensajeroId);
    }
    
    if (usuarioId) {
      query = query.eq('usuario_id', usuarioId);
    }
    
    const { data, error } = await query;
    
    if (error) throw error;
    
    res.json(data);
  } catch (error) {
    console.error('Error al obtener pedidos:', error);
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
});

// Recuperación de contraseña
app.post('/api/recuperar-contrasena', async (req, res) => {
  try {
    const { correo } = req.body;
    
    if (!validarCorreo(correo)) {
      return res.status(400).json({ error: 'Correo inválido' });
    }
    
    const { data, error } = await supabase.auth.resetPasswordForEmail(correo, {
      redirectTo: `${process.env.FRONTEND_URL || 'https://tudominio.com'}/restablecer-contrasena`
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
  console.log(`Base de datos: Supabase PostgreSQL`);
  console.log(`OpenRouteService: ${process.env.OPENROUTE_API_KEY ? 'Configurado' : 'NO configurado'}`);
  console.log(`Supabase: ${supabaseUrl ? 'Configurado' : 'NO configurado'}`);
  console.log(`JWT: ${process.env.JWT_SECRET ? 'Configurado' : 'NO configurado'}`);
  console.log(`FRONTEND_URL: ${process.env.FRONTEND_URL || 'No configurado'}`);
  console.log(`=================================\n`);
});