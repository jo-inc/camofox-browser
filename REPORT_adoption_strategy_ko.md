# camofox-browser 도입 전략 / 아키텍처 제안서

목표:
우리 시스템에 `camofox-browser`를 도입한다면
어떤 위치에 두고, 어떤 리스크를 관리하며, 어떤 단계로 검증할지 제안한다.

---

## 1. 권장 포지션

권장 해석:

```text
camofox-browser = 브라우저 엔진 SDK 대체재
                가 아니라
                웹 에이전트용 browsing control plane / backend
```

즉 직접 모든 비즈니스 로직을 이 위에 얹기보다는,
상위 agent orchestration과 분리해 두는 것이 좋다.

---

## 2. 권장 아키텍처

```text
                     +----------------------+
                     | Planner / LLM Agent  |
                     | - task planning      |
                     | - reasoning          |
                     +----------+-----------+
                                |
                                | tool/API calls
                                v
+-------------------------------------------------------------+
| Browsing Gateway / Adapter                                  |
| - 우리 표준 tool schema                                     |
| - retry / policy / audit / redaction                        |
| - site-specific workflow wrapper                            |
+----------------------------+--------------------------------+
                             |
                             v
+-------------------------------------------------------------+
| camofox-browser                                            |
| - snapshot / click / type / wait                           |
| - cookies / downloads / images / screenshot                |
| - session isolation / locks / metrics                      |
+----------------------------+--------------------------------+
                             |
                             v
+-------------------------------------------------------------+
| Proxy Layer / Residential Proxy / Geo                      |
+----------------------------+--------------------------------+
                             |
                             v
                       [Target Websites]
```

핵심 원칙:
- LLM은 직접 사이트별 세부사항을 다루지 않게 한다
- 우리 Gateway가 표준화/정책/감사를 담당한다
- camofox-browser는 브라우징 백엔드 역할에 집중시킨다

---

## 3. 왜 Adapter/Gateway를 두는가

직접 agent -> camofox-browser 연결도 가능하지만,
실전 운영에서는 중간 계층이 필요하다.

이유:
1. 사이트별 workflow 추상화
2. 위험 API(`evaluate`) 통제
3. 사용자/업무별 권한 정책 적용
4. 감사 로그, 재시도, 레이트 리밋 적용
5. 추후 다른 backend 교체 용이

권장 인터페이스 예:

```text
agent.search_web(query)
agent.login_with_cookie(site)
agent.extract_structured_result(schema)
agent.capture_receipt()
```

이 내부에서만 camofox API 조합을 수행하게 한다.

---

## 4. 도입 방식: 3단계 권장

### Phase 1. 기술 검증 (1~2주)
목표:
- 실제 우리 주요 사이트에서 먹히는지 확인
- anti-bot 우회와 agent 성공률 측정

대상 작업:
- 검색 결과 탐색
- 로그인 후 읽기 전용 페이지 접근
- 간단 폼 입력
- 다운로드/스크린샷 수집

성공 기준 예시:
- 핵심 시나리오 성공률 80%+
- CAPTCHA/차단률 측정 가능
- snapshot 기반 agent action 성공률 확보
- 운영 로그/metrics 확보

### Phase 2. 제한적 운영 파일럿
목표:
- 작은 사용자군/내부 워크플로에 연결
- 장애 유형과 비용 구조 파악

추가할 것:
- Gateway/adapter
- 접근 정책
- 세션 정리 자동화
- 모니터링 대시보드
- 회귀 테스트 시나리오

### Phase 3. 정식 운영
목표:
- 브라우징 작업을 표준 플랫폼 capability로 편입

추가할 것:
- 다중 사이트 capability matrix
- 프록시 공급자 다변화
- 실패 사유 taxonomy
- 비용/성공률 기반 자동 라우팅

---

## 5. 반드시 검증할 항목

### A. 차단 회피 성능
측정 예:
- 사이트별 초기 접속 성공률
- CAPTCHA 발생률
- 세션 유지 시간
- 프록시 rotation 후 복구율

### B. Agent usability
측정 예:
- snapshot -> 행동 성공률
- stale ref 발생률
- task completion rate
- 평균 step 수

### C. 운영 안정성
측정 예:
- 탭 누수율
- 메모리 사용량
- 브라우저 재시작 빈도
- 세션 timeout 후 정리 성공률

### D. 비용성
측정 예:
- 프록시 비용
- 브라우저 인스턴스당 처리량
- task당 평균 실행 시간
- 실패 재시도 비용

---

## 6. 리스크와 대응

### 리스크 1. upstream Camoufox 의존
대응:
- 버전 pinning
- 사전 검증 환경 운영
- fallback backend 준비(예: Playwright)

### 리스크 2. `server.js` 비대화에 따른 변경 리스크
대응:
- fork 후 내부 patch 관리 시 모듈 분해 우선
- 직접 코어 수정 최소화
- wrapper/adapter 중심 통합

### 리스크 3. 실전 탐지 정책 변화
대응:
- 사이트별 벤치마크 자동화
- 프록시 다중 공급자
- 차단률 이상치 경보

### 리스크 4. evaluate 등 위험 기능 오남용
대응:
- Gateway에서 capability allowlist 적용
- trusted workflow만 evaluate 허용
- raw JS 실행은 감사 로그 필수

### 리스크 5. 멀티테넌트 보안 경계
대응:
- tenant/user별 session 분리
- admin/cookie API 별도 인증
- 민감 쿠키 저장/주입 절차 분리

---

## 7. 권장 운영 정책

### 권장 정책 1. 사이트 등급화

```text
Tier A: 읽기 중심, 안정 사이트
Tier B: 로그인 필요, 중간 난이도
Tier C: 강한 anti-bot/민감 작업
```

처음엔 Tier A/B만 운영하고,
Tier C는 별도 승인 기반으로 확장.

### 권장 정책 2. 기능 allowlist
초기 허용:
- create_tab
- navigate
- snapshot
- click
- type
- wait
- screenshot
- downloads
- images

초기 제한:
- evaluate
- cookie import 직접 노출
- admin 성격 endpoint

### 권장 정책 3. 표준 실패 taxonomy 운영
예:
- proxy_error
- bot_detected
- captcha_required
- stale_ref
- session_expired
- site_changed
- timeout

이 분류는 운영 자동화의 핵심이다.

---

## 8. 내부 적용 시 추천 구현 우선순위

1. Gateway/adapter부터 구축
2. 핵심 사이트 3개 파일럿
3. Prometheus/로그 대시보드 연결
4. capability allowlist 적용
5. benchmark/회귀 테스트 자동화
6. 필요시 fork 후 모듈화 개선

---

## 9. 추천 여부

### 추천 시나리오
- 웹 에이전트가 핵심 제품 capability인 경우
- anti-bot 회피가 실제 비즈니스 요구인 경우
- 브라우저 자동화를 운영 플랫폼으로 만들 계획이 있는 경우

### 비추천 시나리오
- 단순 UI 테스트 자동화만 필요한 경우
- 범용 브라우저 자동화면 충분한 경우
- 프록시/운영 비용을 감당하기 어려운 경우

---

## 10. 최종 제안

```text
권장안:
전면 즉시 채택 X
제한적 파일럿 O
상위 orchestration과 분리된 browsing backend로 도입 O
Gateway/정책 계층 없이 직접 노출 X
```

최종 한 문장:
`camofox-browser`는 그대로 제품에 박아 넣을 컴포넌트라기보다,
우리 웹 에이전트 스택의 '고난도 browsing backend' 후보로 도입하는 것이 가장 합리적입니다.
