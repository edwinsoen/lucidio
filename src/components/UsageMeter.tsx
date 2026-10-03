import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Activity, ChevronDown } from 'lucide-react';
import type { ModelCatalog } from '../types';
import { modelName } from '../lib/modelCatalog';
import { formatTokens, getUsageSnapshot, subscribeUsage } from '../lib/usageMeter';

export function UsageMeter({ catalog }: { catalog: ModelCatalog | null }) {
  const usage = useSyncExternalStore(subscribeUsage, getUsageSnapshot, getUsageSnapshot);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointer(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener('mousedown', handlePointer);
    return () => window.removeEventListener('mousedown', handlePointer);
  }, [open]);

  return (
    <div className="usage-meter" ref={ref}>
      <button className="usage-meter-button" aria-expanded={open} aria-label="Token usage breakdown" onClick={() => setOpen((value) => !value)}>
        <Activity size={14} strokeWidth={2.2} />
        <span className="usage-meter-figure"><strong>{formatTokens(usage.inputTokens)}</strong> Tok in</span>
        <span className="usage-meter-sep">|</span>
        <span className="usage-meter-figure"><strong>{formatTokens(usage.outputTokens)}</strong> Tok out</span>
        <ChevronDown size={14} strokeWidth={2.2} />
      </button>
      {open && (
        <div className="usage-meter-menu">
          <div className="usage-meter-head">
            <span>Usage on this device</span>
            <span className="usage-meter-count">{usage.count} {usage.count === 1 ? 'generation' : 'generations'}</span>
          </div>
          <div className="usage-meter-totals">
            <div><label>Tokens in</label><strong>{formatTokens(usage.inputTokens)}</strong></div>
            <div><label>Tokens out</label><strong>{formatTokens(usage.outputTokens)}</strong></div>
          </div>
          {usage.models.length === 0 ? (
            <div className="usage-meter-empty">No generations metered yet.</div>
          ) : (
            <ul className="usage-meter-list">
              {usage.models.map((model) => (
                <li key={model.modelId}>
                  <div className="usage-meter-model">
                    <span className="usage-meter-name" title={modelName(catalog, model.modelId)}>{modelName(catalog, model.modelId)}</span>
                    <span className={`usage-meter-mode ${model.mode}`}>{model.mode}</span>
                  </div>
                  <div className="usage-meter-tokens">
                    <span>{formatTokens(model.inputTokens)} in</span>
                    <span>{formatTokens(model.outputTokens)} out</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
