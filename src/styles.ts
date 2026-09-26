import { css } from 'lit';

/**
 * Card shell styles (ha-card layout, chart area, loading shimmer, in-card alerts).
 * Header/chip styles live in header.ts (`headerStyles`). Everything is driven by HA theme
 * variables so light/dark themes work without extra code.
 */
export const cardStyles = css`
  :host {
    display: block;
  }

  /* Set by the card in the sections (grid) layout so ha-card can fill the grid cell. */
  :host([fill-height]) {
    height: 100%;
  }

  ha-card {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    box-sizing: border-box;
  }

  .chart-wrap {
    position: relative;
    flex: 0 0 auto;
    min-height: 0;
  }

  /* Sections (grid) layout: the chart fills whatever the grid rows leave after the header. */
  ha-card.fill .chart-wrap {
    flex: 1 1 0;
    min-height: 64px;
  }

  .chart {
    width: 100%;
    /* Canvas must never force the card wider than its column. */
    min-width: 0;
    overflow: hidden;
    -webkit-tap-highlight-color: transparent;
  }

  /* Subtle placeholder until the first data arrives. */
  .shimmer {
    position: absolute;
    inset: 12px 16px 16px;
    border-radius: var(--ha-border-radius-md, 8px);
    pointer-events: none;
    background:
      linear-gradient(
        100deg,
        transparent 20%,
        color-mix(in srgb, var(--primary-text-color, #212121) 7%, transparent) 50%,
        transparent 80%
      ),
      linear-gradient(
        to top,
        color-mix(in srgb, var(--primary-text-color, #212121) 4%, transparent),
        transparent 70%
      );
    background-size:
      200% 100%,
      100% 100%;
    background-repeat: no-repeat;
    animation: egc-shimmer 1.6s ease-in-out infinite;
  }

  @keyframes egc-shimmer {
    from {
      background-position:
        150% 0,
        0 0;
    }
    to {
      background-position:
        -50% 0,
        0 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .shimmer {
      animation: none;
    }
  }

  .empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    text-align: center;
    pointer-events: none;
    color: var(--secondary-text-color);
    font-size: var(--ha-font-size-s, 12px);
  }

  /* ha-alert look-alike (ha-alert itself is not guaranteed to be loaded on every dashboard). */
  .alerts {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 12px 0;
  }

  .alert {
    --alert-color: var(--error-color, #db4437);
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 10px 6px 14px;
    border-radius: var(--ha-border-radius-sm, 6px);
    overflow: hidden;
    color: var(--primary-text-color);
    background: rgba(219, 68, 55, 0.1);
    background: color-mix(in srgb, var(--alert-color) 12%, transparent);
    font-size: var(--ha-font-size-s, 12px);
    line-height: 1.4;
    word-break: break-word;
  }

  .alert::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    background: var(--alert-color);
  }

  .alert.warning {
    --alert-color: var(--warning-color, #ffa600);
    background: rgba(255, 166, 0, 0.12);
    background: color-mix(in srgb, var(--alert-color) 14%, transparent);
  }
`;
