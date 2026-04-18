// @ts-nocheck
import { appendFile, mkdir } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { SQLITE_PRAGMA_STATEMENTS } from "./db/client";
import { appMigrations } from "./db/migrations";
import {
  GENERATED_TITLE_MATCH_WINDOW_MS,
  HOOK_DEBUG_LOG_ENV_NAME,
  HOOK_DEBUG_REDACTED_KEYS,
  REDACTED_DEBUG_VALUE,
  TELEGRAM_MAX_MESSAGE_LENGTH,
  TELEGRAM_NOTIFICATION_FOOTER,
  getLoopndrollPaths,
} from "./loopndroll-core";

const paths = getLoopndrollPaths();
const sqlitePragmas = [...SQLITE_PRAGMA_STATEMENTS];

export const databasePath = paths.databasePath;
export const logsDirectoryPath = paths.logsDirectoryPath;
export const hookDebugLogPath = paths.hookDebugLogPath;
export const generatedTitleMatchWindowMs = GENERATED_TITLE_MATCH_WINDOW_MS;
export const awaitReplyPollIntervalMs = 500;
export const telegramMaxMessageLength = TELEGRAM_MAX_MESSAGE_LENGTH;
export const telegramNotificationFooter = TELEGRAM_NOTIFICATION_FOOTER;

function isTruthyEnvValue(value) {
  if (!value) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function shouldEnableHookDebugLogging() {
  return isTruthyEnvValue(process.env[HOOK_DEBUG_LOG_ENV_NAME]);
}

function sanitizeHookDebugLogValue(value, seen = new WeakSet()) {
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeHookDebugLogValue(item, seen));
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return "[circular]";
  }

  seen.add(value);

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => {
      if (
        HOOK_DEBUG_REDACTED_KEYS.includes(entryKey) ||
        /(token|secret|password)$/i.test(entryKey)
      ) {
        return [entryKey, REDACTED_DEBUG_VALUE];
      }

      return [entryKey, sanitizeHookDebugLogValue(entryValue, seen)];
    }),
  );
}

function shouldIgnoreMigrationStatementError(db, statement, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.toLowerCase().includes("duplicate column name:")) {
    return false;
  }

  const match = /^\s*alter\s+table\s+(\w+)\s+add\s+column\s+(\w+)/i.exec(statement);
  if (!match) {
    return false;
  }

  const [, tableName, columnName] = match;
  const rows = db.query(`pragma table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
}

function isSqliteBusyError(error) {
  return error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message);
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function nowIsoString() {
  return new Date().toISOString();
}

export async function ensureDirectory(path) {
  await mkdir(path, { recursive: true });
}

export async function appendHookDebugLog(entry) {
  if (!shouldEnableHookDebugLogging()) {
    return;
  }

  await ensureDirectory(logsDirectoryPath);
  await appendFile(
    hookDebugLogPath,
    `${JSON.stringify(
      sanitizeHookDebugLogValue({
        timestamp: nowIsoString(),
        ...entry,
      }),
    )}\n`,
    "utf8",
  );
}

export function withSqliteBusyRetry(operation, maxAttempts = 5, delayMs = 25) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= maxAttempts) {
        throw error;
      }

      sleepSync(delayMs);
    }
  }
}

export function configureDatabase(db) {
  for (const statement of sqlitePragmas) {
    db.exec(statement);
  }
}

export function applyMigrations(db) {
  db.exec(`create table if not exists schema_migrations (
    id integer primary key,
    name text not null,
    applied_at text not null
  )`);

  const appliedRows = db.query("select id from schema_migrations order by id asc").all();
  const appliedIds = new Set(appliedRows.map((row) => row.id));
  const insertMigration = db.query(
    "insert into schema_migrations (id, name, applied_at) values (?, ?, ?)",
  );
  const applyMigration = db.transaction((migration) => {
    for (const statement of migration.statements) {
      try {
        db.exec(statement);
      } catch (error) {
        if (shouldIgnoreMigrationStatementError(db, statement, error)) {
          continue;
        }

        throw error;
      }
    }

    insertMigration.run(migration.id, migration.name, nowIsoString());
  });

  for (const migration of appMigrations) {
    if (appliedIds.has(migration.id)) {
      continue;
    }

    applyMigration(migration);
  }
}

export function openHookRuntimeDatabase() {
  const db = new Database(databasePath, { create: true });
  configureDatabase(db);
  applyMigrations(db);
  return db;
}
