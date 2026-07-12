const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

class StorageService {
  constructor() {
    this.localBasePath = path.join(__dirname, '..', 'uploads');
    this._init();
  }

  _init() {
    // Config exclusively from env — never from DB
    this.driver = (process.env.STORAGE_DRIVER || 'local').toLowerCase();

    if (this.driver === 's3') {
      const { S3Client } = require('@aws-sdk/client-s3');
      this.s3Client = new S3Client({
        region: process.env.STORAGE_S3_REGION || 'us-east-1',
        endpoint: process.env.STORAGE_S3_ENDPOINT || undefined,
        credentials: {
          accessKeyId: process.env.STORAGE_S3_KEY || '',
          secretAccessKey: process.env.STORAGE_S3_SECRET || '',
        },
        forcePathStyle: !!process.env.STORAGE_S3_ENDPOINT,
      });
      this.s3Bucket = process.env.STORAGE_S3_BUCKET || 'uploads';
      this.s3BaseUrl = process.env.STORAGE_S3_URL || '';
    } else {
      this.s3Client = null;
      this.s3Bucket = null;
      this.s3BaseUrl = null;
      if (!fs.existsSync(this.localBasePath)) {
        fs.mkdirSync(this.localBasePath, { recursive: true });
      }
    }
  }

  // kept for backward compat — now a no-op
  async loadConfig() {}

  async save(filename, buffer, contentType) {

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
