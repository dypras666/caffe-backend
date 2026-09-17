const http = require('http');

const data = JSON.stringify({
  name: "Station 5",
  code: "ST5",
  type: "kitchen",
  printer_id: null,
  auto_print: false,
  is_active: true,
  display_color: "#ffffff"
});

const req = http.request({
  hostname: '127.0.0.1',
  port: 4700,
  path: '/api/stations/5',
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
}, res => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => console.log('STATUS:', res.statusCode, 'BODY:', body));
});
req.on('error', console.error);
req.write(data);
req.end();
