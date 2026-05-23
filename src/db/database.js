const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

let db = null;

function connect(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Seed estado inicial
  _seedState('dispatch_enabled', 'true');
  _seedState('health_status', 'healthy');

  console.log(`[DB] Conectado: ${dbPath}`);
  return db;
}

function _seedState(key, defaultValue) {
  db.prepare('INSERT OR IGNORE INTO instance_state (key, value) VALUES (?, ?)').run(key, defaultValue);
}

function getDb() {
  if (!db) throw new Error('DB não inicializado. Chame connect() primeiro.');
  return db;
}

// ─── instance_state ───────────────────────────────────────────────────────────

function getState(key) {
  const row = getDb().prepare('SELECT value FROM instance_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setState(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO instance_state (key, value) VALUES (?, ?)').run(key, String(value));
}

// ─── group_messages ───────────────────────────────────────────────────────────

function insertGroupMsg(msgId, orderId) {
  getDb().prepare('INSERT OR IGNORE INTO group_messages (msg_id, order_id) VALUES (?, ?)').run(msgId, orderId);
}

function getOrderByMsgId(msgId) {
  return getDb().prepare('SELECT * FROM group_messages WHERE msg_id = ?').get(msgId);
}

function getMostRecentGroupMsg() {
  return getDb().prepare('SELECT * FROM group_messages ORDER BY sent_at DESC LIMIT 1').get();
}

function deleteGroupMsg(msgId) {
  getDb().prepare('DELETE FROM group_messages WHERE msg_id = ?').run(msgId);
}

// ─── eu_dispatched (dedup durável contra double-dispatch) ──────────────────────

function markEuDispatched(orderId) {
  getDb().prepare('INSERT OR IGNORE INTO eu_dispatched (order_id) VALUES (?)').run(orderId);
}

function isEuDispatched(orderId) {
  return !!getDb().prepare('SELECT 1 FROM eu_dispatched WHERE order_id = ?').get(orderId);
}

function clearEuDispatched(orderId) {
  getDb().prepare('DELETE FROM eu_dispatched WHERE order_id = ?').run(orderId);
}

module.exports = {
  connect, getDb,
  getState, setState,
  insertGroupMsg, getOrderByMsgId, getMostRecentGroupMsg, deleteGroupMsg,
  markEuDispatched, isEuDispatched, clearEuDispatched,
};
