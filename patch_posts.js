const fs = require('fs');
let code = fs.readFileSync('routes/posts.js', 'utf8');

// Change GET
code = code.replace(
  /'SELECT \* FROM post_galleries WHERE post_id = \? ORDER BY sort_order'/g,
  "'SELECT id, post_id, url AS image_url, sort_order FROM post_galleries WHERE post_id = ? ORDER BY sort_order'"
);

// Change POST insert
code = code.replace(
  /INSERT INTO post_galleries \(post_id, image_url, sort_order\) VALUES \?/g,
  "INSERT INTO post_galleries (post_id, url, sort_order) VALUES ?"
);

fs.writeFileSync('routes/posts.js', code);
