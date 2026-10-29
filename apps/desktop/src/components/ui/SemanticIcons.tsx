import type { AttentionKind, OutputKind, SessionRole } from '@acc/protocol';
import { cn } from '../../lib/cn';
import { ATTENTION_META, OUTPUT_META, ROLE_META, SCHEDULE_ICON, WORKSPACE_META, type WorkspaceKind } from '../../lib/states';

interface IconProps {
  size?: number;
  className?: string;
}

/** Kind of an output (spec §1.2): document / data / link / files / code. */
export function OutputIcon({ kind, size = 14, className }: IconProps & { kind: OutputKind }) {
  const { icon: Icon, label } = OUTPUT_META[kind];
  return (
    <span role="img" aria-label={label} className={cn('inline-flex shrink-0', className)}>
      <Icon size={size} strokeWidth={1.75} aria-hidden />
    </span>
  );
}

/**
 * Role of a session: chat, agent, supervisor (a filled diamond). `scheduled` overlays a small
 * clock at the top right (started by a schedule).
 */
export function RoleIcon({
  role,
  scheduled = false,
  size = 14,
  className,
}: IconProps & { role: SessionRole; scheduled?: boolean }) {
  const { icon: Icon, label, filled } = ROLE_META[role];
  const Clock = SCHEDULE_ICON;
  return (
    <span
      role="img"
      aria-label={scheduled ? `${label}（繰り返し）` : label}
      className={cn('relative inline-flex shrink-0', className)}
      style={{ width: size, height: size }}
    >
      <Icon size={size} strokeWidth={1.75} aria-hidden fill={filled ? 'currentColor' : 'none'} />
      {scheduled && (
        <span className="absolute -top-1 -right-1 inline-flex rounded-full bg-canvas">
          <Clock size={Math.max(8, Math.round(size * 0.6))} strokeWidth={2.25} aria-hidden />
        </span>
      )}
    </span>
  );
}

/** Kind of an attention item (spec §1.2). */
export function AttentionIcon({ kind, size = 14, className }: IconProps & { kind: AttentionKind }) {
  const { icon: Icon, label } = ATTENTION_META[kind];
  return (
    <span role="img" aria-label={label} className={cn('inline-flex shrink-0', className)}>
      <Icon size={size} strokeWidth={1.75} aria-hidden />
    </span>
  );
}

/** Workspace of a session: nothing for `none`, a folder, or a branch (code). */
export function WorkspaceIcon({ kind, size = 14, className }: IconProps & { kind: WorkspaceKind }) {
  if (kind === 'none') return null;
  const { icon: Icon, label } = WORKSPACE_META[kind];
  return (
    <span role="img" aria-label={label} className={cn('inline-flex shrink-0', className)}>
      <Icon size={size} strokeWidth={1.75} aria-hidden />
    </span>
  );
}
