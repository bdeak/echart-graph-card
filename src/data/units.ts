import { domainOf } from './history';
import type { HomeAssistant } from '../types';

/** Temperature attributes of climate-like entities (unit = the HA temperature unit). */
const TEMPERATURE_ATTRIBUTES = new Set(['temperature', 'current_temperature', 'target_temp_high', 'target_temp_low', 'target_temp_step']);
const TEMPERATURE_DOMAINS = new Set(['climate', 'water_heater']);
/** Humidity attributes (percent). */
const HUMIDITY_ATTRIBUTES = new Set(['humidity', 'current_humidity', 'target_humidity']);
const HUMIDITY_DOMAINS = new Set(['climate', 'humidifier']);

/**
 * Default unit of an attribute series, for the few attributes whose unit Home Assistant defines
 * (entities only carry `unit_of_measurement` for their state): climate / water_heater
 * temperatures use the configured temperature unit (`hass.config.unit_system.temperature`,
 * e.g. `°C`), climate / humidifier humidity is `%`. Undefined otherwise (set `unit:`).
 */
export function attributeUnit(entityId: string, attribute: string, hass: HomeAssistant | undefined): string | undefined {
  const domain = domainOf(entityId);
  if (TEMPERATURE_DOMAINS.has(domain) && TEMPERATURE_ATTRIBUTES.has(attribute)) {
    const unit = (hass?.config as { unit_system?: { temperature?: unknown } } | undefined)?.unit_system?.temperature;
    return typeof unit === 'string' && unit ? unit : undefined;
  }
  if (HUMIDITY_DOMAINS.has(domain) && HUMIDITY_ATTRIBUTES.has(attribute)) return '%';
  return undefined;
}
