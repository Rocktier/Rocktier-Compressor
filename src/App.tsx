import { useEffect, useState } from "react";

function App() {
  const [lang, setLang] = useState<"en" | "zh">("zh");
  const t = (zh: string, en: string) => (lang === "zh" ? zh : en);

  useEffect(() => {
    document.title = "Rocktier Compressor";
  }, []);

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-drag-region">
          <span className="brand-dot" />
          <span className="title-text">Rocktier Compressor</span>
        </div>
        <div className="lang-toggle">
          <button
            className={lang === "zh" ? "active" : ""}
            onClick={() => setLang("zh")}
          >
            中文
          </button>
          <button
            className={lang === "en" ? "active" : ""}
            onClick={() => setLang("en")}
          >
            EN
          </button>
        </div>
      </header>

      <main className="content">
        <div className="dropzone">
          <div className="dropzone-icon">↓</div>
          <p className="dropzone-title">
            {t("拖放文件到这里开始压缩", "Drop files here to start compressing")}
          </p>
          <p className="dropzone-subtitle">
            {t("支持 PDF, Word, Excel, PowerPoint, 图片", "Supports PDF, Word, Excel, PowerPoint, Images")}
          </p>
        </div>
      </main>

      <footer className="statusbar">
        <span>{t("就绪", "Ready")}</span>
      </footer>
    </div>
  );
}

export default App;
