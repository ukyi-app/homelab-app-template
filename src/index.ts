const text = (body: string, init?: ResponseInit) => new Response(body, init);
const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

const fetch = (req: Request) => {
  const { pathname } = new URL(req.url);

  if (pathname === "/") return text("Hello homelab app!");
  if (pathname === "/health") return json({ status: "ok" });

  return text("not found", { status: 404 });
};

export default {
  port: Number(process.env.PORT) || 8080,
  fetch,
};
