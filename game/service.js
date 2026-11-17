/* ======================================================================
 * service.js — 끝말잇기 한 판의 진행. 미니 레디스와 미니 DBMS 를 여기서 함께 쓴다
 *
 *   미니 DBMS (파일에 오래 보관)                미니 레디스 (메모리에 잠깐 보관)
 *     words  등록한 단어                          word:<단어>             사전 확인 결과 캐시          60초
 *     games  끝난 판의 기록                       first:<글자>            그 글자로 시작하는 단어 캐시   60초
 *                                                 ranking                 기록 상위 10개 캐시           5초
 *                                                 game:<번호>             진행 중인 판의 상태 (목숨, 점수, 낸 단어)  30분
 *                                                 game:<번호>:used:<단어>  이번 판에 나온 단어           30분
 *                                                 game:<번호>:turn        플레이어 차례. 사라지면 시간 초과  10초
 *                                                 game:<번호>:lock        한 판을 한 번에 한 요청만 다루게 하는 잠금 (nx)
 *                                                 game:seq / stats:games  판 번호 / 끝난 판 수 (incr)
 *
 *   단어 확인   : 캐시(word:…)에 있으면 그대로, 없으면 DBMS 를 선형 탐색하고 결과를 캐시에 넣는다
 *   단어 등록   : DBMS 에 INSERT 한 뒤 word:<단어> 와 first:<첫 글자> 캐시를 지운다 (무효화)
 *   단어 삭제   : 미니 DBMS 에는 DELETE 가 없다. 그래서 같은 단어를 removed = 1 로 한 줄 더 INSERT 한다 ("지웠다"는 기록).
 *                 같은 단어가 여러 줄이면 가장 나중 줄을 따르므로, 그 단어는 없는 단어가 된다. 캐시도 함께 지운다
 *   목숨        : 이을 단어를 내지 못한 쪽(시간 초과, 이을 단어 없음)이 목숨 하나를 잃고, 새 시작 단어로 이어 간다.
 *                 목숨이 0 이 되면 판이 끝난다
 *   판이 끝나면 : games 에 INSERT, 그 판의 used 키를 prefix 로 한꺼번에 지우고, ranking 캐시를 지운다
 *
 *   모든 응답의 trace 에는 "어디서 값을 가져왔는지"가 담긴다. 화면이 이것을 그대로 보여 준다.
 *     { label, key, source: 'cache' | 'db' | 'redis', plan?, ms }
 * ====================================================================== */

import fs from 'node:fs';
import { createCache } from '../redis/src/cache.js';
import { quote } from './db.js';
import { WORD_PATTERN, LEVELS, LIVES, POINTS, letterPoints, firstChar, lastChar, nextStartChars, rejectReason, pickWord, gradeOf } from './rules.js';

/** 파일에서 word 와 같은 줄을 모두 지운다 */
function dropLine(file, word) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const kept = lines.filter((line) => line.trim() !== word);
  if (kept.length !== lines.length) fs.writeFileSync(file, kept.join('\n'));
}

/** 요청을 처리할 수 없을 때. status 가 HTTP 상태 코드가 된다 */
export class GameError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const GAME_TTL = 30 * 60_000;        // 진행 중인 판을 보관하는 시간
const OVER_TTL = 10 * 60_000;        // 끝난 판을 다시 볼 수 있는 시간
const LOCK_TTL = 5_000;
const START_TRIES = 30;              // 시작 단어를 뽑아 보는 횟수

/**
 * redis     : redis/src/client.js 의 클라이언트
 * db        : game/db.js 의 클라이언트
 * turnMs    : 한 차례의 제한 시간
 * random    : 상대가 단어를 고를 때, 시작 단어를 뽑을 때 쓰는 난수 함수
 * lives     : 플레이어와 상대가 각각 갖는 목숨 수
 * randomStart : 판을 열 때 2~3글자 시작 단어를 무작위로 제시할지 (false 면 플레이어가 아무 단어로 시작)
 * wordFiles : { words, finishers, removed } 화면에서 등록·삭제한 단어를 이어 적을 파일 (없으면 적지 않는다)
 */
export function createGameService({ redis, db, turnMs = 10_000, random = Math.random, wordFiles = null, randomStart = true, lives = LIVES }) {
  const wordCache = createCache(redis, { ttl: 60_000 });
  const rankCache = createCache(redis, { ttl: 5_000 });
  let registering = Promise.resolve();     // 단어 등록을 한 줄로 세운다 ("있는지 확인 → INSERT" 사이에 다른 등록이 끼어들지 않게)

  const gameKey = (id) => 'game:' + id;
  const turnKey = (id) => 'game:' + id + ':turn';
  const usedPrefix = (id) => 'game:' + id + ':used:';

  /* ---------------------------------------------------------------- 단어 사전 */

  /** 캐시를 거쳐 값을 가져오고, 어디서 가져왔는지 trace 에 남긴다 */
  async function cached(cache, key, label, trace, load) {
    const started = performance.now();
    let plan = null;
    const { value, hit } = await cache.getOrLoad(key, async () => {
      const loaded = await load();
      plan = loaded.plan;
      return loaded.value;
    });
    trace.push({ label, key, source: hit ? 'cache' : 'db', plan, ms: performance.now() - started });
    return value;
  }

  /** DBMS 에서 단어 한 개를 찾는다. 같은 단어가 여러 줄이면 가장 나중 줄을 따른다 (나중 줄이 removed = 1 이면 지워진 단어) */
  async function findWord(word) {
    const result = await db.query('SELECT id, finisher, removed FROM words WHERE word = ' + quote(word));
    const latest = result.objects.reduce((a, b) => (a && a.id > b.id ? a : b), null);
    const known = latest !== null && latest.removed !== 1;
    return { plan: result.plan, value: { known, finisher: known && latest.finisher === 1 } };
  }

  /** 등록된 단어인가 → { known, finisher } */
  const lookup = (word, trace) => cached(wordCache, 'word:' + word, "'" + word + "' 사전 확인", trace, () => findWord(word));

  /** char 로 시작하는 단어 전부 → [{ word, finisher }] */
  const wordsStartingWith = (char, trace) => cached(wordCache, 'first:' + char, "'" + char + "'(으)로 시작하는 단어", trace, async () => {
    const result = await db.query('SELECT id, word, finisher, removed FROM words WHERE first = ' + quote(char));
    const latest = new Map();                                  // 같은 단어는 가장 나중 줄만 남긴다
    for (const row of result.objects.sort((a, b) => a.id - b.id)) latest.set(row.word, row);
    const alive = [...latest.values()].filter((row) => row.removed !== 1);            // 지워진 단어는 뺀다
    return { plan: result.plan, value: alive.map((row) => ({ word: row.word, finisher: row.finisher === 1 })) };
  });

  /** word 다음에 낼 수 있는 단어들 (두음법칙 포함) → { total, open } */
  async function continuations(word, used, trace) {
    const lists = [];
    for (const char of nextStartChars(word)) lists.push(await wordsStartingWith(char, trace));
    const all = lists.flat();
    // total: 사전에 있는 전체 개수 (등급을 매길 때 쓴다. 이번 판에 써서 줄어든 것은 반영하지 않는다)
    // open : 그중 이번 판에 아직 나오지 않아 실제로 낼 수 있는 단어
    return { total: all.length, open: all.filter((c) => !used.has(c.word)) };
  }

  /** 판의 기록에 남길 한 줄: 누가, 무슨 단어를, 이을 수 있는 단어 수와 등급, 받은 점수 (시작 단어는 0점) */
  const entry = (by, word, total, extra = {}) => ({ by, word, options: total, grade: gradeOf(total), points: by === 'start' ? 0 : POINTS[gradeOf(total)] + letterPoints(word.length), ...extra });

  /** 단어 등록. 이미 있는 일반 단어를 끝내기로 다시 등록하면 끝내기 단어로 바뀐다 */
  function register(raw, finisher = false) {
    const job = registering.then(async () => {
      const word = String(raw ?? '').trim();
      if (!WORD_PATTERN.test(word)) throw new GameError(400, '한글 2글자 이상으로 입력하세요');
      finisher = finisher === true;

      const existing = (await findWord(word)).value;
      if (existing.known && (existing.finisher || !finisher)) return { added: false, word, finisher: existing.finisher, message: "'" + word + "'은(는) 이미 등록된 단어입니다" };

      const inserted = await db.query('INSERT INTO words (word, first, last, finisher) VALUES (' +
        [quote(word), quote(firstChar(word)), quote(lastChar(word)), finisher ? 1 : 0].join(', ') + ')');
      const invalidated = ['word:' + word, 'first:' + firstChar(word)];
      for (const key of invalidated) await wordCache.invalidate(key);      // 원본이 바뀌었으니 옛 캐시를 지운다

      if (wordFiles) {
        fs.appendFileSync(finisher ? wordFiles.finishers : wordFiles.words, '\n' + word + '\n');
        if (wordFiles.removed) dropLine(wordFiles.removed, word);            // 지웠던 단어를 다시 등록하면 삭제 목록에서 뺀다
      }
      return { added: true, word, finisher, id: inserted.firstId, invalidated,
        message: existing.known ? "'" + word + "'을(를) 끝내기 단어로 바꿨습니다" : "'" + word + "'을(를) 등록했습니다" };
    });
    registering = job.catch(() => {});
    return job;
  }

  /** 단어 삭제. 등록된 단어가 아니면 아무것도 하지 않는다 */
  function remove(raw) {
    const job = registering.then(async () => {
      const word = String(raw ?? '').trim();
      if (!WORD_PATTERN.test(word)) throw new GameError(400, '한글 2글자 이상으로 입력하세요');
      if (!(await findWord(word)).value.known) return { removed: false, word, message: "'" + word + "'은(는) 등록되지 않은 단어입니다" };

      const inserted = await db.query('INSERT INTO words (word, first, last, finisher, removed) VALUES (' +
        [quote(word), quote(firstChar(word)), quote(lastChar(word)), 0, 1].join(', ') + ')');
      const invalidated = ['word:' + word, 'first:' + firstChar(word)];
      for (const key of invalidated) await wordCache.invalidate(key);

      if (wordFiles && wordFiles.removed) fs.appendFileSync(wordFiles.removed, '\n' + word + '\n');   // 사전을 다시 만들어도 되살아나지 않게 적어 둔다
      return { removed: true, word, id: inserted.firstId, invalidated, message: "'" + word + "'을(를) 삭제했습니다" };
    });
    registering = job.catch(() => {});
    return job;
  }

  /* ---------------------------------------------------------------- 판 진행 */

  async function load(id) {
    const state = await redis.get(gameKey(id));
    if (state === null) throw new GameError(404, '없는 판이거나 보관 시간이 지난 판입니다');
    return state;
  }

  /** 화면에 보낼 모양: 상태 + 남은 시간 */
  async function view(state) {
    const remainingMs = state.status === 'playing' ? Math.max(0, await redis.ttl(turnKey(state.id))) : 0;
    return { ...state, remainingMs, turnMs };
  }

  /** 한 판을 한 번에 한 요청만 다루게 한다. 잠금 키를 nx(없을 때만 저장)로 만든 요청만 들어간다 */
  async function withLock(id, run) {
    const lockKey = gameKey(id) + ':lock';
    if (!(await redis.set(lockKey, 1, { nx: true, ttl: LOCK_TTL }))) throw new GameError(409, '앞선 요청을 처리하는 중입니다');
    try { return await run(); } finally { await redis.del(lockKey); }
  }

  /** 판을 끝낸다: 기록 저장, 그 판의 키 정리, 순위 캐시 무효화 */
  async function finish(state, result, reason, trace) {
    state.status = 'over';
    state.result = result;
    state.reason = reason;

    const started = performance.now();
    const saved = await db.query('INSERT INTO games (player, level, turns, result, reason, score) VALUES (' +
      [quote(state.player), quote(state.level), state.turns, quote(result), quote(reason), state.score.player].join(', ') + ')');
    state.recordId = saved.firstId;
    trace.push({ label: '판 기록 저장 (기록 번호 ' + saved.firstId + ')', key: 'games', source: 'db', plan: 'INSERT', ms: performance.now() - started });

    await redis.del(turnKey(state.id));
    const removed = await redis.delByPrefix(usedPrefix(state.id));
    await rankCache.invalidate('ranking');
    await redis.incr('stats:games');
    await redis.set(gameKey(state.id), state, { ttl: OVER_TTL });
    trace.push({ label: '이번 판의 단어 표시 ' + removed + '개와 순위 캐시 지움', key: usedPrefix(state.id) + '*', source: 'redis', plan: null, ms: 0 });
    return state;
  }

  /** 이번 판에 나온 단어들 */
  const usedWordsOf = async (id) => new Set((await redis.keys(usedPrefix(id))).map((key) => key.slice(usedPrefix(id).length)));

  /**
   * 시작 단어를 무작위로 고른다: 2~3글자이고, 이번 판에 아직 나오지 않았고, 이을 수 있는 단어가 하나 이상 있는 것.
   * 단어 번호(id)를 무작위로 뽑아 WHERE id = ? 로 찾는다 → B+ 트리 인덱스를 타므로 사전이 커도 바로 찾는다.
   * 사전이 비었거나 START_TRIES 번 안에 못 찾으면 null (그때는 플레이어가 아무 단어로 시작한다)
   */
  async function pickStartWord(trace, used = new Set()) {
    const table = (await db.tables()).find((t) => t.table === 'words');
    if (!table || table.rows === 0) return null;
    for (let i = 0; i < START_TRIES; i++) {
      const id = 1 + Math.floor(random() * table.rows);
      const started = performance.now();
      const result = await db.query('SELECT word FROM words WHERE id = ' + id);
      const word = result.objects[0] ? result.objects[0].word : null;
      trace.push({ label: '시작 단어 뽑기 (단어 번호 ' + id + (word ? ", '" + word + "'" : '') + ')', key: 'words', source: 'db', plan: result.plan, ms: performance.now() - started });
      if (!word || word.length < 2 || word.length > 3 || used.has(word)) continue;
      if (!(await lookup(word, trace)).known) continue;                    // 그 번호의 줄이 지워진 단어일 수 있다
      const next = await continuations(word, new Set([...used, word]), trace);
      if (next.open.length > 0) return { word, total: next.total };
    }
    return null;
  }

  /** 새 시작 단어를 놓고 플레이어 차례를 연다 (판을 열 때, 그리고 누군가 목숨을 잃은 뒤) */
  async function openRound(state, used, trace) {
    const first = randomStart ? await pickStartWord(trace, used) : null;
    state.need = null;
    if (first) {
      state.history.push(entry('start', first.word, first.total));
      state.need = nextStartChars(first.word);
      await redis.set(usedPrefix(state.id) + first.word, 1, { ttl: GAME_TTL });      // 시작 단어도 이번 판에 나온 단어다
    }
    await redis.set(gameKey(state.id), state, { ttl: GAME_TTL });
    await redis.set(turnKey(state.id), 1, { ttl: turnMs });        // 플레이어 차례 시작: 이 키가 사라지면 시간 초과
  }

  /**
   * who('player' | 'computer')가 목숨 하나를 잃는다.
   * 목숨이 남아 있으면 새 시작 단어로 이어 가고, 0 이 되면 판이 끝난다.
   *   reason: 'timeout' 시간 초과 · 'no-word' 이을 단어가 없음 · 'computer-stuck' 상대가 이을 단어가 없음
   */
  async function loseLife(state, who, reason, trace) {
    state.lives[who]--;
    state.history.push({ by: 'life', who, reason, left: state.lives[who] });
    if (state.lives[who] <= 0) return finish(state, who === 'player' ? 'lose' : 'win', reason, trace);
    await openRound(state, await usedWordsOf(state.id), trace);
    return state;
  }

  async function start({ player, level } = {}) {
    const name = String(player ?? '').trim().slice(0, 12) || '손님';
    if (!LEVELS.includes(level)) level = 'normal';
    const trace = [];
    const id = await redis.incr('game:seq');
    const state = {
      id, player: name, level, status: 'playing', result: null, reason: null, need: null, turns: 0,
      lives: { player: lives, computer: lives }, score: { player: 0, computer: 0 }, history: [],
    };
    await openRound(state, new Set(), trace);
    return { game: await view(state), trace };
  }

  /** 플레이어가 단어를 낸다 → 상대가 받아친다 */
  function play(id, raw) {
    return withLock(id, async () => {
      const trace = [];
      const word = String(raw ?? '').trim();
      const state = await load(id);
      if (state.status !== 'playing') throw new GameError(409, '이미 끝난 판입니다');
      const done = async (extra) => ({ accepted: false, reject: null, computer: null, ...extra, game: await view(state), trace });

      // 차례 키가 만료돼 사라졌으면 시간 초과다: 목숨을 잃고, 지금 낸 단어는 받지 않는다
      if ((await redis.ttl(turnKey(id))) === -2) {
        await loseLife(state, 'player', 'timeout', trace);
        return done({ reject: state.status === 'playing' ? { code: 'timeout', message: '시간이 지나 목숨을 하나 잃었습니다' } : null });
      }

      const valid = WORD_PATTERN.test(word);
      const used = valid && (await redis.get(usedPrefix(id) + word)) !== null;
      const startsRight = !state.need || state.need.includes(word[0]);
      const known = valid && startsRight && !used ? (await lookup(word, trace)).known : true;   // 사전은 다른 조건을 통과한 단어만 찾아본다
      const reject = rejectReason(word, { need: state.need, used, known });
      if (reject) return done({ reject });

      // 받아들인 단어를 이번 판에 나온 단어로 표시하고, 등급에 따라 점수를 준다
      await redis.set(usedPrefix(id) + word, 1, { ttl: GAME_TTL });
      const usedWords = await usedWordsOf(id);
      const mine = await continuations(word, usedWords, trace);
      const played = entry('player', word, mine.total);
      state.history.push(played);
      state.score.player += played.points;
      state.turns++;

      // 상대가 이을 단어가 없으면 상대가 목숨을 잃는다
      const reply = pickWord(mine.open, state.level, random);
      if (!reply) { await loseLife(state, 'computer', 'computer-stuck', trace); return done({ accepted: true }); }

      await redis.set(usedPrefix(id) + reply.word, 1, { ttl: GAME_TTL });
      usedWords.add(reply.word);
      const theirs = await continuations(reply.word, usedWords, trace);
      const answered = entry('computer', reply.word, theirs.total, { finisher: reply.finisher });
      state.history.push(answered);
      state.score.computer += answered.points;
      state.turns++;
      state.need = nextStartChars(reply.word);

      // 플레이어가 이을 수 있는 단어가 하나도 없으면 플레이어가 목숨을 잃는다
      if (theirs.open.length === 0) { await loseLife(state, 'player', 'no-word', trace); return done({ accepted: true, computer: reply }); }

      await redis.set(gameKey(id), state, { ttl: GAME_TTL });
      await redis.set(turnKey(id), 1, { ttl: turnMs });        // 플레이어 차례 시작: 이 키가 사라지면 시간 초과
      return done({ accepted: true, computer: reply });
    });
  }

  /** 판의 현재 상태. 차례 키가 사라져 있으면 시간 초과로 목숨을 잃는다 */
  async function get(id) {
    const state = await load(id);
    if (state.status !== 'playing' || (await redis.ttl(turnKey(id))) !== -2) return { game: await view(state), trace: [] };
    return withLock(id, async () => {
      const trace = [];
      const fresh = await load(id);
      if (fresh.status === 'playing' && (await redis.ttl(turnKey(id))) === -2) await loseLife(fresh, 'player', 'timeout', trace);
      return { game: await view(fresh), trace };
    });
  }

  function giveUp(id) {
    return withLock(id, async () => {
      const trace = [];
      const state = await load(id);
      if (state.status === 'playing') await finish(state, 'lose', 'give-up', trace);
      return { game: await view(state), trace };
    });
  }

  /* ---------------------------------------------------------------- 조회 */

  /** 점수가 가장 높은 판 10개 */
  async function ranking() {
    const trace = [];
    const rows = await cached(rankCache, 'ranking', '순위 조회', trace, async () => {
      const result = await db.query('SELECT id, player, level, turns, result, score FROM games ORDER BY score DESC LIMIT 10');
      return { plan: result.plan, value: result.objects };
    });
    return { ranking: rows, trace };
  }

  /** 기록 번호로 판 기록 한 건을 찾는다 (B+ 트리 인덱스 사용) */
  async function record(id) {
    const started = performance.now();
    const result = await db.query('SELECT * FROM games WHERE id = ' + Number(id));
    return { record: result.objects[0] ?? null, trace: [{ label: '기록 번호 ' + Number(id) + ' 조회', key: 'games', source: 'db', plan: result.plan, ms: performance.now() - started }] };
  }

  /**
   * prefix 로 시작하는 등록 단어 목록 (한 글자든 여러 글자든 된다).
   * 미니 DBMS 는 "~로 시작하는" 조건(LIKE)이 없어서, 첫 글자가 같은 단어를 가져온 뒤(캐시됨) 여기서 앞부분을 비교해 거른다
   */
  async function words(prefix) {
    const trace = [];
    prefix = String(prefix ?? '').trim();
    if (!/^[가-힣]{1,20}$/.test(prefix)) throw new GameError(400, '찾을 단어의 앞부분을 한글로 입력하세요');
    const sameFirst = await wordsStartingWith(prefix[0], trace);
    return { first: prefix, words: prefix.length === 1 ? sameFirst : sameFirst.filter((w) => w.word.startsWith(prefix)), trace };
  }

  /** 두 저장소의 현재 상태 */
  async function status() {
    const [info, tables, pool] = await Promise.all([redis.info(), db.tables(), db.stats()]);
    return { redis: info, tables, pool, cache: { ...wordCache.stats } };
  }

  /** 단어 캐시를 모두 지운다 (단어 파일을 다시 읽어 들인 뒤에 부른다) */
  async function clearWordCache() {
    return (await redis.delByPrefix('word:')) + (await redis.delByPrefix('first:'));
  }

  return { register, remove, start, play, get, giveUp, ranking, record, words, status, clearWordCache };
}
