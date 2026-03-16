-- Migration: add telegram_context_start table
-- Stores the timestamp of the last /clear per chat.
-- Used to exclude pre-clear messages from the live context window
-- while keeping them fully available for searchChatHistory (FTS).
 
CREATE TABLE IF NOT EXISTS telegram_context_start (
  chatId    INTEGER PRIMARY KEY,
  startedAt INTEGER NOT NULL  -- unix ms of last /clear
);
 