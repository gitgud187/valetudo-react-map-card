import { useCallback } from 'react';
import { useTranslation, getTimeState } from '@/hooks';
import { useEntity, useHass } from '@/contexts';
import type { EntityDefinition } from '@/config/entity-ui-mapping';
import './EntityRenderers.scss';

interface EntityTimeProps {
  definition: EntityDefinition;
  isChild?: boolean;
}

export function EntityTime({ definition, isChild = false }: EntityTimeProps) {
  const { t } = useTranslation();
  const entity = useEntity();
  const hass = useHass();
  const entityName = entity.entity_id.split('.')[1] ?? '';

  const timeState = getTimeState(hass, entityName, definition.key);

  const handleChange = useCallback(
    (value: string) => {
      hass.callService('time', 'set_value', {
        entity_id: timeState.entityId,
        time: value,
      });
    },
    [hass, timeState.entityId]
  );

  if (timeState.disabled) return null;

  return (
    <div className={`entity-item entity-item--time ${isChild ? 'entity-item--child' : ''}`}>
      <div className="entity-item__info">
        <span className="entity-item__label">{t(definition.labelKey)}</span>
        {definition.descriptionKey && <span className="entity-item__description">{t(definition.descriptionKey)}</span>}
      </div>
      <input
        type="time"
        className="entity-item__time-input"
        value={timeState.timeValue}
        disabled={timeState.unavailable}
        onChange={(e) => handleChange(e.target.value)}
      />
    </div>
  );
}
