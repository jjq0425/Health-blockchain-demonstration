// 引入 Node 内置模块
const http = require('http');
const fs = require('fs');
const path = require('path');

// 创建服务器（简单静态文件服务器）
const contentTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.wasm': 'application/wasm'
};

const server = http.createServer((req, res) => {
  try {
    // 解码并规范化请求路径
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let safePath = urlPath;
    if (safePath === '/' || safePath === '') safePath = '/index.html';

    const filePath = path.normalize(path.join(__dirname, safePath));

    // 防止目录遍历
    if (!filePath.startsWith(path.normalize(__dirname + path.sep))) {
      res.writeHead(403);
      res.end('禁止访问');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err) {
        res.writeHead(404);
        res.end('文件不存在');
        return;
      }

      if (stats.isDirectory()) {
        // 如果是目录，尝试返回目录下的 index.html
        const indexFile = path.join(filePath, 'index.html');
        fs.stat(indexFile, (ie, istats) => {
          if (ie || !istats.isFile()) {
            res.writeHead(404);
            res.end('文件不存在');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          fs.createReadStream(indexFile).pipe(res);
        });
        return;
      }

      // 设置正确的 Content-Type
      const ext = path.extname(filePath).toLowerCase();
      const contentType = contentTypes[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
    });
  } catch (e) {
    res.writeHead(500);
    res.end('服务器错误');
  }
});

// 启动服务，端口 13733
server.listen(13733, () => {
  console.log('服务器已启动：http://localhost:13733');
});