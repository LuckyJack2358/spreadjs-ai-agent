// ============================================================================
// 工作表 → 对话 桥接（模块级事件总线）
// ----------------------------------------------------------------------------
// 用途：SpreadJS 设计器里「工作表标签右键菜单 → 添加到对话」。
//
// 数据流：
//   1) 用户右键工作表标签 → Designer 打开右键菜单时，SpreadJSDesigner 把被点击的
//      工作表名写入本模块的 contextSheetName（右键菜单打开 ≠ 当前活动工作表）；
//   2) 用户点击菜单项「添加到对话」→ 菜单命令把该工作表名广播给订阅者；
//   3) ChatPanel 收到广播后只做一件事：把提示词预填进输入框并聚焦（不自动发送），
//      用户可继续编辑（补充自己的问题）后手动发送。
// ============================================================================

/** 工作表名订阅回调 */
type SheetToChatListener = (sheetName: string) => void;

/** 右键菜单打开时被点击的工作表名（无右键上下文时为 null） */
let contextSheetName: string | null = null;

/** 记录本次右键菜单针对的工作表名（由设计器在 onOpenMenu 时调用） */
export function setContextSheetName(sheetName: string | null): void {
	contextSheetName = sheetName && sheetName.trim() ? sheetName.trim() : null;
}

/** 读取本次右键菜单针对的工作表名 */
export function getContextSheetName(): string | null {
	return contextSheetName;
}

/** 广播「把该工作表加入对话」——由右键菜单命令调用 */
export function addSheetToChat(sheetName: string): void {
	const name = sheetName?.trim();
	if (!name) return;
	for (const fn of listeners) {
		try {
			fn(name);
		} catch (err) {
			console.error("[sheet-chat-bridge] 订阅回调执行失败", err);
		}
	}
}

const listeners = new Set<SheetToChatListener>();

/** 订阅「添加到对话」事件，返回取消订阅函数 */
export function subscribeSheetToChat(fn: SheetToChatListener): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

/**
 * 生成预填到输入框的提示词（仅预填，不自动发送）。
 * 末尾留出冒号，用户可直接续写自己的问题。
 */
export function buildSheetChatPrompt(sheetName: string): string {
	return `请针对工作表「${sheetName}」回答：`;
}
