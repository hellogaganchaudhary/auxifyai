/** Ambient module declarations for dependencies without bundled types. */

declare module 'pdf-parse/lib/pdf-parse.js' {
  /** Parse a PDF buffer and return its extracted text. */
  function pdfParse(data: Buffer): Promise<{ text: string; numpages: number }>;
  export default pdfParse;
}
