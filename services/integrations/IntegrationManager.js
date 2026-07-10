const db = require('../../config/database');
const BaseIntegration = require('./BaseIntegration');
const MikroTikRadiusIntegration = require('./MikroTikRadiusIntegration');

const PROVIDER_MAP = {
  mikrotik_radius: MikroTikRadiusIntegration,
};

let managerInstance = null;

class IntegrationManager {
  constructor() {
    this.integrations = [];
    this.providers = { ...PROVIDER_MAP };
  }

  static getInstance() {
    if (!managerInstance) {
      managerInstance = new IntegrationManager();
    }
    return managerInstance;
  }

  registerProvider(providerSlug, ProviderClass) {
    if (!(ProviderClass.prototype instanceof BaseIntegration)) {
      throw new Error(`Provider ${providerSlug} must extend BaseIntegration`);
    }
    this.providers[providerSlug] = ProviderClass;
  }

  async loadIntegrations() {
    const [rows] = await db.query(
      "SELECT * FROM external_integrations WHERE status = 'active'"
    );
    this.integrations = rows.map((row) => {
      const ProviderClass = this.providers[row.provider];
      if (!ProviderClass) {
        console.warn(`[IntegrationManager] Unknown provider: ${row.provider} for "${row.name}"`);
        return null;
      }
      return new ProviderClass(row);
    }).filter(Boolean);
    return this.integrations;
  }

  async trigger(event, payload) {
    const matching = this.integrations.filter((int) =>
      int.triggerEvents.includes(event)
    );

    if (matching.length === 0) return [];

    matching.sort((a, b) => (a.run_order || 0) - (b.run_order || 0));

    const results = [];
    for (const integration of matching) {
      try {
        const result = await integration.execute(event, payload);
        results.push({ integration: integration.slug, success: true, data: result });
      } catch (error) {
        console.error(`[IntegrationManager] ${integration.slug} failed:`, error.message);
        results.push({ integration: integration.slug, success: false, error: error.message });
      }
    }
    return results;
  }

  async triggerEvent(event, referenceType, referenceId, customerData = {}) {
    const payload = {
      referenceType,
      referenceId,
      customer: customerData,
      event,
      timestamp: new Date().toISOString(),
    };
    return this.trigger(event, payload);
  }

  async getIntegrations() {
    const [rows] = await db.query('SELECT * FROM external_integrations ORDER BY run_order ASC');
    return rows;
  }

  async getIntegrationById(id) {
    const [rows] = await db.query('SELECT * FROM external_integrations WHERE id = ?', [id]);
    return rows[0] || null;
  }

  async createIntegration(data) {
    const ProviderClass = this.providers[data.provider];
    if (!ProviderClass) {
      throw new Error(`Provider "${data.provider}" tidak dikenal`);
    }

    const tempInstance = new ProviderClass({
      id: null,
      provider: data.provider,
      config: data.config || {},
    });
    const validation = tempInstance.validateConfig(data.config || {});
    if (!validation.valid) {
      throw new Error(`Konfigurasi tidak valid: ${validation.errors.join(', ')}`);
    }

    const [result] = await db.query(
      `INSERT INTO external_integrations (name, slug, description, provider, config, status, trigger_events, run_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.name,
        data.slug || data.name.toLowerCase().replace(/\s+/g, '-'),
        data.description || null,
        data.provider,
        data.config ? JSON.stringify(data.config) : null,
        data.status || 'inactive',
        data.trigger_events ? JSON.stringify(data.trigger_events) : null,
        data.run_order || 0,
      ]
    );

    if (data.status === 'active') {
      await this.loadIntegrations();
    }

    return result.insertId;
  }

  async updateIntegration(id, data) {
    const existing = await this.getIntegrationById(id);
    if (!existing) throw new Error('Integrasi tidak ditemukan');

    const fields = [];
    const values = [];

    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
    if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
    if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
    if (data.run_order !== undefined) { fields.push('run_order = ?'); values.push(data.run_order); }
    if (data.trigger_events !== undefined) { fields.push('trigger_events = ?'); values.push(JSON.stringify(data.trigger_events)); }
    if (data.config !== undefined) { fields.push('config = ?'); values.push(JSON.stringify(data.config)); }
    if (data.slug !== undefined) { fields.push('slug = ?'); values.push(data.slug); }

    if (fields.length === 0) throw new Error('Tidak ada data yang diupdate');

    values.push(id);
    await db.query(`UPDATE external_integrations SET ${fields.join(', ')} WHERE id = ?`, values);

    await this.loadIntegrations();
  }

  async deleteIntegration(id) {
    await db.query('DELETE FROM external_integrations WHERE id = ?', [id]);
    await this.loadIntegrations();
  }

  async testIntegration(id) {
    const integration = await this.getIntegrationById(id);
    if (!integration) throw new Error('Integrasi tidak ditemukan');

    const ProviderClass = this.providers[integration.provider];
    if (!ProviderClass) throw new Error(`Provider "${integration.provider}" tidak dikenal`);

    const instance = new ProviderClass(integration);
    const testPayload = {
      referenceType: 'test',
      referenceId: 0,
      customer: { name: 'Test User', email: 'test@example.com', phone: '08123456789' },
      event: 'test',
      timestamp: new Date().toISOString(),
    };

    return instance.execute('test', testPayload);
  }

  getAvailableProviders() {
    return Object.entries(PROVIDER_MAP).map(([slug, ProviderClass]) => {
      const tempInstance = new ProviderClass({
        id: null, provider: slug, config: {},
      });
      return {
        slug,
        name: slug.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        config_schema: tempInstance.getConfigSchema(),
        supported_events: [
          { event: 'booking.confirmed', label: 'Booking Dikonfirmasi' },
          { event: 'booking.completed', label: 'Booking Selesai' },
          { event: 'order.completed', label: 'Pesanan Selesai' },
          { event: 'order.paid', label: 'Pesanan Dibayar' },
        ],
      };
    });
  }

  async getLogs(filters = {}) {
    let query = 'SELECT l.*, i.name AS integration_name FROM integration_logs l LEFT JOIN external_integrations i ON i.id = l.integration_id WHERE 1=1';
    const params = [];

    if (filters.integration_id) { query += ' AND l.integration_id = ?'; params.push(filters.integration_id); }
    if (filters.status) { query += ' AND l.status = ?'; params.push(filters.status); }
    if (filters.reference_type) { query += ' AND l.reference_type = ?'; params.push(filters.reference_type); }
    if (filters.reference_id) { query += ' AND l.reference_id = ?'; params.push(filters.reference_id); }

    query += ' ORDER BY l.created_at DESC LIMIT 100';
    const [rows] = await db.query(query, params);
    return rows;
  }

  async getWiFiCredentials(filters = {}) {
    let query = 'SELECT w.*, i.name AS integration_name FROM wifi_credentials w LEFT JOIN external_integrations i ON i.id = w.integration_id WHERE 1=1';
    const params = [];

    if (filters.booking_id) { query += ' AND w.booking_id = ?'; params.push(filters.booking_id); }
    if (filters.order_id) { query += ' AND w.order_id = ?'; params.push(filters.order_id); }
    if (filters.status) { query += ' AND w.status = ?'; params.push(filters.status); }

    query += ' ORDER BY w.created_at DESC';
    const [rows] = await db.query(query, params);
    return rows;
  }
}

module.exports = IntegrationManager;
