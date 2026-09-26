/**
 * Minimal stand-in for Home Assistant's <ha-card> (only defined when the real one is absent),
 * with the same theme variables so the card looks like it does on a dashboard.
 */
const STYLE = `
  :host {
    display: block;
    position: relative;
    box-sizing: border-box;
    background: var(--ha-card-background, var(--card-background-color, #fff));
    color: var(--primary-text-color);
    border-radius: var(--ha-card-border-radius, 12px);
    border-width: var(--ha-card-border-width, 1px);
    border-style: solid;
    border-color: var(--ha-card-border-color, var(--divider-color, #e0e0e0));
    box-shadow: var(--ha-card-box-shadow, none);
    font-family: var(--ha-font-family-body, Roboto, Noto, sans-serif);
    transition: all 0.3s ease-out;
  }
  .card-header {
    font-size: var(--ha-font-size-2xl, 24px);
    padding: 12px 16px 16px;
    line-height: 48px;
  }
`;

class HaCardStandIn extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['header'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `<style>${STYLE}</style><slot></slot>`;
  }

  attributeChangedCallback(): void {
    const root = this.shadowRoot;
    if (!root) return;
    root.querySelector('.card-header')?.remove();
    const header = this.getAttribute('header');
    if (header) {
      const el = document.createElement('h1');
      el.className = 'card-header';
      el.textContent = header;
      root.insertBefore(el, root.querySelector('slot'));
    }
  }
}

if (!customElements.get('ha-card')) customElements.define('ha-card', HaCardStandIn);

export {};
