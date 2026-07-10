# Database Seeders

Collection of database seeders for Café Azzura backend.

## Available Seeders

### 1. HR Module Seeder (`hr-seeder.js`)

Seeds complete HR module data for testing and development.

**What it seeds:**
- 4 Work Shifts (Pagi, Siang, Malam, Full)
- 10 Employees (across Dapur, Service, Bar, Kasir departments)
- ~215 Attendance records (last 30 days)
- 30 Payroll records (last 3 months)

**Usage:**
```bash
# Run directly
node database/seeders/hr-seeder.js

# Or via npm script (if configured)
npm run seed:hr
```

**Features:**
- ✅ Idempotent (can run multiple times)
- ✅ Auto-cleanup before seeding
- ✅ Handles FK constraints properly
- ✅ Realistic random data
- ✅ Shows sample output after seeding

**Output:**
```
✅ HR Module enabled
✅ Created 4 work shifts
✅ Created 10 employees
✅ Created 215 attendance records
✅ Created 30 payroll records
```

**Data Details:**

**Employees:**
- EMP-001: Budi Santoso (Head Chef) - Rp 6,000,000
- EMP-002: Siti Nurhaliza (Sous Chef) - Rp 4,500,000
- EMP-003: Ahmad Hidayat (Cook) - Rp 3,500,000
- EMP-004: Dewi Kartika (Head Waiter) - Rp 4,000,000
- EMP-005: Rina Marlina (Waiter) - Rp 3,200,000
- EMP-006: Joko Widodo (Waiter PT) - Rp 2,000,000
- EMP-007: Maya Puspita (Head Barista) - Rp 4,500,000
- EMP-008: Andi Pratama (Barista) - Rp 3,500,000
- EMP-009: Linda Wijaya (Barista PT) - Rp 2,200,000
- EMP-010: Rudi Hartono (Cashier) - Rp 3,000,000

**Shifts:**
- Shift Pagi: 07:00 - 15:00 (Break: 60min)
- Shift Siang: 11:00 - 19:00 (Break: 60min)
- Shift Malam: 15:00 - 23:00 (Break: 60min)
- Shift Full: 09:00 - 18:00 (Break: 60min)

---

## Creating New Seeders

### Template Structure

```javascript
const db = require('../../config/database');

async function seedModuleName() {
  console.log('🌱 Starting Module Seeding...\n');

  try {
    // 1. Cleanup existing data
    await db.query('DELETE FROM table WHERE condition');

    // 2. Seed data
    const data = [/* your data */];
    for (const item of data) {
      await db.query('INSERT INTO table (...) VALUES (...)', [params]);
    }

    // 3. Show summary
    console.log('✅ Seeding Complete!');

  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  seedModuleName()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { seedModuleName };
```

### Best Practices

1. **Idempotent**: Always cleanup before seeding
2. **FK Constraints**: Delete in correct order (children first)
3. **Error Handling**: Use try-catch and proper error messages
4. **Output**: Show progress and summary
5. **Realistic Data**: Use random variance where appropriate
6. **Comments**: Document what each section does
7. **Module Export**: Export function for reuse

### Naming Convention

- File: `{module-name}-seeder.js` (lowercase, kebab-case)
- Function: `seed{ModuleName}()` (camelCase)
- Example: `product-seeder.js` → `seedProducts()`

---

## Running All Seeders

Create a master seeder to run all:

```javascript
// master-seeder.js
const { seedHR } = require('./hr-seeder');
const { seedProducts } = require('./product-seeder');

async function seedAll() {
  await seedHR();
  await seedProducts();
  // Add more seeders here
}

if (require.main === module) {
  seedAll()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
```

---

## Cleanup Scripts

### Clean All HR Data
```bash
# Via SQL
mysql -u root -p cafe_azzura << EOF
DELETE FROM payroll WHERE employee_id IN (SELECT id FROM employees WHERE employee_code LIKE 'EMP-%');
DELETE FROM attendance WHERE employee_id IN (SELECT id FROM employees WHERE employee_code LIKE 'EMP-%');
DELETE FROM employees WHERE employee_code LIKE 'EMP-%';
DELETE FROM work_shifts WHERE shift_name LIKE 'Shift %';
EOF
```

### Clean All Test Data
```bash
# Run cleanup script (if exists)
node database/seeders/cleanup.js
```

---

## Testing Seeders

Always test seeders before committing:

1. **Test Fresh Seed**:
   ```bash
   node database/seeders/hr-seeder.js
   ```

2. **Test Re-seed** (idempotency):
   ```bash
   node database/seeders/hr-seeder.js
   node database/seeders/hr-seeder.js  # Should work without errors
   ```

3. **Verify Data**:
   ```sql
   SELECT COUNT(*) FROM employees WHERE employee_code LIKE 'EMP-%';
   SELECT COUNT(*) FROM attendance;
   SELECT COUNT(*) FROM payroll;
   ```

4. **Test Cleanup**:
   ```bash
   # Cleanup should be automatic on next run
   ```

---

## NPM Scripts (Optional)

Add to `package.json`:

```json
{
  "scripts": {
    "seed:hr": "node database/seeders/hr-seeder.js",
    "seed:all": "node database/seeders/master-seeder.js",
    "seed:clean": "node database/seeders/cleanup.js"
  }
}
```

Usage:
```bash
npm run seed:hr
npm run seed:all
```

---

## Common Issues

### Foreign Key Constraint Errors

**Problem**: `Cannot delete or update a parent row`

**Solution**: Delete child records first:
```javascript
// Wrong order
await db.query('DELETE FROM employees');
await db.query('DELETE FROM attendance');  // Fails!

// Correct order
await db.query('DELETE FROM attendance');
await db.query('DELETE FROM employees');
```

### Duplicate Entry Errors

**Problem**: `Duplicate entry for key 'employee_code'`

**Solution**: Always cleanup before seeding:
```javascript
// Get existing IDs first
const [existing] = await db.query('SELECT id FROM employees WHERE employee_code LIKE "EMP-%"');
if (existing.length > 0) {
  const ids = existing.map(e => e.id);
  // Delete related records
  await db.query('DELETE FROM attendance WHERE employee_id IN (?)', [ids]);
  // Then delete employees
  await db.query('DELETE FROM employees WHERE id IN (?)', [ids]);
}
```

### Unknown Column Errors

**Problem**: `Unknown column 'email' in 'INSERT INTO'`

**Solution**: Check actual table structure:
```bash
# View table structure
mysql -u root -p -e "DESCRIBE employees" cafe_azzura

# Or check CREATE TABLE in schema.sql
grep -A20 "CREATE TABLE employees" database/schema.sql
```

---

## Contributing

When adding new seeders:

1. Create seeder file in `database/seeders/`
2. Follow naming convention and template
3. Test fresh seed and re-seed
4. Update this README with new seeder info
5. Add cleanup instructions if needed
6. Consider adding to master seeder

---

## Related Files

- **Schema**: `database/schema.sql`
- **Routes**: `routes/*.js`
- **Tests**: `__tests__/*.test.js`
- **Config**: `config/database.js`

---

**Last Updated**: July 2026
