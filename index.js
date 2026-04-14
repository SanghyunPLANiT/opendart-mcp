import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import xml2js from "xml2js";
import AdmZip from "adm-zip";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const API_KEY = process.env.OPENDART_API_KEY;
if (!API_KEY) {
  console.error("Error: OPENDART_API_KEY 환경변수를 설정해주세요. (https://opendart.fss.or.kr)");
  process.exit(1);
}

const API_BASE = "https://opendart.fss.or.kr/api";
const CACHE_DIR = join(homedir(), ".cache", "opendart");
const CORP_CODES_PATH = join(CACHE_DIR, "corp_codes.json");

// ── Corp code cache ──

let corpCodes = [];
let corpNameIndex = {};

function loadCorpCodes() {
  if (!existsSync(CORP_CODES_PATH)) return false;
  corpCodes = JSON.parse(readFileSync(CORP_CODES_PATH, "utf-8"));
  buildIndex();
  return true;
}

function buildIndex() {
  corpNameIndex = {};
  for (const row of corpCodes) {
    if (row.corp_name) corpNameIndex[row.corp_name] = row.corp_code;
  }
}

function resolveCorpCode(name) {
  // exact match
  if (corpNameIndex[name]) return corpNameIndex[name];
  // substring match
  const q = name.toLowerCase();
  for (const [n, code] of Object.entries(corpNameIndex)) {
    if (n.toLowerCase().includes(q)) return code;
  }
  return null;
}

// load cache on startup
loadCorpCodes();

// ── API helpers ──

async function dartJson(endpoint, params) {
  const { data } = await axios.get(`${API_BASE}/${endpoint}.json`, {
    params: { crtfc_key: API_KEY, ...params },
    timeout: 30000,
  });
  if (data.status && data.status !== "000") {
    throw new Error(`OpenDART ${data.status}: ${data.message}`);
  }
  return data;
}

async function dartBytes(endpoint, params) {
  const { data } = await axios.get(`${API_BASE}/${endpoint}.xml`, {
    params: { crtfc_key: API_KEY, ...params },
    responseType: "arraybuffer",
    timeout: 120000,
  });
  return Buffer.from(data);
}

// ── Server ──

const server = new McpServer({
  name: "opendart",
  version: "1.0.0",
  instructions:
    "Korean DART public disclosure system. " +
    "Use search_disclosures as the primary tool — it accepts corp_name directly (e.g. '삼성전자'). " +
    "Only call download_corp_codes if search fails with 'Cannot find corp_code'.",
});

// 1. 공시 검색
server.tool(
  "search_disclosures",
  "공시 검색. corp_name(예: '삼성전자')을 직접 입력 가능 — corp_code 조회 불필요.\n" +
    "pblntf_ty: A=정기공시, B=주요사항보고, C=발행공시, D=지분공시, E=기타공시, " +
    "F=외부감사관련, G=펀드공시, H=자산유동화, I=거래소공시, J=공정위공시",
  {
    bgn_de: z.string().describe("검색 시작일 (YYYYMMDD)"),
    end_de: z.string().describe("검색 종료일 (YYYYMMDD)"),
    corp_code: z.string().optional().describe("기업 고유번호 (8자리)"),
    corp_name: z.string().optional().describe("회사명 (예: '삼성전자') — corp_code 대신 사용 가능"),
    last_reprt_at: z.string().optional().default("Y").describe("최종보고서만 (Y/N)"),
    pblntf_ty: z.string().optional().describe("공시유형 (A~J)"),
    pblntf_detail_ty: z.string().optional().describe("공시상세유형"),
    corp_cls: z.string().optional().describe("법인구분: Y=유가, K=코스닥, N=코넥스, E=기타"),
    sort: z.string().optional().default("date").describe("정렬: date, crp, rpt"),
    sort_mth: z.string().optional().default("desc").describe("정렬방향: asc, desc"),
    page_no: z.number().optional().default(1).describe("페이지 번호"),
    page_count: z.number().optional().default(20).describe("페이지당 건수 (최대 100)"),
  },
  async ({ corp_code, corp_name, ...rest }) => {
    if (!corp_code && corp_name) {
      if (corpCodes.length === 0) {
        // auto-download if no cache
        await downloadCorpCodesInternal();
      }
      corp_code = resolveCorpCode(corp_name);
      if (!corp_code) {
        return { content: [{ type: "text", text: `'${corp_name}'에 해당하는 기업을 찾을 수 없습니다. download_corp_codes를 먼저 실행해주세요.` }] };
      }
    }

    const data = await dartJson("list", { corp_code, ...rest });
    const items = data.list || [];
    const text = [
      `총 ${data.total_count || 0}건 (${data.page_no || 1}/${data.total_page || 1} 페이지)`,
      "",
      ...items.map(
        (d, i) =>
          `[${i + 1}] ${d.report_nm}\n  - 접수번호: ${d.rcept_no} | 접수일: ${d.rcept_dt}\n  - 회사: ${d.corp_name} (${d.corp_code}) | 제출인: ${d.flr_nm}`,
      ),
    ].join("\n");

    return { content: [{ type: "text", text }] };
  },
);

// 2. 기업 검색
server.tool(
  "find_companies",
  "회사명, 종목코드, corp_code로 기업을 검색합니다",
  {
    query: z.string().describe("검색어"),
    field: z.enum(["corp_name", "stock_code", "corp_code"]).optional().default("corp_name").describe("검색 필드"),
    limit: z.number().optional().default(10).describe("결과 수"),
  },
  async ({ query, field, limit }) => {
    if (corpCodes.length === 0) await downloadCorpCodesInternal();
    const q = query.toLowerCase();
    const results = corpCodes.filter((r) => (r[field] || "").toLowerCase().includes(q)).slice(0, limit);

    const text = results.length
      ? results.map((r) => `${r.corp_name} | corp_code: ${r.corp_code} | 종목코드: ${r.stock_code || "-"}`).join("\n")
      : "검색 결과가 없습니다.";

    return { content: [{ type: "text", text: `${results.length}건\n\n${text}` }] };
  },
);

// 3. 고유번호 다운로드
async function downloadCorpCodesInternal(force = false) {
  if (corpCodes.length > 0 && !force) return corpCodes.length;

  const buf = await dartBytes("corpCode", {});
  const zip = new AdmZip(buf);
  const xmlEntry = zip.getEntries()[0];
  const xmlStr = xmlEntry.getData().toString("utf-8");
  const parsed = await xml2js.parseStringPromise(xmlStr, { explicitArray: false, trim: true });

  const items = parsed?.result?.list || [];
  corpCodes = (Array.isArray(items) ? items : [items]).map((item) => ({
    corp_code: item.corp_code || "",
    corp_name: item.corp_name || "",
    stock_code: item.stock_code || "",
    modify_date: item.modify_date || "",
  }));

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CORP_CODES_PATH, JSON.stringify(corpCodes), "utf-8");
  buildIndex();
  return corpCodes.length;
}

server.tool(
  "download_corp_codes",
  "전체 기업 고유번호 목록 다운로드 (~10만개). find_companies나 search_disclosures가 기업을 못 찾을 때만 호출",
  {
    force_refresh: z.boolean().optional().default(false).describe("캐시 무시하고 재다운로드"),
  },
  async ({ force_refresh }) => {
    const count = await downloadCorpCodesInternal(force_refresh);
    return { content: [{ type: "text", text: `${count}개 기업 로드 완료 (캐시: ${CORP_CODES_PATH})` }] };
  },
);

// 4. 기업 개황
server.tool(
  "get_company_overview",
  "기업 기본 정보 조회 (대표자, 주소, 업종 등)",
  {
    corp_code: z.string().describe("기업 고유번호 (8자리)"),
  },
  async ({ corp_code }) => {
    const data = await dartJson("company", { corp_code });
    const lines = [
      `# ${data.corp_name || ""}`,
      `- 영문명: ${data.corp_name_eng || "-"}`,
      `- 대표자: ${data.ceo_nm || "-"}`,
      `- 법인구분: ${data.corp_cls || "-"} | 종목코드: ${data.stock_code || "-"}`,
      `- 사업자번호: ${data.bizr_no || "-"} | 법인번호: ${data.jurir_no || "-"}`,
      `- 주소: ${data.adres || "-"}`,
      `- 홈페이지: ${data.hm_url || "-"}`,
      `- 업종코드: ${data.induty_code || "-"} | 설립일: ${data.est_dt || "-"} | 결산월: ${data.acc_mt || "-"}`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// 5. 재무제표
server.tool(
  "get_financial_statements",
  "재무제표 상세 조회. reprt_code: 11013=1분기, 11012=반기, 11014=3분기, 11011=사업보고서",
  {
    corp_code: z.string().describe("기업 고유번호 (8자리)"),
    bsns_year: z.string().describe("사업연도 (YYYY)"),
    reprt_code: z.string().optional().default("11011").describe("보고서코드"),
    fs_div: z.string().optional().default("CFS").describe("개별/연결: OFS=개별, CFS=연결"),
  },
  async ({ corp_code, bsns_year, reprt_code, fs_div }) => {
    const data = await dartJson("fnlttSinglAcntAll", { corp_code, bsns_year, reprt_code, fs_div });
    const items = data.list || [];

    if (!items.length) return { content: [{ type: "text", text: "재무제표 데이터가 없습니다." }] };

    const text = items
      .map((r) => `${r.account_nm}: ${r.thstrm_amount || "-"} (전기: ${r.frmtrm_amount || "-"})`)
      .join("\n");

    return { content: [{ type: "text", text: `${items.length}개 항목\n\n${text}` }] };
  },
);

// 6. 원본 공시 다운로드
server.tool(
  "download_original_document",
  "공시 원본 파일(ZIP) 다운로드",
  {
    rcept_no: z.string().describe("접수번호 (14자리)"),
  },
  async ({ rcept_no }) => {
    const docDir = join(CACHE_DIR, "documents");
    mkdirSync(docDir, { recursive: true });
    const buf = await dartBytes("document", { rcept_no });
    const outPath = join(docDir, `${rcept_no}.zip`);
    writeFileSync(outPath, buf);

    return {
      content: [
        {
          type: "text",
          text: [
            `다운로드 완료: ${outPath} (${(buf.length / 1024).toFixed(1)}KB)`,
            `DART 뷰어: https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcept_no}`,
          ].join("\n"),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
