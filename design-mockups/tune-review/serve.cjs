const http = require("http"), fs = require("fs"), path = require("path");
const root = __dirname;
const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
http.createServer((req, res) => {
  const p = path.join(root, req.url === "/" ? "index.html" : req.url.split("?")[0]);
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": mime[path.extname(p)] || "text/plain" });
    res.end(d);
  });
}).listen(8321, () => console.log("http://localhost:8321"));
