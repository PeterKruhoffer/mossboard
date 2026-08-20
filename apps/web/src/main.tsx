import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main>
      <p className="eyebrow">Garden planning, without the graph paper</p>
      <h1>Mossboard</h1>
      <p className="introduction">
        Turn a walk around your garden into an editable board for beds,
        paths, trees, notes, and the ideas you have not settled on yet.
      </p>
      <p className="status">The web workspace is being planted.</p>
    </main>
  );
}

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Missing application root");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
