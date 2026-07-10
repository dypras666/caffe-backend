const crypto = require('crypto');
const db = require('../../config/database');

class BaseIntegration {
  constructor(integration) {
    this.id = integration.id;
    this.name = integration.name;
    this.slug = integration.slug;
    this.provider = integration.provider;
    this.config = typeof integration.config === 'string'
      ? JSON.parse(integration.config)
      : (integration.config || {});
    this.triggerEvents = typeof integration.trigger_events === 'string'
      ? JSON.parse(integration.trigger_events)
      : (integration.trigger_events || []);
  }

  async execute(event, payload) {
    throw new Error(`Provider ${this.provider} must implement execute()`);
  }

  validateConfig(config) {
    throw new Error(`Provider ${this.provider} must implement validateConfig()`);
  }

  getConfigSchema() {
    throw new Error(`Provider ${this.provider} must implement getConfigSchema()`);
  }

  generatePassword(length = 8) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let password = '';
    for (let i = 0; i < length; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }

  generateUsername(prefix, identifier) {
    const suffix = identifier.toString().slice(-6);
    return `${prefix}${suffix}`;
  }

  async log(event, referenceType, referenceId, requestData, responseData, status, errorMessage, durationMs) {
    await db.query(
      `INSERT INTO integration_logs
        (integration_id, trigger_event, reference_type, reference_id,
         request_data, response_data, status, error_message, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.id,
        event || null,
        referenceType,
        referenceId,
        requestData ? JSON.stringify(requestData) : null,
        responseData ? JSON.stringify(responseData) : null,
        status,
        errorMessage || null,
        durationMs || null,
      ]
    );
  }

  async updateLastRun(status) {
    await db.query(
      'UPDATE external_integrations SET last_run_at = NOW(), last_run_status = ? WHERE id = ?',
      [status, this.id]
    );
  }
}

module.exports = BaseIntegration;
