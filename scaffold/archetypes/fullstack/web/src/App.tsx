import { useEffect, useState } from "react";

export function App() {
  const [msg, setMsg] = useState("로딩...");
  useEffect(() => {
    fetch("/api/hello")
      .then((r) => r.json())
      .then((d: { message: string }) => setMsg(d.message))
      .catch(() => setMsg("API 오류"));
  }, []);
  return (
    <main style={{ fontFamily: "sans-serif", padding: 32 }}>
      <h1>homelab fullstack</h1>
      <p>{msg}</p>
    </main>
  );
}
