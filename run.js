// 引入 Node 内置模块
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// 内容类型映射
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

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.ogg']);

// 简单日志函数
function log(level, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
}

// 内存缓存（仅用于视频预加载）
const videoCache = new Map(); // key: relative path under show (no leading '/'), value: Buffer

// 递归扫描并预加载视频文件到内存
async function preloadVideos(dir) {
  log('info', `开始预加载视频：${dir}`);
  async function walk(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (VIDEO_EXTS.has(ext)) {
          try {
            const stats = await fsp.stat(full);
            const buf = await fsp.readFile(full);
            const rel = path.relative(path.join(__dirname, 'show'), full).replace(/\\/g, '/');
            const etag = `"${stats.size}-${stats.mtimeMs}"`;
            const lastModified = stats.mtime.toUTCString();
            videoCache.set(rel, { buffer: buf, contentType: contentTypes[ext] || 'application/octet-stream', etag, lastModified });
            log('info', `已缓存视频: show/${rel} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
          } catch (e) {
            log('warn', `预加载失败: ${full} -> ${e.message}`);
          }
        }
      }
    }
  }
  try {
    await walk(dir);
    log('info', `预加载完成，缓存视频数量：${videoCache.size}`);
  } catch (e) {
    log('error', `预加载过程中出错：${e.message}`);
  }
}

// 解析 Range header
function parseRange(rangeHeader, total) {
  if (!rangeHeader) return null;
  const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!m) return null;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null && end !== null) {
    start = Math.max(total - end, 0);
    end = total - 1;
  }
  if (start !== null && end === null) end = total - 1;
  if (start == null || isNaN(start) || isNaN(end) || start > end || start < 0) return null;
  return { start, end };
}

const server = http.createServer(async (req, res) => {
  const now = new Date().toISOString();
  log('info', `${req.method} ${req.url}`);
  try {
    const urlPath = decodeURIComponent(req.url.split('?')[0] || '/');
    // 规则：`/` 或 `/index.html` 直接返回项目根的 index.html，其他一律从 show 目录读取
    let filePath;
    if (urlPath === '/' || urlPath === '' || urlPath === '/index.html') {
      filePath = path.normalize(path.join(__dirname, 'index.html'));
    } else {
      const rel = urlPath.replace(/^\//, '');
      filePath = path.normalize(path.join(__dirname, 'show', rel));
    }

    // 防止目录遍历
    if (!filePath.startsWith(path.normalize(__dirname + path.sep))) {
      res.writeHead(403);
      res.end('禁止访问');
      log('warn', `禁止访问尝试: ${req.url}`);
      return;
    }

    // 如果请求的是视频，并且已缓存在内存中，则支持 Range
    const ext = path.extname(filePath).toLowerCase();
    const isVideo = VIDEO_EXTS.has(ext);
    if (isVideo) {
      const relKey = path.relative(path.join(__dirname, 'show'), filePath).replace(/\\/g, '/');
      const cached = videoCache.get(relKey);
      if (cached) {
        const total = cached.buffer.length;
        const etag = cached.etag;
        const lastModified = cached.lastModified;
        // 设置缓存相关头
        res.setHeader('Content-Type', cached.contentType);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('ETag', etag);
        res.setHeader('Last-Modified', lastModified);
        res.setHeader('Cache-Control', 'public, max-age=3600');

        // If-None-Match -> 304 (仅当非 Range 请求)
        const inm = req.headers['if-none-match'];
        const ims = req.headers['if-modified-since'];
        const range = parseRange(req.headers.range, total);
        if (!range && inm && inm === etag) {
          res.writeHead(304);
          res.end();
          return;
        }
        if (!range && ims && new Date(ims).getTime() >= new Date(lastModified).getTime()) {
          res.writeHead(304);
          res.end();
          return;
        }

        // 支持 Range 请求
        if (range) {
          const chunk = cached.buffer.slice(range.start, range.end + 1);
          res.writeHead(206, {
            'Content-Range': `bytes ${range.start}-${range.end}/${total}`,
            'Content-Length': chunk.length,
            'ETag': etag,
            'Last-Modified': lastModified,
            'Cache-Control': 'public, max-age=3600'
          });
          res.end(chunk);
          return;
        } else {
          res.writeHead(200, { 'Content-Length': total });
          res.end(cached.buffer);
          return;
        }
      }
    }

    // 文件系统处理（支持目录 index.html 与 Range）
    fs.stat(filePath, (err, stats) => {
      if (err) {
        res.writeHead(404);
        res.end('文件不存在');
        log('warn', `404 ${req.url} -> ${filePath}`);
        return;
      }

      if (stats.isDirectory()) {
        const indexFile = path.join(filePath, 'index.html');
        fs.stat(indexFile, (ie, istats) => {
          if (ie || !istats.isFile()) {
            res.writeHead(404);
            res.end('文件不存在');
            log('warn', `目录无 index: ${filePath}`);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          fs.createReadStream(indexFile).pipe(res);
        });
        return;
      }

      const contentType = contentTypes[ext] || 'application/octet-stream';
      // 支持 Range 与 条件请求
      const total = stats.size;
      const etag = `"${stats.size}-${stats.mtimeMs}"`;
      const lastModified = stats.mtime.toUTCString();
      const range = parseRange(req.headers.range, total);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', lastModified);
      res.setHeader('Cache-Control', 'public, max-age=3600');

      // 条件请求处理（无 range 的情况下可返回 304）
      const inm = req.headers['if-none-match'];
      const ims = req.headers['if-modified-since'];
      if (!range && inm && inm === etag) {
        res.writeHead(304);
        res.end();
        return;
      }
      if (!range && ims && new Date(ims).getTime() >= new Date(lastModified).getTime()) {
        res.writeHead(304);
        res.end();
        return;
      }

      if (range) {
        const { start, end } = range;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': end - start + 1,
          'ETag': etag,
          'Last-Modified': lastModified
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Length': total });
        fs.createReadStream(filePath).pipe(res);
      }
    });
  } catch (e) {
    res.writeHead(500);
    res.end('服务器错误');
    log('error', `处理请求出错: ${e.message}`);
  }
});

// 先预加载 show 下的视频，然后启动服务器
const SHOW_DIR = path.join(__dirname, 'show');
(async () => {
  // 尝试创建缓存（若 show 不存在则跳过）
  try {
    const s = await fsp.stat(SHOW_DIR);
    if (s && s.isDirectory()) {
      await preloadVideos(SHOW_DIR);
    } else {
      log('info', `未找到 show 目录，跳过预加载`);
    }
  } catch (e) {
    log('info', `预加载: show 目录不存在或不可访问，跳过 (${e.message})`);
  }

  const PORT = 13733;
  server.listen(PORT, () => {
    log('info', `服务器已启动: http://localhost:${PORT}`);
  });
})();