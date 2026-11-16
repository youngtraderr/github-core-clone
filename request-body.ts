import type { IncomingMessage } from 'node:http';

export function readRequest(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let first: Buffer | undefined;
    let chunks: Buffer[] | undefined;
    let length = 0;
    req.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (!first) first = chunk;
      else if (chunks) chunks.push(chunk);
      else chunks = [first, chunk];
    });
    req.on('end', () => resolve(chunks ? Buffer.concat(chunks, length) : first || Buffer.alloc(0)));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('Request aborted')));
  });
}
