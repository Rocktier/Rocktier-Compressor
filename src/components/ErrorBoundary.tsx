import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 全局错误边界：任何未捕获的渲染/Effect 异常都不应让窗口永久白屏。
 * 兜底 UI 提供重载入口，用户不必杀进程 —— 白屏是用户最无法自救的失败形态。
 *
 * 兜底文案刻意写成中英双语硬编码，而不是走 i18n —— 出错时坏掉的可能正是
 * i18n 本身，那时再依赖它取文案就一个字也显示不出来。
 *
 * 配色用家族令牌（--text-primary / --bg-primary / --border），三态主题自动
 * 跟随；按钮取「透明底 + 描边 + 令牌文字色」，而不是实心 accent 底 ——
 * accent 在三态主题下会变（浅色主题里可能变深），实心底会出现黑底黑字。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Uncaught error in renderer:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            gap: 12,
            fontFamily: "inherit",
            color: "var(--text-primary, #f5f5f5)",
            background: "var(--bg-primary, #0a0a0a)",
            padding: 24,
            textAlign: "center",
          }}
        >
          <h2 style={{ fontSize: 16, margin: 0 }}>出错了 / Something went wrong</h2>
          <p style={{ fontSize: 12, opacity: 0.6, margin: 0, maxWidth: 520 }}>
            数据未受影响 / Your data is safe. 重新加载通常即可恢复 / Reloading usually fixes it.
          </p>
          <pre
            style={{
              maxWidth: 640,
              whiteSpace: "pre-wrap",
              fontSize: 12,
              opacity: 0.7,
              maxHeight: 160,
              overflow: "auto",
              margin: 0,
            }}
          >
            {String(this.state.error?.message || this.state.error)}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 20px",
              borderRadius: 8,
              border: "1px solid var(--border-strong, rgba(255,255,255,0.38))",
              background: "transparent",
              color: "var(--text-primary, #f5f5f5)",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            重新加载 / Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
