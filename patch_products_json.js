const fs = require('fs');
let code = fs.readFileSync('/Users/azzura/development/cafe-backend/routes/products.js', 'utf8');
code = code.replace(
  'try { pIds = typeof v.applicable_products === \\'string\\' ? JSON.parse(v.applicable_products) : v.applicable_products; } catch(e){}',
  `let parsed = v.applicable_products;
              try {
                while (typeof parsed === 'string') {
                  parsed = JSON.parse(parsed);
                }
                pIds = Array.isArray(parsed) ? parsed : [];
              } catch(e) {
                pIds = [];
              }`
);
fs.writeFileSync('/Users/azzura/development/cafe-backend/routes/products.js', code);
