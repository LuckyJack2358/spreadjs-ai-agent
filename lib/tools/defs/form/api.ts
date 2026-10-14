export interface ApiErrorShape {
	status: number;
	message: string;
	payload?: unknown;
}

export class ApiError extends Error {
	status: number;
	payload?: unknown;
	constructor(status: number, message: string, payload?: unknown) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.payload = payload;
	}
}

/**
 * 调用内部 API（相对路径，仅客户端可用）。
 * 非 2xx 时抛出 ApiError，错误体 { error } 作为 message。
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
	let res: Response;
	try {
		res = await fetch(path, {
			...init,
			headers: {
				...(init?.body ? { "Content-Type": "application/json" } : {}),
				...(init?.headers ?? {}),
			},
		});
	} catch (e) {
		throw new ApiError(0, `网络请求失败：${e instanceof Error ? e.message : String(e)}`);
	}

	let payload: unknown = null;
	try {
		payload = await res.json();
	} catch {
		payload = null;
	}

	if (!res.ok) {
		const message = (payload as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
		throw new ApiError(res.status, message, payload);
	}
	return payload as T;
}

/** 把 ApiError 转为工具返回的错误文案（保留服务端候选等附加信息） */
export function describeApiError(e: unknown): string {
	if (e instanceof ApiError) return e.message;
	return e instanceof Error ? e.message : String(e);
}
