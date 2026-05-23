const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

let db = null;

function connect(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  console.log(`[DB] Conectado: ${dbPath}`);
  return db;
}

function getDb() {
  if (!db) throw new Error('Banco não inicializado. Chame connect() primeiro.');
  return db;
}

// ─── Pedidos anunciados ────────────────────────────────────────────────────────

function isOrderAnnounced(idPedido) {
  const row = getDb()
    .prepare('SELECT 1 FROM announced_orders WHERE id_pedido = ?')
    .get(idPedido);
  return !!row;
}

function insertAnnouncedOrder(record) {
  getDb()
    .prepare(`
      INSERT INTO announced_orders
        (id_pedido, id_board, display_id, merchant_id, neighborhood,
         full_json, group_msg_id, status, announced_at)
      VALUES
        (@id_pedido, @id_board, @display_id, @merchant_id, @neighborhood,
         @full_json, @group_msg_id, 'pending', @announced_at)
    `)
    .run(record);
}

function setOrderAccepted(idPedido, acceptedAt) {
  getDb()
    .prepare(`UPDATE announced_orders SET status = 'accepted', accepted_at = ? WHERE id_pedido = ?`)
    .run(acceptedAt, idPedido);
}

function insertNoMotoboyOrder(record) {
  getDb()
    .prepare(`
      INSERT INTO announced_orders
        (id_pedido, id_board, display_id, merchant_id, neighborhood,
         full_json, group_msg_id, status, announced_at)
      VALUES
        (@id_pedido, @id_board, @display_id, @merchant_id, @neighborhood,
         @full_json, NULL, 'no_motoboy', @announced_at)
    `)
    .run(record);
}

function setOrderExpired(idPedido, expiredAt) {
  getDb()
    .prepare(`UPDATE announced_orders SET status = 'expired', expired_at = ? WHERE id_pedido = ?`)
    .run(expiredAt, idPedido);
}

function getPendingOrders() {
  return getDb()
    .prepare(`SELECT * FROM announced_orders WHERE status = 'pending' ORDER BY announced_at ASC`)
    .all();
}

function getOrderByGroupMsgId(groupMsgId) {
  return getDb()
    .prepare(`SELECT * FROM announced_orders WHERE group_msg_id = ? AND status = 'pending'`)
    .get(groupMsgId);
}

function getMostRecentPendingOrder() {
  return getDb()
    .prepare(`SELECT * FROM announced_orders WHERE status = 'pending' ORDER BY announced_at DESC LIMIT 1`)
    .get();
}

// ─── Aceitações ───────────────────────────────────────────────────────────────

function isOrderAccepted(idPedido) {
  const row = getDb()
    .prepare('SELECT 1 FROM acceptances WHERE id_pedido = ?')
    .get(idPedido);
  return !!row;
}

function insertAcceptance(record) {
  getDb()
    .prepare(`
      INSERT INTO acceptances (id_pedido, motoboy_jid, detection_mode, accepted_at)
      VALUES (@id_pedido, @motoboy_jid, @detection_mode, @accepted_at)
    `)
    .run(record);
}

// ─── Log de mensagens ─────────────────────────────────────────────────────────

function logMessage(record) {
  getDb()
    .prepare(`
      INSERT INTO message_log (id_pedido, recipient_jid, message_type, sent_at, success, error_text)
      VALUES (@id_pedido, @recipient_jid, @message_type, @sent_at, @success, @error_text)
    `)
    .run(record);
}

// ─── Sessões de motoboy ───────────────────────────────────────────────────────

function getMotoboySession(jid) {
  return getDb().prepare('SELECT * FROM motoboy_sessions WHERE jid = ?').get(jid);
}

function upsertMotoboySession(s) {
  getDb().prepare(`
    INSERT INTO motoboy_sessions (jid, fone, id_pedido, state, nome, chave, data_buffer, confirmed_at, updated_at)
    VALUES (@jid, @fone, @id_pedido, @state, @nome, @chave, @data_buffer, @confirmed_at, @updated_at)
    ON CONFLICT(jid) DO UPDATE SET
      fone=@fone, id_pedido=@id_pedido, state=@state,
      nome=@nome, chave=@chave, data_buffer=@data_buffer,
      confirmed_at=@confirmed_at, updated_at=@updated_at
  `).run(s);
}

module.exports = {
  connect,
  getDb,
  getMotoboySession,
  upsertMotoboySession,
  isOrderAnnounced,
  insertAnnouncedOrder,
  insertNoMotoboyOrder,
  setOrderAccepted,
  setOrderExpired,
  getPendingOrders,
  getOrderByGroupMsgId,
  getMostRecentPendingOrder,
  isOrderAccepted,
  insertAcceptance,
  logMessage,
};
