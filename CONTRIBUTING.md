# 衡准 · 贡献与维护指南

感谢关注“衡准自动改卷工作台”。本项目采用 TypeScript 严格模式、ESM、本地单机优先架构。为了维护项目代码质量、数据安全与版本历史的整洁，请在修改或提交代码前阅读本指南。

---

## 🚫 绝不提交的内容

请严格遵守 [`.gitignore`](./.gitignore) 规则，以下内容绝对禁止提交到 Git：

1. **运行时数据与答卷隐私**：
   - `.data/` 目录（包含本地题目模板、学生答卷原图、评分历史记录、本地加密配置文件）；
   - `grading-artifacts/` 目录（批改过程切图与模型调用中间产物）；
   - 任何真实学生答卷图片（PNG/JPG/WEBP 等）或包含真实考卷的本地私有文稿（DOCX/PDF）。
2. **敏感凭据与认证信息**：
   - 所有密钥与令牌文件：`*.key`（如 `master.key`）、`*.token`、`*.pem`、`*.p12`、`*.cert`；
   - 包含敏感信息的环境变量配置：`.env`、`.env.*`（仅允许更新无敏感信息的占位模板 `.env.example`）；
   - 加密配置文件：`*.enc.json`。
3. **构建产物与临时文件**：
   - `node_modules/`、`dist/`、`dist-electron/`、`dist-server/`、`release/`；
   - `tmp/`、`temp/`、`*.log`、`*.tsbuildinfo`。
4. **内部开发规约与个人备忘**：
   - `AGENTS.md`、`CLAUDE.md`、`CURSOR.md`、`*_PLAN.md` 等面向本地 AI 编码助手或个人阶段性实施计划的文件已统一配置在 `.gitignore` 中，请勿强行暂存入库。

提交前请务必使用以下命令检查待提交的工作树：
```powershell
git status
git diff --staged
```

---

## 🧪 提交前标准验证链

在向仓库提交任何代码修改前，必须在项目根目录按顺序执行以下验证链，确保类型与测试**全部通过（全绿）**：

```powershell
# 1. 前端与共享模块类型检查
npx tsc -b

# 2. 服务端与 Electron 主进程类型检查
npx tsc -p tsconfig.server.json
npx tsc -p tsconfig.electron.json

# 3. 全量单元测试与集成测试回归（438+ 用例）
npm test

# 4. 构建验证（确保打包无破坏性依赖问题）
npm run build
npm run build:server
npm run build:electron
```

---

## 🌿 Git 协作与提交规范

1. **分支管理**：
   - 在开发新功能或修复问题时，建议基于最新 `master` 签出特性分支（如 `feat/xxx` 或 `fix/xxx`）。
2. **Commit 信息规范**：
   - 格式：`<type>: <简要说明>`（推荐中英双语或纯中文，写明修改背景与原因）。
   - Type 取值：
     - `feat`: 新增业务功能或链路（如小题切片核验、智学网新适配）
     - `fix`: 修复缺陷或误判问题（如数值对比逻辑修复、防串卷门禁增强）
     - `refactor`: 重构代码结构（未改变外部行为）
     - `chore`: 依赖更新、构建脚本、配置调整
     - `docs`: 文档完善与更新
     - `test`: 补充或更新测试用例
3. **原子化提交**：
   - 保持提交粒度清晰，避免将互不相关的改动揉在一个 Commit 中；
   - 严禁提交无关的临时文件或测试残渣。

---

## 📦 发布 Windows 安装包

如需打包生成 Windows x64 便携安装包：

```powershell
npm run package:win
```

安装程序输出于 `release/` 目录，命名格式为 `衡准自动改卷工作台-<version>-Windows-x64-Setup.exe`。
