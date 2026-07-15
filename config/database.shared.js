// Shared-backend variant: resolves DB from per-request tenant context.
// Drop-in replacement for config/database.js — all routes work unchanged.
const { db } = require('./tenant-pools');
module.exports = db;
