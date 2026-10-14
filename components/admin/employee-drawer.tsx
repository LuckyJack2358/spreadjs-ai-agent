"use client";

// ============================================================================
// 员工抽屉：我的填报任务（待填报 → 开始填报 → 载入模板 → 上传已填写单据）
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import {
	AlertCircleIcon,
	CameraIcon,
	CheckCircle2Icon,
	ClipboardListIcon,
	LoaderIcon,
	PlayIcon,
	RefreshCwIcon,
} from "lucide-react";
import { useSpreadJS } from "@/lib/spreadjs/context";
import { setFormContext, subscribeFormData } from "@/lib/agent/form-context";
import type { AssignmentView, TemplateRecord } from "@/lib/server/types";
import { DrawerShell } from "@/components/admin/drawer-shell";
import { describeError, formatTime, getJson } from "@/components/admin/admin-api";
import { Badge } from "@/components/ui/badge";
import { ZoomableImage } from "@/components/ui/zoomable-image";
import { Button } from "@/components/ui/button";

const STATUS_LABEL: Record<AssignmentView["status"], string> = {
	pending: "待填报",
	submitted: "已提交",
	revoked: "已撤回",
};

interface EmployeeDrawerProps {
	open: boolean;
	onClose: () => void;
}

export function EmployeeDrawer({ open, onClose }: EmployeeDrawerProps) {
	const { workbook } = useSpreadJS();
	const [assignments, setAssignments] = useState<AssignmentView[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [loadingId, setLoadingId] = useState<string | null>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await getJson<{ assignments: AssignmentView[] }>("/api/assignments?scope=mine");
			setAssignments(res.assignments);
		} catch (e) {
			setError(describeError(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (open) void reload();
	}, [open, reload]);

	useEffect(() => subscribeFormData(() => { void reload(); }), [reload]);

	const handleStart = useCallback(
		async (assignment: AssignmentView) => {
			if (!workbook) {
				setError("SpreadJS 尚未初始化");
				return;
			}
			setLoadingId(assignment.id);
			setError(null);
			setNotice(null);
			try {
				const { template } = await getJson<{ template: TemplateRecord }>(
					`/api/templates/${encodeURIComponent(assignment.templateId)}`,
				);
				workbook.suspendPaint();
				try {
					workbook.fromJSON(template.snapshot);
				} finally {
					workbook.resumePaint();
				}
				setFormContext({
					assignmentId: assignment.id,
					templateId: template.id,
					templateName: template.name,
					fields: template.fields,
					sourceImages: template.sourceImages ?? [],
				});
				setNotice(
					`已载入「${template.name}」。接下来请把填写好的单据照片拖进聊天框（或点回形针上传），我会自动识别并填入模板。`,
				);
			} catch (e) {
				setError(describeError(e));
			} finally {
				setLoadingId(null);
			}
		},
		[workbook],
	);

	const pending = assignments.filter((a) => a.status === "pending");
	const finished = assignments.filter((a) => a.status !== "pending");

	return (
		<DrawerShell
			open={open}
			onClose={onClose}
			title="我的填报任务"
			subtitle={pending.length > 0 ? `${pending.length} 个待填报` : "暂无待填报任务"}
			width={420}
		>
			<div className="mb-3 flex items-center justify-end">
				<button
					type="button"
					onClick={() => void reload()}
					className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					title="刷新"
				>
					<RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
				</button>
			</div>

			{error && (
				<div className="mb-3 flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-destructive">
					<AlertCircleIcon className="mt-px size-3.5 shrink-0" />
					<span className="min-w-0 break-words">{error}</span>
				</div>
			)}
			{notice && !error && (
				<div className="mb-3 rounded-md border border-primary/40 bg-primary/5 px-2.5 py-1.5 text-[11px] text-foreground">
					{notice}
				</div>
			)}

			{loading && assignments.length === 0 ? (
				<div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
					<LoaderIcon className="size-4 animate-spin" />
					加载中…
				</div>
			) : assignments.length === 0 ? (
				<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 px-4 py-8 text-center">
					<ClipboardListIcon className="size-5 text-muted-foreground" />
					<p className="text-[11px] leading-relaxed text-muted-foreground">
						暂无分派给你的填报任务。等管理员分派后，这里会出现待填报单据。
					</p>
				</div>
			) : (
				<div className="space-y-3">
					{/* 待填报 */}
					<div className="space-y-2">
						{pending.length === 0 ? (
							<p className="text-[11px] text-muted-foreground">全部任务都已处理完毕。</p>
						) : (
							pending.map((a) => (
								<div key={a.id} className="rounded-lg border border-border/60 p-2.5">
									<div className="flex items-center gap-1.5">
										<span className="truncate text-[13px] font-medium">{a.templateName}</span>
										<Badge
											variant="outline"
											className="shrink-0 border-amber-500/50 text-[10px] text-amber-600 dark:text-amber-400"
										>
											待填报
										</Badge>
									</div>
									<p className="mt-0.5 text-[11px] text-muted-foreground">
										分派于 {formatTime(a.assignedAt)}
									</p>
									{a.note && (
										<p className="mt-0.5 text-[10px] text-muted-foreground">备注：{a.note}</p>
									)}
									{a.sourceImages?.length > 0 && (
										<div className="mt-2 flex items-center gap-1.5">
											{a.sourceImages.map((img) => (
												<ZoomableImage
													key={img.id}
													src={`/api/uploads/${img.id}`}
													alt={img.name}
													title={`${a.templateName} · 模板原图`}
													description="放大查看模板对应的原始单据，确认填写内容与字段位置。"
													className="size-14"
												/>
											))}
										</div>
									)}
									<div className="mt-2 flex items-center gap-1.5">
										<Button size="xs" onClick={() => void handleStart(a)} disabled={loadingId === a.id}>
											{loadingId === a.id ? (
												<LoaderIcon className="size-3 animate-spin" />
											) : (
												<PlayIcon className="size-3" />
											)}
											开始填报
										</Button>
										<span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
											<CameraIcon className="size-3" />
											载入后上传填写好的单据照片
										</span>
									</div>
								</div>
							))
						)}
					</div>

					{/* 已完成/已撤回 */}
					{finished.length > 0 && (
						<div className="space-y-1.5 border-t border-border/60 pt-2.5">
							<p className="text-[11px] font-medium text-muted-foreground">历史任务</p>
							{finished.map((a) => (
								<div key={a.id} className="flex items-center gap-2 text-[11px] text-muted-foreground">
									{a.status === "submitted" ? (
										<CheckCircle2Icon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
									) : (
										<span className="size-3.5 shrink-0 text-center leading-[14px]">—</span>
									)}
									<span className="min-w-0 flex-1 truncate">{a.templateName}</span>
									<span className="shrink-0">{STATUS_LABEL[a.status]}</span>
									<span className="shrink-0">{formatTime(a.submittedAt ?? a.assignedAt)}</span>
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</DrawerShell>
	);
}