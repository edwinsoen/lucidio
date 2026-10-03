import type { CatalogValue, ParameterDescriptor } from '../types';
import { catalogValueKey, clamp, displayCatalogValue, parameterLabel } from '../lib/modelCatalog';

export function SelectOrText({ value, options, labelFor, onChange }: { value: string | number; options: Array<string | number>; labelFor?: (value: string | number) => string; onChange: (value: string) => void }) {
  if (options.length <= 1) return <div className="readonly-select">{options.length ? labelFor?.(options[0]) ?? String(options[0]) : 'Unavailable'}</div>;
  return <select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={String(option)} value={option}>{labelFor?.(option) ?? String(option)}</option>)}</select>;
}

export function AdvancedParamField({ param, value, onChange }: { param: ParameterDescriptor; value: CatalogValue | undefined; onChange: (value: CatalogValue) => void }) {
  const label = parameterLabel(param.name);
  if (param.type === 'boolean') return <Toggle label={label} enabled checked={value === true} onToggle={() => onChange(value === true ? false : true)} />;
  if (param.enum?.length) {
    const selected = value === undefined ? catalogValueKey(param.enum[0]) : catalogValueKey(value);
    const options = param.enum.map(catalogValueKey);
    return <label className="advanced-field"><span>{label}</span><SelectOrText value={selected} options={options} labelFor={(option) => displayCatalogValue(param.enum?.find((item) => catalogValueKey(item) === option) ?? String(option))} onChange={(option) => { const next = param.enum?.find((item) => catalogValueKey(item) === option); if (next !== undefined) onChange(next); }} />{param.notes && <small>{param.notes}</small>}</label>;
  }
  if ((param.type === 'integer' || param.type === 'number') && (typeof value === 'number' || value === undefined)) {
    const step = param.stepRule === '25 + 4n' ? 4 : param.type === 'integer' ? 1 : 0.1;
    const min = param.minimum ?? (param.stepRule === '25 + 4n' ? 25 : undefined);
    return <label className="advanced-field"><span>{label}</span><input className="param-number" type="number" min={min} max={param.maximum} step={step} value={typeof value === 'number' ? value : ''} onChange={(event) => onChange(Number(event.target.value))} />{param.notes && <small>{param.notes}</small>}{param.stepRule && <small>Must follow {param.stepRule}.</small>}</label>;
  }
  return <label className="advanced-field"><span>{label}</span><input className="param-number" type="text" value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)} />{param.notes && <small>{param.notes}</small>}</label>;
}

export function DurationControl({ duration, value, onChange }: { duration: { minimum: number; maximum: number; intelligent?: number }; value: number; onChange: (value: number) => void }) {
  const intelligent = duration.intelligent;
  const autoSelected = intelligent !== undefined && value === intelligent;
  const sliderValue = autoSelected ? duration.minimum : value;
  return <section className="field"><div className="label-row"><label>Duration</label><small className="accent">{autoSelected ? 'Auto' : `${value}s`}</small></div>{intelligent !== undefined && <div className="chips"><button className={autoSelected ? 'selected' : ''} onClick={() => onChange(intelligent)}>Auto</button><button className={!autoSelected ? 'selected' : ''} onClick={() => onChange(clamp(sliderValue, duration.minimum, duration.maximum))}>Manual</button></div>}<input type="range" min={duration.minimum} max={duration.maximum} step={1} value={sliderValue} onChange={(event) => onChange(Number(event.target.value))} /><div className="range-labels"><span>{duration.minimum}s</span><span>{duration.maximum}s</span></div></section>;
}

export function Toggle({ label, enabled, checked, onToggle }: { label: string; enabled: boolean; checked: boolean; onToggle: () => void }) {
  return <button className="toggle-row" onClick={onToggle} disabled={!enabled}><span>{label}</span><i className={checked ? 'checked' : ''}><b /></i></button>;
}
