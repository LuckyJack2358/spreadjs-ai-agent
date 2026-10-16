"use client";

// ============================================================================
// 管理抽屉（管理员）：模板库 / 分派记录 / 提交记录
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import {
	AlertCircleIcon,
	FileSpreadsheetIcon,
	LayoutTemplateIcon,
	LoaderIcon,
	RefreshCwIcon,
	RulerIcon,
	SaveIcon,
	SendIcon,
	Trash2Icon,
	Undo2Icon,
	UploadIcon,
} from "lucide-react";
import { loadBridge } from "@/lib/tools/types";
import { useSpreadJS } from "@/lib/spreadjs/context";
import { normalizeTemplateSnapshot } from "@/lib/spreadjs/normalize-template-snapshot";
import { getFormContext, setFormContext, subscribeFormData, useFormContext } from "@/lib/agent/form-context";
import type { AssignmentView, SubmissionView, TemplateRecord } from "@/lib/server/types";
import { DrawerShell } from "@/components/admin/drawer-shell";
import { describeError, formatTime, getJson, postJson } from "@/components/admin/admin-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ZoomableImage } from "@/components/ui/zoomable-image";

const SubmissionPreviewDialog = dynamic(() => import("@/components/admin/submission-preview-dialog"), {
	ssr: false,
	loading: () => null,
});

type TabKey = "templates" | "assignments" | "submissions";

const STATUS_LABEL: Record<AssignmentView["status"], string> = {
	pending: "待填报",
	submitted: "已提交",
	revoked: "已撤回",
};

const STATUS_CLASS: Record<AssignmentView["status"], string> = {
	pending: "border-amber-500/50 text-amber-600 dark:text-amber-400",
	submitted: "border-emerald-500/50 text-emerald-600 dark:text-emerald-400",
	revoked: "border-border text-muted-foreground",
};

interface AdminDrawerProps {
	open: boolean;
	onClose: () => void;
}

export function AdminDrawer({ open, onClose }: AdminDrawerProps) {
	const { workbook } = useSpreadJS();
	// 画布当前挂着的模板（AI 保存模板 / 点「载入画布」时写入），用于判断能否「保存为新版本」
	const formCtx = useFormContext();
	const activeTemplateId = formCtx?.templateId ?? null;
	const [tab, setTab] = useState<TabKey>("templates");
	const [templates, setTemplates] = useState<TemplateRecord[]>([]);
	const [assignments, setAssignments] = useState<AssignmentView[]>([]);
	const [submissions, setSubmissions] = useState<SubmissionView[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [preview, setPreview] = useState<SubmissionView | null>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [t, a, s] = await Promise.all([
				getJson<{ templates: TemplateRecord[] }>("/api/templates"),
				getJson<{ assignments: AssignmentView[] }>("/api/assignments?scope=all"),
				getJson<{ submissions: SubmissionView[] }>("/api/submissions?scope=all"),
			]);
			setTemplates(t.templates);
			setAssignments(a.assignments);
			setSubmissions(s.submissions);
		} catch (e) {
			setError(describeError(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (open) void reload();
	}, [open, reload]);

	// AI 通过工具改动数据后自动刷新
	useEffect(() => subscribeFormData(() => { void reload(); }), [reload]);

	const handleLoadTemplate = useCallback(
		(template: TemplateRecord) => {
			if (!workbook) {
				setError("SpreadJS 尚未初始化");
				return;
			}
			try {
				// 兜底清理：早期保存的模板可能带「合并区重复值 / 相邻重复标签 / 值位被标签占位」
				const cleanup = normalizeTemplateSnapshot(
					JSON.parse(JSON.stringify(template.snapshot)) as Record<string, unknown>,
					template.fields,
				);
				workbook.suspendPaint();
				try {
					workbook.fromJSON(cleanup.snapshot);
				} finally {
					workbook.resumePaint();
				}
				setFormContext({
					assignmentId: null,
					templateId: template.id,
					templateName: template.name,
					fields: template.fields,
					sourceImages: template.sourceImages ?? [],
				});
				setNotice(
					cleanup.changed
						? `已把模板「${template.name}」载入画布（顺带清理了残余内容：${cleanup.notes.join("；")}）`
						: `已把模板「${template.name}」载入画布`,
				);
				setError(null);
			} catch (e) {
				setError(describeError(e));
			}
		},
		[workbook],
	);

	const handleDeleteTemplate = useCallback(
		async (template: TemplateRecord) => {
			if (typeof window !== "undefined" && !window.confirm(`确认删除模板「${template.name}」？`)) return;
			try {
				const res = await fetch(`/api/templates/${template.id}`, { method: "DELETE" });
				if (!res.ok) throw new Error(`删除失败（HTTP ${res.status}）`);
				setNotice(`已删除模板「${template.name}」`);
				await reload();
			} catch (e) {
				setError(describeError(e));
			}
		},
		[reload],
	);

	/** 一键按内容适配行高列宽（合并区感知） */
	const handleAutoFit = useCallback(async () => {
		if (!workbook) {
			setError("SpreadJS 尚未初始化");
			return;
		}
		try {
			const bridge = await loadBridge();
			const res = bridge.autoFitWorkbook(workbook, true);
			if (!res.success || !res.data) throw new Error(res.error ?? "自适应失败");
			const { fittedColumns, fittedRows } = res.data.sheets.reduce(
				(acc, s) => ({ fittedColumns: acc.fittedColumns + s.fittedColumns, fittedRows: acc.fittedRows + s.fittedRows }),
				{ fittedColumns: 0, fittedRows: 0 },
			);
			setError(null);
			setNotice(`已按内容适配版式：${fittedColumns} 列 / ${fittedRows} 行`);
		} catch (e) {
			setError(describeError(e));
		}
	}, [workbook]);

	/** 管理员微调画布后，把当前画布另存为该模板的新版本（同名覆盖 → version + 1） */
	const handleSaveNewVersion = useCallback(
		async (template: TemplateRecord) => {
			if (!workbook) {
				setError("SpreadJS 尚未初始化");
				return;
			}
			// 防呆：画布上必须是这个模板，否则会把 A 的表型存进 B
			if (getFormContext()?.templateId !== template.id) {
				setError(`画布上当前不是「${template.name}」，请先点「载入画布」再保存新版本`);
				return;
			}
			setError(null);
			try {
				const snapshot = workbook.toJSON() as Record<string, unknown>;
				const ctx = getFormContext();
				const fields = ctx?.fields?.length ? ctx.fields : template.fields;
				const res = await postJson<{ template: TemplateRecord; cleanup?: { changed: boolean; notes: string[] } }>(
					"/api/templates",
					{
						name: template.name,
						description: template.description,
						snapshot,
						fields,
						// 必须沿用原图，否则 UPDATE 会把模板原图清空
						sourceImages: template.sourceImages ?? [],
					},
				);
				// 回写 context：服务端会补齐 valueType、清理残余内容后的字段地图
				setFormContext({
					assignmentId: null,
					templateId: res.template.id,
					templateName: res.template.name,
					fields: res.template.fields,
					sourceImages: res.template.sourceImages ?? [],
				});
				const cleaned = res.cleanup?.changed ? "，并自动清理了残余内容" : "";
				setNotice(`已把「${res.template.name}」保存为 v${res.template.version}（字段 ${res.template.fields.length} 个）${cleaned}`);
				await reload();
			} catch (e) {
				setError(describeError(e));
			}
		},
		[workbook, reload],
	);

	const handleRevoke = useCallback(
		async (assignment: AssignmentView) => {
			try {
				await postJson(`/api/assignments/${assignment.id}/revoke`);
				setNotice(`已撤回「${assignment.templateName}」→ ${assignment.userName}`);
				await reload();
			} catch (e) {
				setError(describeError(e));
			}
		},
		[reload],
	);

	const counts = useMemo(
		() => ({
			templates: templates.length,
			pending: assignments.filter((a) => a.status === "pending").length,
			submissions: submissions.length,
		}),
		[templates, assignments, submissions],
	);

	const tabs: Array<{ key: TabKey; label: string; count: number }> = [
		{ key: "templates", label: "模板库", count: counts.templates },
		{ key: "assignments", label: "分派记录", count: counts.pending },
		{ key: "submissions", label: "提交记录", count: counts.submissions },
	];

	return (
		<>
			<DrawerShell
				open={open}
				onClose={onClose}
				title="管理工作台"
				subtitle="模板库 · 分派记录 · 提交记录"
				width={520}
			>
				<div className="mb-3 flex items-center gap-1">
					{tabs.map((t) => (
						<button
							key={t.key}
							type="button"
							onClick={() => setTab(t.key)}
							className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
								tab === t.key ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground"
							}`}
						>
							{t.label}
							<span className="ml-1 text-[10px] opacity-70">{t.count}</span>
						</button>
					))}
					<button
						type="button"
						onClick={() => void reload()}
						className="ml-auto inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
					<div className="mb-3 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
						{notice}
					</div>
				)}

				{loading && templates.length === 0 && assignments.length === 0 && submissions.length === 0 ? (
					<div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
						<LoaderIcon className="size-4 animate-spin" />
						加载中…
					</div>
				) : (
					<>
						{tab === "templates" && (
							<TemplateList
								templates={templates}
								activeTemplateId={activeTemplateId}
								onLoad={handleLoadTemplate}
								onDelete={handleDeleteTemplate}
								onSaveNewVersion={handleSaveNewVersion}
								onAutoFit={handleAutoFit}
							/>
						)}
						{tab === "assignments" && (
							<AssignmentList assignments={assignments} onRevoke={handleRevoke} />
						)}
						{tab === "submissions" && (
							<SubmissionList submissions={submissions} onPreview={setPreview} />
						)}
					</>
				)}
			</DrawerShell>

			<SubmissionPreviewDialog
				open={!!preview}
				onClose={() => setPreview(null)}
				title={preview ? `${preview.templateName} · ${preview.userName}` : ""}
				description={preview ? `提交时间：${formatTime(preview.createdAt)}` : undefined}
				snapshot={preview?.snapshot ?? null}
				images={preview?.imageRefs}
			/>
		</>
	);
}

// ─── 模板库 ──────────────────────────────────────────────────────────────

function TemplateList({
	templates,
	activeTemplateId,
	onLoad,
	onDelete,
	onSaveNewVersion,
	onAutoFit,
}: {
	templates: TemplateRecord[];
	activeTemplateId: string | null;
	onLoad: (t: TemplateRecord) => void;
	onDelete: (t: TemplateRecord) => void;
	onSaveNewVersion: (t: TemplateRecord) => void;
	onAutoFit: () => void;
}) {
	if (templates.length === 0) {
		return (
			<EmptyHint
				icon={<LayoutTemplateIcon className="size-5" />}
				text="还没有模板。在聊天里上传纸质单据图片，让 AI 生成模板后说「保存为模板，叫 XXX」。"
			/>
		);
	}
	return (
		<div className="space-y-2.5">
			{templates.map((t) => (
				<div key={t.id} className="rounded-lg border border-border/60 p-2.5">
					<div className="flex items-start gap-2">
						<FileSpreadsheetIcon className="mt-0.5 size-4 shrink-0 text-primary" />
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5">
								<span className="truncate text-[13px] font-medium">{t.name}</span>
								<Badge variant="outline" className="shrink-0 text-[10px]">v{t.version}</Badge>
							</div>
							{t.description && (
								<p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{t.description}</p>
							)}
							<p className="mt-0.5 text-[10px] text-muted-foreground">
								字段 {t.fields.length} 个 · 更新 {formatTime(t.updatedAt)}
							</p>
						</div>
					</div>

					{t.fields.length > 0 && (
						<div className="mt-2 flex flex-wrap gap-1">
							{t.fields.map((f, i) => (
								<span
									key={`${f.name}-${i}`}
									className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
									title={`${f.name} → ${f.sheetName ? `${f.sheetName}!` : ""}${f.address}`}
								>
									{f.name}
									<span className="ml-1 font-mono opacity-70">
										{f.sheetName ? `${f.sheetName}!` : ""}
										{f.address}
									</span>
								</span>
							))}
						</div>
					)}

					{t.sourceImages?.length > 0 && (
						<div className="mt-2 flex items-center gap-1.5 overflow-x-auto">
							{t.sourceImages.map((img) => (
								<ZoomableImage
									key={img.id}
									src={`/api/uploads/${img.id}`}
									alt={img.name}
									title={`模板原图 · ${img.name}`}
									className="size-12"
								/>
							))}
						</div>
					)}

					<div className="mt-2 flex items-center gap-1.5">
						<Button size="xs" variant="outline" onClick={() => onLoad(t)}>
							<UploadIcon className="size-3" />
							载入画布
						</Button>
						{/* 微调画布后另存为新版本：仅当该模板正挂在画布上时可点，避免串模板 */}
						<Button
							size="xs"
							variant="outline"
							disabled={activeTemplateId !== t.id}
							title={
								activeTemplateId === t.id
									? "把画布上当前内容保存为该模板的新版本"
									: "请先点「载入画布」，再在画布上微调后保存新版本"
							}
							onClick={() => onSaveNewVersion(t)}
						>
							<SaveIcon className="size-3" />
							保存新版本
						</Button>
						{activeTemplateId === t.id && (
							<Button
								size="xs"
								variant="ghost"
								title="按内容重新适配行高列宽（合并区感知）"
								onClick={() => onAutoFit()}
							>
								<RulerIcon className="size-3" />
								适配行列
							</Button>
						)}
						<Button
							size="xs"
							variant="ghost"
							className="text-muted-foreground hover:text-destructive"
							onClick={() => onDelete(t)}
						>
							<Trash2Icon className="size-3" />
							删除
						</Button>
					</div>
				</div>
			))}
		</div>
	);
}

// ─── 分派记录 ────────────────────────────────────────────────────────────

function AssignmentList({
	assignments,
	onRevoke,
}: {
	assignments: AssignmentView[];
	onRevoke: (a: AssignmentView) => void;
}) {
	if (assignments.length === 0) {
		return (
			<EmptyHint
				icon={<SendIcon className="size-5" />}
				text="还没有分派记录。在聊天里说「把<模板名>分派给张三」即可。"
			/>
		);
	}
	return (
		<div className="space-y-2">
			{assignments.map((a) => (
				<div key={a.id} className="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-2">
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-1.5">
							<span className="truncate text-[13px] font-medium">{a.templateName}</span>
							<Badge variant="outline" className={`shrink-0 text-[10px] ${STATUS_CLASS[a.status]}`}>
								{STATUS_LABEL[a.status]}
							</Badge>
						</div>
						<p className="mt-0.5 text-[11px] text-muted-foreground">
							{a.userName} · 分派于 {formatTime(a.assignedAt)}
							{a.submittedAt ? ` · 提交于 ${formatTime(a.submittedAt)}` : ""}
						</p>
						{a.note && <p className="mt-0.5 truncate text-[10px] text-muted-foreground">备注：{a.note}</p>}
					</div>
					{a.status === "pending" && (
						<Button size="xs" variant="outline" onClick={() => onRevoke(a)}>
							<Undo2Icon className="size-3" />
							撤回
						</Button>
					)}
				</div>
			))}
		</div>
	);
}

// ─── 提交记录 ────────────────────────────────────────────────────────────

function SubmissionList({
	submissions,
	onPreview,
}: {
	submissions: SubmissionView[];
	onPreview: (s: SubmissionView) => void;
}) {
	if (submissions.length === 0) {
		return <EmptyHint icon={<SendIcon className="size-5" />} text="还没有提交记录。" />;
	}
	return (
		<div className="space-y-2">
			{submissions.map((s) => (
				<div key={s.id} className="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-2">
					<div className="min-w-0 flex-1">
						<div className="truncate text-[13px] font-medium">
							{s.userName} · {s.templateName}
						</div>
						<p className="mt-0.5 text-[11px] text-muted-foreground">
							{formatTime(s.createdAt)}
							{s.imageRefs.length > 0 ? ` · 单据图 ${s.imageRefs.length} 张` : " · 无单据图"}
						</p>
					</div>
					<Button size="xs" variant="outline" onClick={() => onPreview(s)}>
						预览 / 导出
					</Button>
				</div>
			))}
		</div>
	);
}

function EmptyHint({ icon, text }: { icon: React.ReactNode; text: string }) {
	return (
		<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 px-4 py-8 text-center">
			<span className="text-muted-foreground">{icon}</span>
			<p className="text-[11px] leading-relaxed text-muted-foreground">{text}</p>
		</div>
	);
}
