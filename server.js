const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Helper para llamadas a Supabase
function supabaseFetch(endpoint, method, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + endpoint);
    const postData = body ? JSON.stringify(body) : '';
    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': token ? `Bearer ${token}` : `Bearer ${SUPABASE_KEY}`,
    };
    if (postData) headers['Content-Length'] = Buffer.byteLength(postData);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// Helper para auth de Supabase
function supabaseAuth(endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + '/auth/v1' + endpoint);
    const postData = JSON.stringify(body);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch(e) { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // ── AUTH: Callback de Google OAuth ──
  if (req.method === 'POST' && req.url === '/auth/callback') {
    const { code } = await parseBody(req);
    const result = await supabaseAuth('/token?grant_type=pkce', { auth_code: code });
    return json(result.data, result.status);
  }

  // ── AUTH: Registro ──
  if (req.method === 'POST' && req.url === '/auth/register') {
    const { email, password } = await parseBody(req);
    const result = await supabaseAuth('/signup', { email, password });
    return json(result.data, result.status);
  }

  // ── AUTH: Login ──
  if (req.method === 'POST' && req.url === '/auth/login') {
    const { email, password } = await parseBody(req);
    const result = await supabaseAuth('/token?grant_type=password', { email, password });
    return json(result.data, result.status);
  }

  // ── AUTH: Logout ──
  if (req.method === 'POST' && req.url === '/auth/logout') {
    return json({ success: true });
  }

  // ── PERFIL: Obtener créditos ──
  if (req.method === 'GET' && req.url === '/api/perfil') {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return json({ error: 'No autenticado' }, 401);
    const result = await supabaseFetch('/rest/v1/profiles?select=creditos,email,total_analisis', 'GET', null, token);
    if (result.data && result.data.length > 0) return json(result.data[0]);
    return json({ creditos: 0 });
  }

  // ── ANÁLISIS: Proxy a Anthropic con descuento de crédito ──
  if (req.method === 'POST' && req.url === '/api/claude') {
    const token = (req.headers.authorization || '').replace('Bearer ', '');

    // Verificar créditos si hay token
    if (token) {
      const perfil = await supabaseFetch('/rest/v1/profiles?select=id,creditos', 'GET', null, token);
      if (perfil.data && perfil.data.length > 0) {
        const { id, creditos } = perfil.data[0];
        if (creditos <= 0) return json({ error: { message: 'Sin créditos disponibles' } }, 402);
        // Descontar crédito
        await supabaseFetch(`/rest/v1/profiles?id=eq.${id}`, 'PATCH',
          { creditos: creditos - 1, total_analisis: (perfil.data[0].total_analisis || 0) + 1 }, token);
      }
    }

    if (!ANTHROPIC_API_KEY) return json({ error: { message: 'API key no configurada.' } }, 500);

    const body = await parseBody(req);
    const postData = JSON.stringify(body);

    return new Promise((resolve) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(postData)
        }
      };
      const apiReq = https.request(options, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
          res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
          resolve();
        });
      });
      apiReq.on('error', (err) => {
        json({ error: { message: err.message } }, 500);
        resolve();
      });
      apiReq.write(postData);
      apiReq.end();
    });
  }

  // ── ANÁLISIS: Guardar en Supabase ──
  if (req.method === 'POST' && req.url === '/api/guardar-analisis') {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return json({ error: 'No autenticado' }, 401);
    const body = await parseBody(req);
    const result = await supabaseFetch('/rest/v1/analisis', 'POST', body, token);
    return json({ success: true }, 201);
  }

  // ── Servir archivos estáticos ──
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html', '.js': 'application/javascript',
    '.json': 'application/json', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.css': 'text/css'
  };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
