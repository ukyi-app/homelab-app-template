export function tick(now = new Date()) {
  return `worker tick ${now.toISOString()}`;
}

export function main() {
  console.log("worker started");
  const timer = setInterval(() => console.log(tick()), 60_000);
  const stop = () => {
    clearInterval(timer);
    console.log("worker stopped");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (import.meta.main) main();
