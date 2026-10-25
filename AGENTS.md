# AGENTS.md

本文件供 AI 编码助手（如 ZCode）在本仓库工作时遵循，所有会话开始修改代码前先阅读本文件。

## 工作原则（必须遵守）

1. **自测闭环**：所有功能修改完成后，必须自己测试，测试发现问题自己修复并复测，直到功能正常才能提交推送。
   - 本地测试方法：运行 `node scripts/mock-server.mjs` 启动本地 mock 服务器（模拟后端接口，内存存储），浏览器访问 `http://localhost:8787` 端到端验证受影响的功能。
   - 覆盖正常流程和异常流程（如余额不足、网络失败、输入不合法）。

2. **错误提示文案**：所有面向用户的错误提示必须使用体验良好的中文文案，说清楚发生了什么、用户该怎么做。禁止把技术信息直接展示给用户，包括但不限于：API 错误码（如 `API error: 500`）、后端错误标识（如 `database_request_failed`、`invalid_input`）、网络异常原文（如 `Failed to fetch`）、异常堆栈、JSON 内容。技术细节可写入浏览器控制台（`console.error`）便于排查，但不得出现在界面提示中。

## 其他约定

- 功能改动完成后提交并推送到 `main` 分支，保证多设备同步（推送即用户已认可的工作流）。
- 不要提交密钥、令牌或环境变量文件（`.env` 已被 `.gitignore` 排除）。
- 数据模型说明：所有数据（accounts/holdings/transactions/snapshots）端到端加密后整包存于后端；现金是 `productType === '现金'` 的持仓记录，金额存于 `shares` 字段；交易类型 `buy/sell/dividend/transfer`。
