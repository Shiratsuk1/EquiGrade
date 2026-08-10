# 改卷系统维护说明

本项目是一个本地优先的 Electron + Vite + TypeScript 改卷工作台。源码、测试和安装器资源进入 Git；本机评分资料、模型配置和构建产物留在本地。

## 不要提交的内容

- `.data/`：本地模板、题目图片、学生答卷、评分历史、日志和加密配置
- `.env.local` 或其他 `.env.*` 文件：可能包含模型服务密钥
- `node_modules/`、`dist/`、`dist-server/`、`dist-electron/`、`release/`
- `tmp/`：本地验收截图和临时文件

提交前可以用下面的命令确认 Git 看到了什么：

```powershell
git status
git diff --check
```

## 提交前检查

在项目根目录执行：

```powershell
npm test
npm run build
npm run build:server
npm run build:electron
```

## 日常维护流程

先从远程同步，再在独立分支上修改：

```powershell
git pull --ff-only
git switch -c codex/简短任务名
```

完成修改并通过检查后：

```powershell
git add <修改过的文件>
git commit -m "描述本次修改"
git push -u origin <当前分支名>
```

建议一次提交只表达一个完整目的，例如“修复评分证据校验”或“增加 Electron 演练页”。提交前不要把 `.data/` 中的真实试卷或学生资料复制到项目目录中。

## 配置模型服务

开发环境中的 API Key 只通过系统设置或本地环境变量提供，不写入源码、README、测试夹具或 Git 提交。`.env.example` 只放变量名称和示例占位值。

## 发布 Windows 安装包

```powershell
npm run package:win
```

安装包输出到 `release/`，默认不提交到 Git。需要分发时可作为 GitHub Release 附件上传，并在 Release 说明中记录对应的 Git 提交号。
