"use client";

// ============================================================================
// 单据填报确认卡
// 状态机：idle → writing → written → submitted
//   1) AI 调用 propose_fill_data 后，卡片展示识别结果（低置信标「待核对」并可直接修正）
//   2) 「确认写入」把字段值按地址写入工作簿（低置信项以用户编辑值优先）
//   3) 「提交本次填报」上传单据图 + 工作簿快照，任务锁定
// 状态按 assignmentId 持久化到 localStorage，刷新/回看历史消息时可恢复。
// ============================================================================

import { useCallback, useMemo, useState } from "react";
import { AlertTriangleIcon, CheckCircle2Icon, ImageIcon, LoaderIcon, PenLineIcon, SendIcon } from "lucide-react";
import { useSpreadJS } from "@/lib/spreadjs/context";
import { writeFillItems } from "@/lib/spreadjs/fill-writer";
import submitSubmission from "@/lib/tools/defs/form/submit-submission";
import type { ProposeFillDataOutputData } from "@/lib/agent/ui-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ZoomableImage } from "@/components/ui/zoomable-image";

export interface FillImageAttachment {
	name: string;
	dataUrl: string;
	/** 附件阶段已落盘的 imageId：提交时直接复用，不再重传这张大图 */
	imageId?: string;
}

interface FillConfirmCardProps {
	data: ProposeFillDataOutputData;
	/** 收集当前会话中仍可用的单据图（name + dataUrl） */
	collectImages?: () => FillImageAttachment[];
	/** 写入完成后回调（用于触发自动保存） */
	onWritten?: () => void;
	/** 提交成功后回调（用于刷新任务列表） */
	onSubmitted?: (info: { submissionId: string; createdAt: number }) => void;
}

type CardState = "idle" | "writing" | "written" | "submitted";

interface PersistedCardState {
	state: CardState;
	values: Record<string, string>;
	submittedAt?: number;
	submissionId?: string;
}

const LOW_CONFIDENCE = 0.7;

function itemKey(field: string, address: string): string {
	return `${field}::${address}`;
}

function storageKey(assignmentId: string): string {
	return `sjs-fill-card:${assignmentId}`;
}

function loadPersisted(assignmentId: string): PersistedCardState | null {
	if (typeof window === "undefined") return null;
	try {
		const raw = window.localStorage.getItem(storageKey(assignmentId));
		if (!raw) return null;
		return JSON.parse(raw) as PersistedCardState;
	} catch {
		return null;
	}
}

function persist(assignmentId: string, value: PersistedCardState): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(storageKey(assignmentId), JSON.stringify(value));
	} catch {
		// 忽略配额错误
	}
}

function formatTime(ts?: number): string {
	if (!ts) return "";
	try {
		return new Date(ts).toLocaleString("zh-CN", { hour12: false });
	} catch {
		return String(ts);
	}
}

export function FillConfirmCard({ data, collectImages, onWritten, onSubmitted }: FillConfirmCardProps) {
	const { workbook } = useSpreadJS();
	const persisted = useMemo(() => loadPersisted(data.assignmentId), [data.assignmentId]);
	const [state, setState] = useState<CardState>(persisted?.state ?? "idle");
	const [values, setValues] = useState<Record<string, string>>(() => {
		const base: Record<string, string> = {};
		for (const it of data.items) base[itemKey(it.field, it.address)] = it.value ?? "";
		return { ...base, ...(persisted?.values ?? {}) };
	});
	const [submittedAt, setSubmittedAt] = useState<number | undefined>(persisted?.submittedAt);
	const [submissionId, setSubmissionId] = useState<string | undefined>(persisted?.submissionId);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [writeNote, setWriteNote] = useState<string | null>(null);

	const images = useMemo(() => {
		try {
			return collectImages?.() ?? [];
		} catch {
			return [];
		}
	}, [collectImages]);

	const locked = state === "submitted";

	const handleValueChange = useCallback((key: string, value: string) => {
		setValues((prev) => ({ ...prev, [key]: value }));
	}, []);

	const handleWrite = useCallback(async () => {
		if (!workbook || busy || locked) return;
		setBusy(true);
		setError(null);
		setState("writing");
		try {
			const items = data.items.map((it) => ({
				address: it.address,
				value: values[itemKey(it.field, it.address)] ?? it.value ?? "",
			}));
			const res = writeFillItems(workbook, items);
			const next: PersistedCardState = { state: "written", values };
			persist(data.assignmentId, next);
			setState("written");
			setWriteNote(
				res.failed.length > 0
					? `已写入 ${res.written} 项，${res.failed.length} 项失败：${res.failed.map((f) => `${f.address}（${f.reason}）`).join("、")}`
					: `已写入 ${res.written} 项`,
			);
			onWritten?.();
		} catch (e) {
			setState("idle");
			setError(e instanceof Error ? e.message : "写入失败");
		} finally {
			setBusy(false);
		}
	}, [workbook, busy, locked, data.items, data.assignmentId, values, onWritten]);

	const handleSubmit = useCallback(async () => {
		if (!workbook || busy || locked) return;
		const handler = submitSubmission.handler;
		if (!handler) {
			setError("提交工具不可用");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const attachments = collectImages?.() ?? [];
			const res = await handler(workbook, {
				assignmentId: data.assignmentId,
				images: attachments,
			});
			if (!res.success || !res.data) {
				setError(res.error ?? "提交失败");
				return;
			}
			const next: PersistedCardState = {
				state: "submitted",
				values,
				submittedAt: res.data.createdAt,
				submissionId: res.data.submissionId,
			};
			persist(data.assignmentId, next);
			setState("submitted");
			setSubmittedAt(res.data.createdAt);
			setSubmissionId(res.data.submissionId);
			onSubmitted?.({ submissionId: res.data.submissionId, createdAt: res.data.createdAt });
		} catch (e) {
			setError(e instanceof Error ? e.message : "提交失败");
		} finally {
			setBusy(false);
		}
	}, [workbook, busy, locked, data.assignmentId, values, collectImages, onSubmitted]);

	const lowCount = data.items.filter((it) => (it.confidence ?? 1) < LOW_CONFIDENCE).length;
	const thumb = images[0]?.dataUrl;

	return (
		<div className="my-1.5 overflow-hidden rounded-lg border border-border/60 bg-background">
			<div className="flex items-center gap-2 border-b border-border/50 bg-muted/40 px-3 py-2">
				<PenLineIcon className="size-3.5 text-primary" />
				<span className="text-[13px] font-medium">识别结果确认</span>
				{lowCount > 0 && (
					<Badge variant="outline" className="gap-1 border-amber-500/50 text-[11px] text-amber-600 dark:text-amber-400">
						<AlertTriangleIcon className="size-3" />
						{lowCount} 项待核对
					</Badge>
				)}
				{locked && (
					<Badge variant="outline" className="gap-1 border-emerald-500/50 text-[11px] text-emerald-600 dark:text-emerald-400">
						<CheckCircle2Icon className="size-3" />
						已提交
					</Badge>
				)}
			</div>

			<div className="flex gap-3 p-3">
				{thumb ? (
					<ZoomableImage
						src={thumb}
						alt="单据缩略图"
						title="单据原图 · 识别结果对照"
						description={`共 ${data.items.length} 项识别结果${lowCount > 0 ? `，其中 ${lowCount} 项待核对` : ""}；可与右侧清单逐项比对。`}
						className="size-24"
						sideContent={
							<div className="space-y-1.5">
								{data.recognizedFrom && (
									<p className="truncate text-[11px] text-muted-foreground" title={data.recognizedFrom}>
										识别来源：{data.recognizedFrom}
									</p>
								)}
								<div className="divide-y divide-border/60 overflow-hidden rounded-md border border-border/60">
									{data.items.map((it) => {
										const key = itemKey(it.field, it.address);
										const low = (it.confidence ?? 1) < LOW_CONFIDENCE;
										const value = values[key] ?? "";
										return (
											<div key={key} className="flex items-start gap-2 px-2 py-1.5">
												<div className="min-w-0 flex-1">
													<div className="truncate text-[12px] font-medium" title={it.field}>
														{it.field}
													</div>
													<div className="truncate font-mono text-[10px] text-muted-foreground" title={it.address}>
														{it.address}
													</div>
												</div>
												<div
													className="max-w-[45%] shrink-0 truncate text-right text-[12px]"
													title={value || "（未识别）"}
												>
													{value || <span className="text-muted-foreground">（未识别）</span>}
												</div>
												{low && (
													<span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400">待核对</span>
												)}
											</div>
										);
									})}
								</div>
							</div>
						}
					/>
				) : (
					<div className="flex size-20 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border/60 text-muted-foreground">
						<ImageIcon className="size-4" />
						<span className="text-[10px]">无单据图</span>
					</div>
				)}

				<div className="min-w-0 flex-1 space-y-1.5">
					{data.recognizedFrom && (
						<p className="truncate text-[11px] text-muted-foreground" title={data.recognizedFrom}>
							识别来源：{data.recognizedFrom}
						</p>
					)}
					{thumb && (
						<p className="text-[11px] text-muted-foreground">点击左侧缩略图可放大单据，与下方识别值对照。</p>
					)}
					<div className="space-y-1">
						{data.items.map((it) => {
							const key = itemKey(it.field, it.address);
							const low = (it.confidence ?? 1) < LOW_CONFIDENCE;
							return (
								<div key={key} className="flex items-center gap-2">
									<span className="w-20 shrink-0 truncate text-[11px] text-muted-foreground" title={it.field}>
										{it.field}
									</span>
									<span className="w-20 shrink-0 truncate font-mono text-[11px] text-muted-foreground" title={it.address}>
										{it.address}
									</span>
									<Input
										value={values[key] ?? ""}
										disabled={locked}
										onChange={(e) => handleValueChange(key, e.target.value)}
										className={`h-7 flex-1 text-[12px] ${low ? "border-amber-500/60" : ""}`}
									/>
									{low && (
										<span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400" title={it.note ?? "识别置信度偏低"}>
											待核对
										</span>
									)}
								</div>
							);
						})}
					</div>
				</div>
			</div>

			<div className="flex flex-wrap items-center gap-2 border-t border-border/50 px-3 py-2">
				{!locked && (
					<>
						<Button size="sm" variant={state === "written" ? "outline" : "default"} disabled={busy || !workbook} onClick={handleWrite}>
							{busy && state === "writing" ? <LoaderIcon className="size-3.5 animate-spin" /> : <PenLineIcon className="size-3.5" />}
							确认写入
						</Button>
						<Button size="sm" disabled={busy || state !== "written" || !workbook} onClick={handleSubmit}>
							{busy && state === "written" ? <LoaderIcon className="size-3.5 animate-spin" /> : <SendIcon className="size-3.5" />}
							提交本次填报
						</Button>
					</>
				)}
				{writeNote && <span className="text-[11px] text-muted-foreground">{writeNote}</span>}
				{locked && submittedAt && (
					<span className="text-[11px] text-emerald-600 dark:text-emerald-400">
						提交时间：{formatTime(submittedAt)}
						{submissionId ? `（${submissionId}）` : ""}
					</span>
				)}
				{error && <span className="text-[11px] text-destructive">{error}</span>}
			</div>
		</div>
	);
}
