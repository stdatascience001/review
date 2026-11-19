// Prints raw and gzipped sizes of the built widget files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');

export const report = () => {
  const files = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) {
        if (f.name !== '.vite') walk(p);
      } else if (f.name.endsWith('.js')) files.push(p);
    }
  };
  walk(dist);
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  for (const f of files) {
    const buf = fs.readFileSync(f);
    console.log(`${path.relative(dist, f).padEnd(40)} ${kb(buf.length).padStart(9)}  gzip ${kb(zlib.gzipSync(buf).length).padStart(8)}`);
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) report();
