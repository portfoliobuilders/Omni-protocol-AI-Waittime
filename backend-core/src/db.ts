import Database from "better-sqlite3";
import crypto from "node:crypto";
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

  CREATE TABLE IF NOT EXISTS claim_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    used INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS survey_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS survey_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    question_id INTEGER NOT NULL,
    answer TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, question_id)
  );
`);

const surveyQuestionCount = db
  .prepare(`SELECT COUNT(*) AS count FROM survey_questions`)
  .get() as { count: number };

if (surveyQuestionCount.count === 0) {
  const insertSurveyQuestion = db.prepare(`
    INSERT INTO survey_questions (question, options)
    VALUES (?, ?)
  `);

  const seedSurveyQuestions = db.transaction(() => {
    const questions = [
      {
        question: "How often do you use AI chat tools?",
        options: ["Daily", "Weekly", "Rarely"],
      },
      {
        question: "Where do you use AI most?",
        options: ["Work", "School", "Personal", "Other"],
      },
      {
        question: "What matters most in AI tools?",
        options: ["Speed", "Accuracy", "Privacy", "Price"],
      },
      {
        question: "How do AI tools feel today?",
        options: ["Helpful", "Confusing", "Slow", "Fun"],
      },
      {
        question: "Would you share anonymous usage data?",
        options: ["Yes", "No", "Maybe"],
      },
    ];

    for (const surveyQuestion of questions) {
      insertSurveyQuestion.run(
        surveyQuestion.question,
        JSON.stringify(surveyQuestion.options),
      );
    }
  });

  seedSurveyQuestions();
}

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

interface ClaimSessionRow {
  id: number;
  token: string;
  user_id: string;
  created_at: string;
  used: number;
}

interface SurveyQuestionRow {
  id: number;
  question: string;
  options: string;
}

export interface SurveyQuestion {
  id: number;
  question: string;
  options: string[];
}

const insertClaimSession = db.prepare(`
  INSERT INTO claim_sessions (token, user_id)
  VALUES (?, ?)
`);

const selectClaimSession = db.prepare(`
  SELECT id, token, user_id, created_at, used
  FROM claim_sessions
  WHERE token = ?
`);

const markClaimSessionUsed = db.prepare(`
  UPDATE claim_sessions SET used = 1 WHERE token = ?
`);

const selectNextSurveyQuestion = db.prepare(`
  SELECT id, question, options
  FROM survey_questions
  WHERE active = 1
    AND id NOT IN (
      SELECT question_id
      FROM survey_responses
      WHERE user_id = ?
    )
  ORDER BY id ASC
  LIMIT 1
`);

const selectSurveyQuestionById = db.prepare(`
  SELECT id, question, options
  FROM survey_questions
  WHERE id = ?
`);

const insertSurveyResponse = db.prepare(`
  INSERT INTO survey_responses (user_id, question_id, answer)
  VALUES (?, ?, ?)
`);

function parseSurveyOptions(optionsJson: string): string[] {
  const options = JSON.parse(optionsJson);
  return Array.isArray(options) ? options.filter((option) => typeof option === "string") : [];
}

export type ConsumeClaimSessionResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "too_fast" };

export function createClaimSession(userId: string): string {
  const token = crypto.randomUUID();
  insertClaimSession.run(token, userId);
  return token;
}

export const consumeClaimSession = db.transaction(
  (
    token: string,
    userId: string,
    minWaitSeconds: number,
  ): ConsumeClaimSessionResult => {
    const row = selectClaimSession.get(token) as ClaimSessionRow | undefined;

    if (!row || row.used === 1 || row.user_id !== userId) {
      return { ok: false, reason: "invalid" };
    }

    const createdAtIso = row.created_at.includes("T")
      ? row.created_at.endsWith("Z")
        ? row.created_at
        : `${row.created_at}Z`
      : `${row.created_at.replace(" ", "T")}Z`;
    const elapsedSeconds = (Date.now() - Date.parse(createdAtIso)) / 1000;

    if (elapsedSeconds < minWaitSeconds) {
      return { ok: false, reason: "too_fast" };
    }

    markClaimSessionUsed.run(token);
    return { ok: true };
  },
);

export function getNextSurveyQuestion(userId: string): SurveyQuestion | null {
  const row = selectNextSurveyQuestion.get(userId) as SurveyQuestionRow | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    question: row.question,
    options: parseSurveyOptions(row.options),
  };
}

export type RecordSurveyResponseResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "already_answered" };

export const recordSurveyResponse = db.transaction(
  (
    userId: string,
    questionId: number,
    answer: string,
  ): RecordSurveyResponseResult => {
    const row = selectSurveyQuestionById.get(questionId) as
      | SurveyQuestionRow
      | undefined;

    if (!row) {
      return { ok: false, reason: "invalid" };
    }

    const options = parseSurveyOptions(row.options);

    if (!options.includes(answer)) {
      return { ok: false, reason: "invalid" };
    }

    try {
      insertSurveyResponse.run(userId, questionId, answer);
      return { ok: true };
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        err.message.includes("UNIQUE constraint failed")
      ) {
        return { ok: false, reason: "already_answered" };
      }
      throw err;
    }
  },
);

export interface SurveyAnswerBreakdown {
  answer: string;
  count: number;
}

export interface SurveyResult {
  id: number;
  question: string;
  active: boolean;
  totalResponses: number;
  breakdown: SurveyAnswerBreakdown[];
}

export interface LedgerStats {
  totalUsers: number;
  totalTransactions: number;
  totalPaidOut: number;
  totalSurveyResponses: number;
}

export interface RecentTransaction {
  id: number;
  user_id: string;
  amount: number;
  layer: string;
  created_at: string;
}

const selectAllSurveyQuestions = db.prepare(`
  SELECT id, question, options, active
  FROM survey_questions
  ORDER BY id ASC
`);

const countSurveyResponsesByQuestion = db.prepare(`
  SELECT answer, COUNT(*) AS count
  FROM survey_responses
  WHERE question_id = ?
  GROUP BY answer
`);

const countUsers = db.prepare(`SELECT COUNT(*) AS count FROM users`);
const countTransactions = db.prepare(
  `SELECT COUNT(*) AS count FROM transactions`,
);
const sumTransactionAmounts = db.prepare(
  `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions`,
);
const countSurveyResponses = db.prepare(
  `SELECT COUNT(*) AS count FROM survey_responses`,
);

const selectRecentTransactions = db.prepare(`
  SELECT id, user_id, amount, layer, created_at
  FROM transactions
  ORDER BY created_at DESC, id DESC
  LIMIT ?
`);

export function getSurveyResults(): SurveyResult[] {
  const questions = selectAllSurveyQuestions.all() as Array<
    SurveyQuestionRow & { active: number }
  >;

  return questions.map((row) => {
    const options = parseSurveyOptions(row.options);
    const counts = countSurveyResponsesByQuestion.all(row.id) as Array<{
      answer: string;
      count: number;
    }>;
    const countByAnswer = new Map(
      counts.map((entry) => [entry.answer, entry.count]),
    );

    const breakdown = options.map((answer) => ({
      answer,
      count: countByAnswer.get(answer) ?? 0,
    }));

    const totalResponses = breakdown.reduce((sum, entry) => sum + entry.count, 0);

    return {
      id: row.id,
      question: row.question,
      active: row.active === 1,
      totalResponses,
      breakdown,
    };
  });
}

export function getLedgerStats(): LedgerStats {
  const users = countUsers.get() as { count: number };
  const transactions = countTransactions.get() as { count: number };
  const paidOut = sumTransactionAmounts.get() as { total: number };
  const surveyResponses = countSurveyResponses.get() as { count: number };

  return {
    totalUsers: users.count,
    totalTransactions: transactions.count,
    totalPaidOut: paidOut.total,
    totalSurveyResponses: surveyResponses.count,
  };
}

export function getRecentTransactions(limit = 20): RecentTransaction[] {
  return selectRecentTransactions.all(limit) as RecentTransaction[];
}
