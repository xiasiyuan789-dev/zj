# AGENTS.md

本文件供 AI 编码助手（如 ZCode）在本仓库工作时遵循，所有会话开始修改代码前先阅读本文件。

## 工作原则（必须遵守）

0. **正式环境强制使用 CloudBase**：所有对用户发布/上线的版本，必须且只能通过下述「正式环境发布（CloudBase 云端版）」流程部署。禁止将 `server.mjs` 自托管（本地文件模式或 Supabase 模式）作为正式环境发布或让用户当成正式环境使用；`server.mjs` 与 `scripts/mock-server.mjs` 只能用于本地开发自测。用户金库数据只存于 CloudBase 的 PostgreSQL（vaults 表），任何改动不得迁移、复制或清空该库。

1. **自测闭环**：所有功能修改完成后，必须自己测试，测试发现问题自己修复并复测，直到功能正常才能提交推送。
   - 本地测试方法：运行 `node server.mjs`（自托管后端，加密数据存于 `./data`，默认端口 8787），浏览器访问 `http://localhost:8787` 端到端验证受影响的功能。
   - 备选：`node scripts/mock-server.mjs` 为纯内存 mock（不落盘），适合临时验证；注意与 server.mjs 端口相同，不要同时运行。
   - 覆盖正常流程和异常流程（如余额不足、网络失败、输入不合法）。

2. **错误提示文案**：所有面向用户的错误提示必须使用体验良好的中文文案，说清楚发生了什么、用户该怎么做。禁止把技术信息直接展示给用户，包括但不限于：API 错误码（如 `API error: 500`）、后端错误标识（如 `database_request_failed`、`invalid_input`）、网络异常原文（如 `Failed to fetch`）、异常堆栈、JSON 内容。技术细节可写入浏览器控制台（`console.error`）便于排查，但不得出现在界面提示中。

## 发布流程（必须遵守）

1. 修改完成后先本地自测跑通（按「工作原则」第 1 条），然后本地提交（commit 写清修改内容），保持 `node server.mjs` 运行，告知用户可以验收：验收地址、测试账号、本次改动的测试要点。
2. 等待用户验收。用户明确说验收通过后，询问是否推送；用户确认后才推送到 `main`。
3. **每次推送必须打版本标签**：`git tag -a vX.Y.Z -m "本次修改内容清单"`，标签是独立可回退的版本锚点。功能类更新升次版本号（v1.0→v1.1），修复类升修订号（v1.0.0→v1.0.1）。
4. 未经验收和用户确认，不得推送。用户如明确说「免验收直接推」，可跳过验收但仍需打标签。
5. 回退方法：在部署机上 `git fetch --tags && git checkout vX.Y.Z` 后刷新页面即可回到该版本（数据在 `data/` 目录，不受代码回退影响）。

## 正式环境发布（强制走 CloudBase，唯一发布渠道）

正式环境是腾讯 CloudBase：https://xsy-db-d7g6fmldu0e8c5967-1513045239.tcloudbaseapp.com
（环境 ID `xsy-db-d7g6fmldu0e8c5967`，静态托管 + 云函数 vault-app + PostgreSQL vaults 表；用户金库数据在该数据库中）

推送打完标签后，执行云端发布：

1. 生成部署包（`dist/` 已被 gitignore）：
   ```bash
   rm -rf dist && mkdir -p dist && cp public/*.* dist/
   sed -i "s|const API_BASE = '/functions/v1/app';|const API_BASE = 'https://xsy-db-d7g6fmldu0e8c5967.service.tcloudbase.com/functions/v1/app';|" dist/app.js
   ```
2. 部署（CloudBase CLI 已装好并登录）：`tcb hosting deploy dist -e xsy-db-d7g6fmldu0e8c5967`
3. 线上验证：curl 检查 `<title>` 与 app.js 中的新版本特征（注意 CDN 缓存，加 `?v=随机数` 参数绕过），并告知用户强刷。
注意：云端部署的前端与仓库唯一差异是 app.js 的 API_BASE 地址（静态托管与云函数不同域名，需绝对地址）。

## 其他约定

- 多设备协作：如果用户在另一台电脑上直接改过代码，AI 动手前必须先 `git pull`，避免冲突。
- 不要提交密钥、令牌或环境变量文件（`.env` 已被 `.gitignore` 排除）。
- 数据模型说明：所有数据（accounts/holdings/transactions/snapshots）端到端加密后整包存于后端；现金是 `productType === '现金'` 的持仓记录，金额存于 `shares` 字段；交易类型 `buy/sell/dividend/transfer`。
