import React from 'react';
import ReactDOM from 'react-dom/client';
import { DreameVacuumCard } from './components/DreameVacuumCard';
import { ValetudoVacuumCard } from './components/ValetudoVacuumCard/ValetudoVacuumCard';
import { ErrorBoundary } from './components/common';
import type { Hass, HassConfig } from './types/homeassistant';
import type { ValetudoHassConfig } from './types/valetudo';
import { validateConfig } from './utils/typeGuards';
import { attachLoggerToWindow, logger } from './utils/logger';
import styles from './styles.scss?inline';

// Attach logger controls to window for dev tools access
attachLoggerToWindow();

class DreameVacuumMapCard extends HTMLElement {
  private _root: ReactDOM.Root | null = null;
  private _hass?: Hass;
  private _config?: HassConfig;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    const styleEl = document.createElement('style');
    styleEl.textContent = styles;
    this.shadowRoot!.appendChild(styleEl);
  }

  setConfig(config: HassConfig) {
    // Validate configuration
    const validation = validateConfig(config);

    if (!validation.valid) {
      throw new Error(`Invalid configuration: ${validation.errors.join('; ')}`);
    }

    // Log warnings in development
    if (validation.warnings.length > 0) {
      logger.warn('Configuration warnings:', validation.warnings);
    }

    this._config = config;
    this.render();
  }

  set hass(hass: Hass) {
    this._hass = hass;
    this.render();
  }

  private render() {
    if (!this._hass || !this._config || !this.shadowRoot) return;

    let container = this.shadowRoot.querySelector('#react-root') as HTMLElement;
    if (!container) {
      container = document.createElement('div');
      container.id = 'react-root';
      this.shadowRoot.appendChild(container);
    }

    if (!this._root) {
      this._root = ReactDOM.createRoot(container);
    }

    this._root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <DreameVacuumCard hass={this._hass} config={this._config} />
        </ErrorBoundary>
      </React.StrictMode>
    );
  }

  getCardSize() {
    return 4;
  }

  static getStubConfig() {
    return {
      type: 'custom:dreame-vacuum-map-card',
      entity: 'vacuum.dreame_vacuum',
      title: 'Dreame Vacuum',
    };
  }
}

if (!customElements.get('dreame-vacuum-map-card')) {
  customElements.define('dreame-vacuum-map-card', DreameVacuumMapCard);
}

// ─── Valetudo Vacuum Map Card ─────────────────────────────────────────────────

class ValetudoVacuumMapCard extends HTMLElement {
  private _root: ReactDOM.Root | null = null;
  private _hass?: Hass;
  private _config?: ValetudoHassConfig;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    const styleEl = document.createElement('style');
    styleEl.textContent = styles;
    this.shadowRoot!.appendChild(styleEl);
  }

  setConfig(config: ValetudoHassConfig) {
    if (!config.entity) {
      throw new Error('valetudo-react-map-card: you need to define an entity (vacuum.*)');
    }
    this._config = config;
    this.render();
  }

  set hass(hass: Hass) {
    this._hass = hass;
    this.render();
  }

  private render() {
    if (!this._hass || !this._config || !this.shadowRoot) return;

    let container = this.shadowRoot.querySelector('#react-root') as HTMLElement;
    if (!container) {
      container = document.createElement('div');
      container.id = 'react-root';
      this.shadowRoot.appendChild(container);
    }

    if (!this._root) {
      this._root = ReactDOM.createRoot(container);
    }

    this._root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <ValetudoVacuumCard hass={this._hass} config={this._config} />
        </ErrorBoundary>
      </React.StrictMode>
    );
  }

  getCardSize() {
    return 5;
  }

  static getStubConfig(hass?: Hass) {
    const entity =
      (hass && Object.keys(hass.states).find((id) => id.startsWith('vacuum.valetudo_'))) || 'vacuum.valetudo_yourrobot';
    return {
      type: 'custom:valetudo-react-map-card',
      entity,
    };
  }

  static getConfigForm() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema: any[] = [
      {
        name: 'entity',
        required: true,
        selector: { entity: { domain: 'vacuum' } },
      },
      {
        name: 'valetudo_identifier',
        selector: { text: {} },
      },
      {
        name: 'title',
        selector: { text: {} },
      },
      {
        type: 'grid',
        name: '',
        flatten: true,
        column_min_width: '180px',
        schema: [
          {
            name: 'theme',
            selector: {
              select: {
                options: [
                  { label: 'Light ☀️', value: 'light' },
                  { label: 'Dark 🌙', value: 'dark' },
                ],
                mode: 'dropdown',
              },
            },
          },
          {
            name: 'language',
            selector: {
              select: {
                options: [
                  { label: 'English', value: 'en' },
                  { label: 'Русский', value: 'ru' },
                  { label: 'Deutsch', value: 'de' },
                  { label: 'Español', value: 'es' },
                  { label: 'Italiano', value: 'it' },
                  { label: 'Nederlands', value: 'nl' },
                  { label: 'Polski', value: 'pl' },
                  { label: '中文', value: 'zh' },
                ],
                mode: 'dropdown',
              },
            },
          },
        ],
      },
      {
        name: 'valetudo_url',
        selector: { text: { type: 'url' } },
      },
      {
        type: 'expandable',
        name: 'advanced_overrides',
        flatten: true,
        title: 'Advanced entity overrides',
        schema: [
          { name: 'map_entity', selector: { entity: { domain: 'camera' } } },
          { name: 'fan_entity', selector: { entity: { domain: 'select' } } },
          { name: 'water_entity', selector: { entity: { domain: 'select' } } },
          { name: 'battery_entity', selector: { entity: { domain: 'sensor' } } },
          { name: 'segments_entity', selector: { entity: { domain: 'sensor' } } },
        ],
      },
      {
        type: 'expandable',
        name: 'map_visuals',
        flatten: true,
        title: 'Map visuals',
        schema: [
          {
            type: 'grid',
            name: '',
            flatten: true,
            column_min_width: '160px',
            schema: [
              {
                name: 'map_max_height',
                selector: { number: { min: 200, max: 2000, step: 50, mode: 'slider' } },
              },
              {
                name: 'map_rotate',
                selector: {
                  select: {
                    options: [
                      { label: '0°', value: 0 },
                      { label: '90°', value: 90 },
                      { label: '180°', value: 180 },
                      { label: '270°', value: 270 },
                    ],
                    mode: 'dropdown',
                  },
                },
              },
              {
                name: 'robot_size',
                selector: { number: { min: 0.3, max: 3, step: 0.1, mode: 'slider' } },
              },
              {
                name: 'charger_size',
                selector: { number: { min: 0.3, max: 3, step: 0.1, mode: 'slider' } },
              },
              {
                name: 'path_width',
                selector: { number: { min: 0.1, max: 5, step: 0.1, mode: 'slider' } },
              },
            ],
          },
        ],
      },
    ];

    const labels: Record<string, string> = {
      entity: 'Vacuum entity',
      valetudo_identifier: 'Valetudo identifier (e.g. HarshSillyPigeon)',
      title: 'Card title',
      theme: 'Theme',
      language: 'Language',
      valetudo_url: 'Valetudo URL (for direct REST saves)',
      map_entity: 'Map entity (camera.*)',
      fan_entity: 'Fan speed entity (select.*)',
      water_entity: 'Water grade entity (select.*)',
      battery_entity: 'Battery entity (sensor.*)',
      segments_entity: 'Segments entity (sensor.*)',
      robot_size: 'Robot icon size',
      charger_size: 'Charger icon size',
      path_width: 'Path line width',
      map_max_height: 'Max map height (px)',
      map_rotate: 'Map rotation',
    };

    const helpers: Record<string, string> = {
      valetudo_identifier:
        'Open Valetudo web UI → Robot Settings → Connectivity → MQTT → Identifier. Example: HarshSillyPigeon. Required for room and zone cleaning via MQTT.',
      valetudo_url:
        'Optional. Override the robot URL for direct REST calls (restrictions, mapping). If left empty, the card auto-detects the IP from the Wi-Fi sensor entity. Set this only if auto-detection fails (e.g. the robot IP changes or the Wi-Fi entity is unavailable).',
      robot_size: 'Multiplier for the robot icon radius. Default: 1.0',
      charger_size: 'Multiplier for the charger icon radius. Default: 1.0',
      path_width: 'Multiplier for the robot travel path line width. Default: 1.0',
      map_max_height: 'Cap the map display height (aspect ratio preserved). Leave empty for full width.',
      map_rotate:
        'Rotate the map clockwise to fix sensor orientation. Room taps, zones and restrictions follow the rotation.',
    };

    return {
      schema,
      computeLabel: (s: { name: string }) => labels[s.name] ?? s.name,
      computeHelper: (s: { name: string }) => helpers[s.name],
    };
  }
}

if (!customElements.get('valetudo-react-map-card')) {
  customElements.define('valetudo-react-map-card', ValetudoVacuumMapCard);
}

declare global {
  interface Window {
    customCards?: Array<{
      type: string;
      name: string;
      description: string;
    }>;
  }
}

// Register card with Home Assistant custom cards list
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'dreame-vacuum-map-card',
  name: 'Dreame Vacuum Map Card',
  description: 'Custom vacuum map card for Dreame vacuum cleaners',
});

window.customCards.push({
  type: 'valetudo-react-map-card',
  name: 'Valetudo React Map Card',
  description: 'Beautiful map card for Valetudo-flashed vacuum cleaners',
});

logger.info('Dreame Vacuum Map Card (React) loaded');

export default DreameVacuumMapCard;
