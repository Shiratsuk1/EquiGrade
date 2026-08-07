import mammoth from "mammoth";
import pdf from "pdf-parse";

export async function extractDocumentText(file: Express.Multer.File): Promise<string> {
  const extension = file.originalname.split(".").pop()?.toLowerCase();
  if (extension === "txt" || extension === "md" || file.mimetype.startsWith("text/")) {
    return file.buffer.toString("utf8").trim();
  }
  if (extension === "docx") {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value.trim();
  }
  if (extension === "pdf") {
    const result = await pdf(file.buffer);
    const text = result.text.trim();
    if (!text) throw new Error("PDF 中未提取到文字，可能是扫描件，请先转为可复制文本或 DOCX");
    return text;
  }
  throw new Error("暂不支持该文档格式，请上传 TXT、MD、DOCX 或文本型 PDF");
}

