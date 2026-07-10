# ☕ Café Azzura — Backend API

REST API untuk sistem manajemen Café Azzura. Dibangun dengan Express.js + MySQL.

## Repositori Terkait

| Repo | Deskripsi | Link |
|------|-----------|------|
| **caffe-backend** | API Backend (repo ini) | https://github.com/dypras666/caffe-backend |
| **caffe-admin** | Admin Panel (React) | https://github.com/dypras666/caffe-admin |
| **caffe-ui** | Customer Website (React) | https://github.com/dypras666/caffe-ui |

## Tech Stack
- Node.js + Express
- MySQL (mysql2)
- JWT Authentication + Session
- Multi-branch inventory
- Shift management

## Setup

```bash
cp .env.example .env   # isi konfigurasi DB
npm install
node database/migrate.js
npm start              # port 3002
```

## Environment Variables

```env
VITE_API_URL=http://localhost:3002
DB_HOST=127.0.0.1
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=cafe_azzura
DB_PORT=3306
JWT_SECRET=your_secret
```
