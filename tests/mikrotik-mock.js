/**
 * Mock MikroTik REST API Server
 * Simulates RouterOS v7 REST API for development/testing
 * Avoids slow QEMU x86 emulation on ARM Macs
 *
 * Usage: node tests/mikrotik-mock.js
 * Listens on port 8780
 */
const http = require('http');
const url = require('url');

const users = [];
const QUEUE_TYPES = {
  '1M': { name: 'cafe-1M', rate: '1M', burst: '2M', burstTime: '10' },
  '2M': { name: 'cafe-2M', rate: '2M', burst: '4M', burstTime: '15' },
  '5M': { name: 'cafe-5M', rate: '5M', burst: '8M', burstTime: '30' },
};

function basicAuth(headers) {
  const auth = headers.authorization || '';
  const parts = auth.split(' ');
  if (parts[0] !== 'Basic') return null;
  const decoded = Buffer.from(parts[1], 'base64').toString();
  const [user, pass] = decoded.split(':');
  return { user, pass };
}

function respond(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Server': 'RouterOS/7.23.2 (Mock)',
  });
  res.end(JSON.stringify(data));
}

const routes = {
  // GET /rest/ — list available endpoints
  'GET /rest/': (req, res) => {
    respond(res, 200, [
      { endpoint: '/ip/hotspot/user', methods: ['get', 'put', 'add', 'remove'] },
      { endpoint: '/ip/hotspot/user/profile', methods: ['get', 'add'] },
      { endpoint: '/queue/simple', methods: ['get', 'add', 'remove'] },
      { endpoint: '/ip/hotspot/active', methods: ['get'] },
      { endpoint: '/system/identity', methods: ['get'] },
      { endpoint: '/system/resource', methods: ['get'] },
    ]);
  },

  // GET /rest/ip/hotspot/user
  'GET /rest/ip/hotspot/user': (req, res) => {
    respond(res, 200, users.map(u => ({
      '.id': `*${u.id}`,
      name: u.name,
      password: u.password,
      profile: u.profile,
      'limit-uptime': u.limitUptime,
      comment: u.comment,
      disabled: u.disabled ? 'true' : 'false',
    })));
  },

  // POST /rest/ip/hotspot/user (add via REST API)
  'POST /rest/ip/hotspot/user': (req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const id = users.length + 1;
        const newUser = {
          id,
          name: data.name,
          password: data.password,
          profile: data.profile || 'default',
          limitUptime: data['limit-uptime'] || '4h',
          comment: data.comment || '',
          disabled: false,
        };
        users.push(newUser);
        console.log(`[Mock] Hotspot user created: ${data.name} (${data.password}) profile=${data.profile}`);
        respond(res, 200, {
          '.id': `*${id}`,
          after: [{ '.id': `*${id}` }],
        });
      } catch (e) {
        respond(res, 400, { error: e.message, detail: 'Mock parse error' });
      }
    });
  },

  // PUT /rest/ip/hotspot/user (add via RouterOS API)
  'PUT /rest/ip/hotspot/user': (req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const id = users.length + 1;
        const newUser = {
          id,
          name: data.name,
          password: data.password,
          profile: data.profile || 'default',
          limitUptime: data['limit-uptime'] || '4h',
          comment: data.comment || '',
          disabled: false,
        };
        users.push(newUser);

        // Auto-create simple queue for bandwidth limiting
        const queueId = id + 100;
        console.log(`[Mock] Created hotspot user: ${data.name} (${data.password})`);
        console.log(`[Mock] Queue target: ${data.name} — rate: ${QUEUE_TYPES[data.profile]?.rate || '1M'}`);

        respond(res, 200, {
          '.id': `*${id}`,
          after: [{ '.id': `*${id}` }],
        });
      } catch (e) {
        respond(res, 400, { error: e.message, detail: 'Mock parse error' });
      }
    });
  },

  // GET /rest/ip/hotspot/user/profile
  'GET /rest/ip/hotspot/user/profile': (req, res) => {
    respond(res, 200, [
      { '.id': '*1', name: 'default', 'rate-limit': '', sharedusers: '1' },
      { '.id': '*2', name: 'cafe-wifi', 'rate-limit': '1M/1M', sharedusers: '1' },
    ]);
  },

  // GET /rest/queue/simple
  'GET /rest/queue/simple': (req, res) => {
    respond(res, 200, users.map(u => ({
      '.id': `*${u.id + 100}`,
      name: `q-${u.name}`,
      target: u.name,
      'max-limit': `${QUEUE_TYPES[u.profile]?.rate || '1M'}/${QUEUE_TYPES[u.profile]?.rate || '1M'}`,
      'burst-limit': `${QUEUE_TYPES[u.profile]?.burst || '2M'}/${QUEUE_TYPES[u.profile]?.burst || '2M'}`,
      'burst-time': `${QUEUE_TYPES[u.profile]?.burstTime || '10'}/${QUEUE_TYPES[u.profile]?.burstTime || '10'}`,
      queue: 'cafe-1M/cafe-1M',
      comment: u.comment,
    })));
  },

  // GET /rest/system/identity
  'GET /rest/system/identity': (req, res) => {
    respond(res, 200, [{ name: 'CafeAzzura-Mock', '.id': '*1' }]);
  },

  // GET /rest/system/resource
  'GET /rest/system/resource': (req, res) => {
    respond(res, 200, [{
      'cpu-load': '2',
      'free-memory': '2147483648',
      'total-memory': '4294967296',
      'version': '7.23.2 (mock)',
      'uptime': '1d2h30m15s',
    }]);
  },
};

function parseRoute(method, path) {
  const key = `${method} ${path}`;
  // exact match first
  if (routes[key]) return routes[key];
  // try normalized path (remove trailing /)
  const normalized = path.replace(/\/+$/, '');
  if (routes[`${method} ${normalized}`]) return routes[`${method} ${normalized}`];
  // try without /rest prefix
  if (path.startsWith('/rest/')) {
    const inner = `${method} ${path}`;
    if (routes[inner]) return routes[inner];
  }
  return null;
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const path = parsed.pathname;

  // Handle both /rest/... and direct paths
  const route = parseRoute(req.method, path);

  if (!route) {
    console.log(`[Mock] 404 ${req.method} ${path}`);
    return respond(res, 404, { error: `Not found: ${path}`, detail: 'Mock RouterOS' });
  }

  const auth = basicAuth(req.headers);
  if (!auth) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="RouterOS REST API"',
      'Content-Type': 'application/json',
    });
    return res.end(JSON.stringify({ error: 'Authorization required', detail: 'Mock' }));
  }

  console.log(`[Mock] ${req.method} ${path} — auth: ${auth.user}`);
  route(req, res);
});

const PORT = 8780;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🧪 MikroTik REST API Mock Server`);
  console.log(`   Listening on http://0.0.0.0:${PORT}/rest/`);
  console.log(`   Auth: admin / (empty password)`);
  console.log(`   Users created will be stored in memory\n`);
});
