# 키워드 현황 자동화 운영 절차

## 공통 원칙

1. 먼저 `state/latest-snapshot.json`만 읽고 전체 스냅샷은 오류 조사 때만 연다.
2. 커뮤니티·검색·SNS 점수는 합산하지 않는다.
3. 누락값을 0으로 만들지 않고 `미수집` 또는 `측정 대기`로 둔다.
4. 네이버·Instagram·TikTok은 수집하지 않는다.
5. 테스트 실패 시 커밋·푸시·메일 발송을 하지 않는다.

## 오전 11시

1. `npm run collect`
2. `npm test`
3. `npm run check -- data/YYYY-MM-DD.json`
4. `npm run report -- data/YYYY-MM-DD.json`
5. 변경 파일만 커밋하고 `main`에 푸시한다.
6. GitHub Pages의 날짜별 리포트가 HTTP 200인지 확인한다.
7. Gmail 보낸편지함에 `[키워드 현황] YYYY-MM-DD 트렌드 리포트`가 없을 때만 `robustkdh3565@gmail.com`, `ownwellcorp@gmail.com`으로 발송한다.

## 오후 3시·7시

1. `npm run snapshot`
2. `npm test`
3. 해당 시간대 압축 스냅샷과 `state/latest-snapshot.json`만 커밋하고 푸시한다.
4. 일일 HTML·Markdown과 `data/YYYY-MM-DD.json`은 덮어쓰지 않으며 메일도 보내지 않는다.

## 분류

- 첫 측정: `최신글`
- 직전 목록에 없고 현재 존재: `진입글`
- 뜨는글: 전체 속도 백분위 40% + 커뮤니티 내부 속도 백분위 25% + 반응 증가 15% + 순위 상승 10% + 최신성 10%
- 주요글: 내부 순위 30% + 조회 백분위 25% + 반응률 20% + 지속성 15% + 교차 확산 10%
- 뜰 것 같은 글: 속도 40% + 반응 30% + 최신성 15% + 확산 15%, 65점 이상
