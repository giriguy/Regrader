import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pdfToPng } from 'pdf-to-png-converter';
import sharp from 'sharp';
import { fetchBinary } from './gradescopeHttp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PDFS_DIR = path.resolve(__dirname, '../../data/gs-pdfs');
const CROPS_DIR = path.resolve(__dirname, '../../data/gs-crops');

const VIEWPORT_SCALE = 2.0;

export type CropRect = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  page_number: number;
};

export async function downloadGradedPdf(
  pdfUrl: string,
  assignmentId: string,
): Promise<string> {
  await fs.mkdir(PDFS_DIR, { recursive: true });
  const filePath = path.join(PDFS_DIR, `${assignmentId}.pdf`);
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > 0) return filePath;
  } catch {
    // not cached
  }
  const buf = await fetchBinary(pdfUrl);
  await fs.writeFile(filePath, buf);
  return filePath;
}

const renderedPages = new Map<string, Map<number, Buffer>>();

async function renderPage(
  pdfPath: string,
  pageNumber: number,
): Promise<Buffer> {
  let perPdf = renderedPages.get(pdfPath);
  if (!perPdf) {
    perPdf = new Map();
    renderedPages.set(pdfPath, perPdf);
  }
  const cached = perPdf.get(pageNumber);
  if (cached) return cached;

  const pages = await pdfToPng(pdfPath, {
    viewportScale: VIEWPORT_SCALE,
    disableFontFace: true,
    pagesToProcess: [pageNumber],
  });
  const content = pages[0]?.content;
  if (!content) {
    throw new Error(`pdf-to-png-converter returned no content for page ${pageNumber}`);
  }
  perPdf.set(pageNumber, content);
  return content;
}

export async function renderQuestionCrop(
  pdfPath: string,
  assignmentId: string,
  questionId: string,
  rects: CropRect[],
): Promise<string> {
  if (rects.length === 0) {
    throw new Error('renderQuestionCrop: no rects provided');
  }
  await fs.mkdir(CROPS_DIR, { recursive: true });
  const outPath = path.join(CROPS_DIR, `${assignmentId}-${questionId}.png`);

  // For Phase 2 v1 we render only the FIRST rect. Multi-rect questions
  // (rare — questions that span pages) get the first region; we'll
  // upgrade to vertical-stitching if it becomes a real problem.
  const rect = rects[0];
  const pageBuffer = await renderPage(pdfPath, rect.page_number);

  // crop_rect_list is in percentage coordinates of the page (0–100).
  // Convert to pixel offsets at the rendered viewport scale.
  const meta = await sharp(pageBuffer).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const left = Math.max(0, Math.floor((rect.x1 / 100) * W));
  const top = Math.max(0, Math.floor((rect.y1 / 100) * H));
  const right = Math.min(W, Math.ceil((rect.x2 / 100) * W));
  const bottom = Math.min(H, Math.ceil((rect.y2 / 100) * H));
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);

  await sharp(pageBuffer)
    .extract({ left, top, width, height })
    .png({ compressionLevel: 9 })
    .toFile(outPath);

  return outPath;
}

export function clearRenderCache(): void {
  renderedPages.clear();
}
