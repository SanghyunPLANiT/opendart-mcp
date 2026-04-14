# OpenDART MCP

Korean [OpenDART](https://opendart.fss.or.kr) API를 MCP 서버로 제공합니다. Claude Desktop, Claude Code 등에서 공시 검색, 기업 조회, 재무제표 조회, 원본 공시 다운로드를 할 수 있습니다.

## Tools

| Tool | 설명 |
|------|------|
| `search_disclosures` | 공시 검색. `corp_name`(예: '삼성전자')을 직접 입력 가능 |
| `find_companies` | 회사명, 종목코드, corp_code로 기업 검색 |
| `download_corp_codes` | 전체 기업 고유번호 목록 다운로드 (~10만개) |
| `get_company_overview` | 기업 기본 정보 (대표자, 주소, 업종 등) |
| `get_financial_statements` | 재무제표 상세 조회 |
| `download_original_document` | 공시 원본 파일(ZIP) 다운로드 |

## Setup

1. [OpenDART](https://opendart.fss.or.kr)에서 API 인증키 발급

2. 의존성 설치:

```bash
npm install
```

## Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`에 추가:

```json
{
  "mcpServers": {
    "opendart": {
      "command": "node",
      "args": ["/path/to/this/repo/index.js"],
      "env": {
        "OPENDART_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

## Claude Code (CLI)

```bash
claude mcp add opendart \
  --env OPENDART_API_KEY=YOUR_API_KEY \
  -- node /path/to/this/repo/index.js
```

## API Reference

- https://opendart.fss.or.kr/guide/main.do?apiGrpCd=DS001
