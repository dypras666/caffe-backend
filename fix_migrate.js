const fs = require('fs');
let content = fs.readFileSync('database/migrate.js', 'utf8');

const newMigration = `  {
    id: '060_add_voucher_description',
    sql: \`
      ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS description TEXT AFTER name;
    \`,
  },
`;

content = content.replace("id: '059_create_booking_items',", newMigration + "  {\n    id: '059_create_booking_items',");
fs.writeFileSync('database/migrate.js', content);
