import Database from "better-sqlite3";
import path from "node:path";

const DB_PATH = path.join(process.cwd(), "omni-ledger.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    balance REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    amount REAL NOT NULL,
    layer TEXT NOT NULL,
    nonce TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, nonce),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_tx_user_created
    ON transactions (user_id, created_at DESC);
`);

export interface TransactionRow {
  id: number;
  user_id: string;
  amount: number;
  layer: string;
  nonce: string;
  created_at: string;
}

const upsertUser = db.prepare(`
  INSERT INTO users (user_id) VALUES (?)
  ON CONFLICT(user_id) DO NOTHING
`);

const insertTx = db.prepare(`
  INSERT INTO transactions (user_id, amount, layer, nonce)
  VALUES (@userId, @amount, @layer, @nonce)
`);

const creditBalance = db.prepare(`
  UPDATE users
  SET balance = ROUND(balance + @amount, 2)
  WHERE user_id = @userId
`);

const selectBalance = db.prepare(
  `SELECT balance FROM users WHERE user_id = ?`,
);

const selectTransactions = db.prepare(`
  SELECT id, user_id, amount, layer, nonce, created_at
  FROM transactions
  WHERE user_id = ?
  ORDER BY created_at DESC, id DESC
  LIMIT ?
`);

export class DuplicateTransactionError extends Error {
  constructor() {
    super("This transaction nonce has already been processed.");
    this.name = "DuplicateTransactionError";
  }
}

export const applyYield = db.transaction(
  (input: { userId: string; amount: number; layer: string; nonce: string }) => {
    upsertUser.run(input.userId);
    try {
      insertTx.run(input);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        err.message.includes("UNIQUE constraint failed")
      ) {
        throw new DuplicateTransactionError();
      }
      throw err;
    }
    creditBalance.run(input);
    const row = selectBalance.get(input.userId) as { balance: number };
    return row.balance;
  },
);

export function getBalance(userId: string): number {
  const row = selectBalance.get(userId) as { balance: number } | undefined;
  return row?.balance ?? 0;
}

export function getTransactions(userId: string, limit = 25): TransactionRow[] {
  return selectTransactions.all(userId, limit) as TransactionRow[];
}
