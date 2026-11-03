import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { MAX_LOCAL_UPLOAD_BYTES } from './internal-materials.mjs';
import { ServiceError } from './service-error.mjs';
const filename = z.string().min(1).max(240).refine(v => !/[\/\\\x00-\x1f\x7f]/.test(v) && v !== '.' && v !== '..', '文件名无效');

// Browser File inputs deliberately hide absolute paths. Stream the selected
// bytes to the host instead of ever treating C:\fakepath as a real file.
export function registerInternalFileUpload(app, service, directory) {
  app.post('/api/internal-material-files', async (req, res, next) => {
    let staging;
    try {
      if (!directory) throw new ServiceError(503, '当前服务未启用本地文件导入');
      if (service.cloudOnly) await service.binding.requireBound();
      const name = filename.parse(req.query.name);
      if (req.headers['content-type'] !== 'application/octet-stream') throw new ServiceError(415, '请选择文件后重试');
      const length = Number(req.headers['content-length']);
      if (length > MAX_LOCAL_UPLOAD_BYTES) throw new ServiceError(413, '本地文件不能超过 100 MB');
      await mkdir(directory, { recursive: true });
      staging = await mkdtemp(join(resolve(directory), 'selected-'));
      let size = 0;
      const limit = new Transform({ transform(chunk, _encoding, done) {
        size += chunk.length;
        done(size > MAX_LOCAL_UPLOAD_BYTES ? new ServiceError(413, '本地文件不能超过 100 MB') : null, chunk);
      }});
      const abort = () => limit.destroy(new Error('文件导入已中断'));
      req.once('aborted', abort); req.once('error', abort);
      try {
        // Keep the request out of pipeline's destruction so size errors can
        // still return an actionable HTTP response, including chunked uploads.
        req.pipe(limit);
        await pipeline(limit, createWriteStream(join(staging, '.upload'), { flags: 'wx' }));
      } finally {
        req.unpipe(limit); req.removeListener('aborted', abort); req.removeListener('error', abort);
      }
      if (!size) throw new ServiceError(400, '不能导入空文件');
      const source = join(staging, name);
      await rename(join(staging, '.upload'), source);
      res.status(201).json({ source, name, size });
    } catch (error) {
      if (staging) await rm(staging, { recursive: true, force: true });
      if (!req.destroyed) req.resume();
      next(error);
    }
  });
}
