const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

code = code.replace(
  /app\.use\('\/admin', express\.static\(path\.join\(publicDir, 'admin'\)\)\);\s*app\.use\('\/assets', express\.static\(path\.join\(publicDir, 'admin\/assets'\)\)\);\s*\/\/ Cafe Kasir web app\s*app\.use\('\/kasir', express\.static\(path\.join\(publicDir, 'kasir'\)\)\);/,
  "app.use('/admin', express.static(path.join(publicDir, 'admin')));\napp.use('/kasir', express.static(path.join(publicDir, 'kasir')));\napp.use('/assets', express.static(path.join(publicDir, 'assets')));\napp.use('/assets', express.static(path.join(publicDir, 'admin/assets')));\napp.use('/assets', express.static(path.join(publicDir, 'kasir/assets')));"
);

fs.writeFileSync('server.js', code);
