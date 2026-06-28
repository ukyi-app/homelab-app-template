import "./styles.css";

const routes: Record<string, string> = {
  "/": "Home",
  "/about": "About",
};

function render() {
  const title = routes[location.pathname] ?? "Not found";
  document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
    <h1>${title}</h1>
    <nav>
      <a href="/">Home</a>
      <a href="/about">About</a>
    </nav>
    <p>SWS serves Vite assets and falls back unknown paths to index.html for the client router.</p>
  `;
}

document.addEventListener("click", (event) => {
  const anchor = (event.target as HTMLElement).closest("a");
  if (!anchor || anchor.origin !== location.origin) return;
  event.preventDefault();
  history.pushState(null, "", anchor.href);
  render();
});

addEventListener("popstate", render);
render();
