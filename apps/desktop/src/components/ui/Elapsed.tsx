import { useNow, useSlowNow } from '../../hooks/useNow';
import { cn } from '../../lib/cn';
import { formatAbsolute } from '../../lib/format';
import { formatSince } from '../../lib/states';
import { Tooltip } from './Tooltip';

/**
 * Time since `since` (spec §1.3): ongoing `30秒` `4分` `2時間`, finished (`settled`) `12分前`
 * `昨日`. Only `live` items (working right now) re-render every second; the rest every 30s.
 * Nothing is shown without a start time.
 */
export function Elapsed({
  since,
  settled,
  live = false,
  className,
}: {
  since: string | null;
  settled: boolean;
  /** Tick every second (only for what is working right now). */
  live?: boolean;
  className?: string;
}) {
  if (!since) return null;
  return live ? (
    <LiveElapsed since={since} settled={settled} className={className} />
  ) : (
    <SlowElapsed since={since} settled={settled} className={className} />
  );
}

function Text({ since, settled, now, className }: { since: string; settled: boolean; now: number; className?: string }) {
  return (
    <Tooltip content={formatAbsolute(since)}>
      <time dateTime={since} className={cn('tabular text-meta whitespace-nowrap text-fg-3', className)}>
        {formatSince(since, Math.max(now, Date.parse(since)), settled)}
      </time>
    </Tooltip>
  );
}

function LiveElapsed(props: { since: string; settled: boolean; className?: string }) {
  return <Text {...props} now={useNow()} />;
}

function SlowElapsed(props: { since: string; settled: boolean; className?: string }) {
  return <Text {...props} now={useSlowNow()} />;
}
