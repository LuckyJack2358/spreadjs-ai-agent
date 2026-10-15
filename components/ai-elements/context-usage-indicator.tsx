"use client";

import { memo, type ComponentProps } from "react";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import type { ContextUsage } from "@/lib/hooks/useContextUsage";
import { formatTokenCount } from "@/lib/token-estimate";

// ─── 圆环 SVG ────────────────────────────────────────────────

const RING_SIZE = 20;
const STROKE_WIDTH = 2.5;
const RADIUS = (RING_SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function ProgressRing({ percent }: { percent: number }) {
	const offset = CIRCUMFERENCE - (percent / 100) * CIRCUMFERENCE;
	const color = percent >= 90 ? "var(--destructive)" : percent >= 70 ? "var(--warning, #f59e0b)" : "currentColor";

	return (
		<svg
			width={RING_SIZE}
			height={RING_SIZE}
			viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
			className="rotate-[-90deg]"
			suppressHydrationWarning
		>
			<circle
				cx={RING_SIZE / 2}
				cy={RING_SIZE / 2}
				r={RADIUS}
				fill="none"
				stroke="currentColor"
				strokeWidth={STROKE_WIDTH}
				className="opacity-15"
				suppressHydrationWarning
			/>
			<circle
				cx={RING_SIZE / 2}
				cy={RING_SIZE / 2}
				r={RADIUS}
				fill="none"
				stroke={color}
				strokeWidth={STROKE_WIDTH}
				strokeDasharray={CIRCUMFERENCE}
				strokeDashoffset={offset}
				strokeLinecap="round"
				suppressHydrationWarning
			/>
		</svg>
	);
}

// ─── 明细行 ──────────────────────────────────────────────────

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between text-xs">
			<span className="text-popover-foreground/70">{label}</span>
			<span className="tabular-nums">{value}</span>
		</div>
	);
}

function percentOf(part: number, total: number): string {
	if (total === 0) return "0%";
	const p = (part / total) * 100;
	return p < 0.1 ? "<0.1%" : `${p.toFixed(1)}%`;
}

// ─── 主组件 ──────────────────────────────────────────────────

interface ContextUsageIndicatorProps {
	usage: ContextUsage;
	visible?: boolean;
	side?: ComponentProps<typeof HoverCardContent>["side"];
}

export const ContextUsageIndicator = memo(function ContextUsageIndicator({
	usage,
	visible = false,
	side = "top",
}: ContextUsageIndicatorProps) {
	if (!visible) return null;

	const { total, used, percent, isReal, breakdown } = usage;

	return (
		<HoverCard openDelay={200} closeDelay={100}>
			<HoverCardTrigger asChild>
				<button
					type="button"
					className="inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
					aria-label={`上下文已使用 ${percent}%`}
				suppressHydrationWarning
				>
					<ProgressRing percent={percent} />
				</button>
			</HoverCardTrigger>
			<HoverCardContent side={side} align="end" className="w-56 p-3 space-y-2.5 text-xs">
				{/* 标题 */}
				<div>
					<div className="font-medium text-sm">上下文窗口</div>
					<div className="text-popover-foreground/70 mt-0.5">
						{formatTokenCount(used)} / {formatTokenCount(total)} tokens • {percent}%
						{isReal
							? <span className="ml-1 text-emerald-500" title="已获取服务端 usage">●</span>
							: <span className="ml-1 text-popover-foreground/30" title="仅客户端估算">○</span>
						}
					</div>
					<div className="mt-1 space-y-0.5 text-[11px] text-popover-foreground/60">
						{usage.isReal && usage.serverInputTokens != null && <div>服务端最后一步：{formatTokenCount(usage.serverInputTokens)}</div>}
						<div>客户端历史估算：{formatTokenCount(usage.estimatedTokens ?? usage.used)}</div>
						{usage.model && <div className="truncate" title={usage.model}>模型：{usage.model}</div>}
						<div>窗口来源：{usage.contextWindowSource === "env" ? "环境变量" : usage.contextWindowSource === "model-map" ? "模型映射" : "默认估算"}</div>
						{usage.isReal && usage.serverInputTokens != null && usage.serverInputTokens > total && <div className="text-destructive">模型上下文配置可能不匹配</div>}
					</div>
				</div>

				{/* 系统 */}
				<div className="space-y-1">
					<div className="font-medium text-popover-foreground/50 uppercase tracking-wider text-[10px]">系统</div>
					<Row label="系统指令" value={percentOf(breakdown.systemInstructions, total)} />
					<Row label="工具定义" value={percentOf(breakdown.toolDefinitions, total)} />
				</div>

				{/* 用户上下文 */}
				<div className="space-y-1">
					<div className="font-medium text-popover-foreground/50 uppercase tracking-wider text-[10px]">用户上下文</div>
					<Row label="对话消息" value={percentOf(breakdown.messages, total)} />
					<Row label="工具结果" value={percentOf(breakdown.toolResults, total)} />
				</div>
			</HoverCardContent>
		</HoverCard>
	);
});
