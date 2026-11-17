import type { ExplicaApp, SpreadInfo } from '../app';
import { DEFAULT_PAPER, paperForGrammage } from '../physics/params';
import { folioLabel, turnForScreenSide, type ReadingDirection } from '../book/readingDirection';
import { ThemeController } from './theme';
import { mountAnnotateUI } from './annotateUI';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const DIRECTION_KEY = 'explica.direction';

const PRESETS: Record<string, { gsm: number; stiff: number; spine: number; air: number }> = {
  bible: { gsm: 36, stiff: 0, spine: 0.6, air: 1 },
  book: { gsm: 80, stiff: 0, spine: 1, air: 1 },
  magazine: { gsm: 115, stiff: 0.25, spine: 0.8, air: 0.9 },
  card: { gsm: 250, stiff: 0.2, spine: 2, air: 0.8 },
};

/** Binds the HTML chrome (toolbar, pager, settings, dialogs, drag & drop) to the app. */
export function mountUI(app: ExplicaApp): { openFile(file: File): Promise<void> } {
  const fileInput = $<HTMLInputElement>('fileInput');
  const settings = $<HTMLElement>('settings');
  const settingsBtn = $<HTMLButtonElement>('settingsBtn');
  const help = $<HTMLElement>('help');
  const scrub = $<HTMLInputElement>('scrub');
  const folio = $<HTMLElement>('folio');
  const docName = $<HTMLElement>('docName');
  const toastEl = $<HTMLElement>('toast');
  const loading = $<HTMLElement>('loading');
  const loadingText = $<HTMLElement>('loadingText');
  const loadingBar = $<HTMLElement>('loadingBar');

  let toastTimer = 0;
  const toast = (msg: string, ms = 4200) => {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toastEl.hidden = true), ms);
  };

  // ------------------------------------------------------------ theme
  const theme = new ThemeController();
  const themeSwitch = $<HTMLButtonElement>('themeSwitch');
  const syncTheme = () => themeSwitch.setAttribute('aria-checked', String(theme.theme === 'dark'));
  app.setTheme(theme.theme, false);
  syncTheme();
  theme.onChange = (t) => {
    app.setTheme(t, true);
    syncTheme();
  };
  themeSwitch.addEventListener('click', () => theme.toggle());

  // ------------------------------------------------------------ reading direction
  // The switch sets the reader's preference; a PDF that declares its direction
  // is opened that way without changing the preference.
  const dirSwitch = $<HTMLButtonElement>('dirSwitch');
  const pageLeftBtn = $<HTMLButtonElement>('pageLeftBtn');
  const pageRightBtn = $<HTMLButtonElement>('pageRightBtn');
  let preferred: ReadingDirection = 'ltr';
  try {
    preferred = localStorage.getItem(DIRECTION_KEY) === 'rtl' ? 'rtl' : 'ltr';
  } catch {
    preferred = 'ltr';
  }
  const describePager = (d: ReadingDirection) => {
    // the arrows keep pointing at their side of the screen; what they mean mirrors
    const name = (side: 'left' | 'right') => (turnForScreenSide(side, d) > 0 ? 'Next page' : 'Previous page');
    pageLeftBtn.setAttribute('aria-label', name('left'));
    pageLeftBtn.title = `${name('left')} (←)`;
    pageRightBtn.setAttribute('aria-label', name('right'));
    pageRightBtn.title = `${name('right')} (→)`;
  };
  const setDirection = (d: ReadingDirection) => {
    app.setDirection(d);
    dirSwitch.setAttribute('aria-checked', String(d === 'rtl'));
    scrub.dir = d;
    folio.dir = d;
    describePager(d);
    setFill(scrub);
  };
  dirSwitch.addEventListener('click', () => {
    preferred = app.direction === 'rtl' ? 'ltr' : 'rtl';
    try {
      localStorage.setItem(DIRECTION_KEY, preferred);
    } catch {
      /* storage unavailable: the choice lasts for this visit */
    }
    setDirection(preferred);
  });
  pageLeftBtn.addEventListener('click', () => app.turn(turnForScreenSide('left', app.direction)));
  pageRightBtn.addEventListener('click', () => app.turn(turnForScreenSide('right', app.direction)));

  // ------------------------------------------------------------ pager
  let pageCount = 1;
  let scrubbing = false;
  const setFill = (el: HTMLInputElement) => {
    const max = Number(el.max) - Number(el.min) || 1;
    el.style.setProperty('--fill', `${((Number(el.value) - Number(el.min)) / max) * 100}%`);
  };
  app.onSpread = (s: SpreadInfo) => {
    pageCount = s.pageCount;
    scrub.max = String(Math.max(0, s.pageCount - 1));
    if (!scrubbing) {
      scrub.value = String(s.recto ?? s.verso ?? 0);
      folio.textContent = folioLabel(s, pageCount);
    }
    setFill(scrub);
    docName.textContent = s.name;
    document.title = `${s.name} — Explica`;
  };
  scrub.addEventListener('input', () => {
    scrubbing = true;
    const p = Number(scrub.value);
    folio.textContent = `${p + 1}  /  ${pageCount}`;
    setFill(scrub);
  });
  scrub.addEventListener('change', () => {
    scrubbing = false;
    app.jumpTo(Number(scrub.value));
    scrub.blur();
  });

  // ------------------------------------------------------------ settings
  const gsm = $<HTMLInputElement>('gsm');
  const stiff = $<HTMLInputElement>('stiff');
  const spine = $<HTMLInputElement>('spine');
  const air = $<HTMLInputElement>('air');
  const gravity = $<HTMLInputElement>('gravity');
  const applyPaper = () => {
    const g = Number(gsm.value);
    const s = 4 ** Number(stiff.value);
    const sp = Number(spine.value);
    const a = Number(air.value);
    const p = paperForGrammage(g, s);
    p.spineStiffness = DEFAULT_PAPER.spineStiffness * sp * (g / 80);
    app.setPaper(p, a);
    $('gsmOut').textContent = `${g} g/m²`;
    $('stiffOut').textContent = `${s < 1 ? s.toFixed(2) : s.toFixed(1)}×`;
    $('spineOut').textContent = `${sp.toFixed(1)}×`;
    $('airOut').textContent = `${a.toFixed(1)}×`;
    const lg = Math.cbrt(p.flexuralRigidity / (p.arealDensity * 9.81));
    $('derived').textContent =
      `Flexural rigidity D = ${p.flexuralRigidity.toExponential(2)} N·m · ` +
      `elasto-gravity length ${(lg * 100).toFixed(1)} cm` +
      (lg < 0.12 ? ' — pages droop and curl' : ' — pages stay stiff');
    for (const el of [gsm, stiff, spine, air]) setFill(el);
  };
  for (const el of [gsm, stiff, spine, air]) el.addEventListener('input', applyPaper);
  gravity.addEventListener('change', () => (app.gravityFollowsBook = gravity.checked));
  settings.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) =>
    b.addEventListener('click', () => {
      const pr = PRESETS[b.dataset.preset!];
      gsm.value = String(pr.gsm);
      stiff.value = String(pr.stiff);
      spine.value = String(pr.spine);
      air.value = String(pr.air);
      applyPaper();
    }),
  );
  applyPaper();
  const toggleSettings = (open: boolean = !!settings.hidden) => {
    settings.hidden = !open;
    settingsBtn.setAttribute('aria-expanded', String(open));
  };
  settingsBtn.addEventListener('click', () => toggleSettings());
  window.setInterval(() => {
    if (settings.hidden) return;
    const s = app.stats;
    $('stats').textContent =
      `Pages in flight ${s.flying} · physics ${s.stepMs.toFixed(2)} ms/frame · ` +
      `Gauss–Newton ${s.iterations.toFixed(1)} it/step · textures ${s.textureMB.toFixed(0)} MB`;
  }, 400);

  // ------------------------------------------------------------ help
  const showHelp = (show: boolean) => {
    help.hidden = !show;
    if (show) $('helpClose').focus();
  };
  $('helpBtn').addEventListener('click', () => showHelp(!!help.hidden));
  $('helpClose').addEventListener('click', () => {
    showHelp(false);
    try {
      localStorage.setItem('explica.helpSeen', '1');
    } catch {
      /* storage unavailable: fine */
    }
  });
  help.addEventListener('click', (e) => {
    if (e.target === help) showHelp(false);
  });
  let seen = false;
  try {
    seen = localStorage.getItem('explica.helpSeen') === '1';
  } catch {
    seen = false;
  }
  if (!seen) window.setTimeout(() => showHelp(true), 600);

  // ------------------------------------------------------------ fullscreen
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => toast('Fullscreen is not available here.'));
  };
  $('fsBtn').addEventListener('click', toggleFullscreen);

  // ------------------------------------------------------------ files
  const passwordPrompt = (retry: boolean): Promise<string | null> =>
    new Promise((resolve) => {
      const dlg = $<HTMLDialogElement>('pwDialog');
      const input = $<HTMLInputElement>('pwInput');
      $('pwHint').textContent = retry
        ? 'That password did not work. Try again — it stays on this device.'
        : 'Enter its password to open it. The password stays on this device.';
      input.value = '';
      dlg.returnValue = '';
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? input.value : null), { once: true });
      dlg.showModal();
      input.focus();
    });

  const openFile = async (file: File) => {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isPdf) {
      toast('That does not look like a PDF.');
      return;
    }
    loading.hidden = false;
    toastEl.hidden = true; // a notice about the previous document no longer applies
    loadingText.textContent = `Reading ${file.name}…`;
    loadingBar.style.width = '8%';
    try {
      const data = await file.arrayBuffer();
      loadingText.textContent = `Parsing ${file.name}…`;
      loadingBar.style.width = '35%';
      const { PdfSource } = await import('../pdf/appPdfSource');
      const src = await PdfSource.open(data, file.name.replace(/\.pdf$/i, ''), {
        onProgress: (f) => (loadingBar.style.width = `${35 + f * 55}%`),
        onPassword: passwordPrompt,
      });
      loadingBar.style.width = '100%';
      setDirection(src.direction ?? preferred);
      await app.load(src);
      if (src.direction && src.direction !== preferred) {
        const how = src.directionSource === 'detected' ? 'Its text reads' : 'This PDF reads';
        toast(`${how} ${src.direction === 'rtl' ? 'right to left' : 'left to right'}, so it opens that way. The switch above changes it.`);
      }
      toggleSettings(false);
      showHelp(false);
    } catch (e) {
      console.error(e);
      const msg = (e as Error)?.name === 'PasswordException' ? 'The PDF stayed locked.' : `Could not open this PDF: ${(e as Error)?.message ?? e}`;
      toast(msg, 6000);
    } finally {
      loading.hidden = true;
    }
  };

  $('openBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) void openFile(f);
    fileInput.value = '';
  });

  const drop = $<HTMLElement>('drop');
  let dragDepth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    drop.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) drop.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    drop.hidden = true;
    const f = e.dataTransfer?.files?.[0];
    if (f) void openFile(f);
  });

  // ------------------------------------------------------------ annotation tools, selection toolbar, notes
  mountAnnotateUI(app, toast);

  // ------------------------------------------------------------ keyboard commands from the app
  app.onKeyCommand = (cmd) => {
    if (cmd === 'fullscreen') toggleFullscreen();
    else if (cmd === 'help') showHelp(!!help.hidden);
    else if (cmd === 'open') fileInput.click();
    else if (cmd === 'context-lost') toast('The graphics context was lost. Reload the page to continue.', 10000);
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      showHelp(false);
      toggleSettings(false);
    }
  });

  // ------------------------------------------------------------ fade chrome while reading
  let idleTimer = 0;
  const wake = () => {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      if (settings.hidden && help.hidden) document.body.classList.add('idle');
    }, 4000);
  };
  window.addEventListener('pointermove', wake, { passive: true });
  window.addEventListener('keydown', wake);
  wake();

  setDirection(preferred);

  // transitions only after the first paint, so nothing animates into place on load
  requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('preload')));

  return { openFile };
}
