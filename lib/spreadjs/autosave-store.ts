// ============================================================================
// IndexedDB 自动保存存储 — 用于保存/恢复 SpreadJS 工作簿 JSON
// 仅保存一份 JSON，后续保存覆盖前一份。
// ============================================================================

import type { SpreadWorkbook } from "@/lib/agent/types";

const DB_NAME = "spreadjs-agent-autosave";
const DB_VERSION = 1;
const STORE_NAME = "autosave";
const RECORD_KEY_PREFIX = "current:";

/** 每个用户一份自动保存记录，避免身份切换后看到他人的画布 */
function recordKey(userId: string): string {
	return `${RECORD_KEY_PREFIX}${userId}`;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = (e) => {
			const db = (e.target as IDBOpenDBRequest).result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME);
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

/** 保存工作簿 JSON 到 IndexedDB（按用户覆盖写） */
export async function saveWorkbook(workbook: SpreadWorkbook, userId: string): Promise<void> {
	const data = workbook.toJSON();
	const db = await openDB();
	const tx = db.transaction(STORE_NAME, "readwrite");
	await promisify(tx.objectStore(STORE_NAME).put(data, recordKey(userId)));
}

/** 从 IndexedDB 读取工作簿 JSON，不存在时返回 null */
export async function loadWorkbook(userId: string): Promise<object | null> {
	try {
		const db = await openDB();
		const tx = db.transaction(STORE_NAME, "readonly");
		const result = await promisify(tx.objectStore(STORE_NAME).get(recordKey(userId)));
		return result ?? null;
	} catch {
		return null;
	}
}

/** 检查是否存在已保存的工作簿数据 */
export async function hasAutoSaveData(userId: string): Promise<boolean> {
	try {
		const db = await openDB();
		const tx = db.transaction(STORE_NAME, "readonly");
		const count = await promisify(tx.objectStore(STORE_NAME).count(recordKey(userId)));
		return count > 0;
	} catch {
		return false;
	}
}

/** 清除保存的工作簿 JSON */
export async function clearWorkbook(userId: string): Promise<void> {
	try {
		const db = await openDB();
		const tx = db.transaction(STORE_NAME, "readwrite");
		await promisify(tx.objectStore(STORE_NAME).delete(recordKey(userId)));
	} catch {
		// ignore
	}
}
