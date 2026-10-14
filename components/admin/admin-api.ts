// ============================================================================
// 管理/填报抽屉使用的轻量 API 封装（与服务端 route handler 对应）
// ============================================================================

export async function getJson<T>(url: string): Promise<T> {
	const res = await fetch(url, { cache: "no-store" });
	let payload: unknown = null;
	try {
		payload = await res.json();
	} catch {
		payload = null;
	}
	if (!res.ok) {
		throw new Error((payload as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
	}
	return payload as T;
}

export async function postJson<T>(url: string, body?: unknown): Promise<T> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	let payload: unknown = null;
	try {
		payload = await res.json();
	} catch {
		payload = null;
	}
	if (!res.ok) {
		throw new Error((payload as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
	}
	return payload as T;
}

export function formatTime(ts: number | null | undefined): string {
	if (!ts) return "—";
	try {
		return new Date(ts).toLocaleString("zh-CN", { hour12: false });
	} catch {
		return String(ts);
	}
}

export function describeError(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}