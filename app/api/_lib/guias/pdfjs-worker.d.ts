// O pdfjs-dist não publica tipos do worker; só o WorkerMessageHandler é usado (texto-pdf.ts).
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown
}
