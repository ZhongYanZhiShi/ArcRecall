import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { resolve, extname, sep } from "node:path"

const root = resolve("out")
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
}
createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(
      new URL(request.url, "http://127.0.0.1").pathname
    )
    const file = resolve(
      root,
      `.${pathname === "/" ? "/index.html" : pathname}`
    )
    if (!file.startsWith(root + sep)) {
      response.writeHead(403).end()
      return
    }
    const content = await readFile(file)
    response
      .writeHead(200, {
        "Content-Type": types[extname(file)] ?? "application/octet-stream",
      })
      .end(content)
  } catch {
    response.writeHead(404).end()
  }
}).listen(3107, "127.0.0.1", () =>
  process.stdout.write("Static test build: http://127.0.0.1:3107\n")
)
