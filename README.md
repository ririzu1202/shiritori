# 🧠 끝말잇기로 보는 미니 레디스

**끝말잇기의 규칙 Redis 의 기능으로 돌립니다**

![Node.js](https://img.shields.io/badge/Node.js-only-339933?logo=nodedotjs&logoColor=white)
![dependencies](https://img.shields.io/badge/dependencies-0-blue)
![mini-redis tests](https://img.shields.io/badge/mini--redis%20tests-59%20passing-DC382D?logo=redis&logoColor=white)
![all tests](https://img.shields.io/badge/all%20tests-230%20passing-brightgreen)


> [!NOTE]
> ## 🎯 레디스 기능 = 게임 규칙

| 미니 레디스 기능 | 끝말잇기에서 하는 일 | 키 |
|---|---|---|
| ⏱️ **TTL (만료)** | 한 차례 **10초 제한 시간**. 키가 사라지면 시간 초과 → 목숨 -1 | `game:<번호>:turn` |
| ⚡ **캐시 (Cache-Aside)** | 사전 확인을 DBMS 대신 레디스에서 → **20만 단어 벤치에서 약 3.5배** (실제 사전은 약 34만 단어) | `word:<단어>`, `first:<글자>` |
| 🧹 **무효화** | 단어를 등록·삭제하면 그 캐시를 바로 지워 **다음 차례부터 반영** (순차 요청 기준, [4장 한계](#4-캐시와-무효화--사전-확인)) | `del`, `delByPrefix` |
| 🔒 **nx (없을 때만 저장)** | 같은 판에 동시에 낸 단어는 **하나만 처리** (잠금) | `game:<번호>:lock` |
| ➕ **incr** | 판 번호를 겹치지 않게 발급, 로그인 실패 횟수 세기 | `game:seq`, `login:fail:*` |
| 🔑 **세션 TTL** | 제작자 로그인 **30분 뒤 자동 로그아웃** | `session:<토큰>` |
| 💾 **AOF (영속성)** | 서버가 꺼졌다 켜져도 **기록된 키를 복구** (최근 약 1초 기록은 잃을 수 있음) | `data/redis.aof` |


| ⏱️ 제한 시간 | ⚡ 단어 확인 | 🔒 동시 제출 8번 | 💾 강제 종료 후 |
|:---:|:---:|:---:|:---:|
| 서버의 키 만료로 판정 | 56 ms → **16 ms** (20만 단어 벤치) | → **1번만 처리** | **기록된 값 복구** (테스트) |

```mermaid
flowchart LR
  W["⚛️ 브라우저<br/>(미니 리액트)"] -- "fetch /api" --> G["🎮 게임 서버"]
  G == "판 진행 · 제한 시간 · 캐시 · 잠금 · 세션" ==> R["🧠 미니
