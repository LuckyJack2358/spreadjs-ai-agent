// ============================================================================
// 服务端仓库层：所有 CRUD 与查询。接收 DatabaseSync 以便测试注入。
// ============================================================================
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import type {
	Assignment,
	AssignmentStatus,
	AssignmentView,
	ImageRef,
	StoredImage,
	Submission,
	SubmissionView,
	TemplateField,
	TemplateRecord,
	User,
} from "./types";

export type RepoErrorCode =
	| "duplicate_pending"
	| "not_found"
	| "assignment_locked"
	| "template_exists"
	| "invalid_input";

export class RepoError extends Error {
	code: RepoErrorCode;
	constructor(code: RepoErrorCode, message: string) {
		super(message);
		this.name = "RepoError";
		this.code = code;
	}
}

function parseJson<T>(raw: unknown, fallback: T): T {
	if (typeof raw !== "string" || raw.length === 0) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

// ─── 行 → 实体 ──────────────────────────────────────────────

type Row = Record<string, unknown>;

function toUser(r: Row): User {
	return {
		id: String(r.id),
		name: String(r.name),
		role: r.role === "admin" ? "admin" : "user",
		department: r.department == null ? null : String(r.department),
		createdAt: Number(r.createdAt),
	};
}

function toTemplate(r: Row): TemplateRecord {
	return {
		id: String(r.id),
		name: String(r.name),
		description: r.description == null ? null : String(r.description),
		snapshot: parseJson<Record<string, unknown>>(r.snapshot, {}),
		fields: parseJson<TemplateField[]>(r.fields, []),
		sourceImages: parseJson<ImageRef[]>(r.sourceImages, []),
		version: Number(r.version),
		createdBy: String(r.createdBy),
		createdAt: Number(r.createdAt),
		updatedAt: Number(r.updatedAt),
	};
}

function toImage(r: Row): StoredImage {
	return {
		id: String(r.id),
		fileName: String(r.fileName),
		mimeType: String(r.mimeType),
		size: Number(r.size),
		path: String(r.path),
		uploadedBy: r.uploadedBy == null ? null : String(r.uploadedBy),
		createdAt: Number(r.createdAt),
	};
}

function toAssignment(r: Row): Assignment {
	return {
		id: String(r.id),
		templateId: String(r.templateId),
		userId: String(r.userId),
		assignedBy: String(r.assignedBy),
		assignedAt: Number(r.assignedAt),
		status: String(r.status) as AssignmentStatus,
		submittedAt: r.submittedAt == null ? null : Number(r.submittedAt),
		submissionId: r.submissionId == null ? null : String(r.submissionId),
		note: r.note == null ? null : String(r.note),
	};
}

function toSubmission(r: Row): Submission {
	return {
		id: String(r.id),
		assignmentId: String(r.assignmentId),
		templateId: String(r.templateId),
		userId: String(r.userId),
		snapshot: parseJson<Record<string, unknown>>(r.snapshot, {}),
		images: parseJson<string[]>(r.images, []),
		createdAt: Number(r.createdAt),
	};
}

export class Repo {
	constructor(private readonly db: DatabaseSync) {}

	// ─── users ───────────────────────────────────────────────

	listUsers(): User[] {
		const rows = this.db.prepare("SELECT * FROM users ORDER BY role DESC, id ASC").all() as Row[];
		return rows.map(toUser);
	}

	getUser(id: string): User | null {
		const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
		return row ? toUser(row) : null;
	}

	// ─── images ──────────────────────────────────────────────

	insertImage(img: Omit<StoredImage, "createdAt"> & { createdAt?: number }): StoredImage {
		const createdAt = img.createdAt ?? Date.now();
		this.db
			.prepare(
				"INSERT INTO images (id, fileName, mimeType, size, path, uploadedBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(img.id, img.fileName, img.mimeType, img.size, img.path, img.uploadedBy, createdAt);
		return { ...img, createdAt } as StoredImage;
	}

	getImage(id: string): StoredImage | null {
		const row = this.db.prepare("SELECT * FROM images WHERE id = ?").get(id) as Row | undefined;
		return row ? toImage(row) : null;
	}

	getImages(ids: string[]): StoredImage[] {
		return ids
			.map((id) => this.getImage(id))
			.filter((x): x is StoredImage => x !== null);
	}

	// ─── templates ───────────────────────────────────────────

	listTemplates(): TemplateRecord[] {
		return (this.db.prepare("SELECT * FROM templates ORDER BY updatedAt DESC").all() as Row[]).map(toTemplate);
	}

	getTemplate(id: string): TemplateRecord | null {
		const row = this.db.prepare("SELECT * FROM templates WHERE id = ?").get(id) as Row | undefined;
		return row ? toTemplate(row) : null;
	}

	getTemplateByName(name: string): TemplateRecord | null {
		const row = this.db.prepare("SELECT * FROM templates WHERE name = ?").get(name) as Row | undefined;
		return row ? toTemplate(row) : null;
	}

	/** 同名保存 → 覆盖并 version + 1；否则新建 */
	upsertTemplate(input: {
		name: string;
		description?: string | null;
		snapshot: Record<string, unknown>;
		fields: TemplateField[];
		sourceImages: ImageRef[];
		createdBy: string;
	}): TemplateRecord {
		const now = Date.now();
		const existing = this.getTemplateByName(input.name);
		if (existing) {
			this.db
				.prepare(
					"UPDATE templates SET description = ?, snapshot = ?, fields = ?, sourceImages = ?, version = ?, updatedAt = ? WHERE id = ?",
				)
				.run(
					input.description ?? existing.description,
					JSON.stringify(input.snapshot),
					JSON.stringify(input.fields),
					JSON.stringify(input.sourceImages),
					existing.version + 1,
					now,
					existing.id,
				);
			return this.getTemplate(existing.id)!;
		}
		const id = `tpl_${randomUUID()}`;
		this.db
			.prepare(
				"INSERT INTO templates (id, name, description, snapshot, fields, sourceImages, version, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
			)
			.run(
				id,
				input.name,
				input.description ?? null,
				JSON.stringify(input.snapshot),
				JSON.stringify(input.fields),
				JSON.stringify(input.sourceImages),
				input.createdBy,
				now,
				now,
			);
		return this.getTemplate(id)!;
	}

	deleteTemplate(id: string): boolean {
		const res = this.db.prepare("DELETE FROM templates WHERE id = ?").run(id);
		return Number(res.changes) > 0;
	}

	// ─── assignments ─────────────────────────────────────────

	private baseAssignmentQuery(): string {
		return `SELECT a.*, t.name AS templateName, u.name AS userName
			FROM assignments a
			LEFT JOIN templates t ON t.id = a.templateId
			LEFT JOIN users u ON u.id = a.userId`;
	}

	listAssignments(filter: { userId?: string; templateId?: string; status?: AssignmentStatus } = {}): AssignmentView[] {
		const clauses: string[] = [];
		const params: Array<string> = [];
		if (filter.userId) {
			clauses.push("a.userId = ?");
			params.push(filter.userId);
		}
		if (filter.templateId) {
			clauses.push("a.templateId = ?");
			params.push(filter.templateId);
		}
		if (filter.status) {
			clauses.push("a.status = ?");
			params.push(filter.status);
		}
		const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
		const sql = `${this.baseAssignmentQuery()}${where} ORDER BY a.assignedAt DESC`;
		const rows = this.db.prepare(sql).all(...params) as Row[];
		return rows.map((r) => this.decorateAssignment(toAssignment(r), r));
	}

	getAssignment(id: string): AssignmentView | null {
		const row = this.db.prepare(`${this.baseAssignmentQuery()} WHERE a.id = ?`).get(id) as Row | undefined;
		if (!row) return null;
		return this.decorateAssignment(toAssignment(row), row);
	}

	private decorateAssignment(a: Assignment, row: Row): AssignmentView {
		const tpl = this.getTemplate(a.templateId);
		return {
			...a,
			templateName: row.templateName == null ? (tpl?.name ?? "(已删除模板)") : String(row.templateName),
			userName: row.userName == null ? a.userId : String(row.userName),
			fields: tpl?.fields ?? [],
			sourceImages: tpl?.sourceImages ?? [],
		};
	}

	/** 创建分派；同一模板 + 同一人存在 pending 时抛出 duplicate_pending */
	createAssignment(input: {
		templateId: string;
		userId: string;
		assignedBy: string;
		note?: string | null;
	}): AssignmentView {
		if (!this.getTemplate(input.templateId)) {
			throw new RepoError("not_found", "模板不存在");
		}
		if (!this.getUser(input.userId)) {
			throw new RepoError("not_found", "用户不存在");
		}
		const dup = this.db
			.prepare("SELECT id FROM assignments WHERE templateId = ? AND userId = ? AND status = 'pending'")
			.get(input.templateId, input.userId) as Row | undefined;
		if (dup) {
			throw new RepoError("duplicate_pending", "该模板已分派给此人且尚未提交");
		}
		const id = `asg_${randomUUID()}`;
		this.db
			.prepare(
				"INSERT INTO assignments (id, templateId, userId, assignedBy, assignedAt, status, submittedAt, submissionId, note) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?)",
			)
			.run(id, input.templateId, input.userId, input.assignedBy, Date.now(), input.note ?? null);
		return this.getAssignment(id)!;
	}

	revokeAssignment(id: string): AssignmentView {
		const a = this.getAssignment(id);
		if (!a) throw new RepoError("not_found", "分派记录不存在");
		if (a.status === "submitted") {
			throw new RepoError("assignment_locked", "该任务已提交，无法撤回");
		}
		this.db.prepare("UPDATE assignments SET status = 'revoked' WHERE id = ?").run(id);
		return this.getAssignment(id)!;
	}

	/** 提交：锁定任务（status → submitted）；已提交或已撤回时抛错 */
	markSubmitted(id: string, submissionId: string): AssignmentView {
		const a = this.getAssignment(id);
		if (!a) throw new RepoError("not_found", "分派记录不存在");
		if (a.status === "submitted") throw new RepoError("assignment_locked", "该任务已提交");
		if (a.status === "revoked") throw new RepoError("assignment_locked", "该任务已被撤回，无法提交");
		this.db
			.prepare("UPDATE assignments SET status = 'submitted', submittedAt = ?, submissionId = ? WHERE id = ?")
			.run(Date.now(), submissionId, id);
		return this.getAssignment(id)!;
	}

	// ─── submissions ─────────────────────────────────────────

	createSubmission(input: {
		assignmentId: string;
		templateId: string;
		userId: string;
		snapshot: Record<string, unknown>;
		images: string[];
	}): Submission {
		const id = `sub_${randomUUID()}`;
		this.db
			.prepare(
				"INSERT INTO submissions (id, assignmentId, templateId, userId, snapshot, images, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				id,
				input.assignmentId,
				input.templateId,
				input.userId,
				JSON.stringify(input.snapshot),
				JSON.stringify(input.images),
				Date.now(),
			);
		return this.getSubmission(id)!;
	}

	getSubmission(id: string): Submission | null {
		const row = this.db.prepare("SELECT * FROM submissions WHERE id = ?").get(id) as Row | undefined;
		return row ? toSubmission(row) : null;
	}

	listSubmissions(filter: { userId?: string; templateId?: string } = {}): SubmissionView[] {
		const clauses: string[] = [];
		const params: string[] = [];
		if (filter.userId) {
			clauses.push("s.userId = ?");
			params.push(filter.userId);
		}
		if (filter.templateId) {
			clauses.push("s.templateId = ?");
			params.push(filter.templateId);
		}
		const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.db
			.prepare(
				`SELECT s.*, t.name AS templateName, u.name AS userName
				 FROM submissions s
				 LEFT JOIN templates t ON t.id = s.templateId
				 LEFT JOIN users u ON u.id = s.userId
				 ${where} ORDER BY s.createdAt DESC`,
			)
			.all(...params) as Row[];
		return rows.map((r) => this.decorateSubmission(toSubmission(r), r));
	}

	getSubmissionView(id: string): SubmissionView | null {
		const row = this.db
			.prepare(
				`SELECT s.*, t.name AS templateName, u.name AS userName
				 FROM submissions s
				 LEFT JOIN templates t ON t.id = s.templateId
				 LEFT JOIN users u ON u.id = s.userId
				 WHERE s.id = ?`,
			)
			.get(id) as Row | undefined;
		if (!row) return null;
		return this.decorateSubmission(toSubmission(row), row);
	}

	private decorateSubmission(s: Submission, row: Row): SubmissionView {
		return {
			...s,
			templateName: row.templateName == null ? "(已删除模板)" : String(row.templateName),
			userName: row.userName == null ? s.userId : String(row.userName),
			imageRefs: this.getImages(s.images).map((img) => ({ id: img.id, name: img.fileName })),
		};
	}
}

let cachedRepo: Repo | null = null;

/** 进程级单例（route handler 使用） */
export function getRepo(): Repo {
	if (cachedRepo) return cachedRepo;
	cachedRepo = new Repo(getDb());
	return cachedRepo;
}

/** 工厂（测试注入临时 DB） */
export function createRepo(db: DatabaseSync): Repo {
	return new Repo(db);
}
