// Vercel backend entrypoint (ESM).
//
// Rules the launcher enforces:
// 1. The default export must be a plain function - a re-export gets bundled
//    into a nested default (mod.default.default) and rejected.
// 2. The entry is named index.js: the lambda keys files by basename and
//    dist/server.js would collide; dist/ contains no index.*.
//
// dist/prod.mjs exports the http.Server as default and skips listen() when
// process.env.VERCEL is set. Each request is dispatched into that server's
// own request listener, reusing the `node dist/prod.mjs` pipeline.
import mod from './dist/prod.mjs';

const server = mod && mod.default ? mod.default : mod;

export default function handler(req, res) {
  if (!server || typeof server.emit !== 'function') {
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Oboext server bundle failed to load');
    return;
  }
  server.emit('request', req, res);
}
