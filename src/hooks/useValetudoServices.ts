import { useCallback } from 'react';
import type { Hass, CleaningMode, Zone } from '../types/homeassistant';
import type { SupportedLanguage } from '../i18n/locales';
import type { ValetudoEntityIds } from '../types/valetudo';
import { useTranslation } from './useTranslation';

interface ValetudoServicesParams {
  hass: Hass;
  entityIds: ValetudoEntityIds;
  onSuccess?: (message: string) => void;
  language?: SupportedLanguage;
}

export function useValetudoServices({ hass, entityIds, onSuccess, language = 'en' }: ValetudoServicesParams) {
  const { t } = useTranslation(language);

  const handleStart = useCallback(() => {
    hass.callService('vacuum', 'start', { entity_id: entityIds.vacuum });
    onSuccess?.(t('toast.starting_full_clean'));
  }, [hass, entityIds.vacuum, onSuccess, t]);

  const handlePause = useCallback(() => {
    hass.callService('vacuum', 'pause', { entity_id: entityIds.vacuum });
    onSuccess?.(t('toast.pausing_vacuum'));
  }, [hass, entityIds.vacuum, onSuccess, t]);

  const handleStop = useCallback(() => {
    hass.callService('vacuum', 'stop', { entity_id: entityIds.vacuum });
    hass.callService('vacuum', 'return_to_base', { entity_id: entityIds.vacuum });
    onSuccess?.(t('toast.stopping_vacuum'));
  }, [hass, entityIds.vacuum, onSuccess, t]);

  const handleDock = useCallback(() => {
    hass.callService('vacuum', 'return_to_base', { entity_id: entityIds.vacuum });
    onSuccess?.(t('toast.vacuum_docking'));
  }, [hass, entityIds.vacuum, onSuccess, t]);

  const handleResume = useCallback(() => {
    hass.callService('vacuum', 'start', { entity_id: entityIds.vacuum });
  }, [hass, entityIds.vacuum]);

  /**
   * Segment (room) cleaning via Valetudo MQTT.
   * Topic: valetudo/{identifier}/MapSegmentationCapability/operate/set
   */
  const handleCleanSegments = useCallback(
    (segments: number[], count: number, iterations = 1) => {
      const identifier = entityIds.mqttIdentifier;
      if (!identifier) {
        onSuccess?.(t('valetudo.toast.missing_identifier'));
        return;
      }
      hass.callService('mqtt', 'publish', {
        topic: `valetudo/${identifier}/MapSegmentationCapability/clean/set`,
        payload: JSON.stringify({
          segment_ids: segments.map(String),
          iterations,
          customOrder: false,
        }),
        retain: false,
      });
      const key = count === 1 ? 'toast.starting_room_clean' : 'toast.starting_room_clean_plural';
      onSuccess?.(t(key, { count: String(count) }));
    },
    [hass, entityIds.mqttIdentifier, onSuccess, t]
  );

  const handleSetFanSpeed = useCallback(
    (option: string) => {
      hass.callService('select', 'select_option', {
        entity_id: entityIds.fan,
        option,
      });
    },
    [hass, entityIds.fan]
  );

  const handleSetWater = useCallback(
    (option: string) => {
      hass.callService('select', 'select_option', {
        entity_id: entityIds.water,
        option,
      });
    },
    [hass, entityIds.water]
  );

  const handleClean = useCallback(
    (mode: CleaningMode, selectedRooms: Map<number, string>, _selectedZone: Zone | null, iterations = 1) => {
      switch (mode) {
        case 'all':
          handleStart();
          break;
        case 'room':
          if (selectedRooms.size > 0) {
            handleCleanSegments(Array.from(selectedRooms.keys()), selectedRooms.size, iterations);
          } else {
            onSuccess?.(t('toast.select_rooms_first'));
          }
          break;
        case 'zone':
          // Zone cleaning via Valetudo MQTT ZoneCleaningCapability
          if (_selectedZone) {
            const identifier = entityIds.mqttIdentifier;
            if (!identifier) {
              onSuccess?.(t('valetudo.toast.missing_identifier'));
              break;
            }
            const { x1, y1, x2, y2 } = _selectedZone;
            const minX = Math.round(Math.min(x1, x2));
            const maxX = Math.round(Math.max(x1, x2));
            const minY = Math.round(Math.min(y1, y2));
            const maxY = Math.round(Math.max(y1, y2));
            const zoneW = maxX - minX;
            const zoneH = maxY - minY;
            const zonePayload = {
              zones: [
                {
                  points: {
                    pA: { x: minX, y: minY },
                    pB: { x: maxX, y: minY },
                    pC: { x: maxX, y: maxY },
                    pD: { x: minX, y: maxY },
                  },
                },
              ],
              iterations,
            };
            console.log('[Valetudo] Zone payload:', JSON.stringify(zonePayload));
            hass.callService('mqtt', 'publish', {
              topic: `valetudo/${identifier}/ZoneCleaningCapability/start/set`,
              payload: JSON.stringify(zonePayload),
              retain: false,
            });
            onSuccess?.(
              t('valetudo.toast.zone_started', {
                width: String(zoneW),
                height: String(zoneH),
                iterations: String(iterations),
              })
            );
          } else {
            onSuccess?.(t('valetudo.toast.draw_zone_first'));
          }
          break;
      }
    },

    [handleStart, handleCleanSegments, hass, entityIds.mqttIdentifier, onSuccess, t]
  );

  return {
    handleStart,
    handlePause,
    handleStop,
    handleDock,
    handleResume,
    handleCleanSegments,
    handleSetFanSpeed,
    handleSetWater,
    handleClean,
  };
}
