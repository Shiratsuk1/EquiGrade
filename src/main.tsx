import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import DesktopApp from "./DesktopApp";
import MockGradingPage from "./MockGradingPage";
import "katex/dist/katex.min.css";
import "./styles.css";
import "./desktop.css";
import ZhixueMockPage from "./ZhixueMockPage";
import "./zhixueMock.css";

const isElectron = new URLSearchParams(window.location.search).get("electron") === "1";

/**
 * Web 版（App.tsx）已随桌面工作台合并下线：批改入口统一走 Electron 桌面端。
 * 浏览器直开本服务时展示引导页，仅保留两个站点测试入口。
 * 注意：App.tsx 仍被 DesktopApp 复用其导出的报告组件（ResultDetail 等），不可删除。
 */
function DesktopOnlyNotice() {
  return <div className="desktop-only-notice">
    <div className="desktop-only-notice-card">
      <span className="desktop-only-notice-mark">衡准</span>
      <h1>请使用桌面工作台</h1>
      <p>自动批改已迁移到 <strong>衡准自动改卷工作台</strong>（Electron 桌面端）。请通过桌面端启动批改任务；本网页仅保留站点适配测试入口。</p>
      <nav>
        <a href="/zhixue-mock">智学网模拟阅卷页</a>
        <a href="/mock-grading">通用控件测试页</a>
      </nav>
    </div>
  </div>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {window.location.pathname === "/mock-grading"
      ? <MockGradingPage />
      : window.location.pathname === "/zhixue-mock"
        ? <ZhixueMockPage />
      : isElectron
        ? <DesktopApp />
        : <DesktopOnlyNotice />}
  </StrictMode>
);
