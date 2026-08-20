import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main className="garden-background text-moss grid min-h-screen content-center px-page py-8">
      <p className="text-eyebrow tracking-eyebrow text-sage mb-4 font-bold uppercase">
        Garden planning, without the graph paper
      </p>
      <h1 className="text-display leading-display tracking-display font-serif font-medium">
        Mossboard
      </h1>
      <p className="text-introduction leading-introduction mt-10 max-w-2xl">
        Turn a walk around your garden into an editable board for beds,
        paths, trees, notes, and the ideas you have not settled on yet.
      </p>
      <p className="text-sage-dark border-moss/25 mt-12 w-fit rounded-full border px-4 py-2 text-sm">
        The web workspace is being planted.
      </p>
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
