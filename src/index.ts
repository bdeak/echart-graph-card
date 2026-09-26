import { EchartGraphCard } from './card';
import { CARD_DISPLAY_NAME, CARD_NAME, CARD_VERSION } from './const';

/** Card picker entry (window.customCards). */
export interface CustomCardEntry {
  type: string;
  name: string;
  description?: string;
  preview?: boolean;
  documentationURL?: string;
}

declare global {
  interface Window {
    customCards?: CustomCardEntry[];
  }
  interface HTMLElementTagNameMap {
    'echart-graph-card': EchartGraphCard;
  }
}

/** Project README (shown as "documentation" in the card picker). */
export const DOCUMENTATION_URL = 'https://github.com/bdeak/echart-graph-card#readme';

export const CARD_PICKER_ENTRY: CustomCardEntry = {
  type: CARD_NAME,
  name: CARD_DISPLAY_NAME,
  description: 'Fast, beautiful time-series line charts (temperature, power, energy, battery, ...) powered by Apache ECharts.',
  preview: true,
  documentationURL: DOCUMENTATION_URL,
};

// Guarded: the resource may be loaded twice (e.g. HACS + manual resource, or dev reloads).
if (!customElements.get(CARD_NAME)) {
  customElements.define(CARD_NAME, EchartGraphCard);

  console.info(
    `%c ECHART-GRAPH-CARD %c v${CARD_VERSION} `,
    'color: #fff; background: #3B82F6; font-weight: 700; border-radius: 3px 0 0 3px;',
    'color: #3B82F6; background: transparent; font-weight: 700; border: 1px solid #3B82F6; border-radius: 0 3px 3px 0;',
  );
}

window.customCards = window.customCards ?? [];
if (!window.customCards.some((c) => c.type === CARD_NAME)) {
  window.customCards.push(CARD_PICKER_ENTRY);
}

export { EchartGraphCard };
