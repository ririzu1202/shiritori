/* ======================================================================
 * bench/compare.js — 미니 레디스를 쓸 때와 쓰지 않을 때의 성능 비교
 *
 *   npm run bench
 *
 *   ① 상품 API 비교
 *      같은 상품 API 를 두 개 띄운다: 캐시 없음 / 미니 레디스 캐시 사용 (HTTP 로 연결).
 *      원본은 상품 2만 개가 든 파일이고, 조회할 때마다 파일을 읽어 첫 줄부터 찾는다.
 *      인기 상품 100개 중에서 무작위로 골라 2,000번 조회한다 (동시에 20개씩).
 *   ② 저장소 자체 속도
 *      해시 테이블에 100만 개를 넣고, 조회하고, 지우는 데 걸리는 시간.
 *
 *   모든 서버와 요청 생성기가 한 프로세스 안에서 돌기 때문에 절대 수치보다 두 경우의 "차이"를 보는 용도다.
 * ====================================================================== */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { createStore } from '../src/store.js';
import { createApiServer, listen, close } from '../src/api.js';
import { createClient } from '../src/client.js';
import { createCache } from '../src/cache.js';
import { createProductDb, createProductFile } from '../demo/product-db.js';
import { createProductApi } from '../demo/product-api.js';

const PRODUCTS = 20000, POPULAR = 100, REQUESTS = 2000, CONCURRENCY = 20;

/** GET 요청 하나를 보내고 걸린 시간(ms)을 돌려준다 */
function timedGet(agent, url) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    http.get(url, { agent }, (res) => {
      res.resume();
      res.on('end', () => resolve(performance.now() - start));
    }).on('error', reject);
  });
}

/** urls 를 동시에 CONCURRENCY 개씩 요청하고 통계를 낸다 */
async function load(urls) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });
  const times = [];
  let next = 0;
  const worker = async () => { while (next < urls.length) times.push(await timedGet(agent, urls[next++])); };
  const start = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const total = performance.now() - start;
  agent.destroy();
  times.sort((a, b) => a - b);
  const at = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
  return { total, rps: urls.length / (total / 1000), avg: times.reduce((a, b) => a + b, 0) / times.length, p50: at(0.5), p95: at(0.95) };
}

const f = (n, digits = 1) => n.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/* ---------------------------------------------------------------- ① 상품 API */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-redis-bench-'));
const file = path.join(dir, 'products.jsonl');
createProductFile(file, PRODUCTS);

// 인기 상품 100개: 파일 전체에 고르게 퍼져 있다 (앞쪽 상품만 고르면 원본 조회가 빨리 끝나 버린다)
const popular = Array.from({ length: POPULAR }, (_, i) => 1 + Math.floor((i + 0.5) * PRODUCTS / POPULAR));
const picks = Array.from({ length: REQUESTS }, () => popular[Math.floor(Math.random() * POPULAR)]);

const redisServer = createApiServer(createStore());
const redis = createClient(await listen(redisServer));

const dbPlain = createProductDb(file), dbCached = createProductDb(file);
const plainServer = createProductApi({ db: dbPlain });
const cachedServer = createProductApi({ db: dbCached, cache: createCache(redis, { ttl: 60_000 }) });
const plainUrl = await listen(plainServer), cachedUrl = await listen(cachedServer);

const plain = await load(picks.map((id) => plainUrl + '/products/' + id));
const cached = await load(picks.map((id) => cachedUrl + '/products/' + id));
const info = await redis.info();

console.log('① 상품 API: 상품 ' + f(PRODUCTS, 0) + '개, 인기 상품 ' + POPULAR + '개를 ' + f(REQUESTS, 0) + '번 조회 (동시 ' + CONCURRENCY + '개)\n');
console.log('| 항목 | 미니 레디스 없음 | 미니 레디스 사용 | 차이 |');
console.log('|---|---:|---:|---:|');
console.log('| 전체 걸린 시간 | ' + f(plain.total, 0) + ' ms | ' + f(cached.total, 0) + ' ms | ' + f(plain.total / cached.total) + '배 빠름 |');
console.log('| 초당 처리 요청 | ' + f(plain.rps, 0) + ' 건 | ' + f(cached.rps, 0) + ' 건 | ' + f(cached.rps / plain.rps) + '배 |');
console.log('| 평균 응답 시간 | ' + f(plain.avg, 2) + ' ms | ' + f(cached.avg, 2) + ' ms | ' + f(plain.avg / cached.avg) + '배 빠름 |');
console.log('| 중간값 (p50) | ' + f(plain.p50, 2) + ' ms | ' + f(cached.p50, 2) + ' ms | |');
console.log('| 느린 5% (p95) | ' + f(plain.p95, 2) + ' ms | ' + f(cached.p95, 2) + ' ms | |');
console.log('| 원본 파일을 읽은 횟수 | ' + f(dbPlain.reads, 0) + ' 번 | ' + f(dbCached.reads, 0) + ' 번 | |');
console.log('\n미니 레디스: 키 ' + info.keys + '개, 적중 ' + info.hits + '번, 실패 ' + info.misses + '번\n');

redis.close();
await close(plainServer); await close(cachedServer); await close(redisServer);
fs.rmSync(dir, { recursive: true, force: true });

/* ---------------------------------------------------------------- ② 저장소 자체 속도 */
const N = 1_000_000;
const store = createStore();
const keys = Array.from({ length: N }, (_, i) => 'key:' + i);
const time = (fn) => { const s = performance.now(); fn(); return performance.now() - s; };

const tSet = time(() => { for (let i = 0; i < N; i++) store.set(keys[i], i); });
const table = store.info().table;
const tGet = time(() => { for (let i = 0; i < N; i++) store.get(keys[i]); });
const tDel = time(() => { for (let i = 0; i < N; i++) store.del(keys[i]); });

console.log('② 저장소 자체 속도: 키 ' + f(N, 0) + '개 (HTTP 를 거치지 않고 직접 호출)\n');
console.log('| 명령 | 걸린 시간 | 초당 처리 |');
console.log('|---|---:|---:|');
for (const [name, t] of [['set', tSet], ['get', tGet], ['del', tDel]]) console.log('| ' + name + ' | ' + f(t, 0) + ' ms | ' + f(N / (t / 1000), 0) + ' 건 |');
console.log('\n해시 테이블: 버킷 ' + f(table.capacity, 0) + '개, 적재율 ' + f(table.loadFactor, 2) + ', 가장 긴 연결 리스트 ' + table.longestChain + '개');
