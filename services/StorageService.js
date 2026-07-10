const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

class StorageService {
  constructor() {
    this.driver = 'local';
    this.s3Client = null;
    this.s3Bucket = null;
    this.s3BaseUrl = null;
    this.localBasePath = path.join(__dirname, '..', 'uploads');
    this.loadConfig();
  }

  async loadConfig() {
    try {
      const db = require('../config/database');
      const [rows] = await db.query(
        "SELECT setting_key, setting_value FROM system_settings WHERE setting_key LIKE 'storage_%'"
      );
      const config = {};
      for (const row of rows) config[row.setting_key] = row.setting_value;

      this.driver = config.storage_driver || 'local';

      if (this.driver === 's3') {
        const { S3Client } = require('@aws-sdk/client-s3');
        this.s3Client = new S3Client({
          region: config.storage_s3_region || 'us-east-1',
          endpoint: config.storage_s3_endpoint || undefined,
          credentials: {
            accessKeyId: config.storage_s3_key || '',
            secretAccessKey: config.storage_s3_secret || '',
          },
          forcePathStyle: config.storage_s3_endpoint ? true : undefined,
        });
        this.s3Bucket = config.storage_s3_bucket || 'uploads';
        this.s3BaseUrl = config.storage_s3_url || '';
      }

      if (this.driver === 'local') {
        if (!fs.existsSync(this.localBasePath)) {
          fs.mkdirSync(this.localBasePath, { recursive: true });
        }
      }
    } catch { /* defaults */ }
  }

  async save(filename, buffer, contentType) {
    await this.loadConfig();

    if (this.driver === 's3') {
      return this.saveS3(filename, buffer, contentType);
    }
    return this.saveLocal(filename, buffer);
  }

  async saveLocal(filename, buffer) {
    const filePath = path.join(this.localBasePath, filename);
    fs.writeFileSync(filePath, buffer);
    return {
      url: `/uploads/${filename}`,
      path: `/uploads/${filename}`,
      storage_type: 'local',
    };
  }

  async saveS3(filename, buffer, contentType) {
    const { Upload } = require('@aws-sdk/lib-storage');
    const upload = new Upload({
      client: this.s3Client,
      params: {
        Bucket: this.s3Bucket,
        Key: filename,
        Body: buffer,
        ContentType: contentType || 'application/octet-stream',
        ACL: 'public-read',
      },
    });
    await upload.done();
    const baseUrl = this.s3BaseUrl || `https://${this.s3Bucket}.s3.amazonaws.com`;
    return {
      url: `${baseUrl}/${filename}`,
      path: filename,
      storage_type: 's3',
    };
  }

  async delete(filePath, storageType) {
    await this.loadConfig();
    if (storageType === 's3') {
      return this.deleteS3(filePath);
    }
    return this.deleteLocal(filePath);
  }

  async deleteLocal(filePath) {
    const absolutePath = path.join(__dirname, '..', filePath);
    try { fs.unlinkSync(absolutePath); } catch { /* ignore */ }
  }

  async deleteS3(key) {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    try {
      await this.s3Client.send(new DeleteObjectCommand({
        Bucket: this.s3Bucket,
        Key: key,
      }));
    } catch { /* ignore */ }
  }

  async getFileUrl(filePath, storageType) {
    if (!this.s3BaseUrl) await this.loadConfig();
    if (storageType === 's3') {
      const baseUrl = this.s3BaseUrl || `https://${this.s3Bucket || 'uploads'}.s3.amazonaws.com`;
      return `${baseUrl}/${filePath}`;
    }
    return filePath.startsWith('/') ? filePath : `/uploads/${filePath}`;
  }
}

const instance = new StorageService();
module.exports = instance;
