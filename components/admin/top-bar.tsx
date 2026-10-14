"use client";

// ============================================================================
// TopBar —— 顶部身份切换条 + 角色入口（管理员「管理」抽屉 / 员工「我的填报任务」抽屉）
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import { ChevronDownIcon, ClipboardListIcon, LayoutDashboardIcon, UserRoundIcon } from "lucide-react";
import { useUser } from "@/lib/hooks/useUser";
import { subscribeFormData } from "@/lib/agent/form-context";
import { AdminDrawer } from "@/components/admin/admin-drawer";
import { EmployeeDrawer } from "@/components/admin/employee-drawer";
import { getJson } from "@/components/admin/admin-api";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function TopBar() {
	const { user, users, isAdmin, switchUser } = useUser();
	const [adminOpen, setAdminOpen] = useState(false);
	const [employeeOpen, setEmployeeOpen] = useState(false);
	const [pendingCount, setPendingCount] = useState<number | null>(null);

	const refreshPending = useCallback(async () => {
		if (isAdmin) return;
		try {
			const res = await getJson<{ assignments: Array<{ status: string }> }>("/api/assignments?scope=mine");
			setPendingCount(res.assignments.filter((a) => a.status === "pending").length);
		} catch {
			setPendingCount(null);
		}
	}, [isAdmin]);

	// 首次挂载 / 角色切换时拉取待办数量（await 之后再 setState，避免同步渲染级联）
	useEffect(() => {
		let cancelled = false;
		(async () => {
			if (isAdmin) return;
			try {
				const res = await getJson<{ assignments: Array<{ status: string }> }>("/api/assignments?scope=mine");
				if (!cancelled) {
					setPendingCount(res.assignments.filter((a) => a.status === "pending").length);
				}
			} catch {
				if (!cancelled) setPendingCount(null);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [isAdmin, refreshPending]);

	useEffect(() => subscribeFormData(() => { void refreshPending(); }), [refreshPending]);

	return (
		<>
			<header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3">
				<span className="text-xs font-semibold tracking-tight text-foreground">单据模板化填报</span>
				<span className="hidden text-[11px] text-muted-foreground sm:inline">
					{isAdmin ? "管理员：建模板 · 分派 · 查阅提交" : "员工：接收任务 · 上传单据 · 识别填报"}
				</span>

				<div className="ml-auto flex items-center gap-1.5">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
								title="切换身份（演示用，无需密码）"
							>
								<UserRoundIcon className="size-3.5 text-muted-foreground" />
								<span className="max-w-[140px] truncate">
									{user.name}
									<span className="ml-1 text-muted-foreground">
										（{isAdmin ? "管理员" : user.department ?? "员工"}）
									</span>
								</span>
								<ChevronDownIcon className="size-3 text-muted-foreground" />
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="max-h-[70vh] w-52 overflow-y-auto">
							<DropdownMenuLabel className="text-[11px] text-muted-foreground">切换身份</DropdownMenuLabel>
							<DropdownMenuSeparator />
							{users.map((u) => (
								<DropdownMenuItem
									key={u.id}
									disabled={u.id === user.id}
									onSelect={() => {
										if (u.id !== user.id) void switchUser(u.id);
									}}
									className="text-[12px]"
								>
									<span className="flex-1 truncate">{u.name}</span>
									<span className="shrink-0 text-[10px] text-muted-foreground">
										{u.role === "admin" ? "管理员" : u.department ?? "员工"}
									</span>
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>

					{isAdmin ? (
						<button
							type="button"
							onClick={() => setAdminOpen(true)}
							className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<LayoutDashboardIcon className="size-3.5" />
							管理
						</button>
					) : (
						<button
							type="button"
							onClick={() => setEmployeeOpen(true)}
							className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<ClipboardListIcon className="size-3.5" />
							我的填报任务
							{pendingCount != null && pendingCount > 0 && (
								<span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
									{pendingCount}
								</span>
							)}
						</button>
					)}
				</div>
			</header>

			<AdminDrawer open={adminOpen} onClose={() => setAdminOpen(false)} />
			<EmployeeDrawer open={employeeOpen} onClose={() => setEmployeeOpen(false)} />
		</>
	);
}
