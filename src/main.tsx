import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import DesktopApp from "./DesktopApp";
import MockGradingPage from "./MockGradingPage";
import "katex/dist/katex.min.css";
import "./styles.css";
import "./desktop.css";
import ZhixueMockPage from "./ZhixueMockPage";
import "./zhixueMock.css";

const isElectron = new URLSearchParams(window.location.search).get("electron") === "1";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {window.location.pathname === "/mock-grading"
      ? <MockGradingPage />
      : window.location.pathname === "/zhixue-mock"
        ? <ZhixueMockPage />
      : isElectron
        ? <DesktopApp />
        : <App />}
  </StrictMode>
);
