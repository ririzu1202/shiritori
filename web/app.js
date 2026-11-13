/* ======================================================================
 * app.js — 끝말잇기 화면. 미니 리액트(mini-react/ 폴더)로 그린다
 *
 *   App (루트 컴포넌트) 만 state 와 훅을 가진다. 나머지 컴포넌트는 props 만 받는 순수 함수다.
 *
 *   state
 *     tab       보고 있는 화면: 'game' | 'words' | 'rank'
 *     level     고른 난이도
 *     game      서버가 준 판의 상태 (없으면 null)
 *     deadline  이번 차례가 끝나는 시각 (ms)
 *     now       현재 시각. 0.2초마다 바뀌어 남은 시간 표시를 다시 그리게 한다
 *     notice    판 아래에 보여 줄 안내 { kind, text, word? }
 *     trace     방금 요청에서 값을 어디서 가져왔는지 (서버 응답의 trace)
 *     wordNote / found   단어 등록 화면의 안내 / 글자로 찾은 결과
 *     admin     제작자 로그인 { token, id }. 단어 등록 요청에 token 을 함께 보낸다
 *     rank / status      기록 화면의 순위 / 두 저장소 상태
 *
 *   useEffect  ① []                    Enter 키로 버튼 누르기 (미니 리액트는 click 만 위임하므로 여기서 연결한다)
 *              ② [판 번호, 진행 여부, deadline]  0.2초 타이머. 시간이 다 되면 서버에 판 상태를 물어 시간 초과를 반영한다
 *              ③ [tab]                 기록 화면을 열 때 순위와 상태를 불러온다
 *   useMemo    [game.history]          나온 단어들을 큰 박스와 단어 줄에 그릴 모양으로 바꾼다 (시계가 갈 때마다 다시 만들지 않는다)
 *
 *   입력 칸은 state 로 관리하지 않는다. 버튼을 누를 때 DOM 에서 값을 읽는다.
 *   서버 응답을 받은 뒤의 setState 여러 개는 batch 로 묶어 한 번만 다시 그린다.
 * ====================================================================== */

import { h } from '/mini-react/compo.js';
import { useState, useEffect, useMemo, batch } from '/mini-react/hooks.js';
import { createRoot } from '/mini-react/root.js';
import { containerToVdom } from '/mini-react/vdom.js';
import { api } from './api.js';

// 난이도: [서버에 보내는 이름, 화면에 보이는 이름, 설명]. 끝내기 단어를 낼 확률은 game/rules.js 의 FINISHER_CHANCE 와 같다
const LEVELS = [
  ['easy', '아주 쉬움', '끝내기 단어를 쓰지 않음'],
  ['mild', '쉬움', '끝내기 단어가 있으면 25% 확률로 냄'],
  ['normal', '보통', '끝내기 단어가 있으면 50% 확률로 냄'],
  ['tough', '어려움', '끝내기 단어가 있으면 75% 확률로 냄'],
  ['hard', '절대적', '끝내기 단어가 있으면 반드시 냄'],
];
const SHOWN = 300;                    // 단어 찾기에서 한 번에 보여 주는 단어 수
// 단어 등급: [화면에 보이는 이름, 이모지, 이을 수 있는 단어 수, 점수]. 기준은 game/rules.js 의 GRADES · POINTS 와 같다
const GRADES = {
  kill: ['한방', '💀', '0개', '2,000'],
  attack: ['공격', '🔥', '1~10개', '1,000'],
  tricky: ['까다로움', '⚡', '11~100개', '500'],
  normal: ['보통', '🙂', '101~1,000개', '250'],
  easy: ['넉넉', '🌱', '1,001개 이상', '100'],
};
const gradeInfo = (grade) => GRADES[grade] || GRADES.normal;
const WHO = { start: '시작', player: '나', computer: '상대' };
const levelOf = (level) => LEVELS.find((l) => l[0] === level) || LEVELS[2];
const levelName = (level) => levelOf(level)[1];
const $ = (id) => document.getElementById(id);
const ms = (n) => (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ms';

/** 판이 끝난 이유를 문장으로 */
function endingText(game) {
  if (game.reason === 'computer-stuck') return '상대의 목숨이 모두 사라졌습니다';
  if (game.reason === 'no-word') return '이을 수 있는 단어가 없어 마지막 목숨을 잃었습니다';
  if (game.reason === 'timeout') return '제한 시간 안에 단어를 내지 못해 마지막 목숨을 잃었습니다';
  return '판을 포기했습니다';
}

/** 방금 누가 목숨을 잃었으면 그 안내를, 아니면 null 을 돌려준다 (기록의 맨 끝이 '목숨' 줄이거나, 그 바로 뒤에 새 시작 단어가 붙은 경우) */
function lifeNotice(game) {
  if (game.status !== 'playing') return null;
  const list = game.history, last = list[list.length - 1];
  const at = last && last.by === 'life' ? list.length - 1 : last && last.by === 'start' && list.length > 1 && list[list.length - 2].by === 'life' ? list.length - 2 : -1;
  if (at === -1) return null;
  const lost = list[at], before = list[at - 1];
  const next = last.by === 'start' ? " 새 시작 단어는 '" + last.word + "'입니다" : ' 아무 단어로 다시 시작하세요';
  if (lost.who === 'computer') return { kind: 'ok', text: '상대가 이을 단어를 몰라 목숨을 잃었습니다 (상대 목숨 ' + lost.left + '개).' + next };
  if (lost.reason === 'timeout') return { kind: 'bad', text: '시간이 지나 목숨을 잃었습니다 (내 목숨 ' + lost.left + '개).' + next };
  return { kind: 'bad', text: "상대가 '" + (before ? before.word : '') + "'을(를) 냈고 이을 단어가 없어 목숨을 잃었습니다 (내 목숨 " + lost.left + '개).' + next };
}

/**
 * 나온 단어들 → 화면에 그릴 모양
 *   stage : 가운데 큰 박스에 보여 줄 마지막 단어 { by, finisher, head: 끝 글자를 뺀 앞부분, tail: 끝 글자, size }
 *   log   : 낸 순서대로의 목록. 단어 줄 { by, word, grade, options, points } 과 목숨을 잃은 줄 { by: 'life', who, reason, left }
 */
function toBoard(history) {
  const last = history.filter((entry) => entry.by !== 'life').pop();
  const stage = last ? {
    by: last.by,
    finisher: last.finisher === true,
    head: last.word.slice(0, -1),
    tail: last.word.slice(-1),
    grade: last.grade,
    size: last.word.length <= 5 ? 'short' : last.word.length <= 9 ? 'middle' : 'long',     // 긴 단어는 글자를 줄여 한 줄에 담는다
  } : null;
  return {
    stage,
    log: history.map((entry) => (entry.by === 'life'
      ? { by: 'life', who: entry.who, reason: entry.reason, left: entry.left }
      : { by: entry.by, word: entry.word, grade: entry.grade || 'normal', options: entry.options, points: entry.points || 0 })),
  };
}

/* ---------------------------------------------------------------- 순수 컴포넌트 (props 만 사용) */

function Tabs({ tab, onTab }) {
  const item = (id, label) => h('button', { class: tab === id ? 'tab on' : 'tab', type: 'button', onClick: () => onTab(id) }, label);
  return h('header', { class: 'top' },
    h('h1', null, '끝말잇기'),
    h('nav', { class: 'tabs' }, item('game', '게임'), item('words', '단어 등록'), item('rank', '기록')));
}

/** 가운데 큰 박스: 마지막에 나온 단어를 크게 보여 주고, 이어야 할 끝 글자에 형광펜을 칠한다 */
function Stage({ stage, need, game }) {
  const playing = game !== null && game.status === 'playing';
  const who = { start: '시작 단어', player: '내가 낸 단어', computer: '상대가 낸 단어' };
  const hint = game === null ? '판을 시작하면 시작 단어가 여기에 나옵니다'
    : !playing ? ''
    : !need ? '아무 단어로 시작하세요'
    : "'" + need.join("' 또는 '") + "'(으)로 시작하는 단어를 내세요";
  return h('div', { class: 'stage ' + (stage ? stage.by + (stage.finisher ? ' finisher' : '') : 'empty') },
    h('p', { class: 'who' }, stage ? who[stage.by] + (stage.grade ? ' ' + gradeInfo(stage.grade)[1] + ' ' + gradeInfo(stage.grade)[0] : '') : ''),
    h('p', { class: 'big ' + (stage ? stage.size : 'short') },
      h('span', { class: 'head' }, stage ? stage.head : ''),
      h('span', { class: playing ? 'tail on' : 'tail' }, stage ? stage.tail : '')),
    h('p', { class: 'hint' }, hint));
}

/** 목숨과 점수: 나와 상대를 나란히 보여 준다 */
function Scoreboard({ game }) {
  const side = (who, name) => {
    const lives = game && game.lives ? game.lives[who] : 0, score = game && game.score ? game.score[who] : 0;
    const total = game && game.lives ? Math.max(3, game.lives.player, game.lives.computer) : 3;
    return h('div', { class: 'side ' + who },
      h('span', { class: 'name' }, name),
      h('span', { class: 'hearts', 'aria-label': '목숨 ' + lives + '개' }, '♥'.repeat(lives) + '♡'.repeat(Math.max(0, total - lives))),
      h('span', { class: 'points' }, score.toLocaleString('ko-KR') + '점'));
  };
  return h('div', { class: 'scores', hidden: !game || !game.lives },
    side('player', game ? game.player : '나'),
    side('computer', '상대'));
}

/** 낸 단어 목록: 낸 순서대로, 단어마다 등급(색 + 이모지)과 받은 점수를 붙인다. 목숨을 잃은 곳에는 한 줄을 끼워 넣는다 */
function Log({ log }) {
  const lifeText = (e) => (e.who === 'computer' ? '상대' : '나') + ' 목숨 -1 (' +
    (e.reason === 'timeout' ? '시간 초과' : '이을 단어 없음') + ', 남은 목숨 ' + e.left + '개)';
  return h('section', { class: 'log', hidden: log.length === 0 },
    h('h2', null, '낸 단어'),
    h('p', { class: 'grades' }, Object.entries(GRADES).map(([id, [label, emoji, range, points]]) =>
      h('span', { class: 'grade ' + id }, emoji + ' ' + label + ' ' + range + ' ' + points + '점'))),
    h('p', { class: 'small' }, '등급과 점수는 그 단어 다음에 이을 수 있는 단어가 사전에 몇 개 있는지로 정합니다. 이번 판에 이미 나온 단어도 포함한 개수입니다.'),
    h('ol', { class: 'played' }, log.map((entry, i) => (entry.by === 'life'
      ? h('li', { class: 'life ' + entry.who },
          h('span', { class: 'no' }, i + 1),
          h('span', { class: 'by' }, '💔'),
          h('span', { class: 'w' }, lifeText(entry)),
          h('span', { class: 'n' }))
      : h('li', { class: 'grade ' + entry.grade },
          h('span', { class: 'no' }, i + 1),
          h('span', { class: 'by ' + entry.by }, WHO[entry.by]),
          h('span', { class: 'w' }, entry.word + ' ' + gradeInfo(entry.grade)[1]),
          h('span', { class: 'n' }, gradeInfo(entry.grade)[0] + (entry.options === undefined ? '' : ', 이을 단어 ' + entry.options.toLocaleString('ko-KR') + '개') +
            (entry.points ? ', +' + entry.points.toLocaleString('ko-KR') + '점' : '')))))));
}

function Clock({ remaining, total, playing }) {
  const ratio = playing ? Math.max(0, Math.min(1, remaining / total)) : 0;
  return h('div', { class: 'clock' + (playing && remaining < 3000 ? ' hurry' : ''), hidden: !playing },
    h('div', { class: 'bar' }, h('div', { class: 'fill', style: 'width:' + (ratio * 100).toFixed(1) + '%' })),
    h('span', { class: 'left' }, (remaining / 1000).toFixed(1), '초'));
}

function Notice({ notice, onRegister }) {
  return h('p', { class: 'notice ' + (notice ? notice.kind : 'none') },
    h('span', null, notice ? notice.text : ''),
    notice && notice.word ? h('button', { class: 'link', type: 'button', onClick: () => onRegister(notice.word) }, "'" + notice.word + "' 등록하고 내기") : null);
}

function PlayRow({ playing, need, onPlay, onGiveUp }) {
  const hint = !need ? '단어를 입력하세요' : need.join(' 또는 ') + '…';
  return h('div', { class: 'row', hidden: !playing },
    h('input', { id: 'word', class: 'field', type: 'text', maxlength: 20, autocomplete: 'off', spellcheck: 'false', placeholder: hint, 'data-enter': 'play', 'aria-label': '낼 단어' }),
    h('button', { id: 'play', class: 'btn main', type: 'button', onClick: onPlay }, '단어 내기'),
    h('button', { class: 'btn', type: 'button', onClick: onGiveUp }, '포기'));
}

function StartRow({ playing, level, over, onLevel, onStart }) {
  return h('div', { class: 'start', hidden: playing },
    h('div', { class: 'row' },
      h('input', { id: 'player', class: 'field name', type: 'text', maxlength: 12, autocomplete: 'off', placeholder: '이름', 'data-enter': 'start', 'aria-label': '이름' }),
      h('div', { class: 'levels' }, LEVELS.map(([id, label]) =>
        h('button', { class: level === id ? 'chip on' : 'chip', type: 'button', onClick: () => onLevel(id) }, label))),
      h('button', { id: 'start', class: 'btn main', type: 'button', onClick: onStart }, over ? '새 판 시작' : '판 시작')),
    h('p', { class: 'small' }, levelName(level), ': 상대가 ', levelOf(level)[2]));
}

/** 방금 요청을 처리하면서 값을 어디서 가져왔는지 */
function Trace({ trace }) {
  const tag = (t) => t.source === 'cache' ? ['hit', '레디스 캐시']
    : t.source === 'redis' ? ['redis', '레디스']
    : t.plan === 'FULL_SCAN' ? ['scan', 'DBMS 전체 탐색']
    : t.plan === 'INSERT' ? ['write', 'DBMS 저장']
    : ['index', 'DBMS 인덱스'];
  return h('aside', { class: 'trace' },
    h('h2', null, '방금 일어난 일'),
    h('p', { class: 'small' }, trace.length ? '단어를 확인하고 상대가 단어를 고르는 동안 값을 가져온 곳입니다.' : '단어를 내면 사전 확인이 어디서 처리됐는지 여기에 나옵니다.'),
    h('ol', { class: 'steps' }, trace.map((t) => {
      const [kind, text] = tag(t);
      return h('li', null,
        h('span', { class: 'what' }, t.label),
        h('span', { class: 'tag ' + kind }, text),
        h('span', { class: 'time' }, t.ms ? ms(t.ms) : ''));
    })));
}

function GameView({ visible, game, board, remaining, notice, level, trace, on }) {
  const playing = game !== null && game.status === 'playing';
  const over = game !== null && game.status === 'over';
  return h('main', { class: 'game', hidden: !visible },
    h('section', { class: 'board' },
      h('p', { class: 'result ' + (over ? game.result : 'none') }, over ? (game.result === 'win' ? '이겼습니다. ' : '졌습니다. ') + endingText(game) : ''),
      h(Scoreboard, { game }),
      h(Stage, { stage: board.stage, need: game ? game.need : null, game }),
      h(Clock, { remaining, total: game ? game.turnMs : 1, playing }),
      h(PlayRow, { playing, need: game ? game.need : null, onPlay: on.play, onGiveUp: on.giveUp }),
      h(Notice, { notice, onRegister: on.registerAndPlay }),
      h(StartRow, { playing, level, over, onLevel: on.level, onStart: on.start }),
      h(Log, { log: board.log })),
    h(Trace, { trace }));
}

function WordsView({ visible, admin, note, found, on }) {
  const loggedIn = admin !== null;
  return h('main', { class: 'page', hidden: !visible },
    h('section', null,
      h('h2', null, '단어 등록'),
      h('p', { class: 'small' }, '등록한 단어만 게임에서 쓸 수 있고, 상대도 등록된 단어 안에서만 고릅니다. 단어 등록과 삭제는 제작자만 할 수 있습니다.'),
      h('div', { class: 'row', hidden: loggedIn },
        h('input', { id: 'admin-id', class: 'field name', type: 'text', maxlength: 20, autocomplete: 'username', placeholder: '아이디', 'data-enter': 'login', 'aria-label': '제작자 아이디' }),
        h('input', { id: 'admin-password', class: 'field name', type: 'password', maxlength: 100, autocomplete: 'current-password', placeholder: '비밀번호', 'data-enter': 'login', 'aria-label': '제작자 비밀번호' }),
        h('button', { id: 'login', class: 'btn main', type: 'button', onClick: on.login }, '제작자 로그인')),
      h('p', { class: 'small', hidden: !loggedIn },
        h('span', null, loggedIn ? admin.id + ' 계정으로 로그인했습니다. 30분 뒤 자동으로 로그아웃됩니다.' : ''),
        h('button', { class: 'link', type: 'button', onClick: on.logout }, '로그아웃')),
      h('div', { class: 'row', hidden: !loggedIn },
        h('input', { id: 'new-word', class: 'field', type: 'text', maxlength: 20, autocomplete: 'off', spellcheck: 'false', placeholder: '등록하거나 삭제할 단어', 'data-enter': 'register', 'aria-label': '등록하거나 삭제할 단어' }),
        h('button', { id: 'register', class: 'btn main', type: 'button', onClick: on.register }, '단어 등록'),
        h('button', { id: 'remove', class: 'btn danger', type: 'button', onClick: on.remove }, '단어 삭제')),
      h('p', { class: 'notice ' + (note ? note.kind : 'none') }, note ? note.text : ''),
      h('p', { class: 'small', hidden: !loggedIn }, '많은 단어를 한꺼번에 넣으려면 words/extra.txt 에, 끝내기 단어는 words/finishers.txt 에 한 줄에 하나씩 적으세요. 삭제한 단어는 words/remove.txt 에 기록됩니다.')),
    h('section', null,
      h('h2', null, '등록된 단어 찾기'),
      h('div', { class: 'row' },
        h('input', { id: 'find-char', class: 'field', type: 'text', maxlength: 20, autocomplete: 'off', spellcheck: 'false', placeholder: '단어의 앞부분 (예: 확, 확인)', 'data-enter': 'find', 'aria-label': '찾을 단어의 앞부분' }),
        h('button', { id: 'find', class: 'btn', type: 'button', onClick: on.find }, '단어 찾기')),
      h('p', { class: 'small', hidden: !found }, found ? "'" + found.first + "'(으)로 시작하는 단어 " + found.words.length + '개 (' + (found.hit ? '레디스 캐시에서 꺼냄' : 'DBMS 에서 찾음') + ')' : ''),
      h('ul', { class: 'found' }, found ? found.words.slice(0, SHOWN).map((w) => h('li', { class: w.finisher ? 'finisher' : null }, w.word)) : null),
      h('p', { class: 'small', hidden: !found || found.words.length <= SHOWN }, '단어가 많아 앞의 ' + SHOWN + '개만 보여 줍니다.')));
}

function RankView({ visible, rank, status, on }) {
  const rows = rank ? rank.ranking : [];
  const words = status ? status.tables.find((t) => t.table === 'words') : null;
  const games = status ? status.tables.find((t) => t.table === 'games') : null;
  const fact = (label, value) => h('div', { class: 'fact' }, h('dt', null, label), h('dd', null, value));
  return h('main', { class: 'page', hidden: !visible },
    h('section', null,
      h('h2', null, '점수가 높은 판'),
      h('p', { class: 'small' }, rank ? (rank.trace[0].source === 'cache' ? '레디스 캐시에서 꺼냈습니다 (5초 동안 보관, 새 기록이 생기면 지움).' : 'DBMS 에서 새로 읽었습니다. 5초 동안 캐시에 보관합니다.') : '불러오는 중입니다.'),
      h('table', { class: 'rank' },
        h('thead', null, h('tr', null, h('th', null, '순위'), h('th', null, '이름'), h('th', null, '난이도'), h('th', null, '점수'), h('th', null, '이은 횟수'), h('th', null, '결과'), h('th', null, '기록 번호'))),
        h('tbody', null, rows.map((r, i) => h('tr', null,
          h('td', null, i + 1), h('td', null, r.player), h('td', null, levelName(r.level)), h('td', null, (r.score || 0).toLocaleString('ko-KR')), h('td', null, r.turns), h('td', null, r.result === 'win' ? '승' : '패'), h('td', null, r.id))))),
      h('p', { class: 'small', hidden: rows.length > 0 || !rank }, '아직 끝난 판이 없습니다. 게임을 한 판 하면 여기에 기록됩니다.'),
      h('button', { class: 'btn', type: 'button', onClick: on.refresh }, '새로 고침')),
    h('section', null,
      h('h2', null, '두 저장소의 지금 상태'),
      h('h3', null, '미니 레디스 (메모리)'),
      h('dl', { class: 'facts' },
        fact('저장된 키', status ? status.redis.keys : '-'),
        fact('만료 시간이 걸린 키', status ? status.redis.keysWithTtl : '-'),
        fact('조회 성공 / 실패', status ? status.redis.hits + ' / ' + status.redis.misses : '-'),
        fact('만료돼 지워진 키', status ? status.redis.expired : '-'),
        fact('해시 테이블 칸 수', status ? status.redis.table.capacity : '-'),
        fact('가장 긴 체인', status ? status.redis.table.longestChain : '-')),
      h('h3', null, '미니 DBMS (파일)'),
      h('dl', { class: 'facts' },
        fact('단어 기록', words ? words.rows + '건' : '-'),
        fact('판 기록', games ? games.rows + '건' : '-'),
        fact('B+ 트리 높이 (단어 / 판)', words ? words.indexHeight + ' / ' + games.indexHeight : '-'),
        fact('워커 스레드', status ? status.pool.size + '개' : '-'),
        fact('처리한 요청', status ? status.pool.completed : '-'))));
}

/* ---------------------------------------------------------------- 루트 컴포넌트 */

function App() {
  const [tab, setTab] = useState('game');
  const [level, setLevel] = useState('normal');
  const [game, setGame] = useState(null);
  const [deadline, setDeadline] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [notice, setNotice] = useState(null);
  const [trace, setTrace] = useState([]);
  const [wordNote, setWordNote] = useState(null);
  const [found, setFound] = useState(null);
  const [rank, setRank] = useState(null);
  const [status, setStatus] = useState(null);
  const [admin, setAdmin] = useState(null);          // 제작자 로그인 { token, id } (로그인하지 않았으면 null)

  const playing = game !== null && game.status === 'playing';
  const history = game ? game.history : null;
  const board = useMemo(() => toBoard(history || []), [history]);

  /** 서버가 준 판 상태를 화면에 반영한다 (setState 여러 개 → 한 번만 다시 그림) */
  const show = (res, nextNotice = null) => batch(() => {
    setGame(res.game);
    setDeadline(Date.now() + res.game.remainingMs);
    setNow(Date.now());
    if (res.trace.length) setTrace(res.trace);
    setNotice(nextNotice);
  });
  const fail = (err) => setNotice({ kind: 'bad', text: err.message });

  // ① Enter 키: 입력 칸의 data-enter 가 가리키는 버튼을 누른 것으로 처리한다
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Enter' || e.isComposing || !e.target.dataset || !e.target.dataset.enter) return;
      e.preventDefault();
      $(e.target.dataset.enter).click();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // 로그인 토큰은 탭을 닫기 전까지 sessionStorage 에 둔다. 새로 고침하면 서버에 아직 살아 있는 로그인인지 물어본다
  const remember = (value) => {
    try { if (value) sessionStorage.setItem('admin', JSON.stringify(value)); else sessionStorage.removeItem('admin'); } catch (e) { /* 저장소를 못 써도 로그인은 된다 */ }
    setAdmin(value);
  };
  useEffect(() => {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('admin')); } catch (e) { saved = null; }
    if (!saved || !saved.token) return;
    api.session(saved.token).then((res) => remember(res.loggedIn ? { token: saved.token, id: res.id } : null), () => {});
  }, []);

  /** 로그인이 필요한 요청이 401 로 거절되면 (30분이 지나 세션 키가 만료됨) 로그인 폼으로 되돌린다 */
  const expired = (err) => { if (err.status === 401) remember(null); return err.message; };

  // ② 차례 시계. 시간이 다 되면 서버에 물어본다 (서버에서는 차례 키가 만료돼 사라져 있다)
  const gameId = game ? game.id : null;
  useEffect(() => {
    if (!playing) return;
    let asking = false;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() < deadline + 150 || asking) return;
      asking = true;
      api.getGame(gameId).then((res) => show(res, lifeNotice(res.game)), fail).finally(() => { asking = false; });
    }, 200);
    return () => clearInterval(timer);
  }, [gameId, playing, deadline]);

  const loadRank = () => Promise.all([api.ranking(), api.status()])
    .then(([r, s]) => batch(() => { setRank(r); setStatus(s); }), () => {});

  // ③ 기록 화면을 열 때마다 새로 불러온다
  useEffect(() => { if (tab === 'rank') loadRank(); }, [tab]);

  async function play(word) {
    if (!game) return;
    try {
      const res = await api.playWord(game.id, word);
      const input = $('word');
      if (res.reject) {
        show(res, res.reject.code === 'timeout' ? lifeNotice(res.game) || { kind: 'bad', text: res.reject.message }
          : { kind: 'bad', text: res.reject.message, word: res.reject.code === 'unknown' && admin ? word : null });   // 등록 버튼은 제작자에게만 보인다
        input.select();
        return;
      }
      input.value = '';
      show(res, lifeNotice(res.game) || (res.game.status === 'playing' && res.computer
        ? { kind: 'ok', text: "상대가 '" + res.computer.word + "'(으)로 받았습니다" + (res.computer.finisher ? ' (끝내기 단어)' : '') } : null));
      if (res.game.status === 'playing') input.focus();
    } catch (err) { fail(err); }
  }

  const on = {
    level: setLevel,
    start: async () => {
      try {
        const res = await api.startGame($('player').value, level);
        batch(() => { setTrace([]); show(res, { kind: 'ok', text: res.game.player + '님 차례입니다' }); });
        $('word').value = '';
        $('word').focus();
      } catch (err) { fail(err); }
    },
    play: () => play($('word').value.trim()),
    giveUp: async () => { try { show(await api.giveUp(game.id)); } catch (err) { fail(err); } },
    registerAndPlay: async (word) => {
      try { await api.registerWord(word, false, admin && admin.token); await play(word); } catch (err) { setNotice({ kind: 'bad', text: expired(err) }); }
    },
    register: async () => {
      const input = $('new-word');
      try {
        const res = await api.registerWord(input.value.trim(), false, admin && admin.token);
        setWordNote({ kind: res.added ? 'ok' : 'bad', text: res.message + (res.added ? '. 캐시 ' + res.invalidated.join(', ') + ' 를 지웠습니다' : '') });
        if (res.added) { input.value = ''; setFound(null); }
        input.focus();
      } catch (err) { batch(() => setWordNote({ kind: 'bad', text: expired(err) })); }
    },
    remove: async () => {
      const input = $('new-word');
      try {
        const res = await api.removeWord(input.value.trim(), admin && admin.token);
        batch(() => {
          setWordNote({ kind: res.removed ? 'ok' : 'bad', text: res.message + (res.removed ? '. 캐시 ' + res.invalidated.join(', ') + ' 를 지웠습니다' : '') });
          if (res.removed) setFound(null);
        });
        if (res.removed) input.value = '';
        input.focus();
      } catch (err) { batch(() => setWordNote({ kind: 'bad', text: expired(err) })); }
    },
    login: async () => {
      const password = $('admin-password');
      try {
        const res = await api.login($('admin-id').value.trim(), password.value);
        batch(() => { remember({ token: res.token, id: res.id }); setWordNote({ kind: 'ok', text: '로그인했습니다. 이제 단어를 등록할 수 있습니다' }); });
      } catch (err) { setWordNote({ kind: 'bad', text: err.message }); }
      password.value = '';                               // 비밀번호는 화면에 남기지 않는다
    },
    logout: async () => {
      const token = admin && admin.token;
      batch(() => { remember(null); setWordNote({ kind: 'ok', text: '로그아웃했습니다' }); });
      if (token) api.logout(token).catch(() => {});
    },
    find: async () => {
      try {
        const res = await api.wordsStartingWith($('find-char').value.trim());
        batch(() => { setFound({ first: res.first, words: res.words, hit: res.trace[0].source === 'cache' }); setWordNote(null); });
      } catch (err) { batch(() => { setFound(null); setWordNote({ kind: 'bad', text: err.message }); }); }
    },
    refresh: loadRank,
  };

  return h('div', { class: 'app' },
    h(Tabs, { tab, onTab: setTab }),
    h(GameView, { visible: tab === 'game', game, board, remaining: playing ? Math.max(0, deadline - now) : 0, notice, level, trace, on }),
    h(WordsView, { visible: tab === 'words', admin, note: wordNote, found, on }),
    h(RankView, { visible: tab === 'rank', rank, status, on }));
}

const container = $('app');
const root = createRoot(container, { onError: (err) => console.error(err) });
root.mount(App, containerToVdom(container));
