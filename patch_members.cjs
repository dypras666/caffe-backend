const fs = require('fs');
let code = fs.readFileSync('routes/members.js', 'utf8');

if (!code.includes("router.get('/orders/:id'")) {
  const insertStr = `
// GET /api/members/orders/:id — Detail pesanan milik member
router.get('/orders/:id',
  authenticate,
  param('id').isInt({ min: 1 }).withMessage('Invalid order ID'),
  async (req, res) => {
    try {
      const [orders] = await db.query(
        \`SELECT o.*, b.name AS branch_name
         FROM orders o
         LEFT JOIN branches b ON b.id = o.branch_id
         WHERE o.id = ? AND (o.customer_email = ? OR o.served_by = ?) AND o.order_status != 'deleted'\`,
        [req.params.id, req.user.email, req.user.id]
      );
      if (orders.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }
      const order = orders[0];
      
      const [items] = await db.query(
        \`SELECT oi.*, p.name AS product_name, p.image AS product_image, c.name AS category_name
         FROM order_items oi
         JOIN products p ON p.id = oi.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE oi.order_id = ?\`,
        [order.id]
      );
      
      res.json({ order: { ...order, items } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);
`;
  // Insert right before module.exports = router;
  code = code.replace('module.exports = router;', insertStr + '\nmodule.exports = router;');
  fs.writeFileSync('routes/members.js', code);
  console.log('patched');
}
