/* rules.js 단위 테스트: 두음법칙, 단어 판정, 상대의 단어 선택 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORD_PATTERN, LEVELS, FINISHER_CHANCE, dueum, nextStartChars, rejectReason, pickWord, gradeOf, letterPoints } from '../rules.js';

test('단어 형식: 한글 음절 2글자 이상만', () => {
  for (const ok of ['기차', '끝말잇기', '뷁뷁']) assert.equal(WORD_PATTERN.test(ok), true, ok);
  for (const bad of ['', '기', 'ab', '기차1', '기 차', 'ㄱㄴ', '기차!', "기'차"]) assert.equal(WORD_PATTERN.test(bad), false, bad);
});

test('두음법칙: ㄹ → ㅇ', () => {
  assert.equal(dueum('리'), '이');
  assert.equal(dueum('력'), '역');
  assert.equal(dueum('례'), '예');
  assert.equal(dueum('룡'), '용');
  assert.equal(dueum('류'), '유');
  assert.equal(dueum('량'), '양');
});

test('두음법칙: ㄹ → ㄴ', () => {
  assert.equal(dueum('래'), '내');
  assert.equal(dueum('락'), '낙');
  assert.equal(dueum('로'), '노');
  assert.equal(dueum('뢰'), '뇌');
  assert.equal(dueum('루'), '누');
  assert.equal(dueum('름'), '늠');
});

test('두음법칙: ㄴ → ㅇ', () => {
  assert.equal(dueum('녀'), '여');
  assert.equal(dueum('뇨'), '요');
  assert.equal(dueum('뉴'), '유');
  assert.equal(dueum('니'), '이');
  assert.equal(dueum('념'), '염');
});

test('두음법칙: 해당하지 않는 글자는 null', () => {
  for (const char of ['차', '나', '너', '노', '러', '레', '이', '가', 'a', '1', 'ㄹ']) assert.equal(dueum(char), null, char);
});

test('다음 단어가 시작할 수 있는 글자', () => {
  assert.deepEqual(nextStartChars('기차'), ['차']);
  assert.deepEqual(nextStartChars('요리'), ['리', '이']);
  assert.deepEqual(nextStartChars('미래'), ['래', '내']);
  assert.deepEqual(nextStartChars('소녀'), ['녀', '여']);
});

test('단어 판정: 통과하면 null', () => {
  assert.equal(rejectReason('기차'), null);
  assert.equal(rejectReason('이발', { need: ['리', '이'] }), null);
  assert.equal(rejectReason('리본', { need: ['리', '이'] }), null);
});

test('단어 판정: 거절 이유는 형식 → 시작 글자 → 이미 나옴 → 미등록 순으로 본다', () => {
  assert.equal(rejectReason('기').code, 'format');
  assert.equal(rejectReason('abc').code, 'format');
  assert.equal(rejectReason('기차', { need: ['차'] }).code, 'start');
  assert.equal(rejectReason('차표', { need: ['차'], used: true, known: false }).code, 'used');
  assert.equal(rejectReason('차표', { need: ['차'], known: false }).code, 'unknown');
  assert.match(rejectReason('기차', { need: ['리', '이'] }).message, /'리' 또는 '이'/);
});

const CANDIDATES = [{ word: '차표', finisher: false }, { word: '차도', finisher: false }, { word: '차륜', finisher: true }];

test('상대의 선택: 후보가 없으면 null', () => {
  for (const level of LEVELS) assert.equal(pickWord([], level), null);
});

test('상대의 선택: easy 는 끝내기 단어를 쓰지 않는다', () => {
  for (const r of [0, 0.5, 0.99]) assert.equal(pickWord(CANDIDATES, 'easy', () => r).finisher, false);
  assert.equal(pickWord([{ word: '차륜', finisher: true }], 'easy'), null);
});

test('상대의 선택: hard 는 끝내기 단어가 있으면 항상 낸다', () => {
  for (const r of [0, 0.5, 0.99]) assert.equal(pickWord(CANDIDATES, 'hard', () => r).word, '차륜');
  assert.equal(pickWord(CANDIDATES.slice(0, 2), 'hard', () => 0).word, '차표');
});

test('난이도는 5단계이고 끝내기 단어를 낼 확률이 0 · 25 · 50 · 75 · 100% 다', () => {
  assert.deepEqual(LEVELS, ['easy', 'mild', 'normal', 'tough', 'hard']);
  assert.deepEqual(LEVELS.map((level) => FINISHER_CHANCE[level]), [0, 0.25, 0.5, 0.75, 1]);
});

test('상대의 선택: mild · normal · tough 는 난수가 확률보다 작을 때만 끝내기 단어를 낸다', () => {
  for (const [level, chance] of [['mild', 0.25], ['normal', 0.5], ['tough', 0.75]]) {
    assert.equal(pickWord(CANDIDATES, level, () => chance - 0.01).word, '차륜', level);
    assert.equal(pickWord(CANDIDATES, level, () => chance).finisher, false, level);
    assert.equal(pickWord([{ word: '차륜', finisher: true }], level, () => 0.99).word, '차륜', level);   // 끝내기 단어뿐이면 그것을 낸다
    assert.equal(pickWord(CANDIDATES.slice(0, 2), level, () => 0).finisher, false, level);                // 끝내기 단어가 없으면 일반 단어를 낸다
  }
});

test('상대의 선택: 난이도가 높을수록 끝내기 단어를 더 자주 낸다 (1만 번씩 뽑아 확률 확인)', () => {
  const rates = LEVELS.map((level) => {
    let finishers = 0;
    for (let i = 0; i < 10000; i++) if (pickWord(CANDIDATES, level).finisher) finishers++;
    return finishers / 10000;
  });
  const expected = [0, 0.25, 0.5, 0.75, 1];
  rates.forEach((rate, i) => assert.ok(Math.abs(rate - expected[i]) < 0.03, LEVELS[i] + ' ' + rate));
});

test('상대의 선택: 모르는 난이도는 normal 로 본다', () => {
  assert.equal(pickWord(CANDIDATES, 'god', () => 0.49).word, '차륜');
  assert.equal(pickWord(CANDIDATES, 'god', () => 0.5).finisher, false);
});

test('상대의 선택: 난수에 따라 후보가 골고루 나온다', () => {
  const normals = CANDIDATES.slice(0, 2);
  assert.equal(pickWord(normals, 'easy', () => 0).word, '차표');
  assert.equal(pickWord(normals, 'easy', () => 0.5).word, '차도');
  assert.equal(pickWord(normals, 'easy', () => 0.999).word, '차도');
});

test('등급: 이을 수 있는 단어 수로 다섯 등급을 나눈다', () => {
  const cases = [[0, 'kill'], [1, 'attack'], [10, 'attack'], [11, 'tricky'], [100, 'tricky'], [101, 'normal'], [1000, 'normal'], [1001, 'easy'], [50000, 'easy']];
  for (const [options, grade] of cases) assert.equal(gradeOf(options), grade, String(options));
});

test('글자 수 점수: 9글자까지는 10글자(300)에 대한 비율의 제곱, 10글자는 300점, 그 뒤로 한 글자마다 60점이 더해진다', () => {
  const cases = [[2, 12], [3, 27], [4, 48], [5, 75], [9, 243], [10, 300], [11, 360], [12, 420], [20, 900]];
  for (const [length, points] of cases) assert.equal(letterPoints(length), points, String(length));
});
