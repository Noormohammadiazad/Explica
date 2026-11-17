import './ui/textLayer.css';
import './ui/styles.css';
import { ExplicaApp } from './app';
import { WelcomeSource } from './pdf/welcomeSource';
import { mountUI } from './ui/ui';

function supportsWebGL2(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

const canvas = document.getElementById('stage') as HTMLCanvasElement;
if (!supportsWebGL2()) {
  document.body.insertAdjacentHTML(
    'beforeend',
    '<div class="overlay"><div class="card"><h2>WebGL 2 is required</h2><p>Explica renders the book on your graphics card. Please use a current version of Chrome, Edge, Firefox or Safari.</p></div></div>',
  );
  document.documentElement.classList.remove('preload'); // nothing else will: show the message
} else {
  const app = new ExplicaApp(canvas);
  const ui = mountUI(app);
  if (import.meta.env.DEV) (window as unknown as { explicaOpen: typeof ui.openFile }).explicaOpen = ui.openFile;
  void app.load(new WelcomeSource());
  // handy for debugging from the console; holds no document data
  (window as unknown as { explica: ExplicaApp }).explica = app;
}
