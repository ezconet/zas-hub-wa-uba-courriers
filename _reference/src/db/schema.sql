CREATE TABLE IF NOT EXISTS announced_orders (
    id_pedido    TEXT PRIMARY KEY,
    id_board     INTEGER NOT NULL,
    display_id   TEXT NOT NULL,
    merchant_id  TEXT NOT NULL,
    neighborhood TEXT NOT NULL,
    full_json    TEXT NOT NULL,
    group_msg_id TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    announced_at TEXT NOT NULL,
    accepted_at  TEXT,
    expired_at   TEXT
);

CREATE TABLE IF NOT EXISTS acceptances (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    id_pedido      TEXT NOT NULL REFERENCES announced_orders(id_pedido),
    motoboy_jid    TEXT NOT NULL,
    detection_mode TEXT NOT NULL,
    accepted_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    id_pedido      TEXT,
    recipient_jid  TEXT NOT NULL,
    message_type   TEXT NOT NULL,
    sent_at        TEXT NOT NULL,
    success        INTEGER NOT NULL DEFAULT 1,
    error_text     TEXT
);

CREATE TABLE IF NOT EXISTS motoboy_sessions (
    jid          TEXT PRIMARY KEY,
    fone         TEXT NOT NULL,
    id_pedido    TEXT NOT NULL,
    state        TEXT NOT NULL DEFAULT 'awaiting_data',
    nome         TEXT,
    chave        TEXT,
    data_buffer  TEXT NOT NULL DEFAULT '[]',
    confirmed_at TEXT,
    updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_announced_status ON announced_orders(status);
CREATE INDEX IF NOT EXISTS idx_announced_at     ON announced_orders(announced_at);
CREATE INDEX IF NOT EXISTS idx_acceptance_order ON acceptances(id_pedido);
