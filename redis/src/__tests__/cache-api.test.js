/* 기능 테스트 — 간단한 API 의 응답을 미니 레디스에 저장해 활용한다
 *
 *   서버 두 개를 실제로 띄운다.
 *     미니 레디스 서버 ←(HTTP)— 상품 API 서버 ←(HTTP)— 테스트
 *   상품 API 는 원본(상품 파일)을 읽은 결과를 미니 레디스에 캐시한다. db.reads 로 원본을 몇 번 읽었는지 센다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createStore } from '../store.js';
import { createApiServer, listen, close } from '../api.js';
import { createClient } from '../client.js';
import { createCache } from '../cache.js';
import { createProductDb, createProductFile } from '../../demo/product-db.js';
import { createProductApi } from '../../demo/product-api.js';

let dir, db, redisServer, redis, apiServer, api;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-redis-api-'));
  createProductFile(path.join(dir, 'products.jsonl'), 300);
  db = createProductDb(path.join(dir, 'products.jsonl'));
  redisServer = createApiServer(createStore());
  redis = createClient(await listen(redisServer));
  apiServer = createProductApi({ db, cache: createCache(redis, { ttl: 150 }) });
  api = await listen(apiServer);
});
after(async () => {
  await close(apiServer);
  await close(redisServer);
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => { await redis.flushAll(); db.reads = 0; });

const getProduct = async (id) => {
  const res = await fetch(api + '/products/' + id);
  return { status: res.status, cache: res.headers.get('x-cache'), body: await res.json() };
};

test('첫 조회는 원본을 읽고(MISS) 미니 레디스에 저장한다. 두 번째부터는 원본을 읽지 않는다(HIT)', async () => {
  const first = await getProduct(7);
  assert.equal(first.cache, 'MISS');
  assert.deepEqual(first.body, { id: 7, name: '상품 7', price: 1700, stock: 7 });
  assert.deepEqual(await redis.get('product:7'), first.body);        // 응답 값이 미니 레디스에 들어 있다

  const second = await getProduct(7);
  const third = await getProduct(7);
  assert.equal(second.cache, 'HIT');
  assert.deepEqual(third.body, first.body);
  assert.equal(db.reads, 1);                                         // 세 번 조회했지만 원본은 한 번만 읽었다
});

test('보관 기간이 지나면 다시 원본을 읽는다', async () => {
  await getProduct(8);
  await sleep(250);
  const again = await getProduct(8);
  assert.equal(again.cache, 'MISS');
  assert.equal(db.reads, 2);
});

test('무효화: 가격을 바꾸면 캐시의 옛 값이 지워져, 다음 조회가 새 가격을 돌려준다', async () => {
  assert.equal((await getProduct(9)).body.price, 1900);
  const put = await fetch(api + '/products/9', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"price":5000}' });
  assert.equal(put.status, 200);
  assert.equal(await redis.get('product:9'), null);

  const after = await getProduct(9);
  assert.equal(after.cache, 'MISS');
  assert.equal(after.body.price, 5000);
  assert.equal((await getProduct(9)).cache, 'HIT');
});

test('동시 조회: 캐시에 없는 같은 상품을 20명이 한꺼번에 요청해도 원본은 한 번만 읽는다', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => getProduct(10)));
  assert.ok(results.every((r) => r.status === 200 && r.body.id === 10));
  assert.equal(db.reads, 1);
});

test('엣지: 없는 상품은 404 이고 캐시에 저장하지 않는다', async () => {
  const res = await getProduct(99999);
  assert.equal(res.status, 404);
  assert.deepEqual(await redis.keys('product:'), []);
});

test('엣지: 잘못된 가격은 400 이고 캐시를 건드리지 않는다', async () => {
  await getProduct(11);
  const put = await fetch(api + '/products/11', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"price":"비쌈"}' });
  assert.equal(put.status, 400);
  assert.equal((await getProduct(11)).cache, 'HIT');
});

test('엣지: 미니 레디스 서버가 죽어도 상품 API 는 원본을 읽어 응답한다', async () => {
  const deadCache = createCache(createClient('http://127.0.0.1:1'), { ttl: 1000 });   // 아무도 듣지 않는 포트
  const server = createProductApi({ db, cache: deadCache });
  const address = await listen(server);
  try {
    const res = await fetch(address + '/products/12');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).id, 12);
    assert.ok(deadCache.stats.errors >= 1);
  } finally { await close(server); }
});

test('캐시를 쓰지 않는 API 는 조회할 때마다 원본을 읽는다 (비교 기준)', async () => {
  const server = createProductApi({ db });
  const address = await listen(server);
  try {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(address + '/products/13');
      assert.equal(res.headers.get('x-cache'), 'OFF');
      await res.json();
    }
    assert.equal(db.reads, 3);
  } finally { await close(server); }
});
