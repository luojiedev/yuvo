import { createRoot } from "react-dom/client";
import { BookkeepingApp } from "../app/BookkeepingApp";
import "../app/globals.css";

const container = document.getElementById("root");
if (!container) {
  console.error("[demo] application container is missing");
  throw new Error("应用页面加载失败，请重新打开体验地址。");
}

console.debug("[demo] starting local-only experience");
createRoot(container).render(<BookkeepingApp />);
