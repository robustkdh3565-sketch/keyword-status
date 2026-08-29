# 참고한 오픈소스

프로젝트에는 아래 저장소의 코드를 복사하지 않았으며, 공개된 기능과 설계 개념을 참고해 자체 구현했습니다.

- [KeyBERT](https://github.com/MaartenGr/KeyBERT): 임베딩 기반 키워드 추출 확장 후보
- [BERTopic](https://github.com/MaartenGr/BERTopic): 의미 기반 토픽 군집화 확장 후보
- [Kiwi](https://github.com/bab2min/Kiwi): 한국어 형태소 분석 확장 후보
- [KR-WordRank](https://github.com/lovit/KR-WordRank): 비지도 한국어 키워드 추출 확장 후보
- [RapidFuzz](https://github.com/rapidfuzz/RapidFuzz): 문자열 유사도 설계 참고
- [scikit-learn](https://github.com/scikit-learn/scikit-learn): 표준화·Ridge 회귀 검증 기준 참고
- [pandas](https://github.com/pandas-dev/pandas): 일별 데이터·백분위 분석 구조 참고
- [NetworkX](https://github.com/networkx/networkx): 커뮤니티 확산 그래프 확장 후보
- [Trafilatura](https://github.com/adbar/trafilatura): 원문 본문 정제 확장 후보
- [Scrapy](https://github.com/scrapy/scrapy): 다중 사이트 수집기 확장 후보
- [google-trends-api](https://github.com/pat310/google-trends-api): Google Trends 보조 검증 확장 후보
- [Naver Search/DataLab MCP](https://github.com/swift-man/naver-mcp-py): 네이버 검색 수요 검증 확장 후보
- [네이버 데이터랩 공식 API](https://developers.naver.com/docs/serviceapi/datalab/search/search.md): 한국 검색 관심도 시계열 검증
- [네이버 검색 공식 API](https://developers.naver.com/docs/serviceapi/search/news/news.md): 뉴스·블로그 확산량과 최신성 검증
- [Google Trends 공식 API 알파](https://developers.google.com/search/blog/2025/07/trends-api): 권한 확보 시 일관된 척도의 글로벌 검색 관심도 검증
- [YouTube Data API](https://developers.google.com/youtube/v3/docs): 영상 검색 결과와 조회·댓글 통계로 수요 대비 경쟁 강도 계산

외부 의존성은 필요성과 유지 상태, 라이선스를 다시 확인한 후 별도 변경으로 도입합니다.
