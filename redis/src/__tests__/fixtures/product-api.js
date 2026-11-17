/* ======================================================================
 * demo/product-api.js — 미니 레디스를 캐시로 쓰는 간단한 상품 API
 *
 *   GET /products/:id   상품 조회. 응답 헤더 X-Cache: HIT | MISS | OFF
 *   PUT /products/:id   가격 변경 ← { price }. 원본을 바꾼 뒤 캐시의 값을 지운다 (무효화)
 *
 *   cache 를 넘기면 조회 결과를 미니 레디스에 'product:<id>' 키로 저장해 두고 다시 쓴다.
 *   cache 를 넘기지 않으면 매번 원본(product-db.js)을 읽는다. (성능 비교용)
 * ====================================================================== */

import http from 'node:http';

const send = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
};

function readBody(req) {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(text)); } catch (e) { resolve(null); } });
  });
}

export function createProductApi({ db, cache = null }) {
  return http.createServer(async (req, res) => {
    try {
      const match = /^\/products\/(\d+)$/.exec(new URL(req.url, 'http://localhost').pathname);
      if (!match) { send(res, 404, { error: '없는 경로입니다' }); return; }
      const id = Number(match[1]);

      if (req.method === 'GET') {
        let product, state = 'OFF';
        if (cache) {
          const result = await cache.getOrLoad('product:' + id, () => db.findById(id));
          product = result.value;
          state = result.hit ? 'HIT' : 'MISS';
        } else {
          product = await db.findById(id);
        }
        if (!product) { send(res, 404, { error: '없는 상품입니다' }, { 'x-cache': state }); return; }
        send(res, 200, product, { 'x-cache': state });
        return;
      }

      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (!body || !Number.isInteger(body.price) || body.price < 0) { send(res, 400, { error: 'price 는 0 이상의 정수여야 합니다' }); return; }
        const updated = await db.updatePrice(id, body.price);
        if (!updated) { send(res, 404, { error: '없는 상품입니다' }); return; }
        if (cache) await cache.invalidate('product:' + id);        // 원본이 바뀌었으니 캐시의 옛 값을 지운다
        send(res, 200, updated);
        return;
      }

      send(res, 405, { error: '지원하지 않는 메서드입니다' });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });
}
