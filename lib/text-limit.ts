/**
 * 超长文本的展示截断（纯函数，便于单测）。
 *
 * 背景：把一条 10 万字符的文本按增量持续写入 `max-h-40 overflow-y-auto` 容器里的 <pre>，
 * 浏览器每次都要为整段文本重新断行，Chromium 实测约 128ms/增量（1000 次增量合计 128s，
 * 单次最长任务 17.7s）——表现就是「上传图片后界面卡死」；
 * 只渲染开头 4000 字符时降至 0.73ms/增量（约 175 倍差距）。
 * 因此超长的模型思考文本只渲染开头片段，其余用提示行说明已省略。
 */
export const DEFAULT_TEXT_LIMIT = 4000;

export interface TruncatedText {
	/** 实际参与渲染的文本 */
	text: string;
	/** 是否发生了截断 */
	truncated: boolean;
	/** 被省略的字符数（未截断时为 0） */
	omitted: number;
}

export function truncateText(text: string, limit: number = DEFAULT_TEXT_LIMIT): TruncatedText {
	if (limit <= 0 || text.length <= limit) {
		return { text, truncated: false, omitted: 0 };
	}
	return { text: text.slice(0, limit), truncated: true, omitted: text.length - limit };
}
