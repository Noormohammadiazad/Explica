// The app's way into PdfSource: points pdf.js at the worker scripts Vite emits
// beside the bundle. It is loaded on demand, with pdf.js, when a PDF is opened.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import rendererUrl from 'pdfjs-dist/build/pdf.renderer.min.mjs?url';
import { configurePdfjs } from './pdfSource';

configurePdfjs({ workerSrc: workerUrl, rendererSrc: rendererUrl });

export { PdfSource } from './pdfSource';
