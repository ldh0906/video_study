import QRCode from "qrcode";
import { fmtDuration, fmtTime } from "../../shared/time";
import type { Analysis, ExportOptions, Flashcard, Frame, Lecture, Material, Quiz, QuizQuestion, SectionAnalysis, Transcript } from "../../shared/types";
import { createRenderer } from "./markdown";

/**
 * Builds the print HTML for a study book. Chrome lays it out with CSS paged
 * media; pdf.ts then fills page numbers (2-pass), draws grids and turns the
 * "slot" links into fillable fields.
 *
 * Learning-design choices (from the research pass): retrieval first — every
 * section ends with questions and a write-from-memory box, answers live in an
 * appendix linked both ways by page number; space to write is part of the
 * page; every claim links back to the moment in the video.
 */

export interface DocInput {
  lecture: Lecture;
  analysis: Analysis;
  options: ExportOptions;
  cards: Flashcard[];
  quizzes: Quiz[];
  materials: Material[];
  memo: string;
  transcript: Transcript | null;
  frames: Frame[];
  origin: string; // http://127.0.0.1:port
}

const SLOT = "https://slot.invalid/";

const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const cssStr = (s: string) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`;
const pad2 = (n: number) => String(n).padStart(2, "0");
const sid = (s: SectionAnalysis) => `S${pad2(s.index + 1)}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Deep link for a moment in the source video, or null when there's nothing to open. */
export function videoLinker(lecture: Lecture, origin: string): (sec: number) => string | null {
  const v = lecture.source.value;
  const yt = lecture.source.kind === "url" && v.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) return (s) => `https://www.youtube.com/watch?v=${yt[1]}&t=${Math.floor(s)}s`;
  const vimeo = lecture.source.kind === "url" && v.match(/vimeo\.com\/(\d+)/);
  if (vimeo) return (s) => `https://vimeo.com/${vimeo[1]}#t=${Math.floor(s)}s`;
  // local files: opens the app at that moment (works on this PC while Lecture Lens runs)
  return (s) => `${origin.replace("127.0.0.1", "localhost")}/lecture/${lecture.id}?t=${Math.floor(s)}`;
}

interface Geometry {
  w: number;
  h: number;
  margin: [number, number, number, number]; // top right bottom left (mm)
  blankMargin: number;
  fontPt: number;
  cue: number;
}

export function geometry(o: ExportOptions): Geometry {
  const a4 = o.paper === "A4";
  const w = a4 ? 210 : 182;
  const h = a4 ? 297 : 257;
  const margin: Geometry["margin"] =
    o.layout === "margin" ? (a4 ? [16, 62, 18, 16] : [14, 50, 16, 13]) : o.layout === "cornell" ? (a4 ? [16, 14, 18, 14] : [14, 12, 16, 12]) : a4 ? [14, 14, 16, 14] : [12, 12, 14, 12];
  const fontPt = (o.layout === "compact" ? 9.5 : 10) - (a4 ? 0 : 0.5);
  return { w, h, margin, blankMargin: a4 ? 14 : 12, fontPt, cue: a4 ? 50 : 42 };
}

/** Questions for a section's retrieval block: the analysis flashcards (stable across exports). */
function checkQuestions(s: SectionAnalysis) {
  return s.cards.slice(0, 5);
}

function pickFrames(frames: Frame[], start: number, end: number, max: number) {
  const inside = frames.filter((f) => f.time >= start && f.time < end);
  if (inside.length <= max) return inside;
  const step = inside.length / max;
  return Array.from({ length: max }, (_, k) => inside[Math.floor(k * step + step / 2)]);
}

/** Deterministic shuffle so a re-export keeps the same question order (and the student's notes stay valid). */
function seededShuffle<T>(items: T[], seed: string): T[] {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const rand = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Replace bolded key terms with numbered blanks (guided notes). Code and math are left alone. */
function applyBlanks(md: string, mode: ExportOptions["blanks"], next: () => number, found: { n: number; term: string }[]) {
  if (mode === "off") return md;
  let k = 0;
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(/\*\*([^*\n]{1,40}?)\*\*/g, (whole, term: string) => {
        const t = term.trim();
        if (!t || /[$\\[\]]/.test(t) || (mode === "some" && k++ % 2 === 1)) return whole;
        const n = next();
        found.push({ n, term: t });
        return `@@BLANK${n}@@`;
      });
    })
    .join("");
}

function blankHtml(html: string, found: { n: number; term: string }[]) {
  const len = new Map(found.map((f) => [f.n, f.term.length]));
  return html.replace(/@@BLANK(\d+)@@/g, (_, n) => {
    const w = Math.min(12, Math.max(3.5, (len.get(Number(n)) ?? 4) * 0.95));
    return `<span class="blank" style="min-width:${w.toFixed(1)}em"><sup>${n}</sup></span>`;
  });
}

/** Parse the mind-map outline ("# root" + nested "-" bullets) into a tree. */
interface TreeNode {
  label: string;
  children: TreeNode[];
}
function parseOutline(md: string, fallback: string): TreeNode {
  const root: TreeNode = { label: fallback, children: [] };
  const stack: { indent: number; node: TreeNode }[] = [{ indent: -1, node: root }];
  for (const raw of md.split(/\r?\n/)) {
    const h = raw.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      const level = h[1].length;
      if (level === 1) {
        root.label = h[2].trim();
        continue;
      }
      const node = { label: h[2].trim(), children: [] };
      while (stack.length > 1 && stack.at(-1)!.indent >= (level - 2) * 2) stack.pop();
      stack.at(-1)!.node.children.push(node);
      stack.push({ indent: (level - 2) * 2, node });
      continue;
    }
    const b = raw.match(/^(\s*)[-*+]\s+(.*)/);
    if (!b) continue;
    const indent = b[1].replace(/\t/g, "  ").length + 100; // bullets nest below heading branches
    const node = { label: b[2].trim(), children: [] };
    while (stack.length > 1 && stack.at(-1)!.indent >= indent) stack.pop();
    stack.at(-1)!.node.children.push(node);
    stack.push({ indent, node });
  }
  return root;
}

export async function buildDocument(input: DocInput): Promise<{ html: string; labels: Record<string, string> }> {
  const { lecture, analysis, options: o, origin } = input;
  const ov = analysis.overview;
  const g = geometry(o);
  const linkFor = videoLinker(lecture, origin);
  const md = createRenderer(linkFor);
  const typing = o.fields;
  const labels: Record<string, string> = {};
  const namedPages: string[] = [];
  const isOnline = lecture.source.kind === "url";

  // ---- small builders ---------------------------------------------------------
  const ts = (sec: number, end?: number) => {
    const label = `▶${fmtTime(sec)}${end !== undefined ? `–${fmtTime(end)}` : ""}`;
    const href = linkFor(sec);
    return href ? `<a class="ts" href="${esc(href)}">${label}</a>` : `<span class="ts">${label}</span>`;
  };
  const pg = (target: string) => `<span class="pg" data-pg="${target}">000</span>`;
  const pgLink = (target: string) => `<a class="pl" href="#${target}">${pg(target)}</a>`;
  const pref = (target: string, text: string) => `<a class="pref" href="#${target}">${text} p.${pg(target)}</a>`;
  const slot = (name: string, label: string, heightMm: number, extraClass = "") => {
    labels[name] = label;
    return typing
      ? `<a class="slot ${extraClass}" href="${SLOT}${name}"${heightMm ? ` style="height:${heightMm}mm"` : ""}></a>`
      : `<div class="slot ${extraClass}"${heightMm ? ` style="height:${heightMm}mm"` : ""}></div>`;
  };
  const cb = (name: string, label: string) => {
    labels[`cb.${name}`] = label;
    return typing ? `<a class="cb" href="${SLOT}cb.${name}"></a>` : `<span class="cb"></span>`;
  };
  const lines = (n: number) => `<div class="lines">${"<div></div>".repeat(n)}</div>`;
  const marker = (kind: string) => `<a class="marker" href="${SLOT}mk.${kind}"></a>`;
  const namedPage = (name: string, header: string) => {
    namedPages.push(
      `@page ${name} { @top-right { content: ${cssStr(clip(header, 46))}; font: 7.5pt "Pretendard"; color: #8a8a94; vertical-align: bottom; padding-bottom: 3mm } }`,
    );
    return name;
  };
  const write = (name: string, label: string, n: number, heightMm: number) => (typing ? slot(name, label, heightMm) : lines(n));

  // ---- content sets ---------------------------------------------------------------
  const sections = analysis.sections;
  const chapters = ov.chapters.map((c, ci) => ({
    ...c,
    ci,
    list: sections.filter((s) => s.start >= c.start - 1 && s.start < c.end - 1),
  }));
  const orphan = sections.filter((s) => !chapters.some((c) => c.list.includes(s)));
  if (orphan.length) chapters.push({ title: "기타", start: orphan[0].start, end: orphan.at(-1)!.end, summary: "", sections: [], ci: chapters.length, list: orphan });

  const quizzes = o.quiz ? input.quizzes.filter((q) => q.questions.length) : [];
  const materials = input.materials.filter((m) => m.status === "done" && o.materials.includes(m.id));
  const blanks: { section: SectionAnalysis; items: { n: number; term: string }[] }[] = [];
  let blankCounter = 0;
  const hasChecks = o.checks && sections.some((s) => checkQuestions(s).length);
  const bodyHasContent = o.notes || o.checks || o.summaryBox;

  // QR codes per chapter (printed copies of online lectures)
  const qr = new Map<number, string>();
  if (o.qr && isOnline) {
    for (const c of chapters) {
      const href = linkFor(c.start);
      if (href) qr.set(c.ci, await QRCode.toString(href, { type: "svg", margin: 0, errorCorrectionLevel: "M" }));
    }
  }

  const parts: string[] = [];
  const toc: string[] = [];
  const tocRow = (id: string, title: string, level: number, time?: number) =>
    toc.push(
      `<a class="row l${level}" href="#${id}"><span class="t">${esc(title)}</span><span class="leader"></span>${time !== undefined ? `<span class="tm">${fmtTime(time)}</span>` : ""}${pg(id)}</a>`,
    );

  // ---- cover ----------------------------------------------------------------------
  if (o.cover) {
    const meta = [
      ["강의 길이", fmtDuration(lecture.durationSec)],
      ["난이도", `${"●".repeat(ov.difficulty)}${"○".repeat(5 - ov.difficulty)}`],
      ["구성", `${chapters.length}개 챕터 · ${sections.length}개 섹션`],
      ["출처", isOnline ? clip(lecture.source.value, 60) : clip(lecture.source.value.split(/[\\/]/).pop() ?? "", 60)],
      ["분석", analysis.model],
      ["만든 날", new Date().toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" })],
    ];
    parts.push(`<section class="cover" style="page:cover">${marker("cover")}
      <div class="cv-bar"></div>
      <div class="cv-kicker">LECTURE LENS · 학습서${o.blanks !== "off" ? " · 빈칸 노트" : o.preset === "review" ? " · 시험 직전 요약판" : o.preset === "workbook" ? " · 문제집" : ""}</div>
      <div class="cv-title">${esc(ov.title)}</div>
      <div class="cv-sub">${esc(ov.oneLiner)}</div>
      <div class="cv-tags">${ov.tags.map((t) => `<span>${esc(t)}</span>`).join("")}</div>
      <table class="cv-meta">${meta.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join("")}</table>
      <div class="cv-me">
        <div><span>이름</span>${slot("cover.name", "표지 · 이름", 9, "inline")}</div>
        <div><span>시험일</span>${slot("cover.exam", "표지 · 시험일", 9, "inline")}</div>
        <div><span>목표</span>${slot("cover.goal", "표지 · 목표", 9, "inline")}</div>
      </div>
    </section>`);
  }

  // ---- guide: how to use + review plan + read-through log ---------------------------
  if (o.guide) {
    const id = "part-guide";
    tocRow(id, "사용법 · 복습 계획 · 회독 기록", 1);
    const steps = [
      ["전체 지도", "‘한눈에 보기’로 강의의 흐름과 학습 목표를 먼저 봅니다."],
      ["읽고 바로 떠올리기", "섹션을 읽은 뒤 ‘이해 확인’을 답을 보지 않고 풉니다. 정답은 부록에 있고 → p.N 으로 이어집니다."],
      ["덮고 요약", "‘덮고 3문장으로 요약’ 칸에 자기 말로 씁니다. 다시 읽기보다 떠올리기가 오래 남습니다."],
      ["백지 복습", "챕터가 끝나면 백지 복습 쪽에 기억나는 것을 모두 적고, 노트와 비교해 빠진 것을 다른 색으로 채웁니다."],
      ["문제와 오답", "종합 문제는 섹션이 섞여 있습니다. 풀기 전에 확신도를 체크하고, 틀린 문제는 오답 노트로 보냅니다."],
      ["간격 두고 회독", "아래 복습 일정대로 다시 보고, 회독할 때마다 섹션의 □를 채우고 기록표에 날짜를 적습니다."],
    ];
    const legend = [
      [`<span class="cb"></span>`, "회독·확인 체크"],
      [`<span class="ts">▶12:34</span>`, isOnline ? "누르면 영상의 그 장면이 열립니다" : "강의 영상 위치 (이 PC에서 Lecture Lens가 켜져 있을 때 열림)"],
      [`<span class="pref">→ p.N</span>`, "정답·해설이 있는 쪽 (← p.N 은 돌아가기)"],
      [`<span class="pen">✎</span>`, "직접 쓰는 칸"],
      [`<b>확실 · 애매 · 모름</b>`, "답을 보기 전에 표시하는 확신도"],
    ];
    const plan = ["D+1", "D+3", "D+7", "D+14", "D+30"];
    const rows = sections
      .map(
        (s) =>
          `<tr><td class="c-id">${sid(s)}</td><td class="c-t">${esc(clip(s.title, 34))}</td><td class="c-p">${bodyHasContent ? pgLink(`sec-${s.index}`) : ""}</td>${[1, 2, 3, 4, 5]
            .map((r) => `<td class="c-r">${typing ? cb(`log.${sid(s)}.r${r}`, `회독 기록 · ${sid(s)} ${r}회독`) : ""}</td>`)
            .join("")}<td class="c-u">①②③④⑤</td></tr>`,
      )
      .join("");
    parts.push(`<section class="part" id="${id}" style="page:${namedPage("p-guide", "사용법 · 복습 계획")}">
      <div class="kicker">START HERE</div><h1>이 학습서로 공부하는 법</h1>
      <ol class="steps">${steps.map(([t, d]) => `<li><b>${t}</b><span>${d}</span></li>`).join("")}</ol>
      <table class="legend">${legend.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>
      ${typing ? `<p class="note">✎ 점선 칸은 Edge·Acrobat·PDF Expert 등에서 바로 입력할 수 있습니다(굿노트·노타빌리티는 손으로 쓰세요). 다 쓴 PDF를 앱의 <b>메모 → PDF 메모 가져오기</b>로 불러오면 메모로 저장됩니다.</p>` : ""}
      <h2 class="minor">복습 일정</h2>
      <div class="plan"><div class="plan-start"><span>시작일</span>${slot("plan.start", "복습 일정 · 시작일", 8, "inline")}</div>
        ${plan.map((p, i) => `<div class="plan-cell"><b>${p}</b>${slot(`plan.d${i}`, `복습 일정 · ${p} 날짜`, 8, "inline")}${cb(`plan.d${i}`, `복습 일정 · ${p} 완료`)}</div>`).join("")}</div>
      <h2 class="minor">회독 기록표</h2>
      <table class="log"><thead><tr><th>ID</th><th>섹션</th><th>쪽</th><th>1회</th><th>2회</th><th>3회</th><th>4회</th><th>5회</th><th>이해도</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="hint">칸에는 날짜를 적고, 이해도는 동그라미 치세요. 같은 섹션이 계속 ①②라면 그 섹션의 ‘막히기 쉬운 곳’과 정답 해설을 먼저 보세요.</p>
    </section>`);
  }

  // ---- overview -------------------------------------------------------------------
  if (o.overview) {
    const id = "part-overview";
    tocRow(id, "한눈에 보기", 1);
    parts.push(`<section class="part" id="${id}" style="page:${namedPage("p-overview", "한눈에 보기")}">
      <div class="kicker">OVERVIEW</div><h1>한눈에 보기</h1>
      <div class="md lead">${md(ov.summary)}</div>
      ${ov.objectives.length ? `<h2 class="minor">학습 목표 <small>공부를 마친 다음 날, 답을 보지 않고 스스로 점검하세요</small></h2>
      <ul class="objectives">${ov.objectives.map((x, i) => `<li>${cb(`goal.${i}`, `학습 목표 ${i + 1} 달성`)}<span>${esc(x)}</span></li>`).join("")}</ul>` : ""}
      ${ov.prerequisites.length ? `<h2 class="minor">미리 알면 좋은 것</h2><ul class="prereq">${ov.prerequisites.map((p) => `<li><b>${esc(p.topic)}</b> — ${esc(p.why)}</li>`).join("")}</ul>` : ""}
      <h2 class="minor">강의 흐름</h2>
      <table class="flow"><thead><tr><th>시각</th><th>챕터</th><th>요약</th><th>쪽</th></tr></thead><tbody>
      ${chapters.map((c) => `<tr><td>${ts(c.start)}</td><td><b>${esc(c.title)}</b></td><td>${esc(c.summary)}</td><td class="c-p">${bodyHasContent ? pgLink(`ch-${c.ci}`) : ""}</td></tr>`).join("")}
      </tbody></table>
    </section>`);
  }

  // ---- body: chapters & sections ------------------------------------------------------
  if (bodyHasContent) {
    let first = true;
    for (const c of chapters) {
      const cid = `ch-${c.ci}`;
      tocRow(cid, `${c.ci + 1}. ${c.title}`, 1, c.start);
      const secHtml: string[] = [];
      for (const s of c.list) {
        const id = `sec-${s.index}`;
        tocRow(id, `${sid(s)} ${s.title}`, 2, s.start);
        const qs = o.checks ? checkQuestions(s) : [];
        const found: { n: number; term: string }[] = [];

        let notes = "";
        if (o.notes) {
          if (o.depth === "full") {
            notes = blankHtml(md(applyBlanks(s.notes, o.blanks, () => ++blankCounter, found)), found);
            if (found.length) blanks.push({ section: s, items: found });
          } else {
            notes = `<p class="sum">${esc(s.summary)}</p>${
              s.concepts.length ? `<dl class="concepts">${s.concepts.map((x) => `<dt>${esc(x.term)}</dt><dd>${md(x.definition)}</dd>`).join("")}</dl>` : ""
            }`;
          }
        }
        const keyPoints =
          o.notes && s.keyPoints.length
            ? `<div class="callout key"><div class="cl">★ 핵심 정리</div><ul>${s.keyPoints.map((k) => `<li>${md(k.point).replace(/^<p>|<\/p>$/g, "")} ${ts(k.time)}</li>`).join("")}</ul></div>`
            : "";
        const hard =
          o.notes && o.depth === "full"
            ? s.difficult
                .map(
                  (d) =>
                    `<div class="callout hard"><div class="cl">⚠ 막히기 쉬운 곳 · ${esc(d.topic)} ${ts(d.time)}</div><p class="why">${esc(d.why)}</p><p class="self">✎ 해설을 읽기 전에 먼저 스스로 설명해 보세요.</p><div class="md">${md(d.explanation)}</div></div>`,
                )
                .join("")
            : "";
        const frames =
          o.notes && o.frames && input.frames.length
            ? (() => {
                const fs = pickFrames(input.frames, s.start, s.end, o.layout === "compact" ? 2 : 2);
                return fs.length
                  ? `<div class="frames">${fs.map((f) => `<figure><img src="${origin}/api/lectures/${lecture.id}/frames/${f.file}" alt=""><figcaption>화면 ${ts(f.time)}</figcaption></figure>`).join("")}</div>`
                  : "";
              })()
            : "";
        const checks = qs.length
          ? `<div class="checks"><div class="cl">이해 확인 <small>답을 보지 말고 떠올려 쓰세요</small></div><ol>${qs
              .map(
                (q, k) =>
                  `<li id="q-${s.index}-${k}"><div class="q">${md(q.front).replace(/^<p>|<\/p>$/g, "")} ${pref(`a-${s.index}-${k}`, "→ 정답")}</div>${o.layout === "cornell" ? "" : write(`${sid(s)}.q${k + 1}`, `${sid(s)} 이해 확인 ${k + 1}: ${q.front}`, 2, 14)}</li>`,
              )
              .join("")}</ol></div>`
          : "";
        const summary = o.summaryBox
          ? `<div class="sumbox"><div class="cl">✎ 덮고 3문장으로 요약하기</div>${slot(`${sid(s)}.summary`, `${sid(s)} 요약 · ${s.title}`, o.layout === "compact" ? 22 : 30)}</div>`
          : "";
        const head = `<header class="sec-head"><span class="sid">${sid(s)}</span><h3 id="${id}-h">${esc(s.title)}</h3><span class="sec-meta">${ts(s.start, s.end)}<span class="rd">회독 ${[1, 2, 3, 4, 5]
          .map((r) => cb(`${sid(s)}.r${r}`, `${sid(s)} ${r}회독`))
          .join("")}</span></span></header>`;
        const main = `${notes}${keyPoints}${hard}${frames}`;
        const bodyBlock =
          o.layout === "cornell"
            ? `<div class="cornell"><aside class="cue"><div class="cue-label">단서 질문</div>${
                qs.length ? checks : `<p class="cue-empty">읽으면서 떠오르는 질문을 여기에 적으세요.</p>`
              }</aside><div class="cn-body">${main || "&nbsp;"}</div></div>`
            : `${main}${checks}`;
        secHtml.push(`<article class="sec" id="${id}">${head}${bodyBlock}${summary}</article>`);
      }
      const opener = `<div class="ch-head"><div class="ch-num">CHAPTER ${c.ci + 1}</div><h2 id="${cid}-h">${esc(c.title)}</h2>
        <div class="ch-meta">${ts(c.start, c.end)} · 섹션 ${c.list.length}개</div>
        ${c.summary ? `<p class="ch-sum">${esc(c.summary)}</p>` : ""}
        ${qr.has(c.ci) ? `<div class="qr">${qr.get(c.ci)}<span>영상에서 이 챕터 보기</span></div>` : ""}</div>`;
      const partHead = first ? `<div class="kicker">NOTES</div><h1 class="body-h1">본문</h1>` : "";
      first = false;
      parts.push(`<section class="chapter" id="${cid}" style="page:${namedPage(`ch${c.ci}`, `${c.ci + 1}. ${c.title}`)}">${partHead}${opener}${secHtml.join("")}</section>`);

      if (o.recall) {
        const rid = `blank-recall-${c.ci}`;
        tocRow(rid, `백지 복습 — ${c.title}`, 2);
        parts.push(`<section class="blankpage" id="${rid}" style="page:blank">${marker("blank")}<div class="bp-head">
          <div class="bp-kicker">백지 복습 · CHAPTER ${c.ci + 1}</div>
          <div class="bp-title">${esc(c.title)}</div>
          <div class="bp-help">아무것도 보지 말고 이 챕터에서 기억나는 모든 것(개념, 공식, 예시, 연결 관계)을 적으세요. 다 쓴 뒤 노트와 비교해 빠진 내용은 다른 색으로 채웁니다.</div>
          <div class="bp-cues"><b>떠올릴 주제</b> ${c.list.map((s) => `${sid(s)} ${esc(clip(s.title, 26))}`).join(" · ")}</div>
          <div class="bp-dates">1차 ____/____ &nbsp; 2차 ____/____ &nbsp; 3차 ____/____ &nbsp; 빠뜨린 것 ___개</div>
        </div>${typing ? slot(`ch${c.ci + 1}.recall`, `챕터 ${c.ci + 1} 백지 복습 · ${c.title}`, 0, "fill") : ""}</section>`);
      }
    }
  }

  // ---- mixed quiz ---------------------------------------------------------------------
  const quizRows: { q: QuizQuestion; quiz: Quiz; n: number }[] = [];
  if (quizzes.length) {
    const id = "part-quiz";
    tocRow(id, "종합 문제", 1);
    const blocks = quizzes.map((quiz) => {
      const qs = seededShuffle(quiz.questions, quiz.id);
      const items = qs
        .map((q) => {
          const n = quizRows.length + 1;
          quizRows.push({ q, quiz, n });
          const opts =
            q.type === "mcq"
              ? `<ol class="opts">${q.options.map((op, k) => `<li><span class="on">${"①②③④⑤⑥⑦⑧"[k] ?? k + 1}</span><span>${md(op).replace(/^<p>|<\/p>$/g, "")}</span></li>`).join("")}</ol>`
              : "";
          return `<div class="qz" id="qq-${q.id}"><div class="qz-head"><span class="qn">Q${n}</span><span class="tag">${q.type === "mcq" ? "객관식" : "서술형"} · ${{ easy: "쉬움", medium: "보통", hard: "어려움" }[q.difficulty]}</span></div>
            <div class="qz-q">${md(q.question)}</div>${opts}
            <div class="qz-ans"><span class="lbl">답</span>${q.type === "mcq" ? slot(`quiz.${q.id}`, `종합 문제 Q${n} 답`, 8, "inline") : write(`quiz.${q.id}`, `종합 문제 Q${n} 답: ${q.question}`, 3, 22)}</div>
            <div class="qz-meta"><span>확신도 ${cb(`quiz.${q.id}.sure`, `Q${n} 확실`)}확실 ${cb(`quiz.${q.id}.maybe`, `Q${n} 애매`)}애매 ${cb(`quiz.${q.id}.no`, `Q${n} 모름`)}모름</span>
            <span>채점 ${cb(`quiz.${q.id}.o`, `Q${n} 맞음`)}O ${cb(`quiz.${q.id}.t`, `Q${n} 부분`)}△ ${cb(`quiz.${q.id}.x`, `Q${n} 틀림`)}X</span>${pref(`qa-${q.id}`, "→ 해설")}</div></div>`;
        })
        .join("");
      return `<h2 class="sub">${esc(quiz.title)} <small>${quiz.questions.length}문제 · 섹션이 섞여 있어요</small></h2>${items}`;
    });
    const wrong = Array.from({ length: 8 }, (_, i) => `<tr><td>${typing ? slot(`wrong.${i}.id`, `오답 노트 ${i + 1} · 문항`, 7, "inline") : ""}</td><td class="why4">${["개념", "계산", "문제 오독", "기억"].map((w, k) => `${cb(`wrong.${i}.w${k}`, `오답 노트 ${i + 1} · ${w}`)}${w}`).join(" ")}</td><td>${typing ? slot(`wrong.${i}.fix`, `오답 노트 ${i + 1} · 다음엔`, 7, "inline") : ""}</td><td class="dd">${cb(`wrong.${i}.d2`, "D+2")}${cb(`wrong.${i}.d7`, "D+7")}${cb(`wrong.${i}.d14`, "D+14")}</td></tr>`).join("");
    parts.push(`<section class="part" id="${id}" style="page:${namedPage("p-quiz", "종합 문제")}">
      <div class="kicker">PRACTICE</div><h1>종합 문제</h1>
      <p class="hint">풀기 전에 확신도를 먼저 체크하세요. ‘확실’했는데 틀린 문제가 가장 위험한 착각입니다 — 오답 노트 1순위로 보내세요.</p>
      ${blocks.join("")}
      <h2 class="sub" id="wrong-note">오답 노트</h2>
      <table class="wrong"><thead><tr><th>문항</th><th>틀린 이유</th><th>다음엔 ___부터 확인</th><th>다시 풀기</th></tr></thead><tbody>${wrong}</tbody></table>
    </section>`);
  }

  // ---- glossary ------------------------------------------------------------------------
  if (o.glossary && ov.glossary.length) {
    const id = "part-glossary";
    tocRow(id, "용어집", 1);
    parts.push(`<section class="part" id="${id}" style="page:${namedPage("p-glossary", "용어집")}">
      <div class="kicker">GLOSSARY</div><h1>용어집</h1>
      <table class="gloss"><thead><tr><th>용어</th><th>정의</th><th>처음 나온 곳</th></tr></thead><tbody>
      ${ov.glossary.map((t) => `<tr><td class="term">${esc(t.term)}</td><td>${md(t.definition).replace(/^<p>|<\/p>$/g, "")}</td><td>${ts(t.time)}</td></tr>`).join("")}
      </tbody></table></section>`);
  }

  // ---- concept map -----------------------------------------------------------------------
  if (o.conceptMap && ov.mindmap?.trim()) {
    const id = "part-map";
    tocRow(id, "개념 구조", 1);
    const tree = parseOutline(ov.mindmap, ov.title);
    const renderTree = (n: TreeNode): string =>
      `<li><span>${esc(n.label)}</span>${n.children.length ? `<ul>${n.children.map(renderTree).join("")}</ul>` : ""}</li>`;
    parts.push(`<section class="part" id="${id}" style="page:${namedPage("p-map", "개념 구조")}">
      <div class="kicker">CONCEPT MAP</div><h1>개념 구조</h1>
      <div class="tree-root">${esc(tree.label)}</div>
      <ul class="tree">${tree.children.map(renderTree).join("")}</ul></section>
      <section class="blankpage" id="blank-map" style="page:blank">${marker("blank")}<div class="bp-head">
        <div class="bp-kicker">직접 그려 보는 개념 지도</div><div class="bp-title">${esc(tree.label)}</div>
        <div class="bp-help">앞 쪽을 덮고, 가운데 주제에서 시작해 개념들과 그 관계(화살표 위에 ‘왜/어떻게’)를 기억만으로 그려 보세요. 다 그린 뒤 앞 쪽과 비교합니다.</div>
      </div>${typing ? slot("map.draw", "개념 지도 그리기", 0, "fill") : ""}</section>`);
  }

  // ---- materials ---------------------------------------------------------------------------
  if (materials.length) {
    const id = "part-materials";
    tocRow(id, "학습 자료", 1);
    parts.push(`<section class="part" id="${id}" style="page:${namedPage("p-mat", "학습 자료")}"><div class="kicker">MATERIALS</div><h1>학습 자료</h1>
      ${materials.map((m, i) => `<div class="material${i ? " brk" : ""}" id="mat-${m.id}"><h2 class="sub">${esc(m.title)}</h2><div class="md">${md(m.content, 2)}</div></div>`).join("")}</section>`);
    materials.forEach((m) => tocRow(`mat-${m.id}`, m.title, 2));
  }

  // ---- flashcard fold sheet ---------------------------------------------------------------
  if (o.cards && input.cards.length) {
    const id = "part-cards";
    tocRow(id, `플래시카드 시트 (${input.cards.length}장)`, 1);
    parts.push(`<section class="part" id="${id}" style="page:${namedPage("p-cards", "플래시카드")}"><div class="kicker">FLASHCARDS</div><h1>플래시카드 시트</h1>
      <p class="hint">가운데 점선을 따라 접어 답을 가리고, 질문만 보며 떠올려 보세요. 맞히면 □에 표시 — 세 번 연속 맞힐 때까지 반복합니다.</p>
      <table class="cards"><colgroup><col class="c1"><col class="c2"><col class="c3"><col class="c4"></colgroup><tbody>
      ${input.cards
        .map(
          (c, i) =>
            `<tr><td class="cid">C${pad2(i + 1)}<div>${cb(`card.${c.id}.1`, `카드 C${pad2(i + 1)} 1`)}${cb(`card.${c.id}.2`, `카드 C${pad2(i + 1)} 2`)}${cb(`card.${c.id}.3`, `카드 C${pad2(i + 1)} 3`)}</div></td><td class="front">${md(c.front)}</td><td class="fold"></td><td class="back">${md(c.back)}${c.time !== null ? ts(c.time) : ""}</td></tr>`,
        )
        .join("")}</tbody></table></section>`);
  }

  // ---- my memo -------------------------------------------------------------------------------
  if (o.memo && input.memo.trim()) {
    const id = "part-memo";
    tocRow(id, "내 메모", 1);
    parts.push(`<section class="part" id="${id}" style="page:${namedPage("p-memo", "내 메모")}"><div class="kicker">MY NOTES</div><h1>내 메모</h1><div class="md">${md(input.memo, 1)}</div></section>`);
  }

  // ---- answer key ------------------------------------------------------------------------------
  const checkSections = hasChecks && (o.notes || o.checks) ? sections.filter((s) => checkQuestions(s).length) : [];
  if (checkSections.length || blanks.length || quizRows.length) {
    const id = "part-answers";
    tocRow(id, "정답과 해설", 1);
    const checkHtml = checkSections.length
      ? `<h2 class="sub" id="ans-checks">이해 확인 정답</h2>${checkSections
          .map(
            (s) =>
              `<div class="ans-sec"><div class="ans-sec-t">${sid(s)} ${esc(s.title)}</div>${checkQuestions(s)
                .map(
                  (q, k) =>
                    `<div class="ans" id="a-${s.index}-${k}"><span class="an">${k + 1}</span><div class="ab">${md(q.back)}<div class="am">${ts(q.time)} ${pref(`q-${s.index}-${k}`, "← 문제")}</div></div></div>`,
                )
                .join("")}</div>`,
          )
          .join("")}`
      : "";
    const blankKey = blanks.length
      ? `<h2 class="sub" id="ans-blanks">빈칸 정답</h2>${blanks
          .map(
            (b) =>
              `<div class="ans-sec"><div class="ans-sec-t">${sid(b.section)} ${esc(b.section.title)} <a class="pref" href="#sec-${b.section.index}">← p.${pg(`sec-${b.section.index}`)}</a></div><div class="blank-key">${b.items
                .map((x) => `<span><sup>${x.n}</sup>${esc(x.term)}</span>`)
                .join("")}</div></div>`,
          )
          .join("")}`
      : "";
    const quizKey = quizRows.length
      ? `<h2 class="sub" id="ans-quiz">종합 문제 해설</h2>${quizRows
          .map(({ q, n }) => {
            const answer = q.type === "mcq" ? `정답 ${"①②③④⑤⑥⑦⑧"[q.answerIndex] ?? q.answerIndex + 1} ${md(q.answer).replace(/^<p>|<\/p>$/g, "")}` : `<div class="model">모범 답안</div>${md(q.answer)}`;
            return `<div class="ans" id="qa-${q.id}"><span class="an">Q${n}</span><div class="ab"><div class="ak">${answer}</div><div class="md">${md(q.explanation)}</div><div class="am">${q.time !== null ? ts(q.time) : ""} ${pref(`qq-${q.id}`, "← 문제")}</div></div></div>`;
          })
          .join("")}`
      : "";
    parts.push(`<section class="part" id="${id}" style="page:${namedPage("p-ans", "정답과 해설")}"><div class="kicker">ANSWER KEY</div><h1>정답과 해설</h1>
      <p class="hint">먼저 스스로 답을 쓴 다음에만 보세요. 틀린 항목은 ▶ 영상 위치에서 다시 듣고, 문제로 돌아가 다른 색으로 고쳐 씁니다.</p>
      ${checkHtml}${blankKey}${quizKey}</section>`);
  }

  // ---- transcript -----------------------------------------------------------------------------
  if (o.transcript && input.transcript?.segments.length) {
    const id = "part-transcript";
    tocRow(id, "강의 대본", 1);
    parts.push(`<section class="part transcript" id="${id}" style="page:${namedPage("p-tr", "강의 대본")}"><div class="kicker">TRANSCRIPT</div><h1>강의 대본</h1>
      ${input.transcript.segments.map((s) => `<p>${ts(s.start)} ${esc(s.text)}</p>`).join("")}</section>`);
  }

  // ---- blank note pages ------------------------------------------------------------------------
  for (let i = 0; i < o.blankPages; i++) {
    const id = `blank-note-${i}`;
    if (i === 0) tocRow(id, `빈 노트 (${o.blankPages}쪽)`, 1);
    parts.push(`<section class="blankpage note" id="${id}" style="page:blank">${marker("blank")}<div class="bp-head short"><div class="bp-kicker">NOTE ${i + 1}</div></div>${typing ? slot(`note.${i + 1}`, `빈 노트 ${i + 1}`, 0, "fill") : ""}</section>`);
  }

  // ---- table of contents (needs every row collected above) --------------------------------------
  const tocHtml = o.toc
    ? `<section class="part toc" id="part-toc" style="page:${namedPage("p-toc", "목차")}"><div class="kicker">CONTENTS</div><h1>목차</h1><nav>${toc.join("")}</nav></section>`
    : "";
  const coverHtml = o.cover ? parts.shift()! : "";

  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(ov.title)} — 학습서</title>
<link rel="stylesheet" href="${origin}/print-assets/katex/katex.min.css">
<style>${css(o, g, ov.title || lecture.title, namedPages)}</style></head>
<body class="layout-${o.layout} paper-${o.paper}${typing ? " typing" : ""}">
${coverHtml}${tocHtml}${parts.join("\n")}
<script type="application/json" id="lecture-lens-labels">${JSON.stringify(labels).replace(/</g, "\\u003c")}</script>
</body></html>`;
  return { html, labels };
}

function css(o: ExportOptions, g: Geometry, title: string, namedPages: string[]) {
  const [t, r, b, l] = g.margin;
  const blankH = g.h - g.blankMargin * 2 - 8;
  const coverH = g.h - 1;
  const font = (w: number, file: string) => `@font-face{font-family:"Pretendard";font-weight:${w};font-style:normal;src:url(/print-assets/fonts/${file}) format("woff2")}`;
  return `
${font(400, "Pretendard-Regular.woff2")}${font(600, "Pretendard-SemiBold.woff2")}${font(700, "Pretendard-Bold.woff2")}
@page { size: ${g.w}mm ${g.h}mm; margin: ${t}mm ${r}mm ${b}mm ${l}mm;
  @top-left { content: ${cssStr(clip(title, 48))}; font: 7.5pt "Pretendard"; color: #8a8a94; vertical-align: bottom; padding-bottom: 3mm }
  @bottom-left { content: "Lecture Lens 학습서"; font: 7pt "Pretendard"; color: #a4a4ae; vertical-align: top; padding-top: 4mm }
  @bottom-right { content: counter(page) " / " counter(pages); font: 7.5pt "Pretendard"; color: #6a6a74; vertical-align: top; padding-top: 4mm }
}
@page cover { margin: 0; @top-left { content: none } @top-right { content: none } @bottom-left { content: none } @bottom-right { content: none } }
@page blank { margin: ${g.blankMargin}mm; @top-left { content: none } @top-right { content: none } @bottom-left { content: none }
  @bottom-right { content: counter(page) " / " counter(pages); font: 7.5pt "Pretendard"; color: #8a8a94 } }
${namedPages.join("\n")}

:root { --accent: #4646b8; --hard: #a8501c; --rule: #c9c9d3; --muted: #6a6a74; }
html { font-family: "Pretendard", "Malgun Gothic", sans-serif; font-size: ${g.fontPt}pt; line-height: 1.68; color: #1c1c20;
  word-break: keep-all; overflow-wrap: break-word; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; }
p { margin: 0 0 2.2mm; orphans: 2; widows: 2; }
a { color: inherit; text-decoration: none; }
b, strong { font-weight: 700; }
small { font-weight: 400; color: var(--muted); font-size: .78em; margin-left: 1.5mm; }
h1, h2, h3, h4, h5, h6 { break-after: avoid; line-height: 1.35; margin: 0; }
img { max-width: 100%; }

.marker { display: block; width: 1px; height: 1px; overflow: hidden; }
.ts { color: var(--accent); font-weight: 600; font-size: .84em; white-space: nowrap; font-variant-numeric: tabular-nums; }
.pref { color: var(--accent); font-size: .82em; white-space: nowrap; font-weight: 600; }
.pg { display: inline-block; min-width: 2.2em; text-align: right; font-variant-numeric: tabular-nums; }
.pref .pg, .pl .pg { min-width: 1.8em; text-align: left; }
.pl { color: var(--muted); }
.pen { font-weight: 700; color: var(--accent); }
.cb { display: inline-block; width: 3.1mm; height: 3.1mm; border: .7pt solid #6f6f78; border-radius: .6mm; vertical-align: -.5mm; margin: 0 .8mm; box-sizing: border-box; }
.slot { display: block; border: .7pt dashed #a3a3b2; border-radius: 1.6mm; margin: 1.2mm 0 2.6mm; break-inside: avoid; box-sizing: border-box; }
.slot.inline { display: inline-block; vertical-align: middle; width: 34mm; height: 7mm; margin: 0 1.5mm; border-style: none none dashed none; border-radius: 0; }
.slot.fill { position: absolute; left: 0; right: 0; bottom: 6mm; top: 50mm; margin: 0; border: none; }
.lines > div { height: 7mm; border-bottom: .5pt dotted #9c9ca8; }
.kicker { font-size: 7.5pt; letter-spacing: .18em; font-weight: 700; color: var(--accent); margin-bottom: 1.5mm; }
.hint, .note { font-size: .88em; color: var(--muted); }
.note { border: .6pt solid var(--rule); border-radius: 1.6mm; padding: 2mm 3mm; margin: 3mm 0; }

/* parts */
.part, .chapter { break-before: page; }
.part h1, .chapter h1 { font-size: 21pt; font-weight: 700; letter-spacing: -.02em; margin-bottom: 5mm; }
h2.minor { font-size: 11.5pt; font-weight: 700; margin: 6mm 0 2.5mm; }
h2.sub { font-size: 13pt; font-weight: 700; margin: 7mm 0 3mm; padding-bottom: 1.5mm; border-bottom: .6pt solid var(--rule); }

/* cover */
.cover { position: relative; height: ${coverH}mm; padding: 34mm 26mm 22mm 30mm; box-sizing: border-box; overflow: hidden; display: flex; flex-direction: column; }
.cv-bar { position: absolute; left: 0; top: 0; bottom: 0; width: 9mm; background: var(--accent); }
.cv-kicker { font-size: 8pt; letter-spacing: .2em; font-weight: 700; color: var(--accent); }
.cv-title { font-size: 27pt; font-weight: 700; letter-spacing: -.025em; line-height: 1.25; margin: 6mm 0 4mm; }
.cv-sub { font-size: 12pt; color: #44444c; line-height: 1.6; }
.cv-tags { margin-top: 5mm; display: flex; flex-wrap: wrap; gap: 1.5mm; }
.cv-tags span { border: .6pt solid var(--rule); border-radius: 10mm; padding: .4mm 2.4mm; font-size: 8pt; color: var(--muted); }
.cv-meta { margin-top: 12mm; border-collapse: collapse; font-size: 9pt; }
.cv-meta th { text-align: left; color: var(--muted); font-weight: 600; padding: 1.4mm 6mm 1.4mm 0; white-space: nowrap; vertical-align: top; }
.cv-meta td { padding: 1.4mm 0; word-break: break-all; }
.cv-me { margin-top: auto; display: grid; gap: 3mm; font-size: 9.5pt; }
.cv-me > div { display: flex; align-items: flex-end; }
.cv-me span { width: 16mm; color: var(--muted); font-weight: 600; }
.cv-me .slot.inline { width: 90mm; }

/* toc */
.toc nav { margin-top: 2mm; }
.toc .row { display: flex; align-items: baseline; gap: 2mm; padding: 1mm 0; break-inside: avoid; }
.toc .row.l1 { font-weight: 700; margin-top: 2.6mm; font-size: 1.02em; }
.toc .row.l2 { padding-left: 7mm; font-size: .92em; color: #33333a; }
.toc .t { flex: 0 1 auto; }
.toc .leader { flex: 1 1 4mm; border-bottom: .6pt dotted #b2b2bc; transform: translateY(-1mm); min-width: 4mm; }
.toc .tm { color: var(--accent); font-size: .82em; font-variant-numeric: tabular-nums; }

/* guide */
.steps { counter-reset: st; list-style: none; padding: 0; margin: 0 0 4mm; display: grid; gap: 2.2mm; }
.steps li { counter-increment: st; display: grid; grid-template-columns: 7mm 30mm 1fr; align-items: baseline; }
.steps li::before { content: counter(st); font-weight: 700; color: var(--accent); }
.steps span { color: #34343b; }
.legend { border-collapse: collapse; font-size: .9em; margin: 2mm 0; }
.legend td { padding: 1mm 4mm 1mm 0; }
.plan { display: flex; flex-wrap: wrap; gap: 2.5mm 5mm; align-items: flex-end; font-size: .92em; }
.plan-start, .plan-cell { display: flex; align-items: flex-end; }
.plan .slot.inline { width: 17mm; }
.plan-start .slot.inline { width: 26mm; }
table.log { width: 100%; border-collapse: collapse; font-size: 8.4pt; margin-top: 1mm; }
table.log th, table.log td { border: .5pt solid var(--rule); padding: 1mm 1.4mm; height: 6.2mm; }
table.log th { background: #f2f2f6; font-weight: 600; }
table.log .c-id { font-weight: 700; color: var(--accent); white-space: nowrap; }
table.log .c-r { width: 9mm; text-align: center; }
table.log .c-p { width: 8mm; text-align: right; color: var(--muted); }
table.log .c-u { width: 20mm; color: #9a9aa4; letter-spacing: .05em; white-space: nowrap; }
table.log tr { break-inside: avoid; }

/* overview */
.lead { font-size: 1.04em; }
.objectives { list-style: none; padding: 0; margin: 0; display: grid; gap: 1.6mm; }
.objectives li { display: flex; gap: 1.5mm; align-items: baseline; }
.prereq { margin: 0; padding-left: 5mm; }
table.flow, table.gloss, table.wrong { width: 100%; border-collapse: collapse; font-size: .9em; }
table.flow th, table.flow td, table.gloss th, table.gloss td, table.wrong th, table.wrong td { border-bottom: .5pt solid var(--rule); padding: 1.6mm 1.8mm; vertical-align: top; text-align: left; }
table.flow th, table.gloss th, table.wrong th { font-weight: 600; color: var(--muted); border-bottom: .8pt solid #9d9daa; }
table.flow td:first-child { white-space: nowrap; }
.c-p { text-align: right; color: var(--muted); white-space: nowrap; }
thead { display: table-header-group; }
tr { break-inside: avoid; }

/* chapters & sections */
.body-h1 { font-size: 21pt; font-weight: 700; margin-bottom: 4mm; }
.ch-head { margin-bottom: 6mm; padding-bottom: 4mm; border-bottom: 1.2pt solid #1c1c20; position: relative; }
.ch-num { font-size: 8pt; letter-spacing: .2em; font-weight: 700; color: var(--accent); }
.ch-head h2 { font-size: 18pt; font-weight: 700; letter-spacing: -.02em; margin: 1.5mm 0 1.5mm; }
.ch-meta { font-size: .86em; color: var(--muted); }
.ch-sum { margin: 2.5mm 0 0; color: #3a3a42; }
.qr { position: absolute; right: 0; top: 0; width: 20mm; text-align: center; font-size: 6.5pt; color: var(--muted); }
.qr svg { width: 20mm; height: 20mm; display: block; }
.ch-head:has(.qr) { padding-right: 24mm; }
.sec { margin: 0 0 8mm; }
.sec-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 1mm 2.5mm; margin: 0 0 3mm; padding-top: 2mm; border-top: .6pt solid var(--rule); break-after: avoid; }
.sid { font-size: .8em; font-weight: 700; color: #fff; background: var(--accent); border-radius: .9mm; padding: .2mm 1.4mm; }
.sec-head h3 { font-size: 12.5pt; font-weight: 700; letter-spacing: -.01em; flex: 1 1 auto; }
.sec-meta { display: flex; gap: 3mm; align-items: center; white-space: nowrap; }
.rd { font-size: .78em; color: var(--muted); }
.rd .cb { width: 2.8mm; height: 2.8mm; margin: 0 .35mm; }
.sec h4 { font-size: 11pt; font-weight: 700; margin: 4mm 0 1.5mm; }
.sec h5 { font-size: 10.6pt; font-weight: 700; margin: 4mm 0 1.4mm; }
.sec h6 { font-size: 10pt; font-weight: 700; color: #3a3a42; margin: 3mm 0 1mm; }
.sum { color: #2c2c33; }
dl.concepts { display: grid; grid-template-columns: max-content 1fr; gap: 1mm 4mm; margin: 2mm 0; font-size: .95em; }
dl.concepts dt { font-weight: 700; }
dl.concepts dd { margin: 0; }
dl.concepts dd p { margin: 0; }

/* markdown content */
ul, ol { margin: 1mm 0 2.4mm; padding-left: 5.5mm; }
li { margin: .6mm 0; }
li > p { margin: 0; }
blockquote { margin: 2mm 0; padding: 1mm 0 1mm 3.5mm; border-left: 1.6pt solid var(--rule); color: #3a3a42; }
table { border-collapse: collapse; }
.md table, .sec table { width: 100%; font-size: .9em; margin: 2.5mm 0; }
.md th, .md td, .sec th, .sec td { border: .5pt solid var(--rule); padding: 1.2mm 1.8mm; vertical-align: top; text-align: left; }
.md th, .sec th { background: #f2f2f6; font-weight: 600; }
code { font-family: Consolas, "Malgun Gothic", monospace; font-size: .87em; background: #f1f1f5; border-radius: .8mm; padding: 0 .7mm; }
pre { font-family: Consolas, "Malgun Gothic", monospace; font-size: 8.3pt; line-height: 1.5; border: .5pt solid #d2d2da; border-radius: 1.6mm; padding: 2mm 2.6mm; white-space: pre-wrap; word-break: break-all; margin: 2.2mm 0; }
pre code { background: none; padding: 0; font-size: inherit; }
.hljs-keyword, .hljs-built_in, .hljs-selector-tag { color: #5b3db0; font-weight: 600; }
.hljs-string, .hljs-attr { color: #2f7a4f; }
.hljs-number, .hljs-literal { color: #9a5a12; }
.hljs-comment { color: #8a8a94; font-style: italic; }
.hljs-title, .hljs-function { color: #2c5aa8; }
.katex { font-size: 1.04em; }
.katex-display { margin: 2.2mm 0; break-inside: avoid; }
hr { border: 0; border-top: .6pt solid var(--rule); margin: 4mm 0; }

/* callouts: told apart by label and border shape, not colour alone (grayscale printing) */
.callout { border: .6pt solid var(--rule); border-left: 2.4pt solid var(--accent); border-radius: 1.4mm; padding: 2.4mm 3.2mm 1mm; margin: 3.2mm 0; break-inside: avoid; }
.callout .cl { font-size: .8em; font-weight: 700; color: var(--accent); margin-bottom: 1.2mm; letter-spacing: .01em; }
.callout ul { margin: 0 0 1.2mm; }
.callout.hard { border-left-style: double; border-left-width: 3.2pt; border-left-color: var(--hard); break-inside: auto; }
.callout.hard .cl { color: var(--hard); }
.callout .why { color: #3a3a42; font-size: .93em; margin-bottom: 1mm; }
.callout .self { font-size: .82em; color: var(--muted); margin-bottom: 1.6mm; }
.frames { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm; margin: 3mm 0; break-inside: avoid; }
.frames figure { margin: 0; }
.frames img { width: 100%; border: .5pt solid var(--rule); border-radius: 1mm; display: block; }
.frames figcaption { font-size: .75em; color: var(--muted); margin-top: .8mm; }
.checks { margin: 3.5mm 0 1mm; }
.checks > .cl, .sumbox > .cl { font-size: .86em; font-weight: 700; margin-bottom: 1mm; }
.checks ol { padding-left: 5mm; margin: 0; }
.checks li { margin: 0 0 1.8mm; break-inside: avoid; }
.checks .q { font-weight: 600; }
.sumbox { margin-top: 3mm; break-inside: avoid; }
.blank { display: inline-block; border-bottom: .8pt solid #2c2c33; margin: 0 .6mm; height: 1.15em; vertical-align: -.2em; position: relative; }
.blank sup { position: absolute; left: .2em; top: -.85em; font-size: .62em; color: var(--accent); font-weight: 700; }

/* cornell */
.cornell { display: grid; grid-template-columns: ${g.cue}mm 1fr; column-gap: 5mm; }
.cue { border-right: .7pt solid var(--rule); padding-right: 3.2mm; font-size: .86em; }
.cue-label { font-size: .82em; font-weight: 700; letter-spacing: .08em; color: var(--accent); margin-bottom: 1.5mm; }
.cue .checks { margin-top: 0; }
.cue .checks > .cl { display: none; }
.cue-empty { color: var(--muted); font-size: .9em; }
.cn-body { min-width: 0; }

/* blank / recall pages */
.blankpage { position: relative; height: ${blankH}mm; break-before: page; break-after: page; overflow: hidden; }
.bp-head { height: 46mm; overflow: hidden; }
.bp-head.short { height: 8mm; }
.bp-kicker { font-size: 7.5pt; letter-spacing: .18em; font-weight: 700; color: var(--accent); }
.bp-title { font-size: 15pt; font-weight: 700; margin: 1.2mm 0 1.8mm; }
.bp-help { font-size: .86em; color: #3a3a42; }
.bp-cues { font-size: .8em; color: var(--muted); margin-top: 1.8mm; }
.bp-dates { font-size: .84em; color: var(--muted); margin-top: 2mm; }
.blankpage .slot.fill { top: 50mm; }
.blankpage.note .slot.fill { top: 10mm; }

/* quiz */
.qz { margin: 0 0 5mm; padding-bottom: 3.5mm; border-bottom: .5pt solid #e1e1e8; break-inside: avoid; }
.qz-head { display: flex; gap: 2mm; align-items: baseline; margin-bottom: 1mm; }
.qn { font-weight: 700; color: var(--accent); }
.tag { font-size: .76em; color: var(--muted); }
.qz-q p { margin-bottom: 1mm; }
ol.opts { list-style: none; padding: 0; margin: 1mm 0 2mm; display: grid; gap: .8mm; }
ol.opts li { display: flex; gap: 1.8mm; margin: 0; }
ol.opts .on { color: var(--muted); font-weight: 600; }
.qz-ans { display: flex; align-items: flex-end; gap: 1mm; }
.qz-ans .lbl { font-size: .84em; font-weight: 700; color: var(--muted); padding-bottom: 1mm; }
.qz-ans .lines, .qz-ans .slot:not(.inline) { flex: 1; }
.qz-meta { display: flex; flex-wrap: wrap; gap: 1mm 5mm; font-size: .8em; color: var(--muted); margin-top: 1.8mm; align-items: center; }
table.wrong td { height: 9mm; }
table.wrong .why4 { font-size: .82em; white-space: nowrap; }
table.wrong .dd { white-space: nowrap; }
table.wrong .slot.inline { width: 100%; margin: 0; }

/* glossary & map */
table.gloss .term { font-weight: 700; white-space: nowrap; width: 1%; }
table.gloss td:last-child { white-space: nowrap; }
.tree-root { display: inline-block; font-weight: 700; font-size: 12pt; border: 1pt solid #1c1c20; border-radius: 1.6mm; padding: 1.4mm 3.5mm; margin-bottom: 3mm; }
ul.tree, ul.tree ul { list-style: none; margin: 0; padding-left: 6mm; }
ul.tree li { position: relative; margin: 1.2mm 0; padding-left: 3mm; break-inside: avoid; }
ul.tree li::before { content: ""; position: absolute; left: -3mm; top: .85em; width: 4.5mm; border-top: .6pt solid #9d9daa; }
ul.tree ul { border-left: .6pt solid #c9c9d3; margin-left: 1mm; }
ul.tree > li > span { font-weight: 700; border: .7pt solid var(--accent); color: var(--accent); border-radius: 1.2mm; padding: .2mm 2mm; }

/* materials, cards, memo, answers */
.material.brk { break-before: page; }
table.cards { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: .9em; }
table.cards col.c1 { width: 13mm; } table.cards col.c3 { width: 5mm; }
table.cards td { border-bottom: .5pt solid var(--rule); padding: 2mm 2mm; vertical-align: top; }
table.cards td p { margin: 0 0 1mm; }
table.cards .cid { font-weight: 700; color: var(--accent); font-size: .85em; }
table.cards .cid div { margin-top: 1mm; white-space: nowrap; }
table.cards .cid .cb { width: 2.6mm; height: 2.6mm; margin: 0 .3mm 0 0; }
table.cards .front { font-weight: 600; }
table.cards .fold { border-left: .8pt dashed #9d9daa; padding: 0; }
.ans-sec { margin: 0 0 4mm; break-inside: auto; }
.ans-sec-t { font-weight: 700; font-size: .92em; margin: 3mm 0 1.5mm; color: #2c2c33; }
.ans { display: grid; grid-template-columns: 9mm 1fr; gap: 1.5mm; margin: 0 0 2.5mm; break-inside: avoid; }
.an { font-weight: 700; color: var(--accent); font-size: .9em; }
.ab p { margin-bottom: 1mm; }
.ak { font-weight: 700; margin-bottom: 1mm; }
.ak p { display: inline; }
.model { font-size: .82em; color: var(--muted); font-weight: 700; }
.am { font-size: .9em; margin-top: .6mm; display: flex; gap: 3mm; }
.blank-key { display: flex; flex-wrap: wrap; gap: 1.2mm 4.5mm; font-size: .95em; }
.blank-key sup { color: var(--accent); font-weight: 700; margin-right: .6mm; }
.transcript p { font-size: .86em; margin: 0 0 1.2mm; }

/* compact layout trims vertical rhythm */
.layout-compact .sec { margin-bottom: 5mm; }
.layout-compact .callout { margin: 2mm 0; }

@media screen {
  body { background: #e9e9ee; }
  .cover, .part, .chapter, .blankpage { background: #fff; max-width: ${g.w - l - r}mm; margin: 8mm auto; padding: 12mm; box-shadow: 0 1px 6px rgba(0,0,0,.12); }
  .cover { max-width: ${g.w}mm; padding: 34mm 26mm 22mm 30mm; }
}
`;
}
