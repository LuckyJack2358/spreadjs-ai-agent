// ============================================================================
// 测试环境准备：把业务数据指向临时目录，避免污染仓库内的 ./data
// （getDb / resolveUploadDir 都在调用时读取环境变量，因此这里设置即可生效）
// ============================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sjs-test-"));
process.env.SJS_DB_PATH = path.join(dir, "app.db");
process.env.SJS_UPLOAD_DIR = path.join(dir, "uploads");