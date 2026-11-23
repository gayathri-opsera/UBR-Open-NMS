/** Compact "template does not match this device's radio count" notice for a discovery result (card and table row). */
import { describeRadios, type RadioFit } from './radioFit';

export function RadioFitWarning({ fit, compact = false }: { fit?: RadioFit; compact?: boolean }) {
  if (!fit || fit.status !== 'mismatch' || !fit.templateRadios) return null;
  const n = fit.deviceRadios ?? 0;
  const best = fit.suggestions[0];
  const title =
    `This device has ${n} radio${n === 1 ? '' : 's'} but the chosen template is built for ${describeRadios(fit.templateRadios)}. ` +
    (best ? `Suggested: ${best.screenName}. Pick it in the Provision dialog.` : 'No published template fits.');
  return (
    <div
      role="alert"
      title={title}
      style={{
        fontSize: compact ? 10 : 11, lineHeight: 1.35, padding: compact ? '2px 6px' : '6px 8px', borderRadius: 5,
        background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.45)',
        color: 'var(--vf-text-primary)', fontFamily: 'var(--vf-font-sans)',
      }}
    >
      ⚠️ {n} radio{n === 1 ? '' : 's'} · template is for {describeRadios(fit.templateRadios)}
      {!compact && <div style={{ color: 'var(--vf-text-secondary)' }}>{best ? <>Suggested: <strong>{best.screenName}</strong></> : 'No published template fits.'}</div>}
    </div>
  );
}
