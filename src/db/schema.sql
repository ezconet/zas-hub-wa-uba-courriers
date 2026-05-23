-- Mapeamento msgId do grupo WA → orderId
-- Usado para detecção de "eu" quoted
CREATE TABLE IF NOT EXISTS group_messages (
  msg_id    TEXT PRIMARY KEY,
  order_id  TEXT NOT NULL,
  sent_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Estado global da instância (key-value)
-- Chaves: dispatch_enabled, health_status, last_connected_at
CREATE TABLE IF NOT EXISTS instance_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Pedidos cujo webhook eu-received já foi disparado com SUCESSO.
-- Fonte da verdade durável (sobrevive restart) contra double-dispatch:
-- segundo "eu" do mesmo pedido não re-dispara → evita pagar 2 motoboys (R12).
-- Limpo em /group/announce (rodada nova reabre a escuta).
CREATE TABLE IF NOT EXISTS eu_dispatched (
  order_id      TEXT PRIMARY KEY,
  dispatched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_group_messages_sent ON group_messages(sent_at);
