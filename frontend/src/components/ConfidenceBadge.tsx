type Props = { confidence: 'high' | 'medium' | 'low' };

const STYLES = {
  high: 'bg-green-100 text-green-800 ring-green-200',
  medium: 'bg-yellow-100 text-yellow-800 ring-yellow-200',
  low: 'bg-red-100 text-red-800 ring-red-200',
} as const;

const LABELS = { high: '🟢 high', medium: '🟡 medium', low: '🔴 low' } as const;

export function ConfidenceBadge({ confidence }: Props) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${STYLES[confidence]}`}
    >
      {LABELS[confidence]}
    </span>
  );
}
