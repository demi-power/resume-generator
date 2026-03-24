import crypto from "crypto";

const STOPWORDS = new Set([
  "a","an","and","are","as","at","be","by","for","from","in","is","it","of","on","or","that","the","to","with","you","your","our","we","will","this","these","those","their","them","they","about","into","who","what","when","where","why","how","over","under","using","used","use","can","should","must","have","has","had","within","across","per","plus","than","then","also","ability","strong","excellent","highly"
]);

export const KNOWN_TECH_TERMS = [
  "AWS","Azure","GCP","Terraform","Kubernetes","Docker","Python","TypeScript","JavaScript","Java","Go","React","Next.js","Node.js","FastAPI","Django","Flask","Spring","PostgreSQL","MySQL","MongoDB","Redis","Kafka","RabbitMQ","GraphQL","REST","SQL","NoSQL","Spark","Airflow","Databricks","Snowflake","BigQuery","LangChain","OpenAI","HuggingFace","Pandas","NumPy","PyTorch","TensorFlow","GitHub Actions","CircleCI","Jenkins","Linux","Bash","Tailwind","HTML","CSS","Playwright","Cypress","S3","EC2","Lambda","CloudFront","Kinesis","SQS","SNS","RDS","Elasticsearch","OpenSearch"
];

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, "\n").replace(/[\t\f\v ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function sanitizeRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("../")) {
    throw new Error("Invalid relative path");
  }
  return normalized;
}

export function canonicalizeJobUrl(rawUrl: string): { rawUrl: string; canonicalUrl: string } | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const stripParams = ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","gh_src","gh_jid","fbclid","gclid","ref","source"];
  for (const key of stripParams) {
    parsed.searchParams.delete(key);
  }
  parsed.hash = "";
  if (parsed.hostname === "job-boards.greenhouse.io") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 3 && parts[1] === "jobs") {
      parsed.pathname = `/${parts[0]}/jobs/${parts[2]}`;
      parsed.hostname = "boards.greenhouse.io";
    }
  }
  return { rawUrl: trimmed, canonicalUrl: parsed.toString() };
}

export function tokenizeText(value: string): string[] {
  return normalizeWhitespace(value)
    .toLowerCase()
    .split(/[^a-z0-9.+#-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

export function uniqueTokens(value: string): string[] {
  return Array.from(new Set(tokenizeText(value)));
}

export function sentenceSplit(value: string): string[] {
  return normalizeWhitespace(value)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export function extractLikelyTechnologies(value: string): string[] {
  const haystack = ` ${value.toLowerCase()} `;
  const matches = new Set<string>();
  for (const term of KNOWN_TECH_TERMS) {
    const lower = term.toLowerCase();
    if (haystack.includes(` ${lower} `) || haystack.includes(lower.replace(/\./g, ""))) {
      matches.add(term);
    }
  }
  return Array.from(matches);
}

export function parseCsvText(csvText: string): Record<string, string>[] {
  const rows: string[][] = [];
  let current = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < csvText.length; i += 1) {
    const char = csvText[i];
    const next = csvText[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && char === ',') {
      row.push(current);
      current = "";
      continue;
    }
    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(current);
      rows.push(row);
      row = [];
      current = "";
      continue;
    }
    current += char;
  }
  if (current.length > 0 || row.length > 0) {
    row.push(current);
    rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0].map((col) => col.trim());
  return rows.slice(1).filter((cols) => cols.some((col) => col.trim())).map((cols) => {
    const out: Record<string, string> = {};
    header.forEach((key, index) => {
      out[key] = (cols[index] ?? "").trim();
    });
    return out;
  });
}

export function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function pickTop<T>(items: T[], limit: number): T[] {
  return items.slice(0, Math.max(0, limit));
}
