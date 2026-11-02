import { existsSync, mkdirSync } from 'node:fs';
if (!existsSync(new URL('../dist/index.html', import.meta.url))) throw new Error('请先运行 npm run build');
mkdirSync(new URL('../artifacts', import.meta.url), { recursive: true });
