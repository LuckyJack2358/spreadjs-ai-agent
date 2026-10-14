"use client";

// ============================================================================
// 提交记录预览 —— Dialog 内用只读 SpreadJS Workbook 实例渲染提交快照，并支持导出 xlsx
// 该组件由管理抽屉以 dynamic(..., { ssr:false }) 加载（SpreadJS 依赖 DOM）
//
// ⚠️ 画布初始化必须放在「随 Dialog 内容一起挂载」的子组件里：
//    Radix 的 Presence 会先渲染 null，再在下一轮提交才挂载 DialogContent，
//    因此父组件的 useEffect 在 open 变 true 时 hostRef 仍为 null；若此时直接
//    return，后续依赖不变便再也不会重试，表现就是弹窗内一片空白且导出无响应。
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import GC from "@grapecity-software/spread-sheets";
import "@grapecity-software/spread-sheets-io";
import { DownloadIcon, LoaderIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ZoomableImage } from "@/components/ui/zoomable-image";
import type { ImageRef, WorkbookJSON } from "@/lib/server/types";

GC.Spread.Sheets.LicenseKey = process.env.NEXT_PUBLIC_SPREADJS_LICENSE ?? "";

interface SnapshotCanvasProps {
	snapshot: WorkbookJSON | null;
	/** 父级 ref（引用稳定），就绪后写入 Workbook 供导出使用 */
	workbookRef: React.RefObject<GC.Spread.Sheets.Workbook | null>;
	/** 稳定回调：报告就绪 / 错误状态 */
	onStatus: (status: { ready: boolean; error: string | null }) => void;
}

function SnapshotCanvas({ snapshot, workbookRef, onStatus }: SnapshotCanvasProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		let workbook: GC.Spread.Sheets.Workbook | null = null;
		let resizeObserver: ResizeObserver | null = null;
		let timer: number | null = null;

		try {
			workbook = new GC.Spread.Sheets.Workbook(host, { sheetCount: 1 });
			workbook.options.tabStripVisible = true;
			workbook.options.newTabVisible = false;
			if (snapshot) workbook.fromJSON(snapshot);
			workbookRef.current = workbook;
			onStatus({ ready: true, error: null });
		} catch (e) {
			onStatus({ ready: false, error: e instanceof Error ? e.message : "快照渲染失败" });
		}

		// Dialog 打开动画结束后宿主尺寸才稳定，补一次刷新，并跟随容器尺寸变化重绘
		if (workbook) {
			const refresh = () => {
				try {
					workbook?.refresh();
				} catch {
					// 忽略刷新异常（组件可能已卸载）
				}
			};
			requestAnimationFrame(refresh);
			timer = window.setTimeout(refresh, 320);
			if (typeof ResizeObserver !== "undefined") {
				resizeObserver = new ResizeObserver(refresh);
				resizeObserver.observe(host);
			}
		}

		return () => {
			if (timer !== null) window.clearTimeout(timer);
			resizeObserver?.disconnect();
			if (workbookRef.current === workbook) workbookRef.current = null;
			try {
				workbook?.destroy();
			} catch {
				// 忽略销毁异常
			}
		};
	}, [snapshot, workbookRef, onStatus]);

	return <div ref={hostRef} className="h-full w-full" />;
}

interface SubmissionPreviewDialogProps {
	open: boolean;
	onClose: () => void;
	title: string;
	description?: string;
	snapshot: WorkbookJSON | null;
	images?: ImageRef[];
}

function safeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "submission";
}

export default function SubmissionPreviewDialog({
	open,
	onClose,
	title,
	description,
	snapshot,
	images,
}: SubmissionPreviewDialogProps) {
	const workbookRef = useRef<GC.Spread.Sheets.Workbook | null>(null);
	const [ready, setReady] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [exporting, setExporting] = useState(false);

	// 弹窗重新打开时重置状态（渲染期调整 state，避免 effect 内同步 setState）
	const [wasOpen, setWasOpen] = useState(open);
	if (wasOpen !== open) {
		setWasOpen(open);
		if (open) {
			setError(null);
			setReady(false);
			workbookRef.current = null;
		}
	}

	const handleStatus = useCallback((status: { ready: boolean; error: string | null }) => {
		if (status.error) {
			setError(status.error);
			setReady(false);
			return;
		}
		if (status.ready) {
			setReady(true);
			setError(null);
		}
	}, []);

	const handleExport = useCallback(async () => {
		const workbook = workbookRef.current;
		if (!workbook) {
			setError("画布尚未就绪，请稍后重试");
			return;
		}
		setExporting(true);
		setError(null);
		try {
			await new Promise<void>((resolve) => {
				workbook.export(
					(blob: Blob) => {
						try {
							const url = URL.createObjectURL(blob);
							const a = document.createElement("a");
							a.href = url;
							a.download = `${safeFileName(title || "submission")}.xlsx`;
							document.body.appendChild(a);
							a.click();
							a.remove();
							window.setTimeout(() => URL.revokeObjectURL(url), 2000);
						} catch (e) {
							setError(e instanceof Error ? e.message : "导出失败");
						} finally {
							resolve();
						}
					},
					(err: unknown) => {
						setError(err instanceof Error ? err.message : String(err) || "导出失败");
						resolve();
					},
					{ fileType: GC.Spread.Sheets.FileType.excel },
				);
			});
		} catch (e) {
			setError(e instanceof Error ? e.message : "导出失败");
		} finally {
			setExporting(false);
		}
	}, [title]);

	return (
		<Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
			<DialogContent className="flex h-[82vh] max-w-[92vw] flex-col gap-3 sm:max-w-[92vw]">
				<DialogHeader>
					<DialogTitle className="text-base">{title}</DialogTitle>
					{description && <DialogDescription className="text-xs">{description}</DialogDescription>}
				</DialogHeader>
				<div className="min-h-[320px] flex-1 overflow-hidden rounded-md border border-border/60">
					{open ? <SnapshotCanvas snapshot={snapshot} workbookRef={workbookRef} onStatus={handleStatus} /> : null}
				</div>
				{images && images.length > 0 && (
					<div className="flex items-center gap-2 overflow-x-auto">
						<span className="shrink-0 text-[11px] text-muted-foreground">单据原图（点击放大）：</span>
						{images.map((img) => (
							<ZoomableImage
								key={img.id}
								src={`/api/uploads/${img.id}`}
								alt={img.name}
								title={`单据原图 · ${img.name}`}
								className="size-24"
							/>
						))}
					</div>
				)}
				<div className="flex items-center justify-between gap-2">
					{error ? (
						<span className="text-[11px] text-destructive">{error}</span>
					) : (
						<span className="text-[11px] text-muted-foreground">
							{ready ? "只读预览，导出为 xlsx 会保存到浏览器下载目录" : "画布加载中…"}
						</span>
					)}
					<Button size="sm" variant="outline" onClick={handleExport} disabled={exporting || !ready}>
						{exporting ? <LoaderIcon className="size-3.5 animate-spin" /> : <DownloadIcon className="size-3.5" />}
						导出 xlsx
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}