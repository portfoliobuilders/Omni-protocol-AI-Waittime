import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.OMNI_DB_PATH
  ? path.resolve(process.env.OMNI_DB_PATH)
  : path.join(process.cwd(), "omni-ledger.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

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

  CREATE TABLE IF NOT EXISTS ads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    headline TEXT NOT NULL,
    body TEXT NOT NULL,
    cta_label TEXT NOT NULL,
    cta_url TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS ad_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ad_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    event TEXT NOT NULL CHECK (event IN ('impression', 'click')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    amount REAL NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('amazon_voucher', 'upi')),
    detail TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'rejected')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
  );

  CREATE TABLE IF NOT EXISTS partners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const transactionColumns = db.pragma("table_info(transactions)") as Array<{
  name: string;
}>;
if (!transactionColumns.some((column) => column.name === "partner_id")) {
  db.exec(`ALTER TABLE transactions ADD COLUMN partner_id INTEGER`);
}

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

const adCount = db
  .prepare(`SELECT COUNT(*) AS count FROM ads`)
  .get() as { count: number };

if (adCount.count === 0) {
  db.prepare(`
    INSERT INTO ads (headline, body, cta_label, cta_url)
    VALUES (?, ?, ?, ?)
  `).run(
    "Portfolio Builders",
    "FYUGP credit internships & tech courses in Kerala. Build your portfolio while you study.",
    "Explore Internships",
    "https://portfoliobuilders.in",
  );
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
  INSERT INTO transactions (user_id, amount, layer, nonce, partner_id)
  VALUES (@userId, @amount, @layer, @nonce, @partnerId)
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
  (input: {
    userId: string;
    amount: number;
    layer: string;
    nonce: string;
    partnerId?: number;
  }) => {
    upsertUser.run(input.userId);
    try {
      insertTx.run({
        ...input,
        partnerId: input.partnerId ?? null,
      });
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

export function getDbPath(): string {
  return DB_PATH;
}

export function backupDatabase(destPath: string): Promise<Database.BackupMetadata> {
  return db.backup(destPath);
}

export interface Ad {
  id: number;
  headline: string;
  body: string;
  cta_label: string;
  cta_url: string;
}

export interface AdStat {
  id: number;
  headline: string;
  active: boolean;
  impressions: number;
  clicks: number;
}

interface AdRow {
  id: number;
  headline: string;
  body: string;
  cta_label: string;
  cta_url: string;
}

const selectRandomActiveAd = db.prepare(`
  SELECT id, headline, body, cta_label, cta_url
  FROM ads
  WHERE active = 1
  ORDER BY RANDOM()
  LIMIT 1
`);

const selectAdById = db.prepare(`
  SELECT id FROM ads WHERE id = ?
`);

const insertAdEvent = db.prepare(`
  INSERT INTO ad_events (ad_id, user_id, event)
  VALUES (?, ?, ?)
`);

const selectAdStats = db.prepare(`
  SELECT
    a.id,
    a.headline,
    a.active,
    COALESCE(SUM(CASE WHEN e.event = 'impression' THEN 1 ELSE 0 END), 0) AS impressions,
    COALESCE(SUM(CASE WHEN e.event = 'click' THEN 1 ELSE 0 END), 0) AS clicks
  FROM ads a
  LEFT JOIN ad_events e ON e.ad_id = a.id
  GROUP BY a.id, a.headline, a.active
  ORDER BY a.id ASC
`);

export function getActiveAd(): Ad | null {
  const row = selectRandomActiveAd.get() as AdRow | undefined;
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    headline: row.headline,
    body: row.body,
    cta_label: row.cta_label,
    cta_url: row.cta_url,
  };
}

export type RecordAdEventResult =
  | { ok: true }
  | { ok: false; reason: "invalid" };

export function recordAdEvent(
  adId: number,
  userId: string,
  event: string,
): RecordAdEventResult {
  if (event !== "impression" && event !== "click") {
    return { ok: false, reason: "invalid" };
  }

  const ad = selectAdById.get(adId) as { id: number } | undefined;
  if (!ad) {
    return { ok: false, reason: "invalid" };
  }

  insertAdEvent.run(adId, userId, event);
  return { ok: true };
}

export function getAdStats(): AdStat[] {
  const rows = selectAdStats.all() as Array<{
    id: number;
    headline: string;
    active: number;
    impressions: number;
    clicks: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    headline: row.headline,
    active: row.active === 1,
    impressions: row.impressions,
    clicks: row.clicks,
  }));
}

export class ContentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentValidationError";
  }
}

const insertSurveyQuestion = db.prepare(`
  INSERT INTO survey_questions (question, options)
  VALUES (?, ?)
`);

const updateSurveyQuestionActive = db.prepare(`
  UPDATE survey_questions SET active = ? WHERE id = ?
`);

const insertAd = db.prepare(`
  INSERT INTO ads (headline, body, cta_label, cta_url)
  VALUES (?, ?, ?, ?)
`);

const updateAdActive = db.prepare(`
  UPDATE ads SET active = ? WHERE id = ?
`);

function validateSurveyOptions(options: string[]): string[] {
  if (!Array.isArray(options)) {
    throw new ContentValidationError("options must be an array.");
  }

  const trimmed = options
    .filter((option) => typeof option === "string")
    .map((option) => option.trim())
    .filter((option) => option.length > 0);

  if (trimmed.length < 2 || trimmed.length > 4) {
    throw new ContentValidationError("options must contain 2 to 4 non-empty strings.");
  }

  return trimmed;
}

export function addSurveyQuestion(
  question: string,
  options: string[],
): { id: number; question: string; options: string[] } {
  const trimmedQuestion = question.trim();

  if (!trimmedQuestion) {
    throw new ContentValidationError("question must be a non-empty string.");
  }

  const validOptions = validateSurveyOptions(options);
  const result = insertSurveyQuestion.run(
    trimmedQuestion,
    JSON.stringify(validOptions),
  );

  return {
    id: Number(result.lastInsertRowid),
    question: trimmedQuestion,
    options: validOptions,
  };
}

export type SetSurveyQuestionActiveResult =
  | { ok: true }
  | { ok: false; reason: "not_found" };

export function setSurveyQuestionActive(
  id: number,
  active: boolean,
): SetSurveyQuestionActiveResult {
  const result = updateSurveyQuestionActive.run(active ? 1 : 0, id);
  if (result.changes === 0) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: true };
}

export interface AdInput {
  headline: string;
  body: string;
  cta_label: string;
  cta_url: string;
}

export function addAd(input: AdInput): Ad {
  const headline = input.headline.trim();
  const body = input.body.trim();
  const cta_label = input.cta_label.trim();
  const cta_url = input.cta_url.trim();

  if (!headline) {
    throw new ContentValidationError("headline must be a non-empty string.");
  }
  if (!body) {
    throw new ContentValidationError("body must be a non-empty string.");
  }
  if (!cta_label) {
    throw new ContentValidationError("cta_label must be a non-empty string.");
  }
  if (!cta_url.startsWith("https://")) {
    throw new ContentValidationError("cta_url must start with https://.");
  }

  const result = insertAd.run(headline, body, cta_label, cta_url);

  return {
    id: Number(result.lastInsertRowid),
    headline,
    body,
    cta_label,
    cta_url,
  };
}

export type SetAdActiveResult =
  | { ok: true }
  | { ok: false; reason: "not_found" };

export function setAdActive(id: number, active: boolean): SetAdActiveResult {
  const result = updateAdActive.run(active ? 1 : 0, id);
  if (result.changes === 0) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: true };
}

export type RedemptionMethod = "amazon_voucher" | "upi";
export type RedemptionStatus = "pending" | "paid" | "rejected";

export interface RedemptionRow {
  id: number;
  user_id: string;
  amount: number;
  method: string;
  detail: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

const selectPendingRedemption = db.prepare(`
  SELECT id FROM redemptions
  WHERE user_id = ? AND status = 'pending'
  LIMIT 1
`);

const deductFullBalance = db.prepare(`
  UPDATE users SET balance = 0 WHERE user_id = @userId
`);

const insertRedemption = db.prepare(`
  INSERT INTO redemptions (user_id, amount, method, detail)
  VALUES (@userId, @amount, @method, @detail)
`);

const selectRedemptionById = db.prepare(`
  SELECT id, user_id, amount, method, detail, status, created_at, resolved_at
  FROM redemptions WHERE id = ?
`);

const updateRedemptionStatus = db.prepare(`
  UPDATE redemptions
  SET status = @status, resolved_at = datetime('now')
  WHERE id = @id
`);

const selectAllRedemptions = db.prepare(`
  SELECT id, user_id, amount, method, detail, status, created_at, resolved_at
  FROM redemptions
  ORDER BY created_at DESC, id DESC
`);

const selectRedemptionsByStatus = db.prepare(`
  SELECT id, user_id, amount, method, detail, status, created_at, resolved_at
  FROM redemptions
  WHERE status = ?
  ORDER BY created_at DESC, id DESC
`);

const selectRedemptionsByUser = db.prepare(`
  SELECT id, user_id, amount, method, detail, status, created_at, resolved_at
  FROM redemptions
  WHERE user_id = ?
  ORDER BY created_at DESC, id DESC
`);

export type RequestRedemptionResult =
  | { ok: true; amount: number }
  | { ok: false; reason: "below_minimum" | "already_pending" };

export const requestRedemption = db.transaction(
  (
    userId: string,
    method: RedemptionMethod,
    detail: string,
    minRedemption: number,
  ): RequestRedemptionResult => {
    upsertUser.run(userId);

    const pending = selectPendingRedemption.get(userId) as
      | { id: number }
      | undefined;
    if (pending) {
      return { ok: false, reason: "already_pending" };
    }

    const balanceRow = selectBalance.get(userId) as { balance: number } | undefined;
    const balance = balanceRow?.balance ?? 0;

    if (balance < minRedemption) {
      return { ok: false, reason: "below_minimum" };
    }

    const amount = Math.round(balance * 100) / 100;
    deductFullBalance.run({ userId });
    insertRedemption.run({ userId, amount, method, detail });

    return { ok: true, amount };
  },
);

export type ResolveRedemptionResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "already_resolved" | "invalid_status" };

export const resolveRedemption = db.transaction(
  (id: number, status: "paid" | "rejected"): ResolveRedemptionResult => {
    if (status !== "paid" && status !== "rejected") {
      return { ok: false, reason: "invalid_status" };
    }

    const row = selectRedemptionById.get(id) as RedemptionRow | undefined;
    if (!row) {
      return { ok: false, reason: "not_found" };
    }
    if (row.status !== "pending") {
      return { ok: false, reason: "already_resolved" };
    }

    if (status === "rejected") {
      creditBalance.run({ userId: row.user_id, amount: row.amount });
    }

    updateRedemptionStatus.run({ id, status });
    return { ok: true };
  },
);

export function getRedemptions(status?: RedemptionStatus): RedemptionRow[] {
  if (status) {
    return selectRedemptionsByStatus.all(status) as RedemptionRow[];
  }
  return selectAllRedemptions.all() as RedemptionRow[];
}

export function getUserRedemptions(userId: string): RedemptionRow[] {
  return selectRedemptionsByUser.all(userId) as RedemptionRow[];
}

export const resetLedger = db.transaction(() => {
  db.exec(`
    DELETE FROM transactions;
    DELETE FROM redemptions;
    DELETE FROM ad_events;
    DELETE FROM survey_responses;
    UPDATE users SET balance = 0;
  `);
});

export interface Partner {
  id: number;
  partner_key: string;
  name: string;
}

export interface PartnerStat {
  id: number;
  partner_key: string;
  name: string;
  active: boolean;
  transactions: number;
  totalPaid: number;
}

const insertPartner = db.prepare(`
  INSERT INTO partners (partner_key, name)
  VALUES (?, ?)
`);

const selectPartnerByKey = db.prepare(`
  SELECT id, partner_key, name
  FROM partners
  WHERE partner_key = ? AND active = 1
`);

const updatePartnerActive = db.prepare(`
  UPDATE partners SET active = ? WHERE id = ?
`);

const selectPartnerStats = db.prepare(`
  SELECT
    p.id,
    p.partner_key,
    p.name,
    p.active,
    COALESCE(COUNT(t.id), 0) AS transactions,
    COALESCE(SUM(t.amount), 0) AS totalPaid
  FROM partners p
  LEFT JOIN transactions t ON t.partner_id = p.id
  GROUP BY p.id, p.partner_key, p.name, p.active
  ORDER BY p.id ASC
`);

export function createPartner(name: string): Partner {
  const trimmedName = name.trim();

  if (!trimmedName) {
    throw new ContentValidationError("name must be a non-empty string.");
  }

  const partner_key = `pk_${crypto.randomUUID()}`;
  const result = insertPartner.run(partner_key, trimmedName);

  return {
    id: Number(result.lastInsertRowid),
    partner_key,
    name: trimmedName,
  };
}

export function getPartnerByKey(key: string): Partner | null {
  const row = selectPartnerByKey.get(key) as Partner | undefined;
  return row ?? null;
}

export type SetPartnerActiveResult =
  | { ok: true }
  | { ok: false; reason: "not_found" };

export function setPartnerActive(
  id: number,
  active: boolean,
): SetPartnerActiveResult {
  const result = updatePartnerActive.run(active ? 1 : 0, id);
  if (result.changes === 0) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: true };
}

export function getPartnerStats(): PartnerStat[] {
  const rows = selectPartnerStats.all() as Array<{
    id: number;
    partner_key: string;
    name: string;
    active: number;
    transactions: number;
    totalPaid: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    partner_key: row.partner_key,
    name: row.name,
    active: row.active === 1,
    transactions: row.transactions,
    totalPaid: row.totalPaid,
  }));
}
