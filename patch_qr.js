const fs = require('fs');

function patchFile(file, match, replacement) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(match, replacement);
  fs.writeFileSync(file, content);
}

const branchesReplacement = `
    let finalBaseUrl = base_url;
    if (!finalBaseUrl) {
      const [[setting]] = await db.query('SELECT setting_value FROM system_settings WHERE setting_key="qr_base_url"');
      finalBaseUrl = setting?.setting_value || '';
      if (!finalBaseUrl) {
        const origin = req.headers.origin || (req.headers.host ? 'https://' + req.headers.host : '');
        if (origin) {
          finalBaseUrl = origin.replace('office-', '').replace('admin.', '');
        } else {
          finalBaseUrl = 'http://localhost:5174';
        }
      }
    }`;

patchFile('routes/branches.js', 
  /let finalBaseUrl = base_url;\n    if \(!finalBaseUrl\) {\n      const \[\[setting\]\] = await db\.query\('SELECT setting_value FROM system_settings WHERE setting_key="qr_base_url"'\);\n      finalBaseUrl = setting\?\.setting_value \|\| 'http:\/\/localhost:5174';\n    }/g, 
  branchesReplacement.trim());

const membersReplacement = `
      let baseUrl = await getSetting('member_qr_base_url', '');
      if (!baseUrl) {
        const origin = req.headers.origin || (req.headers.host ? 'https://' + req.headers.host : '');
        if (origin) {
          baseUrl = origin.replace('office-', '').replace('admin.', '');
        } else {
          baseUrl = 'http://localhost:5174';
        }
      }`;

patchFile('routes/members.js',
  /const baseUrl = await getSetting\('member_qr_base_url', 'http:\/\/localhost:5174'\);/g,
  membersReplacement.trim());

console.log("Patched backend");
