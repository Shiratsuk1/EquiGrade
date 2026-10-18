# 衡准工作台重构设计方案与交互式演示 Demo

本目录收录新工作台的重构方案规划、实施细则以及完全自包含的交互式 H5 原型 Demo。

## 文件索引

1. **[workbench-design-spec-and-aesthetic-standards.md](./workbench-design-spec-and-aesthetic-standards.md)**
   - **设计目标方案书与视觉美学标准白皮书（面向 ChatGPT / 开发者指导）**
   - 包含三大核心目标、四大对标参考产品（Linear / Raycast / Figma / 医疗工作站）、暗场抗疲劳色彩阶梯、字体与微质感规范，以及直接可复制喂给 AI 的 Prompt 模板。

2. **[workbench-interactive-prototype.html](./workbench-interactive-prototype.html)**
   - **交互式演示 H5 Demo**
   - 包含全新双栏视口、顶部极简胶囊控制栏、右侧证据链与小题切片抽屉、原地聚光灯引导（Spotlight Tour）交互的完整静态演示原型。
   - **使用方法**：直接在任意现代浏览器双击或通过命令打开，无需启动后台服务即可体验全部界面交互与动效。

3. **[workbench-redesign-proposal.md](./workbench-redesign-proposal.md)**
   - **新一代工作台重构方案规划书**
   - 详细阐述设计背景、核心问题剖析、整体架构与布局重构、六步渐进式落地路径与安全设计规范。

4. **[spotlight-tour-implementation.md](./spotlight-tour-implementation.md)**
   - **原地聚光灯与真实验卷现场教学（Spotlight Tour）实施细则**
   - 详细设计暗场聚光灯、沙盒破冰、API 配置气泡及真实考卷感应连通的交互机制与状态机设计。
