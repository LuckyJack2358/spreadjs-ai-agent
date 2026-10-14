"use client";

// ============================================================================
// useUser — 全局身份上下文（cookie sjs_uid），供 TopBar / ChatPanel / 工具分发使用
// 切换身份 = POST /api/identity 后整页刷新：
//   新身份下 ChatPanel 会按各自 userId 重新加载工作簿与会话，
//   避免“A 的表留在 B 的画布上”。
// ============================================================================

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react";
import type { User, UserRole } from "@/lib/server/types";

interface UserContextValue {
	user: User;
	users: User[];
	role: UserRole;
	userId: string;
	isAdmin: boolean;
	loading: boolean;
	error: string | null;
	/** 切换身份：写入 cookie 后整页刷新 */
	switchUser: (userId: string) => Promise<void>;
	/** 重新拉取身份与用户列表 */
	reloadUsers: () => Promise<void>;
}

const UserContext = createContext<UserContextValue | null>(null);

export function UserProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<User | null>(null);
	const [users, setUsers] = useState<User[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const [identityRes, usersRes] = await Promise.all([
				fetch("/api/identity", { cache: "no-store" }),
				fetch("/api/users", { cache: "no-store" }),
			]);
			if (!identityRes.ok) throw new Error(`身份读取失败（${identityRes.status}）`);
			const identity = (await identityRes.json()) as { user?: User };
			const list = usersRes.ok
				? ((await usersRes.json()) as { users?: User[] }).users ?? []
				: [];
			if (!identity.user) throw new Error("身份数据为空");
			setUser(identity.user);
			setUsers(list);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : "身份加载失败");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const switchUser = useCallback(async (nextUserId: string) => {
		try {
			await fetch("/api/identity", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ userId: nextUserId }),
			});
		} catch {
			// 忽略网络错误，仍尝试刷新以回到服务端当前身份
		}
		if (typeof window !== "undefined") {
			window.location.reload();
		}
	}, []);

	const value = useMemo<UserContextValue | null>(() => {
		if (!user) return null;
		return {
			user,
			users,
			role: user.role,
			userId: user.id,
			isAdmin: user.role === "admin",
			loading,
			error,
			switchUser,
			reloadUsers: load,
		};
	}, [user, users, loading, error, switchUser, load]);

	if (!value) {
		return (
			<div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
				{error ? `身份加载失败：${error}` : "正在加载身份…"}
			</div>
		);
	}

	return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}

export function useUser(): UserContextValue {
	const ctx = useContext(UserContext);
	if (!ctx) throw new Error("useUser 必须在 UserProvider 内使用");
	return ctx;
}
