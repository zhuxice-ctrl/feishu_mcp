import http from "node:http";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const host = args.get("--host") ?? "127.0.0.1";
const port = Number(args.get("--port"));
const readyPath = args.get("--ready-path") ?? "/ready";
const delay = Number(args.get("--delay") ?? 0);
const exitBeforeReady = args.has("--exit-before-ready");
if (exitBeforeReady) process.exit(7);
setTimeout(() => {
  const server = http.createServer((request, response) => {
    response.statusCode = request.url === readyPath ? 200 : 404;
    response.end(request.url === readyPath ? "ready" : "missing");
  });
  server.listen(port, host, () => process.stdout.write("ready\n"));
}, delay);
