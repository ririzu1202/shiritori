/* ======================================================================
 * rules.js — 끝말잇기 규칙 (순수 함수만. 서버·저장소를 모른다)
 *
 *   단어      : 한글 음절 2글자 이상 (WORD_PATTERN)
 *   잇는 규칙 : 앞 단어의 끝 글자로 시작해야 한다. 두음법칙으로 바뀐 글자도 인정한다
 *                 리본 → '본'            (바뀌지 않음)
 *                 요리 → '리' 또는 '이'   (ㄹ → ㅇ)
 *                 미래 → '래' 또는 '내'   (ㄹ → ㄴ)
 *                 소녀 → '녀' 또는 '여'   (ㄴ → ㅇ)
 *   등급      : 낸 단어마다 "다음에 이을 수 있는 단어 수"로 등급을 매긴다 (GRADES)
 *                 0개 한방 · 1~10개 공격 · 11~100개 까다로움 · 101~1000개 보통 · 그 이상 넉넉
 *   점수      : 단어를 낼 때마다 등급에 따라 점수를 받고 (POINTS), 글자 수에 따라 더 받는다 (letterPoints: 10글자 300점을 기준으로 한 제곱 비율, 이후 글자당 +60점)
 *                 넉넉 100 · 보통 250 · 까다로움 500 · 공격 1,000 · 한방 2,000
 *   목숨      : 플레이어와 상대가 3개씩 갖는다 (LIVES). 이을 단어를 내지 못한 쪽이 하나를 잃고, 새 시작 단어로 이어 간다.
 *               어느 한쪽의 목숨이 0 이 되면 판이 끝난다
 *   상대      : 후보 단어 중 하나를 무작위로 낸다. 끝내기 단어를 낼 확률만 난이도마다 다르다 (FINISHER_CHANCE)
 *                 easy 0% (쓰지 않음) · mild 25% · normal 50% · tough 75% · hard 100% (있으면 항상)
 * ====================================================================== */

export const WORD_PATTERN = /^[가-힣]{2,}$/;
// 난이도 → 후보에 끝내기 단어가 있을 때 그것을 낼 확률
export const FINISHER_CHANCE = { easy: 0, mild: 0.25, normal: 0.5, tough: 0.75, hard: 1 };
export const LEVELS = Object.keys(FINISHER_CHANCE);

// 단어 등급: 그 단어 다음에 이을 수 있는 단어가 사전에 몇 개 있는가 (이번 판에 이미 나온 단어도 포함해서 센다)
//   [등급 이름, 이 개수 이하면 이 등급]
export const GRADES = [['kill', 0], ['attack', 10], ['tricky', 100], ['normal', 1000], ['easy', Infinity]];

/** 이을 수 있는 단어 수 → 등급 이름. 0 → 'kill'(한방), 1~10 → 'attack'(공격), 11~100 → 'tricky', 101~1000 → 'normal', 그 이상 → 'easy' */
export const gradeOf = (options) => GRADES.find(([, max]) => options <= max)[0];

// 등급별 점수: 이을 단어가 적은 단어일수록 점수가 높다 (최소 100점, 최대 2,000점. 한 등급 올라갈 때마다 약 2배)
export const POINTS = { easy: 100, normal: 250, tricky: 500, attack: 1000, kill: 2000 };
export const LONG_WORD = { length: 10, points: 300, perExtra: 60 };   // 긴 단어는 드물어서 크게 준다: 10글자가 300점이 기준이고, 그 뒤로 한 글자마다 +60점

/** 글자 수에 따라 등급 점수에 더해 주는 점수. 9글자까지는 10글자 점수(300)에 대한 비율의 제곱이라 길수록 가파르게 오른다: 2글자 12, 5글자 75, 9글자 243, 10글자 300, 11글자 360, 12글자 420 … (시작 단어는 0점) */
export const letterPoints = (length) => length < LONG_WORD.length ? Math.round(LONG_WORD.points * (length / LONG_WORD.length) ** 2) : LONG_WORD.points + (length - LONG_WORD.length) * LONG_WORD.perExtra;
export const LIVES = 3;                  // 플레이어와 상대가 각각 갖는 목숨 수

export const firstChar = (word) => word[0];
export const lastChar = (word) => word[word.length - 1];

// 한글 음절 = 0xAC00 + (초성 * 21 + 중성) * 28 + 종성
const BASE = 0xac00;
const CHO_N = 2, CHO_R = 5, CHO_IEUNG = 11;                 // ㄴ, ㄹ, ㅇ
const JUNG_Y = new Set([2, 6, 7, 12, 17, 20]);              // ㅑ ㅕ ㅖ ㅛ ㅠ ㅣ  : ㄹ → ㅇ
const JUNG_N_TO_IEUNG = new Set([6, 12, 17, 20]);           // ㅕ ㅛ ㅠ ㅣ        : ㄴ → ㅇ
const JUNG_R_TO_N = new Set([0, 1, 8, 11, 13, 18]);         // ㅏ ㅐ ㅗ ㅚ ㅜ ㅡ  : ㄹ → ㄴ

/** 두음법칙으로 바뀐 글자. 바뀌지 않는 글자면 null */
export function dueum(char) {
  const code = char.charCodeAt(0) - BASE;
  if (code < 0 || code > 11171) return null;
  const cho = Math.floor(code / 588), jung = Math.floor((code % 588) / 28), jong = code % 28;
  let next = null;
  if (cho === CHO_R && JUNG_Y.has(jung)) next = CHO_IEUNG;
  else if (cho === CHO_R && JUNG_R_TO_N.has(jung)) next = CHO_N;
  else if (cho === CHO_N && JUNG_N_TO_IEUNG.has(jung)) next = CHO_IEUNG;
  if (next === null) return null;
  return String.fromCharCode(BASE + (next * 21 + jung) * 28 + jong);
}

/** word 다음에 올 단어가 시작할 수 있는 글자들. 예: '요리' → ['리', '이'] */
export function nextStartChars(word) {
  const last = lastChar(word), changed = dueum(last);
  return changed ? [last, changed] : [last];
}

/**
 * 플레이어가 낸 단어를 받아들일 수 있는지 본다. 받아들일 수 없으면 이유를, 괜찮으면 null 을 돌려준다.
 *   need  : 시작해야 하는 글자들 (첫 단어면 null)
 *   used  : 이번 판에 이미 나온 단어인가
 *   known : 사전에 등록된 단어인가
 */
export function rejectReason(word, { need = null, used = false, known = true } = {}) {
  if (!WORD_PATTERN.test(word)) return { code: 'format', message: '한글 2글자 이상으로 입력하세요' };
  if (need && !need.includes(firstChar(word))) return { code: 'start', message: "'" + need.join("' 또는 '") + "'(으)로 시작해야 합니다" };
  if (used) return { code: 'used', message: "'" + word + "'은(는) 이번 판에 이미 나온 단어입니다" };
  if (!known) return { code: 'unknown', message: "'" + word + "'은(는) 등록되지 않은 단어입니다" };
  return null;
}

/**
 * 상대가 낼 단어를 고른다. candidates: [{ word, finisher }] (이미 나온 단어는 빼고 넘긴다)
 * 낼 단어가 없으면 null. random 은 0 이상 1 미만의 수를 돌려주는 함수 (테스트에서 바꿔 끼운다)
 */
export function pickWord(candidates, level = 'normal', random = Math.random) {
  const finishers = candidates.filter((c) => c.finisher), normals = candidates.filter((c) => !c.finisher);
  const pick = (list) => (list.length ? list[Math.floor(random() * list.length)] : null);
  const chance = FINISHER_CHANCE[level] ?? FINISHER_CHANCE.normal;

  if (chance === 0) return pick(normals);                                  // 끝내기 단어를 쓰지 않는다 (그것밖에 없으면 진다)
  if (finishers.length && (normals.length === 0 || chance === 1 || random() < chance)) return pick(finishers);
  return pick(normals);
}
