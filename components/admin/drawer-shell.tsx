"use client";

// ============================================================================
// DrawerShell —— 右侧滑出抽屉外壳（顶部 TopBar 的「管理」/「我的填报任务」入口）
// ============================================================================

import type { ReactNode } from "react";
import { XIcon } from "lucide-react";

interface DrawerShellProps {
	open: boolean;
	onClose: () => void;
	title: string;
	subtitle?: string;
	width?: number;
	children: ReactNode;
}

export function DrawerShell({ open, onClose, title, subtitle, width = 460, children }: DrawerShellProps) {
	if (!open) return null;
	return (
		<>
			<div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} aria-hidden />
			<aside
				className="fixed right-0 top-0 z-50 flex h-screen flex-col border-l border-border/60 bg-background shadow-2xl"
				style={{ width }}
			>
				<div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
					<div className="flex min-w-0 flex-1 flex-col">
						<h2 className="truncate text-sm font-semibold leading-tight">{title}</h2>
						{subtitle && (
							<span className="truncate text-[11px] leading-tight text-muted-foreground">{subtitle}</span>
						)}
					</div>
					<button
						type="button"
						onClick={onClose}
						className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						title="关闭"
					>
						<XIcon className="size-4" />
					</button>
				</div>
				<div className="chat-scrollbar flex-1 overflow-y-auto px-4 py-3">{children}</div>
			</aside>
		</>
	);
}