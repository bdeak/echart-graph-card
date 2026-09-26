import { EchartGraphCard } from './card';
import { CARD_DISPLAY_NAME, CARD_NAME, CARD_VERSION } from './const';

interface CustomCardEntry {
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

if (!customElements.get(CARD_NAME)) {
  customElements.define(CARD_NAME, EchartGraphCard);

  window.customCards = window.customCards ?? [];
  if (!window.customCards.some((c) => c.type === CARD_NAME)) {
    window.customCards.push({
      type: CARD_NAME,
      name: CARD_DISPLAY_NAME,
      description: 'Fast, beautiful time-series line charts powered by Apache ECharts.',
      preview: true,
    });
  }

  console.info(
    `%c ECHART-GRAPH-CARD %c v${CARD_VERSION} `,
    'color: #fff; background: #3B82F6; font-weight: 700; border-radius: 3px 0 0 3px;',
    'color: #3B82F6; background: #fff; font-weight: 700; border-radius: 0 3px 3px 0;',
  );
}

export { EchartGraphCard };
