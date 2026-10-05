import { useTranslation } from 'react-i18next';
import { Button, Text } from 'tea-component';
import type { GraphSearchSettings } from '../hooks/useWikiSearch';

export function WikiSearchSettings({ value, onChange, onReset, valid }: {
  value: GraphSearchSettings;
  onChange: (value: GraphSearchSettings) => void;
  onReset: () => void;
  valid: boolean;
}) {
  const { t } = useTranslation();
  const numberField = (name: 'hop' | 'decay' | 'minScore', min: number, max?: number) => (
    <label className="_wiki-search-field">
      <span>{t(`wiki.detail.search.${name}`)}</span>
      <input type="number" min={min} max={max} step={name === 'hop' ? 1 : 'any'}
        value={Number.isFinite(value[name]) ? value[name] : ''}
        onChange={(event) => onChange({ ...value, [name]: event.target.valueAsNumber })} />
      <Text theme="label">{t(`wiki.detail.search.${name}Hint`)}</Text>
    </label>
  );
  return (
    <div className="_wiki-search-settings">
      <div className="_wiki-search-settings-heading">
        <label className="_wiki-search-toggle">
          <input type="checkbox" role="switch" checked={value.enabled}
            onChange={(event) => onChange({ ...value, enabled: event.target.checked })} />
          {t('wiki.detail.search.enableGraph')}
        </label>
        <Button type="link" onClick={onReset}>{t('wiki.detail.search.reset')}</Button>
      </div>
      <Text theme="label">{t('wiki.detail.search.preferenceHint')}</Text>
      {value.enabled && <>
        {numberField('hop', 1, 5)}
        <details>
          <summary>{t('wiki.detail.search.advanced')}</summary>
          <div className="_wiki-search-advanced">
            {numberField('decay', 0, 1)}
            {numberField('minScore', 0)}
          </div>
        </details>
      </>}
      {!valid && <p role="alert" className="_wiki-search-invalid">{t('wiki.detail.search.invalid')}</p>}
    </div>
  );
}
