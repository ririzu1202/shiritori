/* ======================================================================
 * demo/product-db.js — 예제용 "느린 원본 저장소" (상품 목록 파일)
 *
 *   상품을 한 줄에 하나씩 JSON 으로 적은 파일이다. 인덱스가 없어서, 상품 하나를 찾으려면
 *   파일을 읽고 첫 줄부터 차례로 확인해야 한다. → 캐시가 왜 필요한지 보여 주는 용도
 *
 *   reads : 파일을 실제로 읽은 횟수 (캐시가 원본 조회를 얼마나 줄였는지 확인하는 용도)
 * ====================================================================== */

import fs from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

/** 상품 count 개가 든 파일을 만든다 */
export function createProductFile(file, count) {
  const lines = [];
  for (let id = 1; id <= count; id++) lines.push(JSON.stringify({ id, name: '상품 ' + id, price: 1000 + (id % 90) * 100, stock: id % 50 }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

export function createProductDb(file) {
  const db = {
    reads: 0,

    /** id 가 같은 상품을 찾는다 (첫 줄부터 차례로). 없으면 null */
    async findById(id) {
      db.reads++;
      const text = await readFile(file, 'utf8');
      for (const line of text.split('\n')) {
        if (line === '') continue;
        const product = JSON.parse(line);
        if (product.id === id) return product;
      }
      return null;
    },

    /** 상품 가격을 바꾼다 (파일 전체를 다시 쓴다). 바꾼 상품을 돌려주고, 없으면 null */
    async updatePrice(id, price) {
      const text = await readFile(file, 'utf8');
      let updated = null;
      const lines = text.split('\n').filter(Boolean).map((line) => {
        const product = JSON.parse(line);
        if (product.id !== id) return line;
        updated = { ...product, price };
        return JSON.stringify(updated);
      });
      if (updated) await writeFile(file, lines.join('\n') + '\n');
      return updated;
    },
  };
  return db;
}
