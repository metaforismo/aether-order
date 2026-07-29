/** Small DOM helpers. No framework, no virtual DOM, no dependencies. */

export function esc(value: unknown): string {
  return String(value).replace(
    /[&<>"']/gu,
    (character) =>
      (
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        }) as Record<string, string>
      )[character] as string,
  );
}

export function html(markup: string): HTMLElement {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild as HTMLElement;
}

export function on<K extends keyof HTMLElementEventMap>(
  root: ParentNode,
  selector: string,
  type: K,
  handler: (event: HTMLElementEventMap[K], element: HTMLElement) => void,
): void {
  for (const node of root.querySelectorAll<HTMLElement>(selector))
    node.addEventListener(type, (event) => handler(event as HTMLElementEventMap[K], node));
}

export function announce(message: string): void {
  const live = document.getElementById('live');
  if (live) live.textContent = message;
}

export interface SheetOptions {
  title: string;
  subtitle?: string;
  full?: boolean;
  body: string;
  foot?: string;
  onMount?: (root: HTMLElement, close: () => void) => void;
}

let openSheets = 0;

export function openSheet(options: SheetOptions): () => void {
  const root = document.getElementById('sheet-root') as HTMLElement;
  const scrim = html(`
    <div class="scrim">
      <section class="sheet${options.full ? ' sheet--full' : ''}" role="dialog" aria-modal="true" aria-label="${esc(
        options.title,
      )}">
        <header class="sheet__head">
          <div style="flex:1">
            <h2>${esc(options.title)}</h2>
            ${options.subtitle ? `<p>${esc(options.subtitle)}</p>` : ''}
          </div>
          <button class="icon-btn" data-close aria-label="Close">
            <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="1.5"/></svg>
          </button>
        </header>
        <div class="sheet__body">${options.body}</div>
        ${options.foot ? `<div class="sheet__foot">${options.foot}</div>` : ''}
      </section>
    </div>`);
  root.append(scrim);
  openSheets += 1;
  const close = (): void => {
    scrim.remove();
    openSheets = Math.max(0, openSheets - 1);
  };
  scrim.addEventListener('click', (event) => {
    if (event.target === scrim) close();
  });
  on(scrim, '[data-close]', 'click', () => close());
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') close();
    },
    { once: true },
  );
  options.onMount?.(scrim, close);
  return close;
}

export function closeAllSheets(): void {
  const root = document.getElementById('sheet-root');
  if (root) root.innerHTML = '';
  openSheets = 0;
}

export function sheetsOpen(): number {
  return openSheets;
}

export function openModal(markup: string, onMount?: (root: HTMLElement, close: () => void) => void): void {
  const root = document.getElementById('modal-root') as HTMLElement;
  const modal = html(`<div class="modal" role="dialog" aria-modal="true"><div class="modal__panel">${markup}</div></div>`);
  root.append(modal);
  const close = (): void => modal.remove();
  onMount?.(modal, close);
}

let toastTimer: number | undefined;

export function toast(message: string): void {
  document.querySelector('.toast')?.remove();
  const node = html(`<div class="toast" role="status">${esc(message)}</div>`);
  document.body.append(node);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.remove(), 3200);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

export const reducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
