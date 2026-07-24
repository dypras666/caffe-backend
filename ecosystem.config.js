require('dotenv').config();

module.exports = {
  apps: [{
    name: 'cafe-backend',
    script: 'server.js',
    cwd: '/opt/cafe-backend',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '400M',
    // Load env from .env file — path relative to cwd
    env_file: '.env',
    env: {
      NODE_ENV: 'production',
    },
    error_file: '/root/.pm2/logs/cafe-backend-error.log',
    out_file: '/root/.pm2/logs/cafe-backend-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    // Rotate logs agar disk tidak penuh
    max_size: '10M',
    retain: 2,
  }],
};
