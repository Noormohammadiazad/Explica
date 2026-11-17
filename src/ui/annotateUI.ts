import type { ExplicaApp } from '../app';
import { HIGHLIGHT_COLORS, PEN_COLORS, PEN_WIDTHS, type Note, type Tool } from '../annotate/model';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * The annotation chrome: the tool rail with its options, the toolbar that
 * floats at the end of a text selection (copy, highlight colours, remove),
 * the note editor anchored to its mark on the page, and the note preview
 * shown while the pointer rests on a mark.
 */
export function mountAnnotateUI(app: ExplicaApp, toast: (msg: string, ms?: number) => void): void {
  const rail = $<HTMLElement>('toolRail');
  const options = $<HTMLElement>('toolOptions');
  const undoBtn = $<HTMLButtonElement>('undoBtn');
  const redoBtn = $<HTMLButtonElement>('redoBtn');

  // ------------------------------------------------------------ tools
  const tools = [...rail.querySelectorAll<HTMLButtonElement>('[data-tool]')];
  for (const b of tools) b.addEventListener('click', () => app.setTool(b.dataset.tool as Tool));
  undoBtn.addEventListener('click', () => app.undo());
  redoBtn.addEventListener('click', () => app.redo());
  app.onHistory = (canUndo, canRedo) => {
    undoBtn.disabled = !canUndo;
    redoBtn.disabled = !canRedo;
  };

  const swatch = (value: string, name: string, pressed: boolean, onPick: () => void, cls = 'swatch') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.style.setProperty('--swatch', value);
    b.title = name;
    b.setAttribute('aria-label', name);
    b.setAttribute('aria-pressed', String(pressed));
    b.addEventListener('click', onPick);
    return b;
  };

  const showOptions = (t: Tool) => {
    options.replaceChildren();
    if (t === 'highlight') {
      for (const c of HIGHLIGHT_COLORS) {
        options.append(
          swatch(c.value, `${c.name} highlighter`, c.value === app.highlightColor, () => {
            app.highlightColor = c.value;
            showOptions(t);
          }),
        );
      }
    } else if (t === 'pen') {
      for (const c of PEN_COLORS) {
        options.append(
          swatch(c.value, `${c.name} ink`, c.value === app.penColor, () => {
            app.penColor = c.value;
            showOptions(t);
          }),
        );
      }
      const sep = document.createElement('span');
      sep.className = 'options-sep';
      options.append(sep);
      PEN_WIDTHS.forEach((w, i) => {
        const b = swatch(app.penColor, `${w.name} pen`, w.value === app.penWidth, () => {
          app.penWidth = w.value;
          showOptions(t);
        }, 'width');
        b.style.setProperty('--dot', `${4 + i * 4}px`);
        options.append(b);
      });
    }
    options.hidden = options.childElementCount === 0;
  };

  app.onToolChange = (t) => {
    for (const b of tools) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
    document.body.dataset.tool = t;
    showOptions(t);
    hideSelBar();
  };

  // ------------------------------------------------------------ selection toolbar
  const selBar = $<HTMLElement>('selBar');
  const selCopy = $<HTMLButtonElement>('selCopy');
  const selRemove = $<HTMLButtonElement>('selRemove');
  const selSwatches = $<HTMLElement>('selSwatches');
  let selected = '';
  const hideSelBar = () => {
    selBar.hidden = true;
    selected = '';
  };
  for (const c of HIGHLIGHT_COLORS) {
    selSwatches.append(
      swatch(c.value, `Highlight ${c.name.toLowerCase()}`, false, () => {
        app.highlightSelection(c.value);
        hideSelBar();
      }),
    );
  }
  // a press on the bar must not collapse the selection it acts on
  selBar.addEventListener('pointerdown', (e) => e.preventDefault());
  app.onTextSelection = (text, at) => {
    selected = text;
    if (!text || !at || app.tool === 'highlight') {
      selBar.hidden = true;
      return;
    }
    selRemove.hidden = !app.selectionOverlapsHighlight();
    selBar.hidden = false;
    const r = selBar.getBoundingClientRect();
    selBar.style.left = `${Math.min(window.innerWidth - r.width - 8, Math.max(8, at.x - r.width / 2))}px`;
    selBar.style.top = `${Math.min(window.innerHeight - r.height - 8, at.y + 12)}px`;
  };
  selCopy.addEventListener('click', async () => {
    const text = selected;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      document.execCommand('copy');
    }
    hideSelBar();
    toast(text.length > 1 ? `Copied ${text.length} characters.` : 'Copied.', 1800);
  });
  selRemove.addEventListener('click', () => {
    app.removeSelectedHighlights();
    hideSelBar();
  });
  document.addEventListener('copy', () => {
    if (!app.textLayer.selectedText) return;
    hideSelBar();
    toast('Copied.', 1600);
  });

  // ------------------------------------------------------------ notes
  const pop = $<HTMLElement>('notePop');
  const text = $<HTMLTextAreaElement>('noteText');
  const peek = $<HTMLElement>('notePeek');
  let editing: string | null = null;
  let saveTimer = 0;
  const place = (el: HTMLElement, at: { x: number; y: number }, gap: number) => {
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.min(window.innerWidth - r.width - 8, Math.max(8, at.x - r.width / 2))}px`;
    const below = at.y + gap;
    el.style.top = `${below + r.height > window.innerHeight - 8 ? Math.max(8, at.y - gap - r.height) : below}px`;
  };
  const save = () => {
    clearTimeout(saveTimer);
    if (editing) app.setNoteText(editing, text.value);
  };
  app.onNoteOpen = (note: Note | null, at) => {
    if (!note) {
      save();
      editing = null;
      pop.hidden = true;
      return;
    }
    editing = note.id;
    text.value = note.text;
    pop.hidden = false;
    if (at) place(pop, at, 22);
    else pop.hidden = true;
    text.focus();
  };
  app.onNoteMove = (at) => {
    if (!editing) return;
    pop.hidden = !at;
    if (at) place(pop, at, 22);
  };
  text.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(save, 350);
  });
  text.addEventListener('keydown', (e) => {
    e.stopPropagation(); // typing is not a shortcut
    if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key === 'Enter')) {
      save();
      app.closeNote();
    }
  });
  $('noteDone').addEventListener('click', () => {
    save();
    app.closeNote();
  });
  $('noteDelete').addEventListener('click', () => {
    const id = editing;
    editing = null;
    if (id) app.deleteNote(id);
  });
  // a press anywhere else closes the editor
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!editing || pop.contains(e.target as Node) || (e.target as HTMLElement).closest?.('#toolRail')) return;
      if (app.tool === 'note') return; // the note tool decides: open another, or pin a new one
      save();
      app.closeNote();
    },
    true,
  );

  app.onNotePeek = (note, at) => {
    if (!note || !at || editing) {
      peek.hidden = true;
      return;
    }
    peek.textContent = note.text;
    peek.hidden = false;
    place(peek, at, 18);
  };

  app.onStorageError = () => toast('Your browser storage is full: this annotation could not be saved.', 6000);
}
