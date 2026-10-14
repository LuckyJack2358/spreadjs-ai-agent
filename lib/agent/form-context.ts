"use client";

// ============================================================================
// 当前填报上下文（模块级 store）
// 记录员工“正在填报哪个模板”，用于：
//   1) 组装注入 /api/chat body 的 templateContext（模板名 + 字段地图 + assignmentId）
//   2) 提交后通知 TopBar / 员工抽屉刷新任务列表
// 身份切换会整页刷新，store 随页面重建，因此无需按用户分区。
// ============================================================================

import { useSyncExternalStore } from "react";
import type { TemplateField } from "@/lib/server/types";

export interface FormContext {
	assignmentId: string | null;
	templateId: string | null;
	templateName: string;
	fields: TemplateField[];
	sourceImages: Array<{ id: string; name: string }>;
}

let current: FormContext | null = null;
const formListeners = new Set<() => void>();

function emitFormChange() {
	for (const fn of formListeners) fn();
}

export function setFormContext(ctx: FormContext | null): void {
	current = ctx;
	emitFormChange();
}

export function getFormContext(): FormContext | null {
	return current;
}

export function subscribeFormContext(fn: () => void): () => void {
	formListeners.add(fn);
	return () => {
		formListeners.delete(fn);
	};
}

export function useFormContext(): FormContext | null {
	return useSyncExternalStore(subscribeFormContext, getFormContext, () => null);
}

/** 组装注入 chat body 的 templateContext 文本（让模型精确知道 值 → 单元格地址） */
export function buildTemplateContextText(ctx: FormContext | null): string | undefined {
	if (!ctx || !ctx.templateName) return undefined;
	const lines: string[] = [`模板名称：${ctx.templateName}`];
	if (ctx.assignmentId) lines.push(`assignmentId：${ctx.assignmentId}`);
	if (ctx.fields.length > 0) {
		lines.push("字段地图（字段名 → 目标单元格）：");
		for (const f of ctx.fields) {
			const addr = f.address.includes("!") || !f.sheetName ? f.address : `${f.sheetName}!${f.address}`;
			lines.push(`- ${f.name} → ${addr}${f.valueType ? `（${f.valueType}）` : ""}`);
		}
	}
	return lines.join("\n");
}

// ─── 分派/提交数据变更事件（用于刷新管理抽屉与员工任务列表）───────────────

const dataListeners = new Set<() => void>();

export function notifyFormDataChanged(): void {
	for (const fn of dataListeners) fn();
}

export function subscribeFormData(fn: () => void): () => void {
	dataListeners.add(fn);
	return () => {
		dataListeners.delete(fn);
	};
}
