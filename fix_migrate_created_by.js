const fs = require('fs');
let content = fs.readFileSync('database/migrate.js', 'utf8');

const newMigration = `  {
    id: '061_add_voucher_created_by',
    sql: \`
      ALTER TABLE vouchers 
        ADD COLUMN IF NOT EXISTS created_by INT DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
    \`,
  },
`;

content = content.replace("id: '059_create_booking_items',", newMigration + "  {\n    id: '059_create_booking_items',");
fs.writeFileSync('database/migrate.js', content);
