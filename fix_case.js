const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');
code = code.replace("require('./services/storageService')", "require('./services/StorageService')");
fs.writeFileSync('server.js', code);
