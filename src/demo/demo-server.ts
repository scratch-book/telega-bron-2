import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 3847;
const HTML_FILE = path.join(__dirname, 'demo-page.html');

// For compiled version, check both dist and src locations
function getHtmlPath(): string {
  if (fs.existsSync(HTML_FILE)) return HTML_FILE;
  const srcPath = path.join(__dirname, '..', '..', 'src', 'demo', 'demo-page.html');
  if (fs.existsSync(srcPath)) return srcPath;
  throw new Error('Demo HTML file not found');
}

let server: http.Server | null = null;

export function startDemoServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (server) {
      resolve(`http://localhost:${PORT}`);
      return;
    }

    const htmlPath = getHtmlPath();
    const html = fs.readFileSync(htmlPath, 'utf-8');

    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });

    server.listen(PORT, () => {
      resolve(`http://localhost:${PORT}`);
    });

    server.on('error', reject);
  });
}

export function stopDemoServer(): void {
  if (server) {
    server.close();
    server = null;
  }
}
