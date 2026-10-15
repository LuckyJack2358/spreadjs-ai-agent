import type { AppUIMessage, ContextCompactedData, ReplyMetrics } from "@/lib/agent/ui-message";
import type { TaskPlan } from "@/lib/agent/task-types";
import { parseUploadId } from "@/lib/agent/image-ref";

// ============================================================================
// 会话历史存储 — 基于 IndexedDB 的本地持久化
// ============================================================================

export interface Session {
	id: string;
	title: string;
	messages: AppUIMessage[];
	/** messageId → snapshotId 映射，记录每条用户消息发送前的 SpreadJS 快照 */
	snapshotMap?: Record<string, string>;
	/** 会话级任务计划列表，支持多计划历史 */
	taskPlans?: TaskPlan[];
	/** 最近一次 AI 回复后的真实 token 用量（用于切换会话时恢复上下文用量显示） */
	tokenUsage?: {
		promptTokens: number;
		contextWindow: number;
		model?: string;
		contextWindowSource?: "env" | "model-map" | "default";
	};
	/** assistantMessageId → 本轮 AI 回复耗时（毫秒），用于历史会话恢复展示 */
	replyDurations?: Record<string, number>;
	replyMetrics?: Record<string, ReplyMetrics>;
	/** 服务端上下文自动压缩状态（累积摘要 + 水位线，下一次请求回传给服务端做增量摘要） */
	compaction?: ContextCompactedData;
	workflowState?: {
		active: boolean;
		phase: "inspect" | "build" | "verify" | "finalize";
		phaseStep: number;
		totalStep: number;
	};
	createdAt: number;
	updatedAt: number;
}

/** 列表展示用的轻量摘要，不含 messages */
export interface SessionSummary {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
}

const DB_NAME = "spreadjs-agent-sessions";
const DB_VERSION = 1;
const STORE_NAME = "sessions";
export const PAGE_SIZE = 50;

let dbPromise: Promise<IDBDatabase> | null = null;

const PERSISTED_TOOL_OUTPUT_LIMIT = 6_000;
const PERSISTED_PREVIEW_LIMIT = 900;
const IMPORTANT_PERSISTED_TOOLS = new Set([
	"save_template",
	"assign_template",
	"propose_fill_data",
	"submit_submission",
	"load_template",
	"list_my_assignments",
	"ask_user",
	"add_tasks",
	"complete_task",
]);

function stripLargeImageValues(value: unknown): unknown {
	if (typeof value === "string") {
		if (value.startsWith("data:image/")) return "[image data omitted; uploadId retained when available]";
		return value;
	}
	if (Array.isArray(value)) return value.map((item) => stripLargeImageValues(item));
	if (!value || typeof value !== "object") return value;
	const output: Record<string, unknown> = {};
	for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
		if ((childKey === "dataUrl" || childKey === "imageBase64") && typeof childValue === "string") {
			output[childKey] = "[image omitted]";
			continue;
		}
		output[childKey] = stripLargeImageValues(childValue);
	}
	return output;
}

function compactToolOutput(output: unknown): unknown {
	if (output && typeof output === "object" && !Array.isArray(output)) {
		const candidate = output as { type?: unknown; value?: unknown };
		if (candidate.type === "content" && Array.isArray(candidate.value)) {
			return {
				type: "content",
				value: candidate.value.map((part) => {
					if (part && typeof part === "object" && (part as { type?: unknown }).type === "media") {
						return { type: "text", text: "[截图已省略，原结果包含图片媒体]" };
					}
					return stripLargeImageValues(part);
				}),
			};
		}
	}
	const cleaned = stripLargeImageValues(output);
	let serialized = "";
	try { serialized = JSON.stringify(cleaned) ?? ""; } catch { serialized = String(cleaned); }
	if (serialized.length <= PERSISTED_TOOL_OUTPUT_LIMIT) return cleaned;
	return {
		truncated: true,
		note: "工具结果已裁剪，仅保留持久化预览",
		originalChars: serialized.length,
		preview: serialized.slice(0, PERSISTED_PREVIEW_LIMIT),
	};
}

/** 只压缩 IndexedDB 副本；运行中的 messages 保持完整，避免影响当前 UI 与工具流程。 */
export function compactPersistedMessages(messages: AppUIMessage[]): AppUIMessage[] {
	return messages.map((message) => ({
		...message,
		parts: message.parts.map((part) => {
			if (part.type === "file") {
				const imageId = parseUploadId(part.url);
				return {
					...part,
					url: imageId ? part.url : "[image data omitted]",
				};
			}
			if (part.type !== "dynamic-tool" && !String(part.type).startsWith("tool-")) {
				return part;
			}
			const toolName = part.type === "dynamic-tool" ? part.toolName : String(part.type).slice(5);
			const next = { ...part } as Record<string, unknown>;
			if ("input" in next) next.input = stripLargeImageValues(next.input);
			if ("output" in next && !IMPORTANT_PERSISTED_TOOLS.has(toolName)) next.output = compactToolOutput(next.output);
			else if ("output" in next) next.output = stripLargeImageValues(next.output);
			return next as typeof part;
		}),
	}));
}

function openDB(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = (e) => {
			const db = (e.target as IDBOpenDBRequest).result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
				store.createIndex("updatedAt", "updatedAt", { unique: false });
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

export async function saveSession(session: Session): Promise<void> {
	const db = await openDB();
	const tx = db.transaction(STORE_NAME, "readwrite");
	const persisted: Session = {
		...session,
		messages: compactPersistedMessages(session.messages),
	};
	await promisify(tx.objectStore(STORE_NAME).put(persisted));
}

export async function getSession(id: string): Promise<Session | undefined> {
	const db = await openDB();
	const tx = db.transaction(STORE_NAME, "readonly");
	return promisify(tx.objectStore(STORE_NAME).get(id));
}

export async function deleteSession(id: string): Promise<void> {
	const db = await openDB();
	const tx = db.transaction(STORE_NAME, "readwrite");
	await promisify(tx.objectStore(STORE_NAME).delete(id));
}

export async function clearAllSessions(): Promise<void> {
	const db = await openDB();
	const tx = db.transaction(STORE_NAME, "readwrite");
	await promisify(tx.objectStore(STORE_NAME).clear());
}

/** 批量删除指定前缀的所有会话（用于按用户清空） */
export async function clearSessionsByPrefix(prefix: string): Promise<void> {
	const db = await openDB();
	const tx = db.transaction(STORE_NAME, "readwrite");
	const store = tx.objectStore(STORE_NAME);
	const keys: IDBValidKey[] = await new Promise((resolve, reject) => {
		const req = store.getAllKeys();
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	await Promise.all(
		keys.filter((k) => typeof k === "string" && k.startsWith(prefix)).map((k) => promisify(store.delete(k))),
	);
}

function toSummary(s: Session): SessionSummary {
	return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt };
}

/**
 * 按 updatedAt 降序分页获取会话摘要（不含 messages）
 */
export async function listSessionSummaries(
	offset: number = 0,
	limit: number = PAGE_SIZE,
	prefix?: string,
): Promise<{ sessions: SessionSummary[]; total: number }> {
	const db = await openDB();
	const tx = db.transaction(STORE_NAME, "readonly");
	const store = tx.objectStore(STORE_NAME);

	const total: number = await promisify(store.count());
	const match = (s: Session) => !prefix || s.id.startsWith(prefix);

	const sessions: SessionSummary[] = await new Promise((resolve, reject) => {
		const index = store.index("updatedAt");
		const result: SessionSummary[] = [];
		let skipped = 0;
		const req = index.openCursor(null, "prev");
		req.onsuccess = () => {
			const cursor = req.result;
			if (!cursor) {
				resolve(result);
				return;
			}
			const value = cursor.value as Session;
			if (!match(value)) {
				cursor.continue();
				return;
			}
			if (skipped < offset) {
				skipped++;
				cursor.continue();
				return;
			}
			if (result.length < limit) {
				result.push(toSummary(value));
				cursor.continue();
			} else {
				resolve(result);
			}
		};
		req.onerror = () => reject(req.error);
	});

	const filteredTotal = prefix
		? await new Promise<number>((resolve, reject) => {
				let count = 0;
				const req = store.index("updatedAt").openCursor(null, "prev");
				req.onsuccess = () => {
					const cursor = req.result;
					if (!cursor) {
						resolve(count);
						return;
					}
					if (match(cursor.value as Session)) count++;
					cursor.continue();
				};
				req.onerror = () => reject(req.error);
		  })
		: total;

	return { sessions, total: filteredTotal };
}

/**
 * 搜索会话标题，返回摘要（不含 messages）
 */
export async function searchSessionSummaries(
	query: string,
	offset: number = 0,
	limit: number = PAGE_SIZE,
	prefix?: string,
): Promise<{ sessions: SessionSummary[]; total: number }> {
	const db = await openDB();
	const tx = db.transaction(STORE_NAME, "readonly");
	const store = tx.objectStore(STORE_NAME);
	const lower = query.toLowerCase();

	const all: SessionSummary[] = await new Promise((resolve, reject) => {
		const index = store.index("updatedAt");
		const result: SessionSummary[] = [];
		const req = index.openCursor(null, "prev");
		req.onsuccess = () => {
			const cursor = req.result;
			if (!cursor) {
				resolve(result);
				return;
			}
			const s = cursor.value as Session;
			if ((!prefix || s.id.startsWith(prefix)) && s.title.toLowerCase().includes(lower)) {
				result.push(toSummary(s));
			}
			cursor.continue();
		};
		req.onerror = () => reject(req.error);
	});

	return {
		sessions: all.slice(offset, offset + limit),
		total: all.length,
	};
}

/**
 * 按 updatedAt 降序分页获取会话列表（含完整 messages）
 */
export async function listSessions(
	offset: number = 0,
	limit: number = PAGE_SIZE,
): Promise<{ sessions: Session[]; total: number }> {
	const db = await openDB();
	const tx = db.transaction(STORE_NAME, "readonly");
	const store = tx.objectStore(STORE_NAME);

	const total: number = await promisify(store.count());

	const sessions: Session[] = await new Promise((resolve, reject) => {
		const index = store.index("updatedAt");
		const result: Session[] = [];
		let skipped = 0;
		const req = index.openCursor(null, "prev");
		req.onsuccess = () => {
			const cursor = req.result;
			if (!cursor) {
				resolve(result);
				return;
			}
			if (skipped < offset) {
				skipped++;
				cursor.continue();
				return;
			}
			if (result.length < limit) {
				result.push(cursor.value as Session);
				cursor.continue();
			} else {
				resolve(result);
			}
		};
		req.onerror = () => reject(req.error);
	});

	return { sessions, total };
}

/**
 * 搜索所有会话标题（全量搜索，不限页数，但返回结果按 offset/limit 分页）
 */
export async function searchSessions(
	query: string,
	offset: number = 0,
	limit: number = PAGE_SIZE,
): Promise<{ sessions: Session[]; total: number }> {
	const db = await openDB();
	const tx = db.transaction(STORE_NAME, "readonly");
	const store = tx.objectStore(STORE_NAME);
	const lower = query.toLowerCase();

	const all: Session[] = await new Promise((resolve, reject) => {
		const index = store.index("updatedAt");
		const result: Session[] = [];
		const req = index.openCursor(null, "prev");
		req.onsuccess = () => {
			const cursor = req.result;
			if (!cursor) {
				resolve(result);
				return;
			}
			const s = cursor.value as Session;
			if (s.title.toLowerCase().includes(lower)) {
				result.push(s);
			}
			cursor.continue();
		};
		req.onerror = () => reject(req.error);
	});

	return {
		sessions: all.slice(offset, offset + limit),
		total: all.length,
	};
}

/** 生成会话 id；可传前缀实现「按用户隔离」（如 u_user1_sess_...） */
export function generateSessionId(prefix: string = "sess"): string {
	return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
