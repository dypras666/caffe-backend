const fs = require('fs');

function patchFile(file, match, replacement) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(match, replacement);
  fs.writeFileSync(file, content);
}

const branchesReplacement = `
    let finalBaseUrl = base_url;
    if (!finalBaseUrl || finalBaseUrl.includes('localhost:517')) {
      const [[setting]] = await db.query('SELECT setting_value FROM system_settings WHERE setting_key="qr_base_url"');
      let dbUrl = setting?.setting_value || '';
      if (!dbUrl || dbUrl.includes('localhost:517')) {
        const origin = req.headers.origin || (req.headers.host ? 'https://' + req.headers.host : '');
        if (origin) {
          finalBaseUrl = origin.replace('office-', '').replace('admin.', '');
        } else {
          finalBaseUrl = 'http://localhost:5174';
        }
      } else {
        finalBaseUrl = dbUrl;
      }
    }`;

// Note: I will just use sed or string replace directly on the whole block
