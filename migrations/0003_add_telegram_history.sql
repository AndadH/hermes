-- migrations/0003_add_telegram_history.sql

CREATE TABLE IF NOT EXISTS telegram_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chatId INTEGER NOT NULL,
  role TEXT NOT NULL,       -- 'user' or 'assistant'
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

-- Index for fast lookups by chat
CREATE INDEX IF NOT EXISTS idx_telegram_history_chatId ON telegram_history(chatId);

-- Index for the time-based sliding window queries
CREATE INDEX IF NOT EXISTS idx_telegram_history_timestamp ON telegram_history(timestamp);