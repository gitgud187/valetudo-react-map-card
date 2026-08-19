import type { CustomThemeConfig } from '../themes';
import type { SupportedLanguage } from '../i18n/locales';
import type { CleaningSelectionMode } from './homeassistant';

/**
 * Config for the valetudo-vacuum-map-card custom element.
 * Only `entity` is required — all other entities are auto-derived
 * from the robot ID (everything after "vacuum." in the entity ID).
 *
 * Example:
 *   entity: vacuum.valetudo_harshsillypigeon
 *   → map:      camera.valetudo_harshsillypigeon_map_data
 *   → fan:      select.valetudo_harshsillypigeon_fan
 *   → water:    select.valetudo_harshsillypigeon_water
 *   → battery:  sensor.valetudo_harshsillypigeon_battery_level
 *   → segments: sensor.valetudo_harshsillypigeon_map_segments
 */
export interface ValetudoHassConfig {
  type: string;
  entity: string;
  /**
   * The Valetudo robot identifier as set in Valetudo settings (case-sensitive).
   * Required for room and zone cleaning via MQTT.
   * Example: if your robot's MQTT topic is valetudo/HarshSillyPigeon/...,
   * set this to "HarshSillyPigeon".
   */
  valetudo_identifier?: string;
  /**
   * Direct URL to the Valetudo REST API (optional).
   * If provided, restrictions are saved via REST (more reliable than MQTT).
   * Example: http://192.168.0.162
   */
  valetudo_url?: string;
  // Optional overrides for non-standard entity naming
  map_entity?: string;
  fan_entity?: string;
  water_entity?: string;
  battery_entity?: string;
  segments_entity?: string;
  title?: string;
  theme?: 'light' | 'dark' | 'custom';
  custom_theme?: CustomThemeConfig;
  language?: SupportedLanguage;
  default_mode?: CleaningSelectionMode;
  /** Map visual settings */
  robot_size?: number; // multiplier, default 1.0
  charger_size?: number; // multiplier, default 1.0
  path_width?: number; // multiplier, default 1.0
}

/** Resolved entity IDs after applying auto-derivation and overrides */
export interface ValetudoEntityIds {
  vacuum: string;
  map: string;
  fan: string;
  water: string;
  battery: string;
  segments: string;
  wifi: string;
  /** MQTT identifier as set in Valetudo (case-sensitive). May be undefined if not configured. */
  mqttIdentifier: string | undefined;
  // Consumables
  mainBrush: string;
  rightBrush: string;
  mainFilter: string;
  sensorCleaning: string;
  resetMainBrush: string;
  resetRightBrush: string;
  resetMainFilter: string;
  resetSensorCleaning: string;
  // Statistics
  totalStatsArea: string;
  totalStatsTime: string;
  totalStatsCount: string;
  currentStatsArea: string;
  currentStatsTime: string;
  // Switches
  carpetMode: string;
}

// ─── Virtual Restrictions ─────────────────────────────────────────────────────

export interface VirtualWall {
  id: string; // local UUID for editing
  pA: { x: number; y: number };
  pB: { x: number; y: number };
}

export interface RestrictedZone {
  id: string; // local UUID for editing
  type: 'regular' | 'mop';
  pA: { x: number; y: number };
  pB: { x: number; y: number };
  pC: { x: number; y: number };
  pD: { x: number; y: number };
}

export type RestrictionTool = 'wall' | 'no_go' | 'no_mop' | 'select';

export interface RestrictionsState {
  walls: VirtualWall[];
  zones: RestrictedZone[];
  selectedId: string | null;
  tool: RestrictionTool;
  dirty: boolean; // unsaved changes
  /** Last-saved snapshot; persists after exiting edit mode so the canvas can
   *  optimistically show the correct walls/zones while mapData is still stale. */
  savedDisplay: { walls: VirtualWall[]; zones: RestrictedZone[] } | null;
}

/** Derives all Valetudo entity IDs from the vacuum entity ID */
export function deriveValetudoEntityIds(config: ValetudoHassConfig): ValetudoEntityIds {
  const robotId = config.entity.replace(/^vacuum\./, '');
  return {
    vacuum: config.entity,
    map: config.map_entity ?? `camera.${robotId}_map_data`,
    fan: config.fan_entity ?? `select.${robotId}_fan`,
    water: config.water_entity ?? `select.${robotId}_water`,
    battery: config.battery_entity ?? `sensor.${robotId}_battery_level`,
    segments: config.segments_entity ?? `sensor.${robotId}_map_segments`,
    wifi: `sensor.${robotId}_wi_fi_configuration`,
    mqttIdentifier: config.valetudo_identifier,
    // Consumables
    mainBrush: `sensor.${robotId}_main_brush`,
    rightBrush: `sensor.${robotId}_right_brush`,
    mainFilter: `sensor.${robotId}_main_filter`,
    sensorCleaning: `sensor.${robotId}_sensor_cleaning`,
    resetMainBrush: `button.${robotId}_reset_main_brush_consumable`,
    resetRightBrush: `button.${robotId}_reset_right_brush_consumable`,
    resetMainFilter: `button.${robotId}_reset_main_filter_consumable`,
    resetSensorCleaning: `button.${robotId}_reset_sensor_cleaning_consumable`,
    // Statistics
    totalStatsArea: `sensor.${robotId}_total_statistics_area`,
    totalStatsTime: `sensor.${robotId}_total_statistics_time`,
    totalStatsCount: `sensor.${robotId}_total_statistics_count`,
    currentStatsArea: `sensor.${robotId}_current_statistics_area`,
    currentStatsTime: `sensor.${robotId}_current_statistics_time`,
    // Switches
    carpetMode: `switch.${robotId}_carpet_mode`,
  };
}
