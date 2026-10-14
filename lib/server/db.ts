// ============================================================================
// SQLite 数据层（node:sqlite 内置，零原生依赖）
// Node >= 22.5 提供 node:sqlite；本机 24.x 已内置。
// ============================================================================
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_ADMIN_ID = "admin";
export const DEFAULT_DB_PATH = "./data/app.db";
export const DEFAULT_UPLOAD_DIR = "./data/uploads";

/** 种子员工（1 管理员 + 10 员工） */
const SEED_EMPLOYEES: Array<{ id: string; name: string; department: string }> = [
	{ id: "user1", name: "张三", department: "销售部" },
	{ id: "user2", name: "李四", department: "销售部" },
	{ id: "user3", name: "王五", department: "财务部" },
	{ id: "user4", name: "赵六", department: "技术部" },
	{ id: "user5", name: "钱七", department: "市场部" },
	{ id: "user6", name: "孙八", department: "人力资源部" },
	{ id: "user7", name: "周九", department: "技术部" },
	{ id: "user8", name: "吴十", department: "财务部" },
	{ id: "user9", name: "郑十一", department: "市场部" },
	{ id: "user10", name: "王十二", department: "生产部" },
];

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
	id          TEXT PRIMARY KEY,
	name        TEXT NOT NULL,
	role        TEXT NOT NULL CHECK (role IN ('admin','user')),
	department  TEXT,
	createdAt   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
	id           TEXT PRIMARY KEY,
	name         TEXT NOT NULL UNIQUE,
	description  TEXT,
	snapshot     TEXT NOT NULL,
	fields       TEXT NOT NULL,
	sourceImages TEXT NOT NULL DEFAULT '[]',
	version      INTEGER NOT NULL DEFAULT 1,
	createdBy    TEXT NOT NULL,
	createdAt    INTEGER NOT NULL,
	updatedAt    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS images (
	id         TEXT PRIMARY KEY,
	fileName   TEXT NOT NULL,
	mimeType   TEXT NOT NULL,
	size       INTEGER NOT NULL,
	path       TEXT NOT NULL,
	uploadedBy TEXT,
	createdAt  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assignments (
	id           TEXT PRIMARY KEY,
	templateId   TEXT NOT NULL,
	userId       TEXT NOT NULL,
	assignedBy   TEXT NOT NULL,
	assignedAt   INTEGER NOT NULL,
	status       TEXT NOT NULL CHECK (status IN ('pending','submitted','revoked')),
	submittedAt  INTEGER,
	submissionId TEXT,
	note         TEXT
);

CREATE INDEX IF NOT EXISTS idx_assignments_user ON assignments (userId, status);
CREATE INDEX IF NOT EXISTS idx_assignments_template ON assignments (templateId);

CREATE TABLE IF NOT EXISTS submissions (
	id           TEXT PRIMARY KEY,
	assignmentId TEXT NOT NULL,
	templateId   TEXT NOT NULL,
	userId       TEXT NOT NULL,
	snapshot     TEXT NOT NULL,
	images       TEXT NOT NULL DEFAULT '[]',
	createdAt    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions (userId);
`;

/** 建表（幂等） */
export function initSchema(db: DatabaseSync): void {
	db.exec(SCHEMA_SQL);
}

/** 种子数据（幂等：仅在缺失时插入） */
export function seedDatabase(db: DatabaseSync, now = Date.now()): void {
	const insert = db.prepare(
		"INSERT OR IGNORE INTO users (id, name, role, department, createdAt) VALUES (?, ?, ?, ?, ?)",
	);
	insert.run(DEFAULT_ADMIN_ID, "系统管理员", "admin", "信息中心", now);
	for (const e of SEED_EMPLOYEES) {
		insert.run(e.id, e.name, "user", e.department, now);
	}
}

/**
 * 创建（并初始化）一个数据库连接。
 * 传入 ":memory:" 可用于测试隔离。
 */
export function createDb(dbPath: string): DatabaseSync {
	const resolved = dbPath === ":memory:" ? dbPath : path.resolve(dbPath);
	if (resolved !== ":memory:") {
		fs.mkdirSync(path.dirname(resolved), { recursive: true });
	}
	const db = new DatabaseSync(resolved);
	try {
		db.exec("PRAGMA journal_mode = WAL;");
	} catch {
		// :memory: 或不支持 WAL 的环境忽略
	}
	db.exec("PRAGMA foreign_keys = ON;");
	initSchema(db);
	seedDatabase(db);
	return db;
}

let cachedDb: DatabaseSync | null = null;

/** 进程级单例（route handler 使用） */
export function getDb(): DatabaseSync {
	if (cachedDb) return cachedDb;
	cachedDb = createDb(process.env.SJS_DB_PATH ?? DEFAULT_DB_PATH);
	return cachedDb;
}

/** 解析上传目录 */
export function resolveUploadDir(): string {
	return process.env.SJS_UPLOAD_DIR ?? DEFAULT_UPLOAD_DIR;
}
