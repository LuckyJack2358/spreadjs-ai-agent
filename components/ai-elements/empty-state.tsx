"use client";

import {
	SparklesIcon,
	TableIcon,
	BarChart3Icon,
	ClipboardListIcon,
	ImageUpIcon,
	SendIcon,
	UsersIcon,
	PenLineIcon,
} from "lucide-react";
import type { UserRole } from "@/lib/server/types";

interface Capability {
	icon: typeof TableIcon;
	label: string;
}

interface StarterPrompt extends Capability {
	prompt: string;
}

const ADMIN_CAPABILITIES: Capability[] = [
	{ icon: ClipboardListIcon, label: "模板制作" },
	{ icon: UsersIcon, label: "自然语言分派" },
	{ icon: TableIcon, label: "数据读写" },
	{ icon: BarChart3Icon, label: "图表分析" },
];

const ADMIN_STARTER_PROMPTS: StarterPrompt[] = [
	{
		icon: ClipboardListIcon,
		label: "上传纸质单据生成填报模板",
		prompt: "我上传一张空白单据图片，请识别它的结构并在画布上生成一张填报模板",
	},
	{
		icon: UsersIcon,
		label: "把模板分派给某人",
		prompt: "把「差旅报销单」分派给张三",
	},
	{
		icon: TableIcon,
		label: "载入已有模板继续编辑",
		prompt: "列出我已有的填报模板",
	},
];

const EMPLOYEE_CAPABILITIES: Capability[] = [
	{ icon: ClipboardListIcon, label: "我的填报任务" },
	{ icon: ImageUpIcon, label: "单据识别" },
	{ icon: SendIcon, label: "确认后提交" },
];

const EMPLOYEE_STARTER_PROMPTS: StarterPrompt[] = [
	{ icon: ClipboardListIcon, label: "查看我的填报任务", prompt: "看看我有哪些待填报的任务" },
	{ icon: ImageUpIcon, label: "开始填报当前任务", prompt: "载入我当前需要填报的模板" },
	{
		icon: SendIcon,
		label: "上传已填写单据并识别",
		prompt: "我上传一张已经填写好的单据照片，请识别其中的数据",
	},
];

interface EmptyStateProps {
	/** 点击快捷提示：只把提示词填入输入框供用户编辑，不直接发送 */
	onInsertPrompt: (text: string) => void;
	isReady: boolean;
	/** 角色：管理员 = 模板制作与分派；员工 = 单据填报 */
	role?: UserRole;
}

export function EmptyState({ onInsertPrompt, isReady, role = "admin" }: EmptyStateProps) {
	const isEmployee = role === "user";
	const capabilities = isEmployee ? EMPLOYEE_CAPABILITIES : ADMIN_CAPABILITIES;
	const starters = isEmployee ? EMPLOYEE_STARTER_PROMPTS : ADMIN_STARTER_PROMPTS;

	return (
		<div className="flex size-full flex-col items-center justify-center gap-5 px-6 py-8">
			<div className="flex flex-col items-center gap-2">
				<div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
					<SparklesIcon className="size-5 text-primary/80" />
				</div>
				<h3 className="text-[15px] font-semibold">SpreadJS AI 助手</h3>
				<p className="text-center text-[13px] text-muted-foreground/80">
					{isEmployee ? "上传已填写的单据，AI 帮你录入到模板" : "上传纸质单据，AI 帮你生成模板并分派"}
				</p>
			</div>

			{/* 能力标签 */}
			<div className="flex flex-wrap justify-center gap-1.5">
				{capabilities.map(({ icon: Icon, label }) => (
					<span
						key={label}
						className="inline-flex items-center gap-1.5 rounded-full border border-border/50 px-2.5 py-0.5 text-[11px] text-muted-foreground/70"
					>
						<Icon className="size-3" />
						{label}
					</span>
				))}
			</div>

			{/* Starter prompts：点击仅填入输入框，由用户确认后再发送 */}
			<div className="flex w-full flex-col gap-1.5">
				{starters.map(({ icon: Icon, label, prompt }) => (
					<button
						key={label}
						type="button"
						disabled={!isReady}
						title="填入输入框，可编辑后再发送"
						onClick={() => onInsertPrompt(prompt)}
						className="group flex items-center gap-3 rounded-lg border border-border/50 px-3.5 py-2.5 text-left text-[13px] transition-all hover:border-border hover:bg-accent/40 disabled:opacity-50"
					>
						<Icon className="size-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-primary/70" />
						<span className="text-foreground/90">{label}</span>
						<PenLineIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />
					</button>
				))}
				<p className="px-1 pt-0.5 text-[11px] leading-relaxed text-muted-foreground/60">
					点击后填入下方输入框，可先修改（如替换成具体员工姓名）再发送
				</p>
			</div>
		</div>
	);
}
