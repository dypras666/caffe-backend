/**
 * Catalog & Operational Seeder
 * Seeds: Categories, Products, Rooms, Tables, and default Shifts
 * Idempotent — safe to run multiple times
 */
require('dotenv').config();
const db = require('../../config/database');

async function seedCatalog() {
  console.log('🌱 Starting Catalog & Operational Seeding...\n');

  try {
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 1. CATEGORIES
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('📁 Seeding Categories...');
    const categories = [
      { name: 'Kopi',            slug: 'kopi',        description: 'Minuman kopi panas & dingin', display_order: 1 },
      { name: 'Non-Kopi',        slug: 'non-kopi',    description: 'Minuman non-kopi seperti teh, cokelat', display_order: 2 },
      { name: 'Makanan Ringan',  slug: 'makanan-ringan', description: 'Cemilan ringan & pastry', display_order: 3 },
      { name: 'Makanan Berat',   slug: 'makanan-berat', description: 'Nasi, mie, & menu utama', display_order: 4 },
      { name: 'Minuman Segar',   slug: 'minuman-segar', description: 'Jus, smoothie, & minuman dingin', display_order: 5 },
      { name: 'Promo',           slug: 'promo',       description: 'Menu spesial & promo', display_order: 6 },
    ];
    for (const cat of categories) {
      await db.query(
        `INSERT IGNORE INTO categories (name, slug, description, display_order, status, is_active)
         VALUES (?, ?, ?, ?, 'active', 1)`,
        [cat.name, cat.slug, cat.description, cat.display_order]
      );
    }
    console.log(`✅ Created ${categories.length} categories\n`);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 2. PRODUCTS
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('☕ Seeding Products...');
    const [catRows] = await db.query('SELECT id, slug FROM categories');
    const catMap = Object.fromEntries(catRows.map(r => [r.slug, r.id]));

    const products = [
      // ── Kopi ──
      { name: 'Espresso',            slug: 'espresso',          cat: 'kopi', price: 25000, desc: 'Espresso murni 30ml' },
      { name: 'Espresso Doppio',     slug: 'espresso-doppio',   cat: 'kopi', price: 35000, desc: 'Double espresso 60ml' },
      { name: 'Cafe Latte',          slug: 'cafe-latte',        cat: 'kopi', price: 35000, desc: 'Espresso + steamed milk' },
      { name: 'Cappuccino',          slug: 'cappuccino',        cat: 'kopi', price: 35000, desc: 'Espresso + steamed milk + foam' },
      { name: 'Americano',           slug: 'americano',         cat: 'kopi', price: 30000, desc: 'Espresso + air panas' },
      { name: 'Mocha',               slug: 'mocha',             cat: 'kopi', price: 40000, desc: 'Espresso + cokelat + steamed milk' },
      { name: 'Flat White',          slug: 'flat-white',        cat: 'kopi', price: 38000, desc: 'Ristretto + microfoam' },
      { name: 'Kopi Susu Gula Aren', slug: 'kopi-susu-aren',    cat: 'kopi', price: 32000, desc: 'Kopi susu dengan gula aren asli' },
      { name: 'Vietnam Drip',        slug: 'vietnam-drip',      cat: 'kopi', price: 28000, desc: 'Vietnamese drip dengan susu kental manis' },
      { name: 'Cold Brew',           slug: 'cold-brew',         cat: 'kopi', price: 35000, desc: 'Cold brew 12 jam' },
      { name: 'Affogato',            slug: 'affogato',          cat: 'kopi', price: 38000, desc: 'Espresso di atas es krim vanila' },
      { name: 'Kopi Tarik',          slug: 'kopi-tarik',        cat: 'kopi', price: 30000, desc: 'Pulled coffee khas Malaysia' },

      // ── Non-Kopi ──
      { name: 'Chocolate',           slug: 'chocolate',         cat: 'non-kopi', price: 30000, desc: 'Minuman cokelat panas/dingin' },
      { name: 'Matcha Latte',        slug: 'matcha-latte',      cat: 'non-kopi', price: 35000, desc: 'Matcha premium + steamed milk' },
      { name: 'Teh Tarik',           slug: 'teh-tarik',         cat: 'non-kopi', price: 25000, desc: 'Teh susu tarik khas' },
      { name: 'Earl Grey',           slug: 'earl-grey',         cat: 'non-kopi', price: 22000, desc: 'Teh Earl Grey panas/dingin' },
      { name: 'Green Tea',           slug: 'green-tea',         cat: 'non-kopi', price: 20000, desc: 'Teh hijau Jepang' },
      { name: 'Bandrek',             slug: 'bandrek',           cat: 'non-kopi', price: 25000, desc: 'Minuman jahe tradisional Sunda' },
      { name: 'Wedang Uwuh',         slug: 'wedang-uwuh',       cat: 'non-kopi', price: 28000, desc: 'Wedang rempah khas Imogiri' },

      // ── Makanan Ringan ──
      { name: 'Croissant',           slug: 'croissant',         cat: 'makanan-ringan', price: 20000, desc: 'Croissant butter panggang' },
      { name: 'Banana Bread',        slug: 'banana-bread',      cat: 'makanan-ringan', price: 22000, desc: 'Roti pisang homemade' },
      { name: 'Cheese Cake',         slug: 'cheese-cake',       cat: 'makanan-ringan', price: 35000, desc: 'New York style cheese cake' },
      { name: 'Tiramisu',            slug: 'tiramisu',          cat: 'makanan-ringan', price: 38000, desc: 'Tiramisu klasik Italia' },
      { name: 'Pisang Goreng',       slug: 'pisang-goreng',     cat: 'makanan-ringan', price: 18000, desc: 'Pisang goreng crispy + topping' },
      { name: 'French Fries',        slug: 'french-fries',      cat: 'makanan-ringan', price: 22000, desc: 'Kentang goreng dengan saus' },
      { name: 'Nachos',              slug: 'nachos',            cat: 'makanan-ringan', price: 28000, desc: 'Nachos dengan cheese sauce & salsa' },
      { name: 'Spring Roll',         slug: 'spring-roll',       cat: 'makanan-ringan', price: 25000, desc: 'Lumpia isi sayuran & udang' },

      // ── Makanan Berat ──
      { name: 'Nasi Goreng',         slug: 'nasi-goreng',       cat: 'makanan-berat', price: 35000, desc: 'Nasi goreng dengan telur & ayam' },
      { name: 'Mie Goreng',          slug: 'mie-goreng',        cat: 'makanan-berat', price: 32000, desc: 'Mie goreng spesial' },
      { name: 'Chicken Katsu',       slug: 'chicken-katsu',     cat: 'makanan-berat', price: 38000, desc: 'Ayam katsu dengan nasi & salad' },
      { name: 'Beef Bowl',           slug: 'beef-bowl',         cat: 'makanan-berat', price: 42000, desc: 'Beef teriyaki bowl dengan nasi' },
      { name: 'Spaghetti Bolognese', slug: 'spaghetti-bolognese', cat: 'makanan-berat', price: 38000, desc: 'Spaghetti dengan saus daging sapi' },
      { name: 'Sandwich',            slug: 'sandwich',          cat: 'makanan-berat', price: 30000, desc: 'Sandwich roti gandum isi ayam & sayur' },
      { name: 'Burger',              slug: 'burger',            cat: 'makanan-berat', price: 35000, desc: 'Beef burger dengan kentang goreng' },
      { name: 'Salad Bowl',          slug: 'salad-bowl',        cat: 'makanan-berat', price: 32000, desc: 'Salad segar dengan dressing pilihan' },

      // ── Minuman Segar ──
      { name: 'Jus Jeruk',           slug: 'jus-jeruk',         cat: 'minuman-segar', price: 25000, desc: 'Jus jeruk segar peras' },
      { name: 'Jus Alpukat',         slug: 'jus-alpukat',       cat: 'minuman-segar', price: 30000, desc: 'Jus alpukat dengan susu cokelat' },
      { name: 'Smoothie Berry',      slug: 'smoothie-berry',    cat: 'minuman-segar', price: 35000, desc: 'Smoothie campuran berry & yogurt' },
      { name: 'Es Kelapa Muda',      slug: 'es-kelapa-muda',    cat: 'minuman-segar', price: 25000, desc: 'Es kelapa muda segar' },
      { name: 'Lemon Tea',           slug: 'lemon-tea',         cat: 'minuman-segar', price: 20000, desc: 'Teh lemon segar dengan es' },
      { name: 'Mocktail Mojito',     slug: 'mocktail-mojito',   cat: 'minuman-segar', price: 35000, desc: 'Mocktail mojito non-alkohol' },

      // ── Promo ──
      { name: 'Paket Sarapan',       slug: 'paket-sarapan',     cat: 'promo', price: 45000, desc: 'Nasi goreng + kopi/teh' },
      { name: 'Paket Ngopi',         slug: 'paket-ngopi',       cat: 'promo', price: 50000, desc: 'Coffe 2 + pisang goreng' },
      { name: 'Paket Nongkrong',     slug: 'paket-nongkrong',   cat: 'promo', price: 65000, desc: 'Mie goreng + kopi + pisang goreng' },
    ];

    for (const p of products) {
      const catId = catMap[p.cat];
      if (!catId) {
        console.warn(`   ⚠ Category "${p.cat}" not found, skipping "${p.name}"`);
        continue;
      }
      await db.query(
        `INSERT IGNORE INTO products (name, category_id, price, description, is_available, status)
         VALUES (?, ?, ?, ?, 1, 'active')`,
        [p.name, catId, p.price, p.desc || null]
      );
    }
    console.log(`✅ Created ${products.length} products\n`);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 3. ROOMS
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('🚪 Seeding Rooms...');
    const rooms = [
      { name: 'Indoor',         description: 'Area dalam ruangan ber-AC',     capacity: 30 },
      { name: 'Outdoor',        description: 'Area luar ruangan (smoking)',   capacity: 20 },
      { name: 'VIP Room',       description: 'Ruang VIP untuk 6-8 orang',     capacity: 8 },
      { name: 'Terrace',        description: 'Area teras depan',              capacity: 15 },
    ];
    await db.query('DELETE FROM rooms WHERE name IN (?)', [rooms.map(r => r.name)]);
    for (const r of rooms) {
      await db.query(
        'INSERT INTO rooms (name, description, capacity, is_active, sort_order) VALUES (?, ?, ?, 1, ?)',
        [r.name, r.description, r.capacity, rooms.indexOf(r) + 1]
      );
    }
    console.log(`✅ Created ${rooms.length} rooms\n`);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 4. TABLES
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('🪑 Seeding Tables...');
    const [roomRows] = await db.query('SELECT id, name FROM rooms');
    const roomMap = Object.fromEntries(roomRows.map(r => [r.name, r.id]));

    const tableDefs = [
      // Indoor: 8 meja
      { num: 1,  cap: 2, room: 'Indoor' },
      { num: 2,  cap: 2, room: 'Indoor' },
      { num: 3,  cap: 4, room: 'Indoor' },
      { num: 4,  cap: 4, room: 'Indoor' },
      { num: 5,  cap: 4, room: 'Indoor' },
      { num: 6,  cap: 6, room: 'Indoor' },
      { num: 7,  cap: 6, room: 'Indoor' },
      { num: 8,  cap: 2, room: 'Indoor' },
      // Outdoor: 6 meja
      { num: 9,  cap: 2, room: 'Outdoor' },
      { num: 10, cap: 4, room: 'Outdoor' },
      { num: 11, cap: 4, room: 'Outdoor' },
      { num: 12, cap: 4, room: 'Outdoor' },
      { num: 13, cap: 2, room: 'Outdoor' },
      { num: 14, cap: 6, room: 'Outdoor' },
      // VIP Room: 2 meja
      { num: 15, cap: 6, room: 'VIP Room' },
      { num: 16, cap: 8, room: 'VIP Room' },
      // Terrace: 4 meja
      { num: 17, cap: 2, room: 'Terrace' },
      { num: 18, cap: 4, room: 'Terrace' },
      { num: 19, cap: 4, room: 'Terrace' },
      { num: 20, cap: 2, room: 'Terrace' },
    ];

    for (const t of tableDefs) {
      await db.query(
        `INSERT IGNORE INTO tables (number, capacity, status, room_id, is_active, branch_id, sort_order)
         VALUES (?, ?, 'available', ?, 1, 1, ?)`,
        [t.num, t.cap, roomMap[t.room], t.num]
      );
    }
    console.log(`✅ Created ${tableDefs.length} tables\n`);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 5. DEFAULT SHIFT TEMPLATES
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('⏰ Seeding Shift Templates...');
    const shiftTemplates = [
      { name: 'Shift Pagi',   start: '07:00:00', end: '15:00:00' },
      { name: 'Shift Siang',  start: '14:00:00', end: '22:00:00' },
      { name: 'Shift Full',   start: '08:00:00', end: '17:00:00' },
    ];
    for (const s of shiftTemplates) {
      await db.query(
        `INSERT IGNORE INTO system_settings (setting_key, setting_value, setting_type, setting_group, label, sort_order)
         VALUES (?, ?, 'text', 'shifts', ?, ?)`,
        [`shift_template_${s.name.toLowerCase().replace(/\s+/g, '_')}`, JSON.stringify(s), `Template ${s.name}`, shiftTemplates.indexOf(s) + 1]
      );
    }
    console.log(`✅ Created ${shiftTemplates.length} shift templates\n`);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // SUMMARY
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    console.log('📋 Seeding Complete!\n');
    const counts = await Promise.all([
      db.query('SELECT COUNT(*) AS c FROM categories'),
      db.query('SELECT COUNT(*) AS c FROM products'),
      db.query('SELECT COUNT(*) AS c FROM rooms'),
      db.query('SELECT COUNT(*) AS c FROM tables'),
      db.query('SELECT COUNT(*) AS c FROM payment_methods'),
    ]);
    console.log(`  Categories     : ${counts[0][0][0].c}`);
    console.log(`  Products       : ${counts[1][0][0].c}`);
    console.log(`  Rooms          : ${counts[2][0][0].c}`);
    console.log(`  Tables         : ${counts[3][0][0].c}`);
    console.log(`  Payment Methods: ${counts[4][0][0].c}`);
    console.log('');

  } catch (err) {
    console.error('❌ Seeder error:', err);
    throw err;
  }
}

if (require.main === module) {
  seedCatalog()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { seedCatalog };
