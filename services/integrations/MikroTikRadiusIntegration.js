const axios = require('axios');
const BaseIntegration = require('./BaseIntegration');
const db = require('../../config/database');

class MikroTikRadiusIntegration extends BaseIntegration {
  async execute(event, payload) {
    const { referenceType, referenceId, customer } = payload;

    const settings = await this.getSettings();
    const password = this.generatePassword(parseInt(settings.wifi_password_length) || 8);
    const username = this.generateUsername('wifi-', referenceId);
    const ssid = settings.wifi_ssid || 'Cafe-Azzura-WiFi';
    const durationHours = parseInt(settings.wifi_credential_duration_hours) || 4;

    const validFrom = new Date();
    const validUntil = new Date(validFrom.getTime() + durationHours * 60 * 60 * 1000);

    const requestData = {
      username,
      password,
      ssid,
      comment: `${referenceType}#${referenceId} - ${customer.name}`,
      valid_from: validFrom.toISOString(),
      valid_until: validUntil.toISOString(),
      profile: this.config.profile || 'default',
    };

    const startTime = Date.now();
    let responseData = null;
    let status = 'success';
    let errorMessage = null;

    try {
      if (this.config.connection_type === 'rest') {
        responseData = await this.createViaRestAPI(requestData);
      } else if (this.config.connection_type === 'ssh') {
        responseData = await this.createViaSSH(requestData);
      } else {
        responseData = await this.createViaRestAPI(requestData);
      }

      await db.query(
        `INSERT INTO wifi_credentials
          (booking_id, order_id, integration_id, username, password, ssid, valid_from, valid_until, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [
          referenceType === 'booking' ? referenceId : null,
          referenceType === 'order' ? referenceId : null,
          this.id,
          username,
          password,
          ssid,
          validFrom,
          validUntil,
        ]
      );
    } catch (error) {
      status = 'failed';
      errorMessage = error.message;
    }

    const durationMs = Date.now() - startTime;

    await this.log(event, referenceType, referenceId, requestData, responseData, status, errorMessage, durationMs);
    await this.updateLastRun(status);

    return { success: status === 'success', username, password, ssid, validFrom, validUntil };
  }

  async getSettings() {
    const [rows] = await db.query(
      "SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('wifi_ssid', 'wifi_credential_duration_hours', 'wifi_password_length')"
    );
    const settings = {};
    for (const row of rows) {
      settings[row.setting_key] = row.setting_value;
    }
    return settings;
  }

  async createViaRestAPI(data) {
    const { host, api_port, username, password, use_ssl } = this.config;
    const protocol = use_ssl ? 'https' : 'http';
    const baseUrl = `${protocol}://${host}:${api_port || 80}`;

    const mikrotikUser = Buffer.from(`${username}:${password}`).toString('base64');

    const userPayload = {
      name: data.username,
      password: data.password,
      profile: data.profile,
      comment: data.comment,
      'limit-uptime': `${Math.ceil((new Date(data.valid_until) - new Date(data.valid_from)) / 60000)}m`,
    };

    const response = await axios.put(`${baseUrl}/rest/ip/hotspot/user`, userPayload, {
      headers: {
        Authorization: `Basic ${mikrotikUser}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    return { mikrotik_response: response.data };
  }

  async createViaSSH(data) {
    let NodeSSH;
    try {
      NodeSSH = require('node-ssh').NodeSSH;
    } catch {
      throw new Error('Paket "node-ssh" belum terinstall. Jalankan: npm install node-ssh');
    }
    const ssh = new NodeSSH();

    try {
      await ssh.connect({
        host: this.config.host,
        port: parseInt(this.config.ssh_port) || 22,
        username: this.config.username,
        password: this.config.password,
        timeout: 10000,
      });

      const commands = [
        `/ip/hotspot/user add name="${data.username}" password="${data.password}" profile="${data.profile}" comment="${data.comment}" limit-uptime=${Math.ceil((new Date(data.valid_until) - new Date(data.valid_from)) / 60000)}m`,
      ];

      const results = [];
      for (const cmd of commands) {
        const result = await ssh.execCommand(cmd);
        results.push({ command: cmd, stdout: result.stdout, stderr: result.stderr });
      }

      return { ssh_results: results };
    } finally {
      ssh.dispose();
    }
  }

  validateConfig(config) {
    const errors = [];
    if (!config.host) errors.push('Host MikroTik wajib diisi');
    if (!config.username) errors.push('Username MikroTik wajib diisi');
    if (!config.password) errors.push('Password MikroTik wajib diisi');
    if (!config.connection_type) errors.push('Tipe koneksi (rest/ssh) wajib dipilih');
    if (config.connection_type === 'ssh' && !config.ssh_port) {
      errors.push('Port SSH wajib diisi untuk koneksi SSH');
    }
    return { valid: errors.length === 0, errors };
  }

  getConfigSchema() {
    return [
      { key: 'connection_type', label: 'Tipe Koneksi', type: 'select', options: [
        { value: 'rest', label: 'REST API (RouterOS v7+)' },
        { value: 'ssh', label: 'SSH (RouterOS v6/v7)' },
      ], required: true },
      { key: 'host', label: 'Host/IP MikroTik', type: 'text', placeholder: '192.168.88.1', required: true },
      { key: 'api_port', label: 'Port API (REST)', type: 'number', placeholder: '80', required: false },
      { key: 'ssh_port', label: 'Port SSH', type: 'number', placeholder: '22', required: false },
      { key: 'use_ssl', label: 'Gunakan HTTPS', type: 'boolean', required: false },
      { key: 'username', label: 'Username Login', type: 'text', required: true },
      { key: 'password', label: 'Password Login', type: 'password', required: true },
      { key: 'profile', label: 'Profile Hotspot', type: 'text', placeholder: 'default', required: false },
    ];
  }
}

module.exports = MikroTikRadiusIntegration;
