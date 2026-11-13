/* ======================================================================
 * demo/run.js — 시연용: 미니 레디스 서버 + 상품 API 를 한 번에 띄운다
 *
 *   npm run demo
 *     미니 레디스  http://127.0.0.1:6380   (기록 파일: data/demo.aof)
 *     상품 API     http://127.0.0.1:3000   (조회 결과를 미니 레디스에 30초 동안 캐시)
 *
 *   상품 API 는 미니 레디스를 "HTTP 클라이언트"로 쓴다. 즉 외부 프로그램이 쓰는 방식 그대로다.
 * ====================================================================== */

import fs from 'node:fs';
import { startSweeper } from '../src/store.js';
import { openPersistentStore } from '../src/aof.js';
import { createApiServer, listen } from '../src/api.js';
import { createClient } from '../src/client.js';
import { createCache } from '../src/cache.js';
import { createProductDb, createProductFile } from './product-db.js';
import { createProductApi } from './product-api.js';

fs.mkdirSync('data', { recursive: true });
const productFile = 'data/products.jsonl';
if (!fs.existsSync(productFile)) createProductFile(productFile, 20000);

const { store, recovered } = openPersistentStore('data/demo.aof');
startSweeper(store);
const redisUrl = await listen(createApiServer(store), 6380);

const cache = createCache(createClient(redisUrl), { ttl: 30_000 });
const apiUrl = await listen(createProductApi({ db: createProductDb(productFile), cache }), 3000);

console.log('미니 레디스 : ' + redisUrl + '  (복구한 키 ' + recovered + '개)');
console.log('상품 API    : ' + apiUrl);
console.log('');
console.log('해 볼 것');
console.log('  curl -i ' + apiUrl + '/products/19999          처음은 X-Cache: MISS, 다시 부르면 HIT');
console.log('  curl ' + redisUrl + '/keys/product:19999       미니 레디스에 저장된 값과 남은 ttl');
console.log('  curl -X PUT ' + apiUrl + '/products/19999 -H "content-type: application/json" -d "{\\"price\\":5000}"   가격 변경 → 캐시 무효화');
console.log('  curl -X DELETE "' + redisUrl + '/keys?prefix=product:"   상품 캐시 전체 무효화');
