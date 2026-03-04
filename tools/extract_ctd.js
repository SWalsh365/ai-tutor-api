import fs from "fs";
import path from "path";
import mammoth from "mammoth";

// ---------- CONFIG ----------
const SCHOOL = "CCA";
const SUBJECT = "Maths";
const YEAR = "Yr9";

const ROOT = process.cwd();
const CTD_DIR = path.join(ROOT, SCHOOL, SUBJECT, YEAR, "SoL");
const OUT_DIR = path.join(ROOT, SCHOOL, SUBJECT, YEAR, "extracted");
const INDEX_PATH = path.join(ROOT, SCHOOL, SUBJECT, YEAR, "index.json");

// Match lines like: "Week 2/ Lesson 3" OR "Week 3/ Lesson 1 & 2"
const LESSON_HEADER_RE = /^Week\s*(\d+)\s*\/\s*Lesson\s*(\d+)(?:\s*&\s*(\d+))?\s*$/i;

// Section anchors (best-effort). Keep simple and inspectable.
const SECTION_LABELS = [
  { key: "key_knowledge_components", re: /^What are the key knowledge components/i },
  { key: "learning_outcomes", re: /^What are the learning outcomes/i },
  { key: "key_questions", re: /^Key Questions/i },
  { key: "key_vocab", re: /^Key vocabulary/i },
  { key: "recall_activity", re: /^Recall activity/i },
  { key: "suggested_teaching", re: /^Suggested teaching activities/i },
  { key: "addressing_gaps", re: /^Addressing gaps/i },
  { key: "deepening_knowledge", re: /^Deepening knowledge/i },
];

// ---------- HELPERS ----------
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readIndexOrInit() {
  if (!fs.existsSync(INDEX_PATH)) {
    return { school: SCHOOL, subject: SUBJECT, year_group: YEAR, half_terms: {} };
  }
  return JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function normaliseLines(text) {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function detectHalfTermFromFilename(filename) {
  const m = filename.match(/HT\s*([1-6])/i);
  return m ? `HT${m[1]}` : null;
}
function findLineIndex(lines, predicate) {
  for (let i = 0; i < lines.length; i++) if (predicate(lines[i])) return i;
  return -1;
}

// Extract HT-level prior learning + misconceptions that appear BEFORE the first Week/Lesson block.
function extractHalfTermDiagnostics(allLines) {
  const firstLessonIdx = findLineIndex(allLines, (l) => LESSON_HEADER_RE.test(l));
  const preLessonLines = firstLessonIdx === -1 ? allLines : allLines.slice(0, firstLessonIdx);

  const startIdx = findLineIndex(
    preLessonLines,
    (l) => /^Prior learning\s*&\s*common misconceptions/i.test(l)
  );

  if (startIdx === -1) {
    return {
      prior_learning: [],
      common_misconceptions: [],
      warnings: ["No HT-level 'Prior learning & common misconceptions' section found."],
    };
  }

  // End at the next big section (commonly "Assessment") or end of preLessonLines
  const endIdx = findLineIndex(
    preLessonLines.slice(startIdx + 1),
    (l) => /^Assessment\b/i.test(l)
  );
  const sliceEnd = endIdx === -1 ? preLessonLines.length : startIdx + 1 + endIdx;

  const block = preLessonLines.slice(startIdx + 1, sliceEnd);

  // Split using the subheadings that appear in your CTD
  const priorIdx = findLineIndex(block, (l) => /^What learning has come before/i.test(l));
  const miscIdx = findLineIndex(block, (l) => /^What are the common misconceptions/i.test(l));

  let prior = [];
  let misc = [];

  if (priorIdx !== -1) {
    const priorEnd = miscIdx !== -1 ? miscIdx : block.length;
    prior = block.slice(priorIdx + 1, priorEnd).filter((l) => l.length > 0);
  }

  if (miscIdx !== -1) {
    misc = block.slice(miscIdx + 1).filter((l) => l.length > 0);
  }

  return {
    prior_learning: prior,
    common_misconceptions: misc,
    warnings: [],
  };
}

// Deterministic summary (no AI): first N lines, then trim by chars.
function summariseLines(lines, maxLines = 6, maxChars = 450) {
  const snippet = lines.slice(0, maxLines).join(" ").trim();
  return snippet.length > maxChars ? snippet.slice(0, maxChars - 1) + "…" : snippet;
}

function splitIntoLessons(lines) {
  const lessonBlocks = [];
  let current = null;

  for (const line of lines) {
    const m = line.match(LESSON_HEADER_RE);
    if (m) {
      if (current) lessonBlocks.push(current);

      const week = Number(m[1]);
      const lessonA = Number(m[2]);
      const lessonB = m[3] ? Number(m[3]) : null;

      current = {
        header: line,
        week,
        lessons: lessonB ? [lessonA, lessonB] : [lessonA],
        body: [],
      };
    } else if (current) {
      current.body.push(line);
    }
  }

  if (current) lessonBlocks.push(current);
  return lessonBlocks;
}

function extractSections(bodyLines) {
  const sections = {};
  let currentKey = "preamble";
  sections[currentKey] = [];

  for (const line of bodyLines) {
    const label = SECTION_LABELS.find((s) => s.re.test(line));
    if (label) {
      currentKey = label.key;
      if (!sections[currentKey]) sections[currentKey] = [];
      continue;
    }
    if (!sections[currentKey]) sections[currentKey] = [];
    sections[currentKey].push(line);
  }

  return sections;
}

function toLessonChunk({ ht, week, lesson, header, sections, sourceDoc }) {
  const learningOutcomes = sections.learning_outcomes ?? [];
  const kkc = sections.key_knowledge_components ?? [];
  const keyQuestions = sections.key_questions ?? [];
  const keyVocab = sections.key_vocab ?? [];

  const suggestedTeachingLines = sections.suggested_teaching ?? [];
  const addressingGapsLines = sections.addressing_gaps ?? [];
  const deepeningLines = sections.deepening_knowledge ?? [];

  return {
    id: `${ht}-W${week}-L${lesson}`,
    half_term: ht,
    week,
    lesson,
    title: "",
    intent: {
      learning_outcomes: learningOutcomes,
      key_knowledge_components: kkc,
    },
    diagnostic: {
      prereqs: [],
      common_misconceptions: [],
    },
    language: {
      key_vocab: keyVocab,
    },
    teaching: {
      key_questions: keyQuestions,
      worked_examples: [],
      suggested_activities_summary: summariseLines(suggestedTeachingLines),
    },
    assessment: {
      afl_notes_summary: summariseLines(sections.recall_activity ?? []),
      assessment_links: [],
    },
    bounds: {
      next_lesson_id: "",
      do_not_teach_beyond: true,
    },
    source: {
      doc: sourceDoc,
      anchor: header,
    },
    notes: {
      addressing_gaps_summary: summariseLines(addressingGapsLines),
      deepening_knowledge_summary: summariseLines(deepeningLines),
    },
  };
}

function computeNextIds(chunks) {
  const sorted = [...chunks].sort((a, b) => (a.week - b.week) || (a.lesson - b.lesson));
  for (let i = 0; i < sorted.length; i++) {
    sorted[i].bounds.next_lesson_id = sorted[i + 1]?.id ?? "";
  }
  return sorted;
}

async function extractOneDocx(filePath) {
  const filename = path.basename(filePath);
  const ht = detectHalfTermFromFilename(filename);

  if (!ht) {
    return {
      ok: false,
      filename,
      error: "Could not detect half term from filename (expected HT1..HT6 somewhere in the filename).",
    };
  }

  const result = await mammoth.extractRawText({ path: filePath });
  const lines = normaliseLines(result.value);
  const htDiag = extractHalfTermDiagnostics(lines);


  const lessonBlocks = splitIntoLessons(lines);

  const report = {
    source: filename,
    half_term: ht,
    lessons_detected: 0,
    combined_lessons: [],
    warnings: [],
  };
  if (htDiag.warnings.length) report.warnings.push(...htDiag.warnings);


  if (lessonBlocks.length === 0) {
    report.warnings.push("No 'Week X/ Lesson Y' headers detected.");
    return { ok: false, filename, report };
  }

  const chunks = [];

  for (const block of lessonBlocks) {
    const sections = extractSections(block.body);

    if (block.lessons.length > 1) {
      report.combined_lessons.push(`W${block.week}L${block.lessons.join("&")}`);
    }

    for (const lessonNo of block.lessons) {
      chunks.push(
        toLessonChunk({
          ht,
          week: block.week,
          lesson: lessonNo,
          header: block.header,
          sections,
          sourceDoc: filename,
        })
      );
    }
  }

  const finalChunks = computeNextIds(chunks);
  report.lessons_detected = finalChunks.length;

  // Basic sanity checks (warnings only)
  for (const c of finalChunks) {
    if (!c.intent.learning_outcomes.length) report.warnings.push(`${c.id}: missing learning outcomes (not detected).`);
    if (!c.language.key_vocab.length) report.warnings.push(`${c.id}: missing key vocab (not detected).`);
  }

  return { ok: true, filename, ht, chunks: finalChunks, report, htDiag };
}

async function main() {
  ensureDir(OUT_DIR);

  if (!fs.existsSync(CTD_DIR)) {
    console.error(`❌ CTD directory not found: ${CTD_DIR}`);
    process.exit(1);
  }

  const files = fs
  .readdirSync(CTD_DIR)
  .filter((f) => f.toLowerCase().endsWith(".docx"))
  .filter((f) => !f.startsWith("~$"));

  if (files.length === 0) {
    console.error(`❌ No .docx files found in: ${CTD_DIR}`);
    process.exit(1);
  }

  const index = readIndexOrInit();

  for (const f of files) {
    const filePath = path.join(CTD_DIR, f);
    const out = await extractOneDocx(filePath);

    if (!out.ok) {
      console.error(`❌ Failed: ${f}`);
      if (out.error) console.error(out.error);
      if (out.report) console.error(JSON.stringify(out.report, null, 2));
      continue;
    }

    const htOutPath = path.join(OUT_DIR, `${out.ht}.json`);
    const reportOutPath = path.join(OUT_DIR, `${out.ht}_parse_report.json`);

    writeJson(htOutPath, {
  meta: {
    half_term: out.ht,
    prior_learning: out.htDiag?.prior_learning ?? [],
    common_misconceptions: out.htDiag?.common_misconceptions ?? [],
  },
  lessons: out.chunks,
});

    writeJson(reportOutPath, out.report);

    // Update index.json
    if (!index.half_terms[out.ht]) index.half_terms[out.ht] = {};
    for (const chunk of out.chunks) {
      const wKey = `W${chunk.week}`;
      const lKey = `L${chunk.lesson}`;
      if (!index.half_terms[out.ht][wKey]) index.half_terms[out.ht][wKey] = {};
      index.half_terms[out.ht][wKey][lKey] = {
        lesson_id: chunk.id,
        file: `extracted/${out.ht}.json`,
      };
    }

    console.log(`✅ Extracted ${out.ht}: ${out.chunks.length} lesson chunks`);
    if (out.report.warnings.length) {
      console.log(`⚠️  ${out.ht} warnings: ${out.report.warnings.length}`);
    }
  }

  writeJson(INDEX_PATH, index);
  console.log(`✅ Updated index: ${INDEX_PATH}`);
}

main().catch((e) => {
  console.error("❌ Unhandled error:", e);
  process.exit(1);
});
