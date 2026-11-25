import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const maxArchiveBytes = 200 * 1024 * 1024;

function archivePath(directory, archive) {
  if (!/^dsh-industry-research-\d+\.\d+\.\d+\.tgz$/.test(archive.name) ||
    !/^[a-f0-9]{64}$/.test(archive.sha256) ||
    !Number.isSafeInteger(archive.size) || archive.size < 1 || archive.size > maxArchiveBytes) {
    throw new Error('更新安装包信息无效');
  }
  return join(directory, `${archive.sha256}-${archive.name}`);
}

async function validFile(path, archive) {
  let size;
  try { size = (await stat(path)).size; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (size !== archive.size) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex') === archive.sha256;
}

export async function stageUpdateArchive(directory, archive, request, signal, onProgress = () => {}) {
  const target = archivePath(directory, archive);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await validFile(target, archive)) {
    onProgress(archive.size, archive.size);
    return { path: target, cached: true };
  }
  const url = new URL(archive.url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password ||
    url.pathname !== `/zaki-zeyi/dsh-industry-research/releases/download/v${archive.version}/${archive.name}`) {
    throw new Error('更新安装包地址无效');
  }
  const response = await request(url.href, { signal, headers: { 'User-Agent': 'dsh-industry-research' } });
  if (!response.ok || !response.body) throw new Error(`更新安装包下载失败：${response.status}`);
  const temp = join(directory, `.download-${randomUUID()}.tmp`);
  const file = await open(temp, 'wx', 0o600);
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of response.body) {
      signal?.throwIfAborted();
      size += chunk.length;
      if (size > archive.size || size > maxArchiveBytes) throw new Error('更新安装包大小不符');
      hash.update(chunk);
      await file.writeFile(chunk);
      onProgress(size, archive.size);
    }
    if (size !== archive.size || hash.digest('hex') !== archive.sha256) throw new Error('更新安装包校验失败');
    await file.sync();
    await file.close();
    try { await rename(temp, target); }
    catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
      await unlink(target);
      await rename(temp, target);
    }
    return { path: target, cached: false };
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}
