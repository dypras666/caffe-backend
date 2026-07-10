const axios = require('axios');
const db = require('../../config/database');

async function getMikrotikConfig() {
  const [rows] = await db.query(
    "SELECT config FROM external_integrations WHERE provider = 'mikrotik_radius' AND status = 'active' LIMIT 1"
  );
  if (!rows[0]) throw new Error('MikroTik integration not found or inactive');
  const config = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
  return config;
}

function getClient(config) {
  const protocol = config.use_ssl ? 'https' : 'http';
  const port = config.api_port || 80;
  const baseUrl = `${protocol}://${config.host}:${port}`;
  const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
  return axios.create({
    baseURL: `${baseUrl}/rest`,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });
}

async function proxyGet(path) {
  const config = await getMikrotikConfig();
  const client = getClient(config);
  const res = await client.get(path);
  return res.data;
}

async function proxyPut(path, data) {
  const config = await getMikrotikConfig();
  const client = getClient(config);
  const res = await client.put(path, data);
  return res.data;
}

async function proxyPatch(path, data) {
  const config = await getMikrotikConfig();
  const client = getClient(config);
  const res = await client.patch(path, data);
  return res.data;
}

async function proxyDelete(path) {
  const config = await getMikrotikConfig();
  const client = getClient(config);
  const res = await client.delete(path);
  return res.data;
}

async function proxyPost(path, data) {
  const config = await getMikrotikConfig();
  const client = getClient(config);
  const res = await client.post(path, data);
  return res.data;
}

module.exports = {
  getMikrotikConfig,
  getClient,
  proxyGet,
  proxyPut,
  proxyPatch,
  proxyDelete,
  proxyPost,
};
