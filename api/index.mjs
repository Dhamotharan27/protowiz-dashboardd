// Vercel Function: every /api/* request is sent here (see vercel.json) and handled by server.js.
import server from '../server.js';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    let path = url.pathname;
    // vercel.json also passes the original path as ?__path=..., in case the function sees the rewritten URL
    const original = url.searchParams.get('__path');
    if (original !== null && !/^\/api\/(?!index)/.test(path)) path = '/api/' + original.replace(/^\/+/, '');
    const body = ['POST', 'PATCH'].includes(request.method) ? await request.text() : '';
    const r = await server.handleApi({
      method: request.method, path, body,
      auth: request.headers.get('authorization'),
      localDate: request.headers.get('x-local-date')
    });
    return new Response(JSON.stringify(r.data), {
      status: r.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
};
