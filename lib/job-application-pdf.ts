import fs from "fs";
import path from "path";

const JOB_PDFS_DIR = path.join(process.cwd(), "data", "job-pdfs");

export function ensureJobPdfDir(): void {
  if (!fs.existsSync(JOB_PDFS_DIR)) {
    fs.mkdirSync(JOB_PDFS_DIR, { recursive: true });
  }
}

export function getJobApplicationPdfPath(id: string): string {
  ensureJobPdfDir();
  return path.join(JOB_PDFS_DIR, `${id}.pdf`);
}

export function deleteJobApplicationPdfIfExists(id: string): void {
  const filePath = getJobApplicationPdfPath(id);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveJobApplicationPdf(id: string, pdf: Buffer | Uint8Array | ArrayBuffer): void {
  const filePath = getJobApplicationPdfPath(id);
  const buffer =
    pdf instanceof ArrayBuffer
      ? Buffer.from(pdf)
      : Buffer.isBuffer(pdf)
      ? pdf
      : Buffer.from(pdf);
  fs.writeFileSync(filePath, buffer);
}

export function readJobApplicationPdf(id: string): Buffer | null {
  const filePath = getJobApplicationPdfPath(id);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}
