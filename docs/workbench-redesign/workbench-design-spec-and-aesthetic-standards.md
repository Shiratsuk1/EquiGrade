# 《衡准 · 物理阅卷工作台》界面重构设计方案与美学标准白皮书
> **面向对象**：产品经理、UI/UX 设计师、ChatGPT / Claude 等大模型 Prompt 指令、Codex 自动化代码智能体、前端开发团队  
> **文档版本**：v2.2 · 2026 旗舰增强版（聚焦引导零溢出架构与 Codex 启动指令版）  
> **核心使命**：将传统“局促、挤压、填表式”的本地桌面改卷软件，蜕变为**极客级、高沉浸、暗场抗疲劳、毫秒级证据链回放的下一代 AI 阅卷工作台**。

---

## 目录
- [一、 核心设计目标与产品愿景 (Design Goals)](#一-核心设计目标与产品愿景-design-goals)
- [二、 应当参考的顶级对象与设计精髓 (Benchmark References)](#二-应当参考的顶级对象与设计精髓-benchmark-references)
- [三、 视觉美学标准与设计系统规范 (Aesthetic Standards)](#三-视觉美学标准与设计系统规范-aesthetic-standards)
  - [3.1 色彩哲学与暗场抗疲劳系统](#31-色彩哲学与暗场抗疲劳系统)
  - [3.2 字体排版与数学公式渲染阶梯](#32-字体排版与数学公式渲染阶梯)
  - [3.3 空间网格、微质感与毛玻璃层次](#33-空间网格微质感与毛玻璃层次)
  - [3.4 动效与交互微反馈规范](#34-动效与交互微反馈规范)
- [四、 核心模块重构方案设计细则 (Module Specifications)](#四-核心模块重构方案设计细则-module-specifications)
- [五、 空间边界防御与防 UI 排布溢出硬性铁律 (Anti-Overflow & Boundary Defense)](#五-空间边界防御与防-ui-排布溢出硬性铁律-anti-overflow--boundary-defense)
  - [5.1 根容器与横向滚动条绝对防御](#51-根容器与横向滚动条绝对防御)
  - [5.2 Windows 系统 DPI 缩放灾难防御 (100% / 125% / 150%)](#52-windows-系统-dpi-缩放灾难防御-100--125--150)
  - [5.3 复杂 KaTeX 长公式与手写转录截断熔断机制](#53-复杂-katex-长公式与手写转录截断熔断机制)
  - [5.4 手写高清切图极端长宽比（长条/窄高）容器自适应](#54-手写高清切图极端长宽比长条窄高容器自适应)
  - [5.5 Z-Index 严格分层架构与视口穿透防御](#55-z-index-严格分层架构与视口穿透防御)
  - [5.6 Electron 原生 BrowserView 与 DOM 像素级尺寸同步](#56-electron-原生-browserview-与-dom-像素级尺寸同步)
  - [5.7 聚焦引导（Spotlight Tour）对话框定位引擎与零溢出防御架构](#57-聚焦引导spotlight-tour对话框定位引擎与零溢出防御架构)
- [六、 真实界面用户 E2E 体验验证与验收标准 (Real-World E2E Verification)](#六-真实界面用户-e2e-体验验证与验收标准-real-world-e2e-verification)
  - [6.1 全分辨率与 Windows 缩放实机矩阵测试](#61-全分辨率与-windows-缩放实机矩阵测试)
  - [6.2 真实阅卷业务场景的压力极限用例](#62-真实阅卷业务场景的压力极限用例)
  - [6.3 物理教师眼动心流与操作人体工学核对](#63-物理教师眼动心流与操作人体工学核对)
  - [6.4 界面验收“五禁五必”一票否决红线](#64-界面验收五禁五必一票否决红线)
- [七、 启动 Codex 落地重构的官方指令 Prompt (Codex Launch Prompt)](#七-启动-codex-落地重构的官方指令-prompt-codex-launch-prompt)
- [八、 供 ChatGPT / Claude 进行 UI 设计对话的 Prompt (UI Chat Prompt)](#八-供-chatgpt--claude-进行-ui-设计对话的-prompt-ui-chat-prompt)

---

## 一、 核心设计目标与产品愿景 (Design Goals)

### 1.1 核心痛点与场景认知
高中物理阅卷老师通常需要在电脑屏幕前连续工作 **8 ~ 12 小时**，面对成百上千份字迹潦草、包含复杂物理受力图与公式推导的试卷。
- **痛点 1（空间挤压）**：传统客户端常将大块屏幕分配给静态菜单、控制卡片和庞大侧边栏，导致核心的“学生手写答卷视口”严重受限，教师需要不断手动缩放和平移。
- **痛点 2（视觉疲劳）**：大面积高饱和白色刺眼背景、杂乱无序的色块、突兀的红叉导致眼睛干涩、认知负荷极大。
- **痛点 3（信任缺失）**：AI 判定分数时如果只展示一个“总分”或一段模糊文字，教师不敢放行；必须让“卷面手写切片、扣分点、逻辑争议”与打分**并列即时呈现**。

### 1.2 三大核心设计目标

```mermaid
flowchart LR
    A["核心目标"] --> B["1. 答卷视口极限化<br>(Content-First)"]
    A --> C["2. 悬浮胶囊控制台<br>(HUD Floating Pill)"]
    A --> D["3. 伴侣式证据链抽屉<br>(Evidence Companion)"]

    B --> B1["答卷可用面积提升至 70%~75%<br>无框全景呈现，零无效边距"]
    C --> C1["折叠侧边栏，收纳为 44px 极简顶栏<br>运行状态一目了然，一键启停"]
    D --> D1["切图证据、得分点、OCR 识别<br>右侧自适应滑出，按需审计"]
```

1. **答卷视口极限化（Content-First & 0-Chrome）**：
   - 界面上所有装饰性边框、多余层级必须退让。真实验卷网页或原图占据 **70%~75%** 以上的核心屏幕区域，让教师看清每一笔手写受力分析与下标。
2. **悬浮式 HUD 胶囊交互（Floating HUD Capsule）**：
   - 将原先笨重杂乱的左侧大抽屉、上层设置栏，重构为类似 macOS 动态岛或 Raycast 的**顶部悬浮胶囊**（高度 ≤ 44px）。仅露出核心：当前批卷进度、当前分值、站点探针绿灯、主运行/暂停键。
3. **伴侣式证据链与小题切片抽屉（Evidence Companion）**：
   - 不再让复杂的评分明细遮挡答卷；右侧提供可随时收折的 280px~360px 证据伴侣抽屉，精准并列展示：**手写局部高清切图**、**教师模型扣分裁决**、**置信度指示灯**与**原始转录对照**。

---

## 二、 应当参考的顶级对象与设计精髓 (Benchmark References)

为打造真正世界级的产品体验，建议在 UI/UX 与工程落地时深度借鉴以下标杆产品：

| 标杆对象 | 对应产品形态 | 我们应当学习的核心精髓 |
| :--- | :--- | :--- |
| **Linear** | 极客级项目协作客户端 | • **极致的键盘优先理念**（Space 启停、J/K 切换、Esc 返回）<br>• **Subtle 1px 细线边框**（`rgba(255,255,255,0.08)`）取代重阴影<br>• **暗场 Obsidian 质感**：极具呼吸感的灰黑梯度与专业感<br>• **微交互响应**：输入焦点、状态切换均在 150ms 优雅回弹 |
| **Raycast / Arc Browser** | 浮动命令中心与沉浸式浏览器 | • **Floating Pill 胶囊布局**：将控制系统悬浮在视口之上，而非切分视口<br>• **状态感知呼吸灯**：使用微光脉冲（Pulse Glow）表达 AI 心跳与连通状态<br>• **渐进式展开（Progressive Disclosure）**：日常只有 5% 的视觉噪音，需要时一键展开全部细节 |
| **Figma / Adobe Lightroom** | 专业画布与检视器 | • **高清切片对比检视**：右侧检查器（Inspector）与左侧原画面的联动高亮<br>• **数值微调手感**：分数调整、复核覆盖（Override）具有即时反馈与撤销提示<br>• **视网膜级锐度**：暗色背景下学生手写笔迹反差自动增强 |
| **PACS 医疗影像工作站** | 放射科/病理学诊断系统 | • **证据链零丢失原则**：每一个判决必有对应的坐标切图与原始审计链<br>• **零歧义视觉警报**：用稳重耐看的 Amber（琥珀黄）表示疑似复核，避免大红大紫造成心理恐慌 |

---

## 三、 视觉美学标准与设计系统规范 (Aesthetic Standards)

### 3.1 色彩哲学与暗场抗疲劳系统

> [!IMPORTANT]
> 拒绝使用高纯度纯黑（`#000000`）或粗暴的纯白（`#FFFFFF`）。使用精密调配的**深曜石色（Obsidian Slate）**梯度，辅以精准的物理语义功能色。

#### 背景与表面色梯度（Surface Hierarchy）
* **Canvas 深空基底**：`#0B0D12`（最底层窗口底色，沉静、深邃）
* **Viewport 答卷容器**：`#12151D`（微抬升表面，与外部边框形成柔和层次）
* **Capsule 悬浮胶囊底色**：`rgba(22, 27, 38, 0.82)` 配合 `backdrop-filter: blur(16px)`
* **Card/Drawer 抽屉卡片**：`#181C26`（承载切片图与文字，高可读性）
* **Elevated Hover 悬浮态**：`#202634`（交互时的微高亮）

#### 语义功能色（Semantic Accents）
```
Emerald (全对/运行中)   : #10B981 | 边框: rgba(16, 185, 129, 0.3) | 背景: rgba(16, 185, 129, 0.1)
Amber (待复核/疑点)     : #F59E0B | 边框: rgba(245, 158, 11, 0.3) | 背景: rgba(245, 158, 11, 0.1)
Rose (扣分/异常终止)   : #F43F5E | 边框: rgba(244, 63, 94, 0.3)  | 背景: rgba(244, 63, 94, 0.1)
Indigo (AI推理/模型态)  : #6366F1 | 边框: rgba(99, 102, 241, 0.3) | 背景: rgba(99, 102, 241, 0.1)
Cyan (站点探针/连通)    : #06B6D4 | 边框: rgba(6, 182, 212, 0.3)  | 背景: rgba(6, 182, 212, 0.1)
```

---

### 3.2 字体排版与数学公式渲染阶梯

- **英文/数字主字体**：`Inter`, `-apple-system`, `BlinkMacSystemFont`, `sans-serif`
- **代码/数值显示（Tabular Nums）**：`JetBrains Mono`, `Consolas`, `monospace`（确保分值、耗时、坐标对齐不跳动）
- **中文字体栈**：`PingFang SC`, `Microsoft YaHei UI`, `Noto Sans SC`, `sans-serif`
- **公式符号**：原生嵌入 **KaTeX**，保证分式 $\frac{GMm}{r^2} = m\frac{v^2}{r}$ 与希腊字母 $\mu, \theta, \lambda$ 呈现印刷级清晰度。

#### 排版字阶（Type Scale）
1. **Hero HUD 分数**：`32px` / `line-height: 1` / `font-weight: 700`（如 `16 / 16`）
2. **一级标题/关键状态**：`15px` / `font-weight: 600` / `color: #F1F5F9`
3. **正文与手写转录**：`13px` / `line-height: 1.6` / `color: #CBD5E1`
4. **小题题号与元信息**：`12px` / `font-weight: 500` / `color: #94A3B8`
5. **审计微标（Badge）**：`11px` / `font-weight: 600` / `letter-spacing: 0.5px` / `text-transform: uppercase`

---

### 3.3 空间网格、微质感与毛玻璃层次

- **Hairline 细线边框原则**：全面剔除 2px 以上的厚笨边框，统一切换为 `1px solid rgba(255, 255, 255, 0.07)`。在卡片高光面可叠加 `border-top: 1px solid rgba(255, 255, 255, 0.12)` 产生精巧的倒角高光。
- **圆角体系（Radii）**：
  - 悬浮胶囊：`rounded-full` 或 `32px`
  - 核心视口与抽屉面板：`12px`
  - 内嵌切片图卡片与评分点：`8px`
  - 小型标签 Badge：`4px`
- **高阶内阴影（Inner Ambient Shadow）**：
  - 容器卡片使用内发光模拟物理金属/玻璃切面：`box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 8px 24px rgba(0, 0, 0, 0.4)`。

---

### 3.4 动效与交互微反馈规范

1. **缓动曲线（Apple Smooth Easing）**：
   - 全局过渡使用：`transition: all 200ms cubic-bezier(0.16, 1, 0.3, 1)`。
2. **呼吸微光（Status Pulse）**：
   - 处于自动批改中时，运行指示点不仅变绿，还附带细腻的扩散呼吸环：
   ```css
   @keyframes pulse-ring {
     0% { transform: scale(0.95); opacity: 0.8; }
     50% { transform: scale(1.4); opacity: 0; }
     100% { transform: scale(0.95); opacity: 0; }
   }
   ```
3. **切片灯箱无缝平滑放大（Hero Layout Motion）**：
   - 点击小题局部切图时，通过平滑的局部展开飞入中央大图检视，保持视觉注意力不跳跃。

---

## 四、 核心模块重构方案设计细则 (Module Specifications)

### 4.1 总体视口网格切分（72% 验卷 + 28% 证据伴侣）

```
+-----------------------------------------------------------------------------------------+
| [● 衡准] [智学网: 已就绪 ●]  [批改中: 第 14/120 份]  [当前: 16分]  [ Space 暂停 ]  [设置/日志] | <-- 悬浮顶栏 (44px)
+-------------------------------------------------------------+---------------------------+
|                                                             | [证据伴侣抽屉: 展开 / 收起]  |
|                                                             |                           |
|                                                             | ● 第 (1) 问 [ 3 / 3 分 ]   |
|                 真实验卷 / 答题卡嵌入式视口                   |   [局部切片: R=12.0Ω]     |
|                                                             |   ✔ 最终答案正确 (快速通道)  |
|               (Webview / Electron BrowserView)              |---------------------------|
|                                                             | ▲ 第 (2) 问 [ 2 / 5 分 ]   |
|            保留 100% 原汁原味网页排版，无遮挡输入框            |   [局部切图: 步骤涂改处]    |
|                                                             |   -2 漏写方向判定公式      |
|                                                             |   置信度: 0.94 [需复核]    |
|                                                             |---------------------------|
|                                                             | 实时流水线审计日志 (极简滚动)|
+-------------------------------------------------------------+---------------------------+
| 快捷键提示: [Space] 启停流水线 | [Tab] 切换抽屉 | [Esc] 关闭弹窗 | [R] 强制重审当前份          |
+-----------------------------------------------------------------------------------------+
```

---

## 五、 空间边界防御与防 UI 排布溢出硬性铁律 (Anti-Overflow & Boundary Defense)

> [!CAUTION]
> 界面重构最常见的致命缺陷是：**在设计师的 2K/4K 大屏上很美，但在教师真实的 1080p 笔记本（尤其是 Windows 125% 或 150% DPI 缩放）下，文字溢出截断、出现双重横向滚动条、聚焦指引卡片被挤出屏幕边缘、抽屉把网页打分框遮挡**。以下规范为硬性约束，违背任何一条即视为不合格。

### 5.1 根容器与横向滚动条绝对防御
1. **全局横向锁死**：应用根容器 `#root` 及主工作台视口必须声明 `overflow-x: hidden; width: 100vw; max-width: 100vw;`。除特定代码块或长公式内部容器外，**严禁在页面全局或主视口出现横向滚动条**。
2. **Flex 容器防撑爆铁律**：所有水平 Flex 容器的文字子项或公式容器，**必须声明 `min-width: 0`**（防止内部未换行文本默认撑破父级弹性盒模型），关键图标必须声明 `flex-shrink: 0` 防止被挤压变形。
3. **安全内边距盒模型**：全系统组件统一设定 `box-sizing: border-box;`，任何 Padding 与 Border 不得额外撑开元素总宽高。

### 5.2 Windows 系统 DPI 缩放灾难防御 (100% / 125% / 150%)
1. **响应式字号防御**：放弃硬编码的固定大像素，顶部胶囊内的标签、副标题使用 `clamp(11px, 0.8vw, 13px)` 动态微调；按钮内文字严格单行，配置 `white-space: nowrap; text-overflow: ellipsis;`。
2. **抽屉自适应弹性占比**：
   - 当屏幕可用宽度 $\ge 1600px$ 时，证据抽屉宽度定为 `360px`；
   - 当屏幕可用宽度在 $1280px \sim 1599px$ 时，证据抽屉压缩为 `280px`；
   - 当屏幕可用宽度 $< 1280px$（常见于 1080p @ 150% 缩放，实际有效视口仅 1280×720）时，**右侧抽屉默认折叠为悬浮微徽标（36px 竖条）**，仅在教师鼠标悬停或按快捷键时展开为抽屉浮层，绝对不与左侧验卷视口争抢物理宽度！

### 5.3 复杂 KaTeX 长公式与手写转录截断熔断机制
物理学科大题经常出现长达几十个字符的方程组（例如：$m_1v_1 + m_2v_2 = m_1v_1' + m_2v_2'$ 连同动能守恒公式并列）：
1. **公式专用安全容器**：所有 KaTeX 渲染节点必须包裹在带有 `.katex-safe-container` 的容器内：
   ```css
   .katex-safe-container {
     max-width: 100%;
     overflow-x: auto;
     overflow-y: hidden;
     scrollbar-width: thin;
     scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
     padding-bottom: 2px;
   }
   ```
2. **转录长文本三行熔断**：AI 视觉转录与扣分原因默认限制显示 3 行（`-webkit-line-clamp: 3; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden;`），超长文本在末尾显示渐变暗色遮罩与“展开全文”微按钮，禁止卡片高度失控撑爆抽屉。

### 5.4 手写高清切图极端长宽比（长条/窄高）容器自适应
1. **比例防御**：学生答卷切片可能是“整行横向方程”（宽高比 6:1）或“竖向列式”（宽高比 1:3）。切图展示卡片必须设置：
   ```css
   .evidence-crop-img {
     max-width: 100%;
     max-height: 220px;
     width: auto;
     height: auto;
     object-fit: contain;
     border-radius: 6px;
     background: #0D0F14; /* 防白图穿透底色 */
   }
   ```
2. **灯箱居中安全区**：点击放大进入全屏灯箱时，外部容器必须预留 `padding: 48px` 安全边界，大图 `max-width: calc(100vw - 96px); max-height: calc(100vh - 96px);`，任何比例切图均绝对不溢出屏幕外。

### 5.5 Z-Index 严格分层架构与视口穿透防御
为杜绝任意手写 `z-index: 99999` 导致的弹窗错乱、控件被遮挡或穿透，全系统统一执行层级天梯：

```
Layer 0   : 底层验卷视口 (Webview / 原图 Canvas)
Layer 10  : 右侧证据伴侣固定抽屉 (Companion Drawer)
Layer 20  : 顶部悬浮控制胶囊 (HUD Floating Capsule)
Layer 30  : 快捷键帮助条 / 状态提示徽标
Layer 50  : 下拉选择框 / Tooltip 悬浮微气泡 (Popover)
Layer 100 : 暗场聚光灯遮罩 (In-Situ Spotlight Tour Backdrop)
Layer 110 : 聚光灯高亮高穿透对象 (Spotlight Target) & 指引气泡
Layer 200 : 切图高清大图检视灯箱 (Lightbox Modal)
Layer 900 : 致命阻断错误弹窗 (Fatal Safety Interrupt Modal)
Layer 999 : 全局 Toast 吐司通知
```

### 5.6 Electron 原生 BrowserView 与 DOM 像素级尺寸同步
- 智学网/睿芽云在 Electron 中由原生的 `WebContentsView` / `BrowserView` 渲染，它位于 React DOM 之下或特定物理坐标内。
- **边界互锁机制**：React 的主视口容器必须挂载 `ResizeObserver`，当右侧抽屉展开/折叠、或窗口缩放时，通过 IPC 向主进程发送 `updateViewBounds({ x, y, width, height })`，使用 `requestAnimationFrame` 防抖合并，**确保原生网页与 React 边框之间 0 像素缝隙、0 白边、0 抖动**。

---

### 5.7 聚焦引导（Spotlight Tour）对话框定位引擎与零溢出防御架构

> [!IMPORTANT]
> **聚焦引导最容易翻车的场景**：当聚光灯高亮“顶部胶囊”时，弹窗向下展开被浏览器顶部遮挡；当高亮“右下角重试按钮”时，弹窗向右溢出屏幕外；在 125%/150% 笔记本小屏幕上，弹窗过长把“下一步”按钮挤到可视区外导致流程卡死。必须采用以下 **4D 零溢出定位引擎**。

```mermaid
flowchart TD
    Target["获取目标元素 targetRect"] --> ScrollCheck{"目标是否完全在可视区?"}
    ScrollCheck -- "否" --> ScrollIntoView["执行平滑滚动 scrollIntoView"]
    ScrollCheck -- "是" --> CollisionDetection["计算四周可用空间 (Top/Bottom/Left/Right)"]
    ScrollIntoView --> CollisionDetection

    CollisionDetection --> FlipDecision{"首选方向是否产生视口碰撞?"}
    FlipDecision -- "有碰撞 (溢出边界)" --> AutoFlip["自动翻转至对侧 (Auto-Flip)"]
    FlipDecision -- "无碰撞 (空间充足)" --> KeepPlacement["保持最佳朝向"]

    AutoFlip --> ClampCoords["执行 16px 视口钳位 (Clamping)"]
    KeepPlacement --> ClampCoords

    ClampCoords --> SlideArrow["动态滑轨吸附计算 (Dynamic Arrow Offset)"]
    SlideArrow --> RenderPortal["通过 React Portal 挂载至 document.body"]
```

#### 1. 基于视口碰撞的主动翻转算法（Auto-Flip Positioning）
- **垂直轴智能决策**：
  - 若目标位于视口上半屏（`targetRect.top < window.innerHeight / 2`），指引卡片首选挂在目标下方（`placement = 'bottom'`）；
  - 若目标位于下半屏，首选挂在目标上方（`placement = 'top'`）；
  - **动态避障检查**：`if (computedTop + popoverHeight > window.innerHeight - 16) -> flip to Top`。
- **水平轴智能防飞出**：
  - 若目标靠右（如右侧抽屉按钮），气泡首选向左弹出（`placement = 'left'` 或贴右边缘）；
  - 气泡水平坐标强制执行 **16px 视口钳位**：
    $$\text{popoverLeft} = \text{clamp}(16\text{px},\ \text{targetCenter} - \frac{\text{width}}{2},\ \text{window.innerWidth} - \text{width} - 16\text{px})$$

#### 2. 动态滑轨自适应三角箭头（Sliding Dynamic Arrow）
- 当指引卡片因防止溢出而向左或向右平移时，卡片上的指示箭头**不得固定在卡片中间**（否则箭头会指向虚空或脱靶）。
- 箭头水平偏移必须根据目标实际中心与卡片相对位置动态算出：
  $$\text{arrowLeft} = \text{clamp}(12\text{px},\ \text{targetCenter} - \text{popoverLeft} - 6\text{px},\ \text{popoverWidth} - 24\text{px})$$
  **确保无论卡片怎么避让，箭头永远死死咬住目标控件的中心！**

#### 3. 三层固定盒模型与操作栏防截断熔断（Pinned Footer）
在小分辨率或 150% 缩放下，指引气泡卡片必须满足：
```css
.spotlight-popover-card {
  max-width: min(420px, calc(100vw - 32px));
  max-height: min(460px, calc(100vh - 48px));
  display: flex;
  flex-direction: column;
  overflow: hidden; /* 保证圆角干净 */
}

/* 顶部标题区：绝对不压缩 */
.spotlight-popover-header {
  flex-shrink: 0;
}

/* 中间内容区：超长时内部优雅纵向滚动，自带细体滚动条 */
.spotlight-popover-body {
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  padding: 12px 16px;
}

/* 底部操作区（下一步/跳过/测试按键）：永远焊死在可视范围内，绝不被挤出！ */
.spotlight-popover-footer {
  flex-shrink: 0;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding: 12px 16px;
  background: rgba(18, 21, 29, 0.95);
}
```

#### 4. 脱离 DOM 堆叠上下文（Direct Body Portal）
- 聚焦气泡与遮罩必须通过 `ReactDOM.createPortal(..., document.body)` 挂载到根节点，彻底粉碎父级容器因 `overflow: hidden`、`transform`、`filter` 等 CSS 属性引发的裁切灾难。

---

## 六、 真实界面用户 E2E 体验验证与验收标准 (Real-World E2E Verification)

> [!IMPORTANT]
> “代码写完、单元测试全绿”并不等于交付完成。所有界面重构改动必须在**真实 Electron 桌面端窗口中执行端到端（E2E）实际用户走查**。

### 6.1 全分辨率与 Windows 缩放实机矩阵测试
必须在以下 5 组典型屏幕分辨率与 DPI 缩放组合下实测通过：

| 分辨率与缩放 | 代表设备 | 关键检查项 | 判定合格标准 |
| :--- | :--- | :--- | :--- |
| **1920×1080 @ 100%** | 标准台式机显示器 | 胶囊栏与抽屉并排完整度 | 75% 验卷面积，抽屉完整展开，无挤压 |
| **1920×1080 @ 125%** | 主流 15.6 寸教学笔记本 | 文字换行与卡片边距 | 胶囊文字无折行，KaTeX 公式完整显示 |
| **1920×1080 @ 150%** | 常见 14 寸轻薄笔记本 | 纵向与横向极限溢出检查 | 抽屉折叠微标正常生效，绝对无横向滚动条 |
| **2560×1440 (2K) @ 125%**| 高清大屏办公机 | 空间留白与字体清晰度 | 文字排版呼吸感优异，切图高保真不糊 |
| **1366×768 @ 100%** | 教室老旧电子白板/应急机 | 极限小屏幕保底能力 | 核心评分按钮与打分输入区必须 100% 可视可按 |

---

### 6.2 真实阅卷业务场景的压力极限用例

在真实运行环境下，注入以下 4 组极限业务数据进行破坏性测试：
1. **极限超长评语压力**：
   - 模拟 AI 生成长达 600 字的详细推导扣分解释，验证是否优雅触发三行截断与“展开/收起”机制，严禁将抽屉底部的“人工重审/确认”按钮顶出可视区。
2. **多达 8 小问的复杂长试卷**：
   - 验证右侧抽屉内部的小问卡片流是否具备平滑的独立纵向滚动（`overflow-y: auto`），滚轮滑动时是否平稳，顶部标题是否具备毛玻璃吸顶效果。
3. **极窄与极长异常切片图**：
   - 注入宽高比 8:1 的长横条草稿切图与 1:4 的长坚竖式切图，验证容器是否均能 `object-fit: contain` 居中适应，无变形拉伸。
4. **真实站点加载延迟态（3 秒白屏/重定向）**：
   - 在智学网换卷、登录或跳转页面期间，主视口必须呈现沉静的深色骨架屏（Skeleton）与“正在同步答卷图像...”微光脉冲，禁止出现突兀的白屏闪烁（Flash of White）。

---

### 6.3 物理教师眼动心流与操作人体工学核对

模拟真实教师连续批阅 50 份试卷的沉浸式心流，检查以下人体工学指标：

- **眼动距离核对**：从“答卷手写推导”（左中）到“AI 得分结论”（右上）视线夹角 $\le 25^\circ$，无需频繁大幅度扭头。
- **单手键盘盲操**：双手无需频繁在“鼠标”和“键盘”之间来回切换；核心操作（启停批改、放行、复核、重跑）均配有单键快捷键（`Space`、`Enter`、`R`、`Esc`）。
- **误触防护**：高危操作（如“清空历史”、“重置配置”）必须具备二次确认或 3 秒撤销气泡（Undo Toast），普通操作禁止频繁弹出烦人的系统级 Modal 阻断工作流。

---

### 6.4 界面验收“五禁五必”一票否决红线

任何重构版本的发布，必须经过以下红线审查，违反任何一条即**一票否决**：

```
【五 禁】
❌ 1. 禁全局横向滚动条：主视口或根页面在任何正常分辨率下均不得出现横向滚动。
❌ 2. 禁公式撑破容器：KaTeX 长公式绝对不得把卡片或侧边栏撑宽变形。
❌ 3. 禁文字折叠重叠：按钮文字或状态 Badge 绝对不得发生垂直文字重叠或截断半个字。
❌ 4. 禁遮挡真实网页输入框：React 悬浮抽屉或胶囊绝对不得盖住智学网/睿芽云的真实打分框与提交按钮。
❌ 5. 禁无反馈卡死态：模型调用或网页加载超过 500ms 时，绝对不得无加载动画或呈死机态。

【五 必】
✔ 1. 必保持视口 ≥ 70%：核心答卷面积在正常窗口下必须占据绝对主导地位。
✔ 2. 必支持 Windows 125%/150% 缩放：在主流笔记本分辨率下必须排布平整有序。
✔ 3. 必具备独立纵向滚动：证据伴侣抽屉内容超长时，必须抽屉内部自循环滚动，不带跑整页。
✔ 4. 必保持切图可读性：手写切片在暗色模式下必须保留最高对比度，点击必能灯箱无损放大。
✔ 5. 必实现键盘优先流：整个自动化流程支持单空格键无缝起停。
```

---

## 七、 启动 Codex 落地重构的官方指令 Prompt (Codex Launch Prompt)

> [!TIP]
> **使用方法**：直接将下方 Markdown 框内的指令完整复制并发送给 Codex 或具备代码写权限的智能体。

````markdown
# Codex Mission: 衡准·物理改卷工作台 界面重构与防溢出排布工程落地

## 1. 任务背景与核心使命
你正在为《衡准 · 物理阅卷工作台》（Electron + React 19 + TypeScript 严格模式）执行界面重构。
请根据项目 `docs/workbench-redesign/` 目录下的设计白皮书与 H5 交互原型，将旧版拥挤杂乱的工作台重构为极客级暗场工作台。

## 2. 必须阅读的参考与规则文件
在开始修改代码之前，你必须完整阅读并遵守以下文件约束：
- `AGENTS.md`：核心设计不变量（计分权威、复核安全、防串卷三道防线、严格 json_schema、标准验证链）。
- `docs/workbench-redesign/workbench-design-spec-and-aesthetic-standards.md`：设计白皮书（核心目标、色彩系统、防溢出铁律、E2E 验收清单）。
- `docs/workbench-redesign/spotlight-tour-implementation.md`：现场暗场聚光灯引导实施细则。
- `docs/workbench-redesign/workbench-interactive-prototype.html`：已通过的完整 H5 演示原型。

## 3. 核心实现要点与硬性边界约束
1. **视口黄金分割 (Content-First)**：
   - 左侧真实网页/答卷嵌入视口必须占据全屏 70%~75% 面积，无冗余多层边框；
   - 顶部悬浮控制胶囊（HUD Floating Capsule）高度严格限制在 44px 以内，采用暗场毛玻璃；
   - 右侧证据伴侣抽屉（Evidence Companion Drawer）宽度默认 320px，支持平滑收折，大屏自适应，超长卡片独立自循环滚动。
2. **防溢出与边界保护铁律 (Anti-Overflow)**：
   - 根容器强制 `overflow-x: hidden;`，严禁产生全局横向滚动条；
   - 所有水平 Flex 文本项必须添加 `min-width: 0;`，图标加 `flex-shrink: 0;`；
   - 适配 Windows 125%/150% DPI 缩放，屏幕宽度 < 1280px 时证据抽屉自动折叠为悬浮微标；
   - KaTeX 复杂公式必须包裹在带 `max-width: 100%; overflow-x: auto;` 的专用容器内；
   - 极端长宽比切片图限制 `max-height: 220px; object-fit: contain;`，严禁拉伸变形；
   - 严格遵循 9 级 Z-Index 分层天梯，严禁任意书写 `z-index: 99999`。
3. **聚焦引导（Spotlight Tour）对话框防溢出引擎**：
   - 必须实现基于视口碰撞的主动翻转（Auto-Flip：上下自动判定、左右 16px 视口钳位）；
   - 指示箭头必须支持动态滑轨计算，严禁箭头脱靶或指向虚空；
   - 对话框采用三层盒模型：Header 与 Footer 必须 `flex-shrink: 0;`（操作按钮永远在可视范围内），Body 内部溢出纵向滚动；
   - 必须使用 `ReactDOM.createPortal(..., document.body)` 挂载，彻底摆脱父级 `overflow: hidden` 的裁切。
4. **单手键盘盲操流**：
   - `Space` 键无缝启停改卷流水线；
   - `Tab` 键快速展开/收折右侧证据抽屉；
   - `Esc` 键退出灯箱或弹窗。

## 4. 标准实施步骤 (Phased Plan)
- **Phase 1: 基础防溢出机制与定位 Hook**
  - 创建 `src/useSmartPositioning.ts` 实现视口碰撞检测、16px 钳位与滑轨箭头计算。
  - 完善 CSS 变量与 `.katex-safe-container` 防撑破样式。
- **Phase 2: 零溢出聚焦引导组件 (Spotlight Tour)**
  - 实现基于 Portal 的 `SpotlightTour` 组件，覆盖沙盒破冰、API 配置气泡与真实考卷感应流程。
- **Phase 3: 桌面端主工作台双栏排布重构**
  - 重构 `src/DesktopApp.tsx` 与相关样式，接入 44px 极简顶栏胶囊与右侧可收折证据抽屉。
  - 保持 Electron `updateViewBounds` 像素级同步。
- **Phase 4: 全量回归与标准验证链**
  - 依次执行：`npx tsc -b` -> `npx tsc -p tsconfig.server.json` -> `npx tsc -p tsconfig.electron.json` -> `npx vitest run` -> `npm run build`。
  - 确保 50 个测试文件、454 项测试全部通过，0 编译错误。

请按照以上规范与步骤逐步执行，每完成一个阶段均进行严格的类型与回归自检。
````

---

## 八、 供 ChatGPT / Claude 进行 UI 设计对话的 Prompt (UI Chat Prompt)

如果你是在 ChatGPT 或 Claude 对话框中进行 UI 组件微调或探讨，请复制以下 Prompt：

````markdown
你是一位精通 Linear、Raycast、Figma 视觉风格的高级前端架构师。
请协助我重构《衡准 · 物理阅卷工作台》的 UI 组件，核心要求：
1. 暗场 Obsidian 风格：底色 #0B0D12，表面色 #12151D，1px 细线边框 rgba(255,255,255,0.07)，语义色采用翡翠绿、琥珀金、玫瑰红。
2. 空间极致防御：严禁横向滚动条，Flex 文本项必带 min-width: 0，长公式独立滚动，切片图防拉伸。
3. 聚焦引导气泡零溢出：自动视口碰撞翻转（Auto-Flip）、16px 屏幕边距钳位、滑轨自适应三角箭头、底栏按钮防截断。
请产出符合 React 19 + TypeScript 严格标准的纯净代码。
````

---
> *本设计规范书由衡准团队深度研发制定，作为全自动物理阅卷系统的视觉与交互终极基线。*
