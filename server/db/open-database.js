const fs = require("fs");
const path = require("path");

let sqlJsInitPromise = null;

function resolveBindParameters(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return undefined;
  }
  if (args.length === 1) {
    return args[0];
  }
  return args;
}

function isMutatingStatement(sql) {
  const source = String(sql || "").trim();
  if (!source) return false;
  const normalized = source.toUpperCase();
  if (
    normalized.startsWith("INSERT") ||
    normalized.startsWith("UPDATE") ||
    normalized.startsWith("DELETE") ||
    normalized.startsWith("REPLACE") ||
    normalized.startsWith("CREATE") ||
    normalized.startsWith("DROP") ||
    normalized.startsWith("ALTER") ||
    normalized.startsWith("VACUUM") ||
    normalized.startsWith("REINDEX")
  ) {
    return true;
  }
  if (
    normalized.startsWith("BEGIN") ||
    normalized.startsWith("COMMIT") ||
    normalized.startsWith("ROLLBACK") ||
    normalized.startsWith("END")
  ) {
    return true;
  }
  // Some write statements can start with WITH.
  if (normalized.startsWith("WITH") && /\b(INSERT|UPDATE|DELETE|REPLACE)\b/.test(normalized)) {
    return true;
  }
  return false;
}

async function loadSqlJs() {
  if (sqlJsInitPromise) {
    return sqlJsInitPromise;
  }
  const initSqlJs = require("sql.js");
  sqlJsInitPromise = initSqlJs({
    locateFile(fileName) {
      try {
        return require.resolve(`sql.js/dist/${fileName}`);
      } catch {
        return fileName;
      }
    }
  });
  return sqlJsInitPromise;
}

function ensureParentDirectory(filePath) {
  const parentDirectory = path.dirname(path.resolve(filePath));
  fs.mkdirSync(parentDirectory, { recursive: true });
}

function readDatabaseFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  if (!buffer || buffer.length === 0) return null;
  return buffer;
}

class SqlJsDatabaseAdapter {
  constructor(database, filename, readOnly) {
    this._db = database;
    this._filename = filename;
    this._readOnly = Boolean(readOnly);
    this._inTransaction = false;
  }

  _ensureWritable(sql) {
    if (this._readOnly && isMutatingStatement(sql)) {
      throw new Error("Database was opened in read-only mode.");
    }
  }

  _persist() {
    if (this._readOnly) return;
    if (this._inTransaction) return;
    const bytes = this._db.export();
    ensureParentDirectory(this._filename);
    fs.writeFileSync(this._filename, Buffer.from(bytes));
  }

  _trackTransactionState(sql) {
    const normalized = String(sql || "").trim().toUpperCase();
    if (!normalized) return;
    if (normalized.startsWith("BEGIN")) {
      this._inTransaction = true;
      return;
    }
    if (
      normalized.startsWith("COMMIT") ||
      normalized.startsWith("ROLLBACK") ||
      normalized.startsWith("END")
    ) {
      this._inTransaction = false;
    }
  }

  async exec(sql) {
    this._ensureWritable(sql);
    this._db.exec(String(sql || ""));
    this._trackTransactionState(sql);
    if (isMutatingStatement(sql)) {
      this._persist();
    }
    return this;
  }

  async run(sql, ...params) {
    this._ensureWritable(sql);
    const previousRowCount = this._db.getRowsModified();
    const statement = this._db.prepare(String(sql || ""));
    try {
      const bound = resolveBindParameters(params);
      if (bound !== undefined) {
        statement.bind(bound);
      }
      statement.step();
    } finally {
      statement.free();
    }
    this._trackTransactionState(sql);
    const lastIdRow = this._db.exec("SELECT last_insert_rowid() AS last_id;");
    const lastID =
      Array.isArray(lastIdRow) &&
      lastIdRow.length > 0 &&
      Array.isArray(lastIdRow[0]?.values) &&
      lastIdRow[0].values.length > 0
        ? Number(lastIdRow[0].values[0][0] || 0)
        : 0;
    const changes = Math.max(0, this._db.getRowsModified() - previousRowCount);
    if (isMutatingStatement(sql)) {
      this._persist();
    }
    return {
      changes,
      lastID
    };
  }

  async get(sql, ...params) {
    const rows = await this.all(sql, ...params);
    return rows[0];
  }

  async all(sql, ...params) {
    const statement = this._db.prepare(String(sql || ""));
    try {
      const bound = resolveBindParameters(params);
      if (bound !== undefined) {
        statement.bind(bound);
      }
      const rows = [];
      while (statement.step()) {
        rows.push(statement.getAsObject());
      }
      return rows;
    } finally {
      statement.free();
    }
  }

  async close() {
    if (!this._readOnly) {
      this._persist();
    }
    this._db.close();
  }
}

async function openSqlite3Database({ filename, mode }) {
  const { open } = require("sqlite");
  const sqlite3 = require("sqlite3");
  const options = {
    filename,
    driver: sqlite3.Database
  };
  if (mode !== undefined) {
    options.mode = mode;
  }
  return open(options);
}

function shouldPreferSqlJs() {
  const explicit = String(process.env.OPENPOSTINGS_DB_DRIVER || "").trim().toLowerCase();
  if (explicit === "sqljs" || explicit === "sql.js") return true;
  if (explicit === "sqlite3") return false;
  const useSqlJs = String(process.env.OPENPOSTINGS_USE_SQLJS || "").trim().toLowerCase();
  return useSqlJs === "1" || useSqlJs === "true" || useSqlJs === "yes";
}

async function openSqlJsDatabase({ filename, mode }) {
  const SQL = await loadSqlJs();
  const existingBytes = readDatabaseFile(filename);
  const readOnly = Number(mode) === 1;
  const database = existingBytes ? new SQL.Database(existingBytes) : new SQL.Database();
  return new SqlJsDatabaseAdapter(database, filename, readOnly);
}

async function openDatabase(options) {
  const preferredSqlJs = shouldPreferSqlJs();
  if (preferredSqlJs) {
    return openSqlJsDatabase(options);
  }
  try {
    return await openSqlite3Database(options);
  } catch (error) {
    // Android node runtime path: sqlite3 native bindings are often unavailable.
    if (error && (error.code === "MODULE_NOT_FOUND" || /sqlite3/i.test(String(error.message || "")))) {
      return openSqlJsDatabase(options);
    }
    throw error;
  }
}

function getSqliteReadOnlyMode() {
  try {
    const sqlite3 = require("sqlite3");
    return sqlite3.OPEN_READONLY;
  } catch {
    return 1;
  }
}

module.exports = {
  openDatabase,
  getSqliteReadOnlyMode
};
